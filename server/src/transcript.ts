import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { getSessionInfo, listSessions } from '@anthropic-ai/claude-agent-sdk';
import type { AssistantBlock, ServerEvent } from './protocol.js';

/**
 * CC 原生会话转录读取（~/.claude/projects/<slug>/<sessionId>.jsonl），
 * 归一化为与实时流相同的 ServerEvent 序列。
 *
 * 性能设计（转录可达数十 MB，绝不能阻塞事件循环）：
 * - 流式逐行读取（createReadStream + readline），每解析 YIELD_EVERY 行主动让出事件循环
 * - 按会话 LRU 缓存解析结果，mtime/size 变化才重新解析
 * - 同一会话的并发请求共享同一个解析 Promise（in-flight 合并）
 * - 分页返回（limit/before 游标），启动预热逐个会话低优先级进行
 */

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const TOOL_RESULT_MAX = 4000;
/** 单会话缓存的事件上限（超出丢弃最旧部分并加提示） */
const EVENT_CAP = 20000;
/** LRU 缓存的会话数上限 */
const CACHE_MAX = 40;
/** 每解析多少行让出一次事件循环 */
const YIELD_EVERY = 400;

export type TranscriptPage = {
  sessionId: string;
  title?: string;
  cwd?: string;
  events: ServerEvent[];
  total: number;
  from: number;
  hasMore: boolean;
};

type CachedTranscript = {
  file: string;
  mtimeMs: number;
  size: number;
  events: ServerEvent[];
  title?: string;
  cwd?: string;
};

const cache = new Map<string, CachedTranscript>();
const inflight = new Map<string, Promise<CachedTranscript>>();

const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

function touchCache(sessionId: string, entry: CachedTranscript): void {
  cache.delete(sessionId);
  cache.set(sessionId, entry);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function findTranscriptFile(sessionId: string): string | null {
  const root = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(root)) return null;
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const candidate = path.join(root, ent.name, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** 流式解析转录为归一化事件序列（异步、分块让出事件循环） */
async function parseTranscript(file: string, sessionId: string): Promise<ServerEvent[]> {
  const events: ServerEvent[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let lineNo = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    if (++lineNo % YIELD_EVERY === 0) await yieldToLoop();
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (e.isSidechain === true || e.isMeta === true) continue; // 子代理内部消息 / 元数据
    const tsRaw = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
    const at = Number.isFinite(tsRaw) ? tsRaw : Date.now();
    const message = e.message as { role?: string; content?: unknown } | undefined;

    if (e.type === 'user' && message?.role === 'user') {
      const c = message.content;
      if (typeof c === 'string') {
        const t = c.trim();
        if (
          !t ||
          t.startsWith('<command-name>') ||
          t.startsWith('<command-message>') ||
          t.startsWith('Caveat:') ||
          t.startsWith('<local-command')
        ) {
          continue; // 斜杠命令/系统注入文本，不算用户消息
        }
        events.push({
          type: 'task_started',
          taskId: sessionId,
          convId: '',
          dirId: '',
          dirLabel: '',
          prompt: t,
          at,
        });
      } else if (Array.isArray(c)) {
        for (const b of c as Array<Record<string, unknown>>) {
          if (b?.type === 'tool_result') {
            events.push({
              type: 'tool_result',
              taskId: sessionId,
              toolUseId: String(b.tool_use_id ?? ''),
              text: truncate(stringifyContent(b.content), TOOL_RESULT_MAX),
              isError: b.is_error === true,
            });
          }
        }
      }
    } else if (e.type === 'assistant' && message?.role === 'assistant') {
      const content = message.content;
      if (!Array.isArray(content)) continue;
      const blocks: AssistantBlock[] = [];
      for (const b of content as Array<Record<string, unknown>>) {
        if (b.type === 'text' && typeof b.text === 'string' && b.text) {
          blocks.push({ type: 'text', text: b.text });
        } else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking) {
          blocks.push({ type: 'thinking', thinking: b.thinking });
        } else if (b.type === 'tool_use' && b.id && b.name) {
          blocks.push({
            type: 'tool_use',
            id: String(b.id),
            name: String(b.name),
            input: b.input,
          });
        }
      }
      if (blocks.length) events.push({ type: 'agent_message', taskId: sessionId, blocks });
    }
  }
  if (events.length > EVENT_CAP) {
    const kept = events.slice(-EVENT_CAP);
    kept.unshift({
      type: 'task_started',
      taskId: sessionId,
      convId: '',
      dirId: '',
      dirLabel: '',
      prompt: `（历史过长，更早的 ${events.length - EVENT_CAP} 条事件已省略）`,
      at: 0,
    });
    return kept;
  }
  return events;
}

/** 取得（或解析并缓存）会话全量事件；并发请求共享同一解析 */
async function loadCached(sessionId: string): Promise<CachedTranscript> {
  const hit = cache.get(sessionId);
  const file = hit?.file ?? findTranscriptFile(sessionId);
  if (!file) throw new Error(`会话转录不存在: ${sessionId}`);
  const st = await fsp.stat(file);

  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    touchCache(sessionId, hit);
    return hit;
  }

  const running = inflight.get(sessionId);
  if (running) return running;

  const p = (async (): Promise<CachedTranscript> => {
    const events = await parseTranscript(file, sessionId);
    let title: string | undefined;
    let cwd: string | undefined;
    try {
      const info = await getSessionInfo(sessionId);
      if (info) {
        title = info.customTitle || info.summary || info.firstPrompt || undefined;
        cwd = info.cwd;
      }
    } catch {
      /* info 缺失不影响转录读取 */
    }
    const entry: CachedTranscript = { file, mtimeMs: st.mtimeMs, size: st.size, events, title, cwd };
    touchCache(sessionId, entry);
    return entry;
  })();

  inflight.set(sessionId, p);
  p.catch(() => {}).finally(() => inflight.delete(sessionId));
  return p;
}

