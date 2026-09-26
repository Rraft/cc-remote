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

前置：Node.js ≥ 22；已安装并配置好 Claude Code CLI（`claude` 可用，模型端点在 `~/.claude/settings.json` 或环境变量中配置——本应用不管理你的模型订阅，只是复用 CC 的配置）。

```bash
git clone <this-repo> && cd cc-remote

# 服务端
cd server
npm install
npm run setup          # 交互设置密码 + 目录白名单，生成 config.json
npx tsc                # 构建到 dist/
npm run start          # 或 npm run dev（开发模式）

# 前端
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

## 7. 卸载

1. 删除自启项（Startup vbs / systemd unit）
2. `tailscale serve --bg 8787 off`（或其他隧道对应操作）
3. 删除项目目录；`~/.claude/settings.json` 若有改动可自行还原（网关写入时旧文件备份为 `.bak`）
