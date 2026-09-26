import fs from 'node:fs';
import path from 'node:path';

/**
 * 追加式审计日志（data/audit.jsonl）。
 * 记录：登录尝试、任务创建/结束、每次工具审批决定。
 */
let auditFile = '';

export function initAudit(dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
  auditFile = path.join(dataDir, 'audit.jsonl');
}

export function audit(kind: string, data: Record<string, unknown> = {}): void {
  if (!auditFile) return;
  try {
    fs.appendFileSync(auditFile, JSON.stringify({ at: Date.now(), kind, ...data }) + '\n');
  } catch {
    // 审计失败不能影响主流程，但要在 stderr 留痕
    console.error(`[audit] 写入失败: ${kind}`);
  }
}
