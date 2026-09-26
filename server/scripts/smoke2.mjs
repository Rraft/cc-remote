/**
 * 新功能冒烟测试：目录浏览 / 白名单管理 / CC 会话历史 / iCloud 文件中转站
 *
 * 用法：
 *   node scripts/smoke2.mjs                 # 不带密码：只验证路由存在（未鉴权返回 401 而非 404）
 *   CCR_PASS=你的密码 node scripts/smoke2.mjs   # 完整功能测试（Git Bash: CCR_PASS=xxx node scripts/smoke2.mjs）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.CCR_BASE || 'http://127.0.0.1:8787';
const PASSWORD = process.env.CCR_PASS || '';
const SERVER_DIR = path.resolve(import.meta.dirname, '..');
// 工作目录 id：登录后从 /api/config 动态取白名单第一项（可用 CCR_DIR 覆盖）
let DIR_ID = process.env.CCR_DIR || '';

let failures = 0;
const ok = (m) => console.log('  ✔', m);
const fail = (m) => {
  failures++;
  console.error('  ✘ FAIL:', m);
};
const assert = (c, m) => (c ? ok(m) : fail(m));

async function j(url, opts = {}, cookie = '') {
  const r = await fetch(url, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(opts.headers ?? {}) },
  });
  let body = null;
  try {
    body = await r.json();
  } catch {}
  return { status: r.status, body, headers: r.headers };
}

// ---------- 0. 路由存在性（未登录应 401，而不是 404） ----------
console.log('[0] 新路由存在性（未鉴权 → 401）');
for (const [method, p] of [
  ['GET', '/api/fs'],
  ['GET', '/api/cc-sessions'],
  ['GET', '/api/cc-sessions/00000000-0000-4000-8000-000000000000/transcript'],
  ['GET', '/api/commands'],
  ['GET', '/api/files?box=inbox'],
  ['POST', '/api/dirs'],
  ['DELETE', '/api/dirs/whatever'],
  ['POST', '/api/files/outbox'],
  ['DELETE', '/api/files?box=inbox&name=x'],
]) {
  const r = await j(`${BASE}${p}`, { method });
  assert(r.status === 401, `${method} ${p} → 401（实际 ${r.status}）`);
}

if (!PASSWORD) {
  console.log('\n未提供 CCR_PASS，跳过功能测试。完整测试: CCR_PASS=密码 node scripts/smoke2.mjs');
  console.log(failures === 0 ? '=== 路由检查通过 ===' : `=== 失败 ${failures} 项 ===`);
  process.exit(failures === 0 ? 0 : 1);
}

// ---------- 1. 登录 ----------
console.log('[1] 登录');
const lr = await j(`${BASE}/api/login`, { method: 'POST', body: JSON.stringify({ password: PASSWORD }) });
const cookie = (lr.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
assert(lr.status === 200 && cookie.includes('ccr_token='), '登录成功拿到 cookie');
if (lr.status !== 200) {
  console.error('无法继续（密码错误或锁定）');
  process.exit(1);
}
{
  // 解析工作目录 id（未指定 CCR_DIR 时取白名单第一项）
  const cfg0 = await j(`${BASE}/api/config`, {}, cookie);
  if (!DIR_ID) DIR_ID = cfg0.body?.directories?.[0]?.id ?? '';
  if (!DIR_ID) {
    console.error('白名单为空，无法继续功能测试（先在设置里固定一个工作目录）');
    process.exit(1);
  }
  console.log('    使用工作目录:', DIR_ID);
}

// ---------- 2. 目录浏览 ----------
console.log('[2] 目录浏览');
{
  const drives = await j(`${BASE}/api/fs`, {}, cookie);
  assert(drives.body?.path === 'DRIVES' && drives.body.dirs.some((d) => d.path.startsWith('C:')), '驱动器列表包含 C:');
  const home = await j(`${BASE}/api/fs?path=${encodeURIComponent(os.homedir())}`, {}, cookie);
  assert(home.status === 200 && Array.isArray(home.body?.dirs) && home.body.dirs.length > 0, '浏览用户主目录成功');
  assert(home.body?.dirs.every((d) => !d.name.startsWith('.') && d.name !== 'node_modules'), '过滤隐藏目录与 node_modules');
  const bad = await j(`${BASE}/api/fs?path=${encodeURIComponent('C:\\不存在的目录xyz')}`, {}, cookie);
  assert(bad.status === 404, '不存在的目录 → 404');
}

// ---------- 3. 白名单增删 ----------
console.log('[3] 白名单管理（固定/移除）');
const tmpDir = path.join(SERVER_DIR, 'smoke-tmp-dir');
let tmpDirId = '';
{
  fs.mkdirSync(tmpDir, { recursive: true });
  const add = await j(`${BASE}/api/dirs`, { method: 'POST', body: JSON.stringify({ path: tmpDir }) }, cookie);
  assert(add.body?.ok === true && add.body.dir?.id, `固定目录成功 (id=${add.body?.dir?.id})`);
  tmpDirId = add.body?.dir?.id ?? '';
  await new Promise((r) => setTimeout(r, 1200)); // 等 config 热加载
  const cfg = await j(`${BASE}/api/config`, {}, cookie);
  assert(cfg.body?.directories.some((d) => d.id === tmpDirId), '热加载后 /api/config 包含新目录');
  assert(cfg.body?.directories.every((d) => typeof d.path === 'string'), '/api/config 目录带 path 字段');
  const dup = await j(`${BASE}/api/dirs`, { method: 'POST', body: JSON.stringify({ path: tmpDir }) }, cookie);
  assert(dup.body?.existed === true, '重复固定 → existed:true 幂等');
}

// ---------- 4. CC 会话历史 ----------
console.log('[4] CC 会话历史');
{
  const byDir = await j(`${BASE}/api/cc-sessions?dirId=cc-remote&limit=10`, {}, cookie);
  assert(byDir.status === 200 && Array.isArray(byDir.body?.sessions), `按白名单目录过滤 (n=${byDir.body?.sessions?.length})`);
  const all = await j(`${BASE}/api/cc-sessions?limit=5`, {}, cookie);
  assert(all.status === 200 && Array.isArray(all.body?.sessions) && all.body.sessions.length > 0, `全部项目 (n=${all.body?.sessions?.length})`);
  const s = all.body?.sessions?.[0];
  if (s) {
    assert(typeof s.sessionId === 'string' && typeof s.title === 'string' && typeof s.lastModified === 'number', '会话 DTO 字段齐全');
    console.log(`    示例: "${s.title.slice(0, 40)}" branch=${s.gitBranch ?? '-'}`);
    // 转录分页回放
    const tr = await j(`${BASE}/api/cc-sessions/${s.sessionId}/transcript?limit=2`, {}, cookie);
    assert(
      tr.status === 200 && Array.isArray(tr.body?.events) && tr.body.events.length <= 2 &&
      typeof tr.body?.total === 'number' && typeof tr.body?.from === 'number' && typeof tr.body?.hasMore === 'boolean',
      `转录分页读取成功 (events=${tr.body?.events?.length}, total=${tr.body?.total}, from=${tr.body?.from}, hasMore=${tr.body?.hasMore})`,
    );
    if (tr.body?.hasMore) {
      const older = await j(`${BASE}/api/cc-sessions/${s.sessionId}/transcript?limit=2&before=${tr.body.from}`, {}, cookie);
      assert(older.status === 200 && older.body?.from < tr.body.from, `向更早翻页成功 (from=${older.body?.from})`);
    }
    const full = await j(`${BASE}/api/cc-sessions/${s.sessionId}/transcript`, {}, cookie);
    const hasUser = full.body?.events.some((e) => e.type === 'task_started');
    const hasAssistant = full.body?.events.some((e) => e.type === 'agent_message');
    assert(hasUser || hasAssistant, '转录包含用户/助手消息');
  }

  // 命令面板数据源
  const cmds = await j(`${BASE}/api/commands`, {}, cookie);
  assert(cmds.status === 200 && Array.isArray(cmds.body?.commands), `命令清单 (n=${cmds.body?.commands?.length}, skills=${cmds.body?.skills?.length}, models=${cmds.body?.models?.length})`);
  const badId = await j(`${BASE}/api/cc-sessions/not-a-uuid/transcript`, {}, cookie);
  assert(badId.status === 404, '非法 sessionId → 404');
  const badDir = await j(`${BASE}/api/cc-sessions?dirId=no-such-dir`, {}, cookie);
  assert(badDir.status === 400, '未知 dirId → 400');
}

// ---------- 5. iCloud 文件中转站 ----------
console.log('[5] 文件中转站');
{
  const inbox = await j(`${BASE}/api/files?box=inbox`, {}, cookie);
  assert(inbox.body?.configured === true, `fileDrop 已配置 (root=${inbox.body?.root})`);
  assert(fs.existsSync(path.join(inbox.body.root, 'inbox')) && fs.existsSync(path.join(inbox.body.root, 'outbox')), 'inbox/outbox 目录已创建');

  // 发送：白名单内文件 → outbox
  const src = path.join(SERVER_DIR, 'package.json');
  const send = await j(`${BASE}/api/files/outbox`, { method: 'POST', body: JSON.stringify({ srcPath: src }) }, cookie);
  assert(send.body?.ok === true && send.body.file?.name, `复制到 outbox 成功 (${send.body?.file?.name})`);
  const sentName = send.body?.file?.name ?? '';

  // 白名单外文件拒绝
  const outside = await j(`${BASE}/api/files/outbox`, { method: 'POST', body: JSON.stringify({ srcPath: 'C:\\Windows\\win.ini' }) }, cookie);
  assert(outside.status === 400, '白名单外源文件被拒绝');

  // 列表 + 下载 + 删除
  const outbox = await j(`${BASE}/api/files?box=outbox`, {}, cookie);
  assert(outbox.body?.files.some((f) => f.name === sentName), 'outbox 列表包含刚发送的文件');
  const dl = await fetch(`${BASE}/api/files/download?box=outbox&name=${encodeURIComponent(sentName)}`, { headers: { cookie } });
  assert(dl.status === 200 && Number(dl.headers.get('content-length') ?? 1) > 0, `HTTPS 下载成功 (${dl.status})`);
  await dl.body?.cancel();
  const del = await j(`${BASE}/api/files?box=outbox&name=${encodeURIComponent(sentName)}`, { method: 'DELETE' }, cookie);
  assert(del.body?.ok === true, '删除 outbox 文件成功');
  const traversal = await j(`${BASE}/api/files?box=inbox&name=${encodeURIComponent('..\\..\\secret.txt')}`, { method: 'DELETE' }, cookie);
  assert(traversal.status === 400, '路径穿越文件名被拒绝');

  // 清理白名单临时目录
  const rm = await j(`${BASE}/api/dirs/${encodeURIComponent(tmpDirId)}`, { method: 'DELETE' }, cookie);
  assert(rm.body?.ok === true, '移除白名单目录成功');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\n=== 新功能冒烟全部通过 ===' : `\n=== 失败 ${failures} 项 ===`);
process.exit(failures === 0 ? 0 : 1);
