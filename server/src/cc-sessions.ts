import { deleteSession, listSessions, renameSession } from '@anthropic-ai/claude-agent-sdk';
import { listConversations } from './sessions.js';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** 重命名 CC 会话（写入转录的 custom-title 条目，终端 /resume 里同样生效） */
export async function renameCcSession(sessionId: string, title: string): Promise<void> {
  if (!UUID_RE.test(sessionId)) throw new Error('非法 sessionId');
  const t = title.trim().slice(0, 80);
  if (!t) throw new Error('标题不能为空');
  await renameSession(sessionId, t);
}

/** 删除 CC 会话转录文件 */
export async function deleteCcSession(sessionId: string): Promise<void> {
  if (!UUID_RE.test(sessionId)) throw new Error('非法 sessionId');
  await deleteSession(sessionId);
}

/**
 * 读取 CC 本机会话历史（~/.claude/projects 下的转录，包括用户在 PC 终端里跑的会话）。
 * 通过 SDK 的 listSessions()，不自己解析 JSONL。
 */

export type CcSessionDTO = {
  sessionId: string;
  title: string;
  lastModified: number;
  createdAt?: number;
  gitBranch?: string;
  cwd?: string;
  sizeKb?: number;
  /** 若该 CC 会话已有对应的远程会话记录（convId），手机端可直接跳回原聊天 */
  remoteConvId?: string;
};

/** listSessions 会扫描项目目录读元数据，开销不小——加 5s TTL 缓存抗轮询/连点 */
const LIST_TTL_MS = 5000;
let listCache: { key: string; at: number; infos: Awaited<ReturnType<typeof listSessions>> } | null =
  null;

export async function listCcSessions(dirPath?: string, limit = 50): Promise<CcSessionDTO[]> {
  const key = `${dirPath ?? '*'}:${limit}`;
  let infos;
  if (listCache && listCache.key === key && Date.now() - listCache.at < LIST_TTL_MS) {
    infos = listCache.infos;
  } else {
    infos = await listSessions(dirPath ? { dir: dirPath, limit } : { limit });
    listCache = { key, at: Date.now(), infos };
  }
  const byCc = new Map<string, string>();
  for (const c of listConversations()) {
    if (c.ccSessionId) byCc.set(c.ccSessionId, c.convId);
  }
  return infos
    .map((i) => ({
      sessionId: i.sessionId,
      title: i.customTitle || i.summary || i.firstPrompt || '(无标题)',
      lastModified: i.lastModified,
      createdAt: i.createdAt,
      gitBranch: i.gitBranch,
      cwd: i.cwd,
      sizeKb: i.fileSize != null ? Math.max(1, Math.round(i.fileSize / 1024)) : undefined,
      remoteConvId: byCc.get(i.sessionId),
    }))
    .sort((a, b) => b.lastModified - a.lastModified);
}
