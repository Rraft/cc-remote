import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * 追加式审计日志（data/audit.jsonl）。
 * 记录：登录尝试、任务创建/结束、每次工具审批决定、配置变更。
 * 写入走异步串行队列——不阻塞事件循环，且保证行序。
 */
let auditFile = '';
let chain: Promise<void> = Promise.resolve();

export function initAudit(dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
  auditFile = path.join(dataDir, 'audit.jsonl');
}

export function audit(kind: string, data: Record<string, unknown> = {}): void {
  if (!auditFile) return;
  let line: string;
  try {
    line = JSON.stringify({ at: Date.now(), kind, ...data }) + '\n';
  } catch {
    return;
  }
  chain = chain
    .then(() => fsp.appendFile(auditFile, line))
    .catch((err) => {
      // 审计失败不能影响主流程，但要在 stderr 留痕
      console.error(`[audit] 写入失败: ${kind}`, err instanceof Error ? err.message : err);
    });
}

/** 关停前等待审计队列清空（限时） */
export async function flushAudit(timeoutMs = 1000): Promise<void> {
  await Promise.race([
    chain,
    new Promise<void>((r) => setTimeout(r, timeoutMs)),
  ]);
}
