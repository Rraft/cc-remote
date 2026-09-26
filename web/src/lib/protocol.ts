/**
 * 与 server/src/protocol.ts 保持一致（v1 手动同步；改动服务端协议时记得同步这里）。
 */

export type TaskStatus = 'running' | 'done' | 'error' | 'aborted' | 'queued';

/** 权限档位：manual = 每个敏感操作都推手机审批；auto = 分类器放行安全操作，高危才推手机 */
export type PermissionModeChoice = 'manual' | 'auto';

export type ClientMessage =
  | { type: 'ping' }
  | {
      type: 'create_task';
      prompt: string;
      dirId: string;
      convId?: string;
      ccSessionId?: string;
      mode?: PermissionModeChoice;
    }
  | { type: 'approval'; requestId: string; allow: boolean; alwaysAllow?: boolean }
  | { type: 'interrupt'; taskId: string }
  | { type: 'list_sessions' };

export type AssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };

export type SessionRecord = {
  convId: string;
  ccSessionId: string;
  dirId: string;
  dirLabel?: string;
  title: string;
  createdAt: number;
  lastTaskAt: number;
  taskCount: number;
  lastStatus: string;
};

export type PendingApprovalInfo = {
  requestId: string;
  taskId: string;
  toolName: string;
  input: unknown;
  title?: string;
  displayName?: string;
  description?: string;
  canAlwaysAllow: boolean;
  expiresAt: number;
};

export type ServerEvent =
  | {
      /** 同会话任务执行中，本消息已排队，前序结束后自动执行（taskId 与后续 task_started 相同） */
      type: 'task_queued';
      taskId: string;
      dirId: string;
      dirLabel: string;
      prompt: string;
      position: number;
      at: number;
    }
  | {
      type: 'task_started';
      taskId: string;
      convId: string;
      dirId: string;
      dirLabel: string;
      prompt: string;
      resumeSessionId?: string;
      mode?: PermissionModeChoice;
      at: number;
    }
  | { type: 'task_init'; taskId: string; ccSessionId: string; model?: string; commands?: string[] }
  | { type: 'agent_text'; taskId: string; text: string }
  | { type: 'agent_message'; taskId: string; blocks: AssistantBlock[] }
  | { type: 'tool_result'; taskId: string; toolUseId: string; text: string; isError: boolean }
  | {
      type: 'tool_request';
      taskId: string;
      requestId: string;
      toolName: string;
      input: unknown;
      title?: string;
      displayName?: string;
      description?: string;
      canAlwaysAllow: boolean;
      expiresAt: number;
    }
  | {
      type: 'tool_resolved';
      taskId: string;
      requestId: string;
      toolName: string;
      decision: 'allow' | 'deny';
      reason?: 'user' | 'timeout' | 'aborted';
      alwaysAllow?: boolean;
    }
  | {
      type: 'task_done';
      taskId: string;
      status: TaskStatus;
      result?: string;
      isError?: boolean;
      numTurns?: number;
      durationMs?: number;
      totalCostUsd?: number;
      message?: string;
    }
  | { type: 'sessions'; sessions: SessionRecord[] }
  | { type: 'snapshot'; activeTasks: ActiveTaskSnapshot[]; pendingApprovals: PendingApprovalInfo[] }
  | { type: 'error'; message: string }
  | { type: 'pong' };

export type ActiveTaskSnapshot = {
  taskId: string;
  convId: string;
  dirId: string;
  dirLabel: string;
  prompt: string;
  status: TaskStatus;
  startedAt: number;
  ccSessionId?: string;
  events: ServerEvent[];
};
