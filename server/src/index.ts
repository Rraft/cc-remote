import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { audit, initAudit } from './audit.js';
import {
  COOKIE_NAME,
  buildClearCookie,
  buildSessionCookie,
  checkLock,
  clearAllTokens,
  createToken,
  hashPassword,
  noteFailure,
  noteSuccess,
  parseCookies,
  revokeToken,
  validateToken,
  verifyPassword,
} from './auth.js';
import { getDeployInfo } from './deploy-info.js';
import { readGateway, writeGateway, type GatewayPatch } from './gateway.js';
import { configPath, loadConfig, readCurrentPassword, resolveWhitelistedDir, serverRoot, updateConfigFile } from './config.js';
import { deleteCcSession, listCcSessions, renameCcSession } from './cc-sessions.js';
import { getCommands, getSkills, initCommands, readSettingsModels } from './commands.js';
import { getTranscript, warmTranscripts } from './transcript.js';
import { copyToOutbox, deleteInBox, ensureFileDrop, listBox, resolveInBox } from './files.js';
import type { ClientMessage, PendingApprovalInfo, ServerEvent } from './protocol.js';
import { initSessions, listConversations, removeByCcSession } from './sessions.js';
import { TaskManager } from './task-manager.js';

const cfg = loadConfig();
initAudit(cfg.dataDir);
initSessions(cfg.dataDir);
initCommands(cfg.dataDir);
ensureFileDrop(cfg);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
// tailscale serve 以 https 边缘 → http 本机的方式代理，信任其 X-Forwarded-Proto 以决定 Cookie Secure 位
app.set('trust proxy', true);

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 });
const clients = new Set<WebSocket>();

function broadcast(e: ServerEvent): void {
  const s = JSON.stringify(e);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(s);
  }
}

const tasks = new TaskManager(cfg, broadcast);

// ---------- REST ----------

function isSecureReq(req: Request): boolean {
  return req.headers['x-forwarded-proto'] === 'https' || !!(req.socket as { encrypted?: boolean }).encrypted;
}

function tokenFromReq(req: Request): string | undefined {
  return parseCookies(req.headers.cookie)[COOKIE_NAME];
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (validateToken(tokenFromReq(req))) return next();
  res.status(401).json({ error: '未登录或会话已过期' });
}

app.post('/api/login', async (req, res) => {
  const key = req.ip ?? 'unknown';
  const lock = checkLock(key);
  if (lock.locked) {
    res.status(429).json({ error: '失败次数过多，已临时锁定', retryAfterMs: lock.retryAfterMs });
    return;
  }
  const currentPassword = readCurrentPassword(); // 每次登录从磁盘读，改密后免重启
  if (!currentPassword) {
    res.status(500).json({ error: '服务端未配置密码，请先在 PC 上运行 npm run setup' });
    return;
  }
  const password = (req.body as { password?: unknown } | undefined)?.password;
  const ok = typeof password === 'string' && (await verifyPassword(password, currentPassword));
  if (!ok) {
    noteFailure(key);
    audit('login_fail', { ip: key });
    res.status(401).json({ error: '密码错误' });
    return;
  }
  noteSuccess(key);
  const token = createToken();
  res.setHeader('set-cookie', buildSessionCookie(token, isSecureReq(req)));
  audit('login_ok', { ip: key });
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const t = tokenFromReq(req);
  if (t) revokeToken(t);
  res.setHeader('set-cookie', buildClearCookie(isSecureReq(req)));
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  res.json({ authenticated: validateToken(tokenFromReq(req)), setupDone: !!cfg.password });
});

app.get('/api/config', requireAuth, (_req, res) => {
  res.json({
    directories: cfg.directories.map(({ id, label, path }) => ({ id, label, path })),
    autoAllowTools: cfg.autoAllowTools,
    approvalTimeoutMs: cfg.approvalTimeoutMs,
    maxTurns: cfg.maxTurns,
    maxConcurrentTasks: cfg.maxConcurrentTasks,
    fileDrop: cfg.fileDrop
      ? { configured: true, root: cfg.fileDrop.root }
      : { configured: false },
  });
});

// ---------- 运行时设置（Web 远程可配，热生效） ----------

