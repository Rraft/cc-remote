import crypto from 'node:crypto';
import type { PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { audit } from './audit.js';
import type { ServerEvent } from './protocol.js';

/**
 * 审批中转：SDK 的 canUseTool 回调 → WS 推送到手机 → 等待响应/超时。
 *
 * 关键约束（读自 sdk.d.ts CanUseTool 注释）：
 * - 回调绝不能返回 null（null 表示已在带外发送 control_response，
 *   误返回会让工具调用永久挂起）——超时/中断都必须 resolve 成 deny。
 * - SDK 侧权限提示没有内置超时，超时逻辑必须在这里自己实现。
 */

export type PendingApproval = {
  requestId: string;
  taskId: string;
  toolName: string;
  input: unknown;
  title?: string;
  displayName?: string;
  description?: string;
  suggestions?: PermissionUpdate[];
  expiresAt: number;
};

type PendingEntry = PendingApproval & {
  resolve: (r: PermissionResult) => void;
  timer: NodeJS.Timeout;
  settled: boolean;
};

export class ApprovalBroker {
  private pending = new Map<string, PendingEntry>();

  constructor(
    private timeoutMs: number,
    private emit: (e: ServerEvent) => void,
  ) {}

  /** canUseTool 的实现体：广播审批请求并等待手机响应 */
  request(
    taskId: string,
    toolName: string,
    input: Record<string, unknown>,
    ui: {
      title?: string;
      displayName?: string;
      description?: string;
      suggestions?: PermissionUpdate[];
    },
    signal: AbortSignal,
  ): Promise<PermissionResult> {
    const requestId = crypto.randomUUID();
    const expiresAt = Date.now() + this.timeoutMs;

    return new Promise<PermissionResult>((resolve) => {
      const entry: PendingEntry = {
        requestId,
        taskId,
        toolName,
        input,
        title: ui.title,
        displayName: ui.displayName,
        description: ui.description,
        suggestions: ui.suggestions,
        expiresAt,
        resolve,
        settled: false,
        timer: setTimeout(() => {
          this.settle(requestId, {
            result: {
              behavior: 'deny',
              message: `审批超时（${Math.round(this.timeoutMs / 1000)}s 未响应），已自动拒绝`,
            },
            decision: 'deny',
            reason: 'timeout',
          });
        }, this.timeoutMs),
      };

      signal.addEventListener(
        'abort',
        () => {
          this.settle(requestId, {
            result: { behavior: 'deny', message: '任务已被中断' },
            decision: 'deny',
            reason: 'aborted',
          });
        },
        { once: true },
      );

      this.pending.set(requestId, entry);
      this.emit({
        type: 'tool_request',
        taskId,
        requestId,
        toolName,
        input,
        title: ui.title,
        displayName: ui.displayName,
        description: ui.description,
        canAlwaysAllow: !!ui.suggestions && ui.suggestions.length > 0,
        expiresAt,
      });
    });
  }

  private settle(
    requestId: string,
    outcome: {
      result: PermissionResult;
      decision: 'allow' | 'deny';
      reason: 'user' | 'timeout' | 'aborted';
      alwaysAllow?: boolean;
    },
  ): void {
    const entry = this.pending.get(requestId);
    if (!entry || entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);

    audit('approval', {
      taskId: entry.taskId,
      requestId,
      toolName: entry.toolName,
      decision: outcome.decision,
      reason: outcome.reason,
      alwaysAllow: outcome.alwaysAllow ?? false,
      inputSummary: summarizeInput(entry.input),
    });
    this.emit({
      type: 'tool_resolved',
      taskId: entry.taskId,
      requestId,
      toolName: entry.toolName,
      decision: outcome.decision,
      reason: outcome.reason,
      alwaysAllow: outcome.alwaysAllow,
    });
    entry.resolve(outcome.result);
  }

  /** 手机响应审批；未知 requestId 返回 false */
  respond(requestId: string, allow: boolean, alwaysAllow = false): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    if (allow) {
      this.settle(requestId, {
        result: {
          behavior: 'allow',
          updatedInput: entry.input as Record<string, unknown>,
          // “本会话内总是允许”：把 SDK 给的 suggestions 原样写回会话级权限
          ...(alwaysAllow && entry.suggestions?.length
            ? { updatedPermissions: entry.suggestions }
            : {}),
        },
        decision: 'allow',
        reason: 'user',
        alwaysAllow,
      });
    } else {
      this.settle(requestId, {
        result: { behavior: 'deny', message: '用户拒绝了此操作' },
        decision: 'deny',
        reason: 'user',
      });
    }
    return true;
  }

  /** 任务中断/结束时，清掉该任务所有未决审批（一律拒绝） */
  cancelTask(taskId: string): void {
    for (const [requestId, entry] of this.pending) {
      if (entry.taskId === taskId && !entry.settled) {
        this.settle(requestId, {
          result: { behavior: 'deny', message: '任务已被中断' },
          decision: 'deny',
          reason: 'aborted',
        });
      }
    }
  }

  /** 供 WS snapshot：当前未决审批（重连后手机能恢复审批卡片） */
  listPending(): PendingApproval[] {
    return [...this.pending.values()].map(({ resolve: _r, timer: _t, settled: _s, ...rest }) => rest);
  }
}

function summarizeInput(input: unknown): string {
  try {
    const s = JSON.stringify(input) ?? String(input);
    return s.length > 300 ? s.slice(0, 300) + '…' : s;
  } catch {
    return '<unserializable>';
  }
}
