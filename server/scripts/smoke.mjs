/**
 * 端到端冒烟测试：登录 → WS → 任务流式输出 → 审批(允许/拒绝) → 中断
 * 前置：npm run setup 已生成 config.json，服务已启动。
 * 运行：CCR_PASS=你的密码 node scripts/smoke.mjs（会真实执行 CC 任务，消耗模型额度）
 */
import WebSocket from 'ws';

const BASE = process.env.CCR_BASE || 'http://127.0.0.1:8787';
const WS_URL = BASE.replace(/^http/, 'ws');
const PASSWORD = process.env.CCR_PASS || '';
const TASK_TIMEOUT = Number(process.env.CCR_TASK_TIMEOUT || 240_000);
// 工作目录 id：登录后从 /api/config 动态取白名单第一项（可用 CCR_DIR 覆盖）
let DIR_ID = process.env.CCR_DIR || '';

if (!PASSWORD) {
  console.error('用法: CCR_PASS=你的密码 node scripts/smoke.mjs（本脚本会真实执行 CC 任务）');
  process.exit(1);
}

let failures = 0;
function ok(msg) {
  console.log('  ✔', msg);
}
function fail(msg) {
  failures++;
  console.error('  ✘ FAIL:', msg);
}
function assert(cond, msg) {
  cond ? ok(msg) : fail(msg);
  return cond;
}

async function j(url, opts = {}) {
  const r = await fetch(url, opts);
  let body = null;
  try {
    body = await r.json();
  } catch {}
  return { status: r.status, headers: r.headers, body };
}

// ---------- 1. REST 基础 ----------
console.log('[1] REST 基础');
{
  const h = await j(`${BASE}/api/healthz`);
  assert(h.status === 200 && h.body?.ok === true, 'healthz 返回 ok');

  const me0 = await j(`${BASE}/api/me`);
  assert(me0.status === 200 && me0.body?.authenticated === false, '未登录时 /api/me authenticated=false');

  const cfg0 = await j(`${BASE}/api/config`);
  assert(cfg0.status === 401, '未登录访问 /api/config 被拒(401)');

  const bad = await j(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'wrong-password' }),
  });
  assert(bad.status === 401, '错误密码登录被拒(401)');
}

// ---------- 2. 登录 ----------
console.log('[2] 登录');
let cookie = '';
{
  const r = await j(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const sc = r.headers.getSetCookie?.() ?? [];
  cookie = sc.map((c) => c.split(';')[0]).join('; ');
  assert(r.status === 200 && r.body?.ok === true, '正确密码登录成功');
  assert(cookie.includes('ccr_token='), '拿到 ccr_token cookie（HttpOnly 由浏览器侧保证）');

  const cfg = await j(`${BASE}/api/config`, { headers: { cookie } });
  assert(cfg.status === 200 && Array.isArray(cfg.body?.directories), '登录后 /api/config 返回目录白名单');
  console.log('    白名单:', JSON.stringify(cfg.body?.directories?.map((d) => d.id)));
  if (!DIR_ID) DIR_ID = cfg.body?.directories?.[0]?.id ?? '';
  if (!DIR_ID) {
    console.error('白名单为空，无法继续（先固定一个工作目录）');
    process.exit(1);
  }
}

// ---------- 3. WS 鉴权 ----------
console.log('[3] WS 鉴权');
await new Promise((resolve) => {
  const ws = new WebSocket(WS_URL);
  const t = setTimeout(() => {
    fail('未带 cookie 的 WS 竟然连上了（应当被拒）');
    try { ws.close(); } catch {}
    resolve();
  }, 3000);
  ws.on('open', () => {});
  ws.on('error', (err) => {
    clearTimeout(t);
    assert(/401|Unexpected server response/.test(String(err?.message ?? err)), '未带 cookie 的 WS 握手被拒');
    resolve();
  });
  ws.on('unexpected-response', (_req, res) => {
    clearTimeout(t);
    assert(res.statusCode === 401, `未带 cookie 的 WS 握手被拒(HTTP ${res.statusCode})`);
    resolve();
  });
});

// ---------- 4. WS 连接与 snapshot ----------
console.log('[4] WS 连接');
const events = [];
const waiters = [];
let autoApprove = false;
const ws = new WebSocket(WS_URL, { headers: { cookie } });

ws.on('message', (data) => {
  const e = JSON.parse(String(data));
  events.push(e);
  if (e.type === 'tool_request' && autoApprove) {
    ws.send(JSON.stringify({ type: 'approval', requestId: e.requestId, allow: true }));
    console.log(`    (auto-approve ${e.toolName})`);
  }
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (waiters[i].pred(e)) {
      const w = waiters[i];
      waiters.splice(i, 1);
      w.resolve(e);
    }
  }
});