/** 分页读取转录：默认返回最近 limit 条；before = 全量数组下标游标 */
export async function getTranscript(
  sessionId: string,
  opts: { limit?: number; before?: number } = {},
): Promise<TranscriptPage> {
  if (!UUID_RE.test(sessionId)) throw new Error('非法 sessionId');
  const entry = await loadCached(sessionId);
  const total = entry.events.length;
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  const end = Math.min(Math.max(opts.before ?? total, 0), total);
  const start = Math.max(0, end - limit);
  return {
    sessionId,
    title: entry.title,
    cwd: entry.cwd,
    events: entry.events.slice(start, end),
    total,
    from: start,
    hasMore: start > 0,
  };
}

/**
 * 启动预热：逐个解析最近 n 个会话进缓存。
 * 每个会话之间主动让出事件循环，预热期间服务保持完全可用。
 */
export async function warmTranscripts(n = 20): Promise<number> {
  const startedAt = Date.now();
  let warmed = 0;
  try {
    const infos = await listSessions({ limit: n });
    for (const info of infos) {
      try {
        await loadCached(info.sessionId);
        warmed++;
      } catch {
        /* 单个会话失败跳过 */
      }
      await new Promise((r) => setTimeout(r, 30)); // 低优先级：给正常请求让路
    }
  } catch {
    /* listSessions 失败则跳过预热 */
  }
  if (warmed > 0) {
    console.log(`[cc-remote] 转录缓存预热完成: ${warmed} 个会话, ${Date.now() - startedAt}ms`);
  }
  return warmed;
}

// ---------- 工具函数 ----------

function stringifyContent(c: unknown): string {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((x) => {
        if (typeof x === 'string') return x;
        if (x && typeof x === 'object' && 'text' in x && typeof (x as { text?: unknown }).text === 'string') {
          return (x as { text: string }).text;
        }
        return JSON.stringify(x);
      })
      .join('\n');
  }
  try {
    return JSON.stringify(c);
  } catch {
    return String(c);
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n…（已截断，原长 ${s.length} 字符）` : s;
}
