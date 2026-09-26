/**
 * WS/REST 消息协议 —— 服务端与前端共享的类型定义（对应 docs/plan.md「WS 消息协议」）
 *
 * convId = 本服务生成的逻辑会话 ID（稳定）；
 * ccSessionId = Claude Code 的会话 ID（resume 时可能变化，由服务端追踪最新值）。
 * 手机端只用 convId 续聊。
 */

export type TaskStatus = 'running' | 'done' | 'error' | 'aborted' | 'queued';

/** 权限档位：manual = 每个敏感操作都推手机审批；auto = CC 分类器自动放行安全操作，高危才推手机 */
export type PermissionModeChoice = 'manual' | 'auto';

/** client -> server */
export type ClientMessage =
  | { type: 'ping' }
  | {
      type: 'create_task';
      prompt: string;
      dirId: string;
      convId?: string;
      /** 续接一个"外部" CC 会话（如 PC 终端里跑的），服务端为其新建远程会话记录 */
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
  /** 最近一次 init 事件报告的 CC 会话 ID（resume 用） */
  ccSessionId: string;
  dirId: string;
  dirLabel?: string;
  title: string;
  createdAt: number;
  lastTaskAt: number;
  taskCount: number;
  lastStatus: string;
};

/** 未决审批（snapshot 里带给重连的手机端） */
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

/** server -> client（同时也是任务事件缓冲区里存的形态） */
export type ServerEvent =
  | {
      /** 同会话已有任务在跑，本消息进入队列，前序任务结束后自动执行（taskId 与后续 task_started 相同） */
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
  | {
      type: 'task_init';
      taskId: string;
      ccSessionId: string;
      model?: string;
      /** 本会话可用的斜杠命令名（不含 /，已过滤终端专属命令） */
      commands?: string[];
    }
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