app.get('/api/settings', requireAuth, (_req, res) => {
  res.json({
    host: cfg.host,
    port: cfg.port,
    directories: cfg.directories.map(({ id, label, path }) => ({ id, label, path })),
    autoAllowTools: cfg.autoAllowTools,
    strictApproval: cfg.strictApproval,
    approvalTimeoutMs: cfg.approvalTimeoutMs,
    maxTurns: cfg.maxTurns,
    maxConcurrentTasks: cfg.maxConcurrentTasks,
    fileDrop: cfg.fileDrop,
  });
});

app.put('/api/settings', requireAuth, (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};

  if (b.autoAllowTools !== undefined) {
    if (
      !Array.isArray(b.autoAllowTools) ||
      b.autoAllowTools.length > 50 ||
      !b.autoAllowTools.every((x) => typeof x === 'string' && x.trim() && x.length <= 64)
    ) {
      res.status(400).json({ error: 'autoAllowTools 必须是字符串数组（≤50 项）' });
      return;
    }
    patch.autoAllowTools = [...new Set((b.autoAllowTools as string[]).map((x) => x.trim()))];
  }
  if (b.strictApproval !== undefined) {
    if (typeof b.strictApproval !== 'boolean') {
      res.status(400).json({ error: 'strictApproval 必须是布尔值' });
      return;
    }
    patch.strictApproval = b.strictApproval;
  }
  const numFields: Array<[string, number, number]> = [
    ['approvalTimeoutMs', 5_000, 3_600_000],
    ['maxTurns', 1, 1000],
    ['maxConcurrentTasks', 1, 8],
  ];
  for (const [field, min, max] of numFields) {
    if (b[field] !== undefined) {
      const n = Number(b[field]);
      if (!Number.isFinite(n) || n < min || n > max) {
        res.status(400).json({ error: `${field} 必须在 ${min}~${max} 之间` });
        return;
      }
      patch[field] = Math.floor(n);
    }
  }
  if (b.fileDrop !== undefined) {
    if (b.fileDrop === null) {
      patch.fileDrop = null;
    } else {
      const fd = b.fileDrop as { root?: unknown; addToAgentScope?: unknown };
      if (typeof fd.root !== 'string' || !fd.root.trim()) {
        res.status(400).json({ error: 'fileDrop.root 必须是非空路径' });
        return;
      }
      patch.fileDrop = {
        root: path.resolve(fd.root.trim()),
        addToAgentScope: fd.addToAgentScope !== false,
      };
    }
  }

  if (!Object.keys(patch).length) {
    res.status(400).json({ error: '没有可更新的有效字段' });
    return;
  }
  try {
    updateConfigFile((raw) => Object.assign(raw, patch));
    audit('settings_update', { fields: Object.keys(patch) });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 修改登录密码（需验证当前密码；成功后 watcher 会作废所有令牌，各端需重新登录）
app.post('/api/settings/password', requireAuth, async (req, res) => {
  const body = (req.body ?? {}) as { current?: unknown; next?: unknown };
  const cur = readCurrentPassword();
  if (!cur || typeof body.current !== 'string' || !(await verifyPassword(body.current, cur))) {
    audit('password_change_fail', { ip: req.ip ?? '?' });
    res.status(403).json({ error: '当前密码不正确' });
    return;
  }
  if (typeof body.next !== 'string' || body.next.length < 8) {
    res.status(400).json({ error: '新密码至少 8 位' });
    return;
  }
  const rec = await hashPassword(body.next);
  updateConfigFile((raw) => {
    raw.password = rec;
  });
  audit('password_change_ok', { ip: req.ip ?? '?' });
  res.json({ ok: true });
});

// ---------- 模型网关（读写 ~/.claude/settings.json，token 只回掩码） ----------

app.get('/api/settings/gateway', requireAuth, (_req, res) => {
  res.json(readGateway());
});

app.put('/api/settings/gateway', requireAuth, (req, res) => {
  try {
    const view = writeGateway((req.body ?? {}) as GatewayPatch);
    res.json({ ok: true, gateway: view });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---------- 部署状态检测（只读） ----------

app.get('/api/settings/deploy', requireAuth, async (_req, res) => {
  res.json(await getDeployInfo(cfg.host, cfg.port));
});

// ---------- 目录浏览（只列目录名，不读文件内容） ----------

const FS_SKIP = new Set(['node_modules', 'System Volume Information', 'Windows', 'Recovery']);

app.get('/api/fs', requireAuth, (req, res) => {
  const p = typeof req.query.path === 'string' ? req.query.path : '';
  if (!p || p === 'DRIVES') {
    const drives: Array<{ name: string; path: string }> = [];
    for (let c = 65; c <= 90; c++) {
      const root = String.fromCharCode(c) + ':\\';
      try {
        if (fs.existsSync(root)) drives.push({ name: root, path: root });
      } catch {
        /* 无权限的驱动器跳过 */
      }
    }
    res.json({ path: 'DRIVES', parent: null, dirs: drives });
    return;
  }
  let abs: string;
  try {
    abs = path.resolve(p);
  } catch {
    res.status(400).json({ error: '路径无效' });
    return;
  }
  try {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      res.status(404).json({ error: `目录不存在: ${abs}` });
      return;
    }
    const dirs: Array<{ name: string; path: string }> = [];
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      if (dirs.length >= 500) break;
      const n = ent.name;
      if (n.startsWith('.') || n.startsWith('$') || FS_SKIP.has(n)) continue;
      let isDir = ent.isDirectory();
      if (!isDir && ent.isSymbolicLink()) {
        try {
          isDir = fs.statSync(path.join(abs, n)).isDirectory();
        } catch {
          isDir = false;
        }
      }
      if (isDir) dirs.push({ name: n, path: path.join(abs, n) });
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    const parent = path.dirname(abs);
    res.json({ path: abs, parent: parent !== abs ? parent : null, dirs });
  } catch (err) {
    res.status(403).json({ error: `无法读取: ${err instanceof Error ? err.message : String(err)}` });
  }
});

// ---------- 目录白名单管理（手机端固定/移除工作目录） ----------

app.post('/api/dirs', requireAuth, (req, res) => {
  const body = (req.body ?? {}) as { path?: string; label?: string };
  if (typeof body.path !== 'string' || !body.path.trim()) {
    res.status(400).json({ error: '缺少 path' });
    return;
  }
  const abs = path.resolve(body.path.trim());
  try {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      res.status(400).json({ error: `目录不存在: ${abs}` });
      return;
    }
  } catch {
    res.status(400).json({ error: `目录不可访问: ${abs}` });
    return;
  }
  const existing = cfg.directories.find((d) => d.path.toLowerCase() === abs.toLowerCase());
  if (existing) {
    res.json({ ok: true, dir: existing, existed: true });
    return;
  }
  const base = path.basename(abs) || abs;
  const idBase =
    base
      .toLowerCase()
      .replace(/[^a-z0-9一-鿿]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'dir';
  let id = idBase;
  for (let n = 2; cfg.directories.some((d) => d.id === id); n++) id = `${idBase}-${n}`;
  const entry = {
    id,
    label: typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 40) : base,
    path: abs,
  };
  updateConfigFile((raw) => {
    const arr = Array.isArray(raw.directories) ? (raw.directories as unknown[]) : [];
    arr.push(entry);
    raw.directories = arr;
  });
  audit('dir_add', { id: entry.id, path: abs });
  res.json({ ok: true, dir: entry, existed: false });
});

app.delete('/api/dirs/:id', requireAuth, (req, res) => {
  const id = req.params.id;
  const d = cfg.directories.find((x) => x.id === id);
  if (!d) {
    res.status(404).json({ error: '白名单中不存在该目录' });
    return;
  }
  if (cfg.directories.length <= 1) {
    res.status(400).json({ error: '至少需保留一个白名单目录' });
    return;
  }
  if (tasks.isDirBusy(id)) {
    res.status(409).json({ error: '该目录下有任务正在运行，不能移除' });
    return;
  }
  updateConfigFile((raw) => {
    raw.directories = (Array.isArray(raw.directories) ? raw.directories : []).filter(
      (x) => !x || typeof x !== 'object' || (x as { id?: string }).id !== id,
    );
  });
  audit('dir_remove', { id, path: d.path });
  res.json({ ok: true });
});

// ---------- CC 本机会话历史（含 PC 终端里跑的会话） ----------

app.get('/api/cc-sessions', requireAuth, async (req, res) => {
  const dirId = typeof req.query.dirId === 'string' ? req.query.dirId : '';
  const rawPath = typeof req.query.path === 'string' ? req.query.path : '';
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  let dirPath: string | undefined;
  try {
    if (dirId) {
      dirPath = resolveWhitelistedDir(dirId, cfg).path;
    } else if (rawPath) {
      dirPath = path.resolve(rawPath);
      if (!fs.existsSync(dirPath)) throw new Error(`目录不存在: ${dirPath}`);
    }
    const sessions = await listCcSessions(dirPath, limit);
    res.json({ sessions });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 重命名 CC 会话（写入转录 custom-title，终端 /resume 同样生效）
app.patch('/api/cc-sessions/:id', requireAuth, async (req, res) => {
  const title = String((req.body as { title?: unknown } | undefined)?.title ?? '').trim();
  if (!title) {
    res.status(400).json({ error: '标题不能为空' });
    return;
  }
  if (title.length > 80) {
    res.status(400).json({ error: '标题最长 80 字符' });
    return;
  }
  try {
    await renameCcSession(req.params.id, title);
    audit('session_rename', { id: req.params.id, title });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 删除 CC 会话转录（有运行中/排队任务时拒绝）
app.delete('/api/cc-sessions/:id', requireAuth, async (req, res) => {
  const id = req.params.id;
  if (tasks.isSessionBusy(id)) {
    res.status(409).json({ error: '该会话有任务在运行或排队，请先停止' });
    return;
  }
  try {
    await deleteCcSession(id);
    removeByCcSession(id); // 清理内部会话记录
    audit('session_delete', { id });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 斜杠命令 + 技能清单 + 模型列表（手机命令面板数据源）
app.get('/api/commands', requireAuth, (_req, res) => {
  res.json({ commands: getCommands(), skills: getSkills(), models: readSettingsModels() });
});

// 单个 CC 会话的转录（分页）：默认最近 100 条事件；before=下标游标向更早翻页。
// 服务端带 LRU 缓存（mtime/size 失效），首屏快、翻页更快。
app.get('/api/cc-sessions/:id/transcript', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000);
    const beforeRaw = Number(req.query.before);
    const before = Number.isFinite(beforeRaw) && beforeRaw >= 0 ? beforeRaw : undefined;
    res.json(await getTranscript(req.params.id, { limit, before }));
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---------- iCloud 文件中转站 ----------

app.get('/api/files', requireAuth, (req, res) => {
  const box = req.query.box === 'outbox' ? 'outbox' : 'inbox';
  if (!cfg.fileDrop) {
    res.json({ configured: false, box, files: [] });
    return;
  }
  try {
    res.json({ configured: true, box, root: cfg.fileDrop.root, files: listBox(cfg, box) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/files/download', requireAuth, (req, res) => {
  const box = req.query.box === 'outbox' ? 'outbox' : 'inbox';
  const name = String(req.query.name ?? '');
  try {
    const abs = resolveInBox(cfg, box, name);
    if (!fs.existsSync(abs)) {
      res.status(404).json({ error: '文件不存在' });
      return;
    }
    res.download(abs, name.replace(/\.icloud$/i, ''));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/files/outbox', requireAuth, (req, res) => {
  const srcPath = String((req.body as { srcPath?: unknown } | undefined)?.srcPath ?? '');
  try {
    const file = copyToOutbox(cfg, srcPath);
    res.json({ ok: true, file });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete('/api/files', requireAuth, (req, res) => {
  const box = req.query.box === 'outbox' ? 'outbox' : 'inbox';
  const name = String(req.query.name ?? '');
  try {
    deleteInBox(cfg, box, name);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/sessions', requireAuth, (_req, res) => {
  res.json({ sessions: listConversations() });
});

// 无敏感信息的健康检查（tailscale serve / 运维用）
app.get('/api/healthz', (_req, res) => res.json({ ok: true }));

// 前端静态文件（web/ 构建后生效）
const webDist = path.resolve(serverRoot, '../web/dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('*', (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
}

// ---------- WebSocket ----------

server.on('upgrade', (req, socket, head) => {
  const ip = req.socket.remoteAddress ?? '?';
  if (!validateToken(parseCookies(req.headers.cookie)[COOKIE_NAME])) {
    audit('ws_reject', { ip });
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.add(ws);
    const pending: PendingApprovalInfo[] = tasks.broker.listPending().map((p) => ({
      requestId: p.requestId,
      taskId: p.taskId,
      toolName: p.toolName,
      input: p.input,
      title: p.title,
      displayName: p.displayName,
      description: p.description,
      canAlwaysAllow: !!p.suggestions && p.suggestions.length > 0,
      expiresAt: p.expiresAt,
    }));
    send(ws, { type: 'snapshot', activeTasks: tasks.snapshot(), pendingApprovals: pending });
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
    ws.on('message', (data) => handleWsMessage(ws, data, ip));
  });
});

function send(ws: WebSocket, e: ServerEvent): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(e));
}

function handleWsMessage(ws: WebSocket, data: unknown, ip: string): void {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(String(data)) as ClientMessage;
  } catch {
    send(ws, { type: 'error', message: 'JSON 格式错误' });
    return;
  }
  switch (msg?.type) {
    case 'ping':
      send(ws, { type: 'pong' });
      break;
    case 'create_task':
      try {
        tasks.createTask(msg.prompt, msg.dirId, msg.convId, msg.ccSessionId, msg.mode);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        audit('task_reject', { ip, message });
        send(ws, { type: 'error', message });
      }
      break;
    case 'approval': {
      const found = tasks.broker.respond(msg.requestId, msg.allow === true, msg.alwaysAllow === true);
      if (!found) send(ws, { type: 'error', message: `审批请求不存在或已处理: ${msg.requestId}` });
      break;
    }
    case 'interrupt': {
      const ok = tasks.interrupt(msg.taskId);
      if (!ok) send(ws, { type: 'error', message: `任务不存在或已结束: ${msg.taskId}` });
      break;
    }
    case 'list_sessions':
      send(ws, { type: 'sessions', sessions: listConversations() });
      break;
    default:
      send(ws, { type: 'error', message: '未知消息类型' });
  }
}

// WS 心跳：及时发现半开连接（手机切网/休眠场景）
const heartbeat = setInterval(() => {
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
    else clients.delete(ws);
  }
}, 30_000);
heartbeat.unref();

// ---------- 启动 ----------

server.listen(cfg.port, cfg.host, () => {
  // 监听 config.json：密码更换 → 作废所有登录令牌；目录白名单等 → 热更新
  let lastPasswordHash = cfg.password?.hash ?? '';
  try {
    fs.watch(configPath, () => {
      try {
        const fresh = loadConfig();
        const h = fresh.password?.hash ?? '';
        if (h && h !== lastPasswordHash) {
          lastPasswordHash = h;
          clearAllTokens();
          audit('password_changed', {});
          console.log('[cc-remote] 检测到密码已更换，所有登录会话已作废');
        }
        Object.assign(cfg, fresh); // 目录白名单/审批超时等即时生效（新任务用新配置）
        ensureFileDrop(cfg);
        console.log('[cc-remote] config.json 已热加载');
      } catch (err) {
        console.warn(
          '[cc-remote] config.json 重载失败，沿用旧配置:',
          err instanceof Error ? err.message : err,
        );
      }
    });
  } catch {
    console.warn('[cc-remote] config.json 监听失败（改配置后需重启服务）');
  }

  console.log(`[cc-remote] 服务端已启动: http://${cfg.host}:${cfg.port}`);
  console.log(
    `[cc-remote] 目录白名单: ${cfg.directories.map((d) => `${d.id} → ${d.path}`).join(' | ')}`,
  );
  console.log(`[cc-remote] 自动放行工具: ${cfg.autoAllowTools.join(', ')}（其余全部走手机审批）`);
  console.log('[cc-remote] 远程访问: tailscale serve --bg ' + cfg.port + ' 后用手机访问 https://<机器名>.<tailnet>.ts.net');

  // 后台预热最近会话的转录缓存（不阻塞启动）
  setTimeout(() => {
    void warmTranscripts(20).catch(() => {});
  }, 1500);
});

function shutdown(sig: string): void {
  console.log(`[cc-remote] 收到 ${sig}，正在关闭`);
  clearInterval(heartbeat);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