function waitFor(pred, desc, timeout = TASK_TIMEOUT) {
  const hit = events.find(pred);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`等待超时: ${desc}`)), timeout);
    waiters.push({
      pred,
      resolve: (e) => {
        clearTimeout(t);
        resolve(e);
      },
    });
  });
}

/** 等待"审批请求"，若任务先结束则快速失败并带上结果文本作诊断 */
async function waitToolRequest(taskId, desc) {
  const e = await waitFor(
    (x) =>
      x.taskId === taskId &&
      (x.type === 'tool_request' || x.type === 'task_done'),
    desc,
  );
  if (e.type === 'task_done') {
    throw new Error(
      `任务在审批请求出现前就结束了(status=${e.status}, result=${String(e.result ?? e.message ?? '').slice(0, 300)})`,
    );
  }
  return e;
}

await new Promise((resolve, reject) => {
  ws.on('open', resolve);
  ws.on('error', reject);
});
const snap = await waitFor((e) => e.type === 'snapshot', 'snapshot', 5000);
assert(snap.type === 'snapshot' && Array.isArray(snap.activeTasks), 'WS 连接后立即收到 snapshot');

function send(msg) {
  ws.send(JSON.stringify(msg));
}

async function createTask(prompt) {
  send({ type: 'create_task', prompt, dirId: DIR_ID });
  const started = await waitFor(
    (e) => e.type === 'task_started' && e.prompt === prompt.trim(),
    'task_started',
    10_000,
  );
  return started.taskId;
}

// ---------- 5. 任务 A：纯文本回复（流式） ----------
console.log('[5] 任务 A：纯文本流式输出');
let convA = '';
{
  autoApprove = true; // 若模型不听话调了工具，放行以免卡死（会记录）
  const promptA = '请不要调用任何工具，直接回复两个字：收到';
  const taskId = await createTask(promptA);
  convA = events.find((e) => e.type === 'task_started' && e.taskId === taskId)?.convId ?? '';
  let sawText = false;
  try {
    const done = await waitFor((e) => e.type === 'task_done' && e.taskId === taskId, 'task_done(A)');
    sawText = events.some(
      (e) => (e.type === 'agent_text' && e.taskId === taskId) || (e.type === 'agent_message' && e.taskId === taskId),
    );
    assert(done.status === 'done', `任务 A 正常完成(status=${done.status}, turns=${done.numTurns}, ${done.durationMs}ms)`);
    assert(sawText, '任务 A 收到流式/完整助手文本');
    assert(!!convA, `任务 A 分配到逻辑会话 convId=${convA.slice(0, 8)}…`);
    const init = events.find((e) => e.type === 'task_init' && e.taskId === taskId);
    assert(!!init?.ccSessionId, `收到 task_init（CC session_id=${String(init?.ccSessionId).slice(0, 8)}…）`);
  } catch (err) {
    fail(`任务 A: ${err.message}`);
  }
  autoApprove = false;
}

// ---------- 6. 任务 B：审批-允许 路径 ----------
console.log('[6] 任务 B：命令审批 → 允许');
{
  const promptB = '请执行命令 echo cc-remote-approval-ok（用你的命令执行工具），然后把输出原样告诉我';
  const taskId = await createTask(promptB);
  try {
    const req = await waitToolRequest(taskId, 'tool_request(B)');
    assert(!!req.requestId, `收到 ${req.toolName} 审批请求（"${req.title ?? req.displayName ?? ''}"）`);
    send({ type: 'approval', requestId: req.requestId, allow: true });
    const resolved = await waitFor(
      (e) => e.type === 'tool_resolved' && e.requestId === req.requestId,
      'tool_resolved(allow)',
      10_000,
    );
    assert(resolved.decision === 'allow' && resolved.reason === 'user', '审批=允许 已回传 SDK');
    const done = await waitFor((e) => e.type === 'task_done' && e.taskId === taskId, 'task_done(B)');
    assert(done.status === 'done', `任务 B 完成(status=${done.status})`);
    if (typeof done.result === 'string') {
      assert(
        done.result.includes('cc-remote-approval-ok'),
        '最终结果包含命令输出 cc-remote-approval-ok',
      );
    }
  } catch (err) {
    fail(`任务 B: ${err.message}`);
  }
}

