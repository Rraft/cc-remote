import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SessionRecord } from './protocol.js';

/**
 * 会话持久化（data/sessions.json），按逻辑会话 convId 为主键。
 * ccSessionId 记录最新一次 init 报告的 CC 会话 ID，resume 时取它。
 */
let file = '';
let cache: SessionRecord[] = [];

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

function save(): void {
  if (!file) return;
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, file);
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
