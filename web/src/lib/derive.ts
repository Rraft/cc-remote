import type { ServerEvent, TaskStatus } from './protocol';

/** 把任务事件流推导为聊天 UI 的渲染条目 */
export type Item =
  | { kind: 'user'; text: string; at: number }
  | { kind: 'text'; text: string; final: boolean }
  | { kind: 'thinking'; text: string }
  | {
      kind: 'tool';
      id: string;
      name: string;
      input: unknown;
      result?: { text: string; isError: boolean };
    }
  | {
      kind: 'approval';
      requestId: string;
      toolName: string;
      input: unknown;
      title?: string;
      displayName?: string;
      description?: string;
      canAlwaysAllow: boolean;
      expiresAt: number;
      resolved?: { decision: 'allow' | 'deny'; reason?: string; alwaysAllow?: boolean };
    }
  | {
      kind: 'done';
      status: TaskStatus;
      result?: string;
      isError?: boolean;
      numTurns?: number;
      durationMs?: number;
      totalCostUsd?: number;
      message?: string;
    };

export function buildItems(events: ServerEvent[]): Item[] {
  const items: Item[] = [];
  let acc = ''; // agent_text 流式增量累积
  let sawQueued = false; // 排队消息已渲染过用户气泡，task_started 不再重复
  const toolIndex = new Map<string, number>();
  const approvalIndex = new Map<string, number>();

  const flushAcc = (): void => {
    if (acc) {
      items.push({ kind: 'text', text: acc, final: false });
      acc = '';
    }
  };

  for (const e of events) {
    switch (e.type) {
      case 'task_queued':
        items.push({ kind: 'user', text: e.prompt, at: e.at });
        sawQueued = true;
        break;
      case 'task_started':
        if (sawQueued) sawQueued = false;
        else items.push({ kind: 'user', text: e.prompt, at: e.at });
        break;
      case 'agent_text':
        acc += e.text;
        break;
      case 'agent_message': {
        // 完整消息到达，丢弃对应的流式累积（避免重复渲染）
        acc = '';
        for (const b of e.blocks) {
          if (b.type === 'text') items.push({ kind: 'text', text: b.text, final: true });
          else if (b.type === 'thinking') items.push({ kind: 'thinking', text: b.thinking });
          else if (b.type === 'tool_use') {
            toolIndex.set(b.id, items.length);
            items.push({ kind: 'tool', id: b.id, name: b.name, input: b.input });
          }
        }
        break;
      }
      case 'tool_result': {
        const i = toolIndex.get(e.toolUseId);
        if (i !== undefined) {
          const it = items[i];
          if (it && it.kind === 'tool') it.result = { text: e.text, isError: e.isError };
        }
        break;
      }
      case 'tool_request':
        approvalIndex.set(e.requestId, items.length);
        items.push({
          kind: 'approval',
          requestId: e.requestId,
          toolName: e.toolName,
          input: e.input,
          title: e.title,
          displayName: e.displayName,
          description: e.description,
          canAlwaysAllow: e.canAlwaysAllow,
          expiresAt: e.expiresAt,
        });
        break;
      case 'tool_resolved': {
        const i = approvalIndex.get(e.requestId);
        if (i !== undefined) {
          const it = items[i];
          if (it && it.kind === 'approval') {
            it.resolved = { decision: e.decision, reason: e.reason, alwaysAllow: e.alwaysAllow };
          }
        }
        break;
      }
      case 'task_done':
        flushAcc();
        items.push({
          kind: 'done',
          status: e.status,
          result: e.result,
          isError: e.isError,
          numTurns: e.numTurns,
          durationMs: e.durationMs,
          totalCostUsd: e.totalCostUsd,
          message: e.message,
        });
        break;
      default:
        break; // task_init / sessions / snapshot / pong 不直接渲染
    }
  }
  flushAcc(); // 进行中任务的流式文本
  return items;
}