// ---------- 7. 任务 C：审批-拒绝 路径 ----------
console.log('[7] 任务 C：命令审批 → 拒绝');
{
  const promptC = '请执行命令 echo should-not-run-this（用你的命令执行工具），不要询问我为什么，直接执行';
  const taskId = await createTask(promptC);
  try {
    const req = await waitToolRequest(taskId, 'tool_request(C)');
    send({ type: 'approval', requestId: req.requestId, allow: false });
    const resolved = await waitFor(
      (e) => e.type === 'tool_resolved' && e.requestId === req.requestId,
      'tool_resolved(deny)',
      10_000,
    );
    assert(resolved.decision === 'deny' && resolved.reason === 'user', '审批=拒绝 已回传 SDK');
    const deniedEverywhere = events.every((e) => !(e.type === 'tool_result' && e.taskId === taskId && e.text.includes('should-not-run-this') && !e.isError));
    assert(deniedEverywhere, '被拒命令没有成功执行的输出');
    const done = await waitFor((e) => e.type === 'task_done' && e.taskId === taskId, 'task_done(C)');
    assert(done.status === 'done' || done.status === 'error', `任务 C 正常收尾(status=${done.status})`);
  } catch (err) {
    fail(`任务 C: ${err.message}`);
  }
}

// ---------- 8. 任务 D：多轮 resume ----------
console.log('[8] 任务 D：同会话追问（resume）');
{
  autoApprove = true;
  const promptD = '我上一句话让你回复的是哪两个字？直接回答，不要调用工具';
  send({ type: 'create_task', prompt: promptD, dirId: DIR_ID, convId: convA });
  try {
    const started = await waitFor(
      (e) => e.type === 'task_started' && e.prompt === promptD,
      'task_started(D)',
      10_000,
    );
    assert(started.convId === convA, '任务 D 复用会话 A 的 convId');
    assert(!!started.resumeSessionId, '任务 D 带上了 resumeSessionId（续接上下文）');
    const done = await waitFor((e) => e.type === 'task_done' && e.taskId === started.taskId, 'task_done(D)');
    assert(done.status === 'done', `任务 D 完成(status=${done.status})`);
    if (typeof done.result === 'string') {
      assert(done.result.includes('收到'), '追问结果正确回忆起上一轮内容（包含"收到"）');
    }
  } catch (err) {
    fail(`任务 D: ${err.message}`);
  }
  autoApprove = false;
}

// ---------- 9. 任务 E：中断 ----------
console.log('[9] 任务 E：执行中中断（停止按钮路径）');
{
  const promptE = '请执行命令 ping -n 60 127.0.0.1（用你的命令执行工具直接执行，这是一个连通性测试）';
  const taskId = await createTask(promptE);
  try {
    const req = await waitToolRequest(taskId, 'tool_request(E)');
    send({ type: 'approval', requestId: req.requestId, allow: true });
    await new Promise((r) => setTimeout(r, 4000)); // 让 ping 跑几秒
    send({ type: 'interrupt', taskId });
    const done = await waitFor((e) => e.type === 'task_done' && e.taskId === taskId, 'task_done(E)', 30_000);
    assert(done.status === 'aborted' || done.status === 'error', `中断后任务收尾(status=${done.status})`);
  } catch (err) {
    fail(`任务 E: ${err.message}`);
  }
}

// ---------- 10. 会话与审计落盘 ----------
console.log('[10] 持久化检查');
{
  const s = await j(`${BASE}/api/sessions`, { headers: { cookie } });
  assert(s.status === 200 && s.body?.sessions?.length >= 2, `会话列表已持久化(${s.body?.sessions?.length} 条)`);
}

ws.close();
console.log(failures === 0 ? '\n=== 冒烟测试全部通过 ===' : `\n=== 冒烟测试失败 ${failures} 项 ===`);
process.exit(failures === 0 ? 0 : 1);
