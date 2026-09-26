# CC Remote 部署指南

面向自部署用户的完整说明：配置分层、首次部署、网络接入（穿透）方案、开机自启、升级备份。

## 1. 架构与安全模型

```
手机浏览器/PWA ──(隧道提供商加密通道)──> 127.0.0.1:<port> Node 服务 ──> Claude Agent SDK ──> claude CLI ──> 模型网关
```

核心原则：**服务只绑定回环地址**（config 校验强制 `127.0.0.1`，或 Tailscale 网段 `100.64.0.0/10`），
公网/局域网零暴露；远程可达性完全由隧道层提供，与穿透提供商解耦。

纵深防御四层：隧道设备认证 → 应用登录密码（scrypt + 限速锁定）→ 逐操作手机审批（超时拒绝）→ 目录白名单 + 禁止读工作目录外文件。

## 2. 配置分层（哪些在哪配）

### A. 首次部署时配置（服务端 CLI / config.json，改动需 setup 或重启）

| 项 | 位置 | 说明 |
|---|---|---|
| 登录密码 | `npm run setup` 交互生成 | 只存 scrypt 哈希；也可日后在 Web 设置页修改 |
| 绑定端口 | `config.json: port` | 默认 8787；host 仅允许 127.0.0.1 或 Tailscale 网段 |
| 数据目录 | `config.json: dataDir` | 会话记录/审计日志/命令缓存 |
| 网络接入方式 | 隧道提供商自己的 CLI/客户端 | 见第 4 节，与应用解耦 |
| 对外域名 | 由提供商决定 | Tailscale: `<机器>.<tailnet>.ts.net`；Cloudflare: 自有/临时域名；frp: VPS 域名 |

### B. Web 设置页远程配置（⚙️ 标签，保存即热生效，无需重启）

| 项 | 说明 |
|---|---|
| 模型网关 | Base URL、API Token（只回显尾 4 位）、模型目录（default/opus/sonnet/haiku/subagent 五档）——写入 `~/.claude/settings.json`，与 PC 上的 Claude Code 共用 |
| 目录白名单 | 浏览 PC 文件系统 → 固定/移除工作目录 |
| 权限与任务 | 严格审批开关、审批超时、单任务轮数上限、并发任务数、自动放行工具列表 |
| 文件中转站 | 同步盘根目录（iCloud/OneDrive/Dropbox 均可）+ 是否纳入 agent 范围 |
| 修改密码 | 验证当前密码；改完所有设备强制重新登录 |

### C. 不建议远程配置的（保持服务端本地）

绑定地址/端口（防止误操作把自己锁在外面或意外暴露）、dataDir、隧道本身的凭据。

## 3. 首次部署

前置只有一个：**Node.js ≥ 22**。
**无需单独安装 Claude Code**：`@anthropic-ai/claude-agent-sdk` 通过平台可选依赖自带完整 CLI 运行时
（win32/linux/darwin × x64/arm64，约 200MB，`npm install` 自动选择下载）。
模型端点（官方 Anthropic 或任意 Anthropic 兼容网关）在 setup 向导或 Web 设置页配置，写入 `~/.claude/settings.json`。

### 一键安装（推荐）

```bash
git clone <this-repo> && cd cc-remote

# Windows：双击 cc-remote.bat（或 .\cc-remote.bat）→ 选 [1]
# Linux / macOS：
bash cc-remote.sh   # 选 [1]
```

流程：检查 Node → 安装依赖并构建两端 → 配置向导（密码/目录/端口/中转站/模型网关）→
可选开机自启（Windows Startup / Linux systemd）→ 可选立即启动 → 打印隧道配置指引。
统一入口菜单还包含 **[2] 启动运行、[3] 重置配置、[4] 卸载**（对应 `scripts/` 下同名脚本）。

### 手动安装

```bash
cd server
npm install
npm run setup          # 交互向导；参数化: npm run setup -- --dir "标签=路径" [--port 8787] [--force]
npx tsc                # 构建到 dist/
npm run start          # 或 npm run dev（开发模式）

cd ../web
npm install
npm run build          # 产物 web/dist 由服务端自动托管（同源）
```

