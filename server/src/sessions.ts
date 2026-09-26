import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { SessionRecord } from './protocol.js';

/**
 * 会话持久化（data/sessions.json），按逻辑会话 convId 为主键。
 * ccSessionId 记录最新一次 init 报告的 CC 会话 ID，resume 时取它。
 *
 * 写入采用「防抖 + 异步串行」：内存缓存同步更新（读永远即时），
 * 落盘合并到 400ms 后的一次异步写，不阻塞事件循环；进程关停前 flush。
 */
let file = '';
let cache: SessionRecord[] = [];
let saveTimer: NodeJS.Timeout | null = null;
let saveChain: Promise<void> = Promise.resolve();

export function initSessions(dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
  file = path.join(dataDir, 'sessions.json');
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) cache = parsed as SessionRecord[];
    } catch {
      console.error('[sessions] sessions.json 解析失败，从空列表开始（旧文件已改名 .bak）');
      fs.renameSync(file, file + '.bak');
    }
  }
}

function doSave(): Promise<void> {
  if (!file) return Promise.resolve();
  const snapshot = JSON.stringify(cache, null, 2);
  const tmp = file + '.tmp';
  return fsp
    .writeFile(tmp, snapshot)
    .then(() => fsp.rename(tmp, file))
    .catch((err) => {
      console.error('[sessions] 保存失败:', err instanceof Error ? err.message : err);
    });
}

function save(): void {
  if (saveTimer) return; // 400ms 内的多次修改合并为一次写盘
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveChain = saveChain.then(doSave);
  }, 400);
  saveTimer.unref?.();
}

/** 关停前立即落盘（同步，确保不丢最近 400ms 的变更） */
export function flushSessionsSync(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!file) return;
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('[sessions] 关停落盘失败:', err instanceof Error ? err.message : err);
  }
}

export function createConversation(dirId: string, dirLabel: string, title: string): SessionRecord {
  const now = Date.now();
  const rec: SessionRecord = {
    convId: crypto.randomUUID(),
    ccSessionId: '',
    dirId,
    dirLabel,
    title,
    createdAt: now,
    lastTaskAt: now,
    taskCount: 0,
    lastStatus: 'created',
  };
  cache.push(rec);
  save();
  return rec;
}

export function getConversation(convId: string): SessionRecord | undefined {
  return cache.find((s) => s.convId === convId);
}

export function updateConversation(convId: string, patch: Partial<SessionRecord>): void {
  const s = getConversation(convId);
  if (!s) return;
  Object.assign(s, patch, { convId }); // convId 不可被覆盖
  save();
}

export function listConversations(): SessionRecord[] {
  return [...cache].sort((a, b) => b.lastTaskAt - a.lastTaskAt);
}

/** CC 会话被删除时，清掉引用它的内部会话记录 */
export function removeByCcSession(ccSessionId: string): void {
  const before = cache.length;
  cache = cache.filter((s) => s.ccSessionId !== ccSessionId);
  if (cache.length !== before) save();
}
