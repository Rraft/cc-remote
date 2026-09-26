# CC Remote

**在手机上远程驱动你 PC 上的 Claude Code**：发任务、逐字流式看输出、逐个审批敏感操作、续接 PC 终端里跑过的任何会话——通过任意加密隧道（推荐 Tailscale）访问，公网零暴露。

一个自部署的 Web 桥接层：`手机 PWA ⇄ 隧道 ⇄ 本机 Node 服务 ⇄ Claude Agent SDK ⇄ claude CLI ⇄ 你的模型网关`。

## 功能

- **统一会话**：直接使用 CC 原生会话存储（`~/.claude/projects` 转录），手机建的、PC 终端里跑的都在一个列表；支持重命名/删除（写回 CC 转录，终端同步生效）；进入会话先渲染最近一页历史，后台静默补全，上滑翻页秒开
- **还原 CLI 的输入体验**：`/` 斜杠命令面板（指令 + 技能 + 真实模型清单，来自会话运行时上报）；任务执行中可继续发消息，自动排队依次执行（同 CC 交互习惯）
- **权限档位**：🛡 手动——每个敏感操作推手机审批（超时自动拒绝）；⚡ 自动——CC 分类器放行安全操作，高危才推手机
- **目录白名单**：手机浏览 PC 文件系统、一键固定工作目录（热生效）；agent 被限制在白名单目录内，且任何模式下禁止读工作目录之外的文件
- **文件中转站**：指定任意同步盘目录（iCloud/OneDrive/Dropbox…），`inbox` 手机→PC（agent 直接可读），`outbox` PC→手机（对 agent 说"把 xx 发给我"即可）
- **Web 设置页**：模型网关（API Key/Base URL/模型目录）、权限参数、白名单、中转站、改密码、部署状态检测，全部热生效
- **安全审计**：登录尝试/任务/审批决定/配置变更全量记录（`server/data/audit.jsonl`）

## 安全模型（四层纵深）

1. **网络**：服务只绑回环地址（代码强制校验），远程可达性由隧道层提供，公网无入站端口
2. **认证**：登录密码 scrypt 哈希存储、失败限速+指数锁定、httpOnly Cookie、WS 握手同票据
3. **Agent 权限**：默认拒绝——严格审批模式下每个命令/编辑/网络工具都推手机批准，超时自动拒绝
4. **范围**：目录白名单 + 禁止读工作目录外文件 + 模型密钥永不经手本服务（由 CC 自己读 `~/.claude/settings.json`）

残余风险与权衡详见 [deploy/DEPLOY.md](deploy/DEPLOY.md)。

## 配置分层

| 层 | 在哪配 | 内容 |
|---|---|---|
| **首次部署**（本地） | `npm run setup` 交互 / `config.json` | 登录密码、工作目录白名单初始项、绑定端口、数据目录、文件中转根目录 |
| **网络接入**（本地） | 隧道提供商自己的 CLI | Tailscale / Cloudflare Tunnel / frp / 局域网——与本项目解耦，标准是"能加密转发到 127.0.0.1:port" |
| **日常调整**（远程） | Web ⚙️ 设置页 | API Key、网关地址、模型目录、白名单增删、严格审批开关、审批超时、并发数、自动放行工具、中转站、改密码 |

## 快速开始

前置：**Node.js ≥ 22**，以及一台已装好 [Claude Code](https://code.claude.com/docs) 并配置了模型端点的 PC（本应用复用 CC 的配置，不管理你的模型订阅）。

```bash
git clone <this-repo> && cd cc-remote

cd server
npm install
npm run setup        # 交互设置密码 + 工作目录白名单（生成 config.json，密码只存哈希）
npx tsc              # 构建
npm run start

cd ../web
npm install
npm run build        # 产物由服务端同源托管
```

本机浏览器打开 `http://127.0.0.1:8787` → 登录 → 发第一个任务。
远程访问（手机）配置、开机自启（Windows/Linux/macOS）、升级备份：**[deploy/DEPLOY.md](deploy/DEPLOY.md)**。

冒烟测试：

```bash
cd server
node scripts/smoke2.mjs                    # 路由存在性检查（无需密码）
CCR_PASS=你的密码 node scripts/smoke2.mjs   # 完整功能：浏览/白名单/会话历史/分页/文件中转
CCR_PASS=你的密码 node scripts/smoke.mjs    # 任务链路：流式/审批允许/拒绝/超时/resume/中断
```

## 开发

```bash
cd server && npm run dev      # 后端 tsx watch（127.0.0.1:8787）
cd web && npm run dev         # 前端 Vite dev server（手机同 WiFi 可访问，/api 自动代理）
```

技术栈：Node 22 + TypeScript + Express + ws + `@anthropic-ai/claude-agent-sdk`（锁版本）｜React 19 + Vite + Tailwind 4 PWA。
配置热加载：`config.json` 变更即时生效；密码变更自动作废所有登录令牌。

## 路线图 / 已知限制

- [ ] LICENSE 文件（提交开源前选定协议）
- [ ] 英文界面 / i18n
- [ ] 转录内附件（图片）预览
- [ ] 审批"总是允许"目前仅会话级（CC session 范围）
- 斜杠命令中终端绑定类命令（如 `/exit`）已按 SDK 建议从手机面板隐藏