浏览器打开 `http://127.0.0.1:8787` 验证登录，再配置第 4 节的远程接入。

冒烟测试：`cd server && node scripts/smoke2.mjs`（路由检查）；
`CCR_PASS=你的密码 node scripts/smoke2.mjs`（完整功能）。

## 4. 网络接入（穿透）——提供商无关

标准：**任何能把外部加密流量转发到 `127.0.0.1:<port>` 的方案都可以**。按安全性排序：

### 方案 1：Tailscale（推荐）
WireGuard 私有组网，公网零入站端口，只有你账号下的设备可达。

```bash
# PC（Windows: winget install Tailscale.Tailscale；Linux: 官方一键脚本）
tailscale up
tailscale serve --bg 8787      # 自动 HTTPS，域名 https://<机器>.<tailnet>.ts.net
# 手机装 Tailscale App 登录同账号即可访问
```
需先在 https://login.tailscale.com/admin/dns 开启 HTTPS Certificates（一次性）。

### 方案 2：Cloudflare Tunnel
无需公网 IP，出站连接获得公网 HTTPS 域名。

```bash
cloudflared tunnel --url http://127.0.0.1:8787        # 临时随机域名（快速体验）
# 长期：cloudflared tunnel create + 绑定自有域名 + 建议叠加 Cloudflare Access
```
⚠️ 服务暴露公网，务必保持强密码，建议叠加 Cloudflare Access（邮箱 OTP）。

### 方案 3：frp（自有 VPS）
```ini
# frpc.toml（PC 上）
serverAddr = "your.vps.ip"
[[proxies]]
name = "cc-remote"
type = "tcp"
localIP = "127.0.0.1"
localPort = 8787
remotePort = 18787
```
⚠️ VPS 端口公网可达：建议在 frps 上启用 TLS/令牌，或前面再挂 Nginx + Basic Auth/证书。

### 方案 4：局域网直连（仅家庭内网临时用）
把 `config.json` 的 host 临时改为 PC 局域网 IP（注意：代码只放行回环与 Tailscale 网段，
局域网 IP 需要自行放宽 `src/config.ts` 的 `isAllowedBindHost`——默认拒绝是有意的）。

## 5. 开机自启

### Windows（用户登录时静默启动）
复制 `deploy/cc-remote-server.vbs.template` 到
`%AppData%\Microsoft\Windows\Start Menu\Programs\Startup\cc-remote-server.vbs`，
把其中 `__SERVER_DIR__` 替换为你的 server 目录绝对路径。
（或计划任务：`schtasks /create /tn cc-remote /sc onlogon /tr "cmd /c cd /d <server目录> && npm run start"`）

### Linux（systemd，开机即启不依赖登录）
复制 `deploy/cc-remote.service` 到 `/etc/systemd/system/`，改其中的路径与用户，然后：
```bash
sudo systemctl daemon-reload && sudo systemctl enable --now cc-remote
```

### macOS
launchd 用户代理（`~/Library/LaunchAgents/`），ProgramArguments 指向 `node <server>/dist/index.js`，RunAtLoad=true。

电源注意：PC 睡眠会挂起任务，设置为接通电源不睡眠。

## 6. 升级与备份

```bash
git pull
cd server && npm install && npx tsc
cd ../web && npm install && npm run build
# 重启服务（Windows: 杀 node 进程后自启脚本/手动拉起；Linux: systemctl restart cc-remote）
```

备份：`server/config.json`（密码哈希+白名单）与 `server/data/`（会话/审计）。
模型网关配置在 `~/.claude/settings.json`（属于 Claude Code，不在本应用备份范围）。

## 7. 卸载与重置

- **卸载**：运行 `cc-remote.bat` / `cc-remote.sh` 选 **[4]**（停止服务、删除 Startup vbs 或 systemd 服务、关闭 tailscale serve 443 转发、可选删除配置与数据）。项目目录本身请手动删除；`~/.claude/settings.json` 属于 Claude Code，脚本不做改动（网关写入时旧文件备份为 `.bak`）。
- **仅重置配置**：选 **[3]**——备份并删除 config.json（可选清空 data/），然后重跑配置向导；不影响自启与隧道配置。
