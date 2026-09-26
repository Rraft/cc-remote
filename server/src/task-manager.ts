import crypto from 'node:crypto';
import path from 'node:path';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { ApprovalBroker } from './approvals.js';
import { audit } from './audit.js';
import type { AppConfig, DirEntry } from './config.js';
import { resolveWhitelistedDir } from './config.js';
import { rememberCommandDetails, rememberCommandsFromInit, rememberSkills } from './commands.js';
import { fileDropRoot } from './files.js';
import type {
  ActiveTaskSnapshot,
  AssistantBlock,
  PermissionModeChoice,
  ServerEvent,
  TaskStatus,
} from './protocol.js';
import {
  createConversation,
  getConversation,
  listConversations,
  updateConversation,
} from './sessions.js';

type ActiveTask = {
  taskId: string;
  convId: string;
  dirId: string;
  dirLabel: string;
  prompt: string;
  status: TaskStatus;
  startedAt: number;
  ccSessionId?: string;
  /** 本任务启动时 resume 的 CC 会话（用于并发守卫与排队） */
  resumeFrom?: string;
  /** 权限档位 */
  mode: PermissionModeChoice;
  events: ServerEvent[];
  abort: AbortController;
  doneEmitted: boolean;
};

/** 排队中的消息（同会话任务执行中时新发的消息，前序结束后自动执行） */
type QueuedTask = {
  taskId: string;
  prompt: string;
  dirId: string;
  dirLabel: string;
  mode: PermissionModeChoice;
  queuedAt: number;
  events: ServerEvent[];
};

/** SDK 消息的结构化宽松视图（避免绑定 SDK 内部类型细节） */
type LooseMessage = { type: string; subtype?: string; [k: string]: unknown };

const PROMPT_MAX = 20_000;
const TOOL_RESULT_MAX = 4_000;
const KEEP_FINISHED = 30;
/** 单会话排队上限 */
const QUEUE_MAX = 10;

/**
 * strictApproval 模式下强制弹审批的工具（settings.permissions.ask 规则）。
 * 说明：Windows 上 CC 的命令执行工具叫 PowerShell（Linux/mac 为 Bash），两个都列上；
 * ask 规则优先级高于 CC 内置的“安全命令自动放行”，保证每个命令都到手机审批。
 */
const STRICT_ASK_TOOLS = [
  'Bash',
  'PowerShell',
  'Edit',
  'Write',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
  'Skill',
];

export class TaskManager {
  readonly broker: ApprovalBroker;
  private tasks = new Map<string, ActiveTask>();
  /** 会话内消息队列：key = 目标 CC 会话 id（或内部 convId） */
  private queues = new Map<string, QueuedTask[]>();

  constructor(
    private cfg: AppConfig,
    private broadcast: (e: ServerEvent) => void,
  ) {
    this.broker = new ApprovalBroker(cfg.approvalTimeoutMs, (e) => {
      // 审批事件同样进任务缓冲（重连 snapshot 用），再广播
      const taskId = (e as { taskId?: string }).taskId;
      if (taskId) this.buffer(this.tasks.get(taskId), e);
      this.broadcast(e);
    });
  }

  // ---------- 对外接口 ----------

  createTask(
    prompt: string,
    dirId: string,
    convId?: string,
    ccSessionId?: string,
    mode?: PermissionModeChoice,
  ): { taskId: string; convId: string; queued: boolean } {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt 不能为空');
    if (prompt.length > PROMPT_MAX) throw new Error(`prompt 过长（上限 ${PROMPT_MAX} 字符）`);

    const dir = resolveWhitelistedDir(dirId, this.cfg);
    const m: PermissionModeChoice = mode === 'auto' ? 'auto' : 'manual';

    let conv = convId ? getConversation(convId) : undefined;
    if (convId && !conv) throw new Error(`会话不存在: ${convId}`);
    if (conv && conv.dirId !== dirId) throw new Error('续聊时不能更换工作目录');

    const resumeTarget = conv ? conv.ccSessionId || undefined : ccSessionId || undefined;

    // 同会话已有任务在跑 → 排队（对齐 CC 交互：执行中发的消息排队，当前轮结束后自动执行）
    const clash = resumeTarget
      ? this.activeTasks().find(
          (t) => t.ccSessionId === resumeTarget || t.resumeFrom === resumeTarget,
        )
      : convId
        ? this.activeTasks().find((t) => t.convId === convId)
        : undefined;
    if (clash) {
      return this.enqueue(prompt.trim(), dir, resumeTarget ?? clash.convId, m);
    }

    // 全局并发上限（排队不占名额，出队时再检查）
    if (this.activeTasks().length >= this.cfg.maxConcurrentTasks) {
      throw new Error(`并发运行任务已达上限（${this.cfg.maxConcurrentTasks}），请等待完成或先停止`);
    }

    if (!conv) {
      conv = createConversation(dirId, dir.label, prompt.trim().slice(0, 60));
      // 续接外部 CC 会话（如用户在 PC 终端里跑出来的）：把它的 session id 记为新会话的起点
      if (ccSessionId) {
        updateConversation(conv.convId, { ccSessionId });
        conv = getConversation(conv.convId) ?? conv;
      }
    }

    const resumeFrom = conv.ccSessionId || undefined;
    const r = this.launch(prompt.trim(), dir, conv, resumeFrom, m);
    return { ...r, queued: false };
  }

  /** 实际启动任务（createTask 立即执行路径 / 队列出队路径共用） */
  private launch(
    prompt: string,
    dir: DirEntry,
    conv: { convId: string; taskCount: number },
    resumeFrom: string | undefined,
    mode: PermissionModeChoice,
    presetTaskId?: string,
  ): { taskId: string; convId: string } {
    const task: ActiveTask = {
      taskId: presetTaskId ?? crypto.randomUUID(),
      convId: conv.convId,
      dirId: dir.id,
      dirLabel: dir.label,
      prompt,
      status: 'running',
      startedAt: Date.now(),
      resumeFrom,
      mode,
      events: [],
      abort: new AbortController(),
      doneEmitted: false,
    };
    this.tasks.set(task.taskId, task);
    this.pruneFinished();

    updateConversation(conv.convId, {
      taskCount: conv.taskCount + 1,
      lastTaskAt: Date.now(),
      lastStatus: 'running',
    });
    audit('task_create', {
      taskId: task.taskId,
      convId: conv.convId,
      dirId: dir.id,
      dirPath: dir.path,
      resumeFrom,
      mode,
      promptLen: prompt.length,
      fromQueue: !!presetTaskId,
    });

    this.emit(task, {
      type: 'task_started',
      taskId: task.taskId,
      convId: conv.convId,
      dirId: dir.id,
      dirLabel: dir.label,
      prompt,
      resumeSessionId: resumeFrom,
      mode,
      at: Date.now(),
    });

    void this.runTask(task, dir, resumeFrom).catch((err) =>
      console.error('[task] 未处理异常:', err),
    );
    return { taskId: task.taskId, convId: conv.convId };
  }

  /** 会话内排队：返回预生成的 taskId（出队执行时复用，事件流无缝衔接） */
  private enqueue(
    prompt: string,
    dir: DirEntry,
    queueKey: string,
    mode: PermissionModeChoice,
  ): { taskId: string; convId: string; queued: true } {
    const list = this.queues.get(queueKey) ?? [];
    if (list.length >= QUEUE_MAX) {
      throw new Error(`该会话排队已满（${QUEUE_MAX} 条），请等前面的任务执行完`);
    }
    const taskId = crypto.randomUUID();
    const ev: ServerEvent = {
      type: 'task_queued',
      taskId,
      dirId: dir.id,
      dirLabel: dir.label,
      prompt,
      position: list.length + 1,
      at: Date.now(),
    };
    list.push({
      taskId,
      prompt,
      dirId: dir.id,
      dirLabel: dir.label,
      mode,
      queuedAt: Date.now(),
      events: [ev],
    });
    this.queues.set(queueKey, list);
    audit('task_queue', { taskId, queueKey, position: list.length, mode, promptLen: prompt.length });
    this.broadcast(ev);
    return { taskId, convId: '', queued: true };
  }

  /** 任务结束后链式唤起该会话的下一条排队消息 */
  private drainQueue(task: ActiveTask): void {
    const latest = task.ccSessionId ?? task.resumeFrom;
    const keys: string[] = [];
    if (latest) keys.push(latest);
    keys.push(task.convId);
    for (const key of keys) {
      const list = this.queues.get(key);
      if (!list || !list.length) continue;
      if (this.activeTasks().length >= this.cfg.maxConcurrentTasks) return; // 满载，等下次完成
      const next = list.shift()!;
      if (!list.length) this.queues.delete(key);
      let dir: DirEntry;
      try {
        dir = resolveWhitelistedDir(next.dirId, this.cfg);
      } catch (err) {
        this.broadcast({
          type: 'task_done',
          taskId: next.taskId,
          status: 'error',
          message: errText(err),
        });
        continue;
      }
      // 排队任务续接最新的 CC 会话（前序任务 init 时可能刷新过 session id）
      const conv = createConversation(next.dirId, dir.label, next.prompt.slice(0, 60));
      if (latest) updateConversation(conv.convId, { ccSessionId: latest });
      const fresh = getConversation(conv.convId) ?? conv;
      audit('task_dequeue', { taskId: next.taskId, convId: fresh.convId, resumeFrom: latest });
      this.launch(next.prompt, dir, fresh, latest, next.mode, next.taskId);
      return; // 一次只启动一个；它结束时继续 drain
    }
  }

  /** CC 会话是否有运行中/排队中的任务（删除会话前的守卫） */
  isSessionBusy(ccSessionId: string): boolean {
    if (
      this.activeTasks().some(
        (t) => t.ccSessionId === ccSessionId || t.resumeFrom === ccSessionId,
      )
    ) {
      return true;
    }
    const list = this.queues.get(ccSessionId);
    return !!list && list.length > 0;
  }

  interrupt(taskId: string): boolean {
    // 排队中的任务 → 直接取消
    for (const [key, list] of this.queues) {
      const i = list.findIndex((e) => e.taskId === taskId);
      if (i >= 0) {
        list.splice(i, 1);
        if (!list.length) this.queues.delete(key);
        audit('task_cancel_queued', { taskId });
        this.broadcast({
          type: 'task_done',
          taskId,
          status: 'aborted',
          message: '已取消排队',
        });
        return true;
      }
    }
    const t = this.tasks.get(taskId);
    if (!t || t.status !== 'running') return false;
    audit('task_interrupt', { taskId });
    t.abort.abort(); // SDK 收到 abort 后终止 CLI；catch 路径里发 task_done(aborted)
    return true;
  }

  snapshot(): ActiveTaskSnapshot[] {
    const queued: ActiveTaskSnapshot[] = [];
    for (const [key, list] of this.queues) {
      // 队列 key 是内部 convId 还是 CC 会话 id（决定重连后 UI 归属）
      const isConv = !!getConversation(key);
      for (const e of list) {
        queued.push({
          taskId: e.taskId,
          convId: isConv ? key : '',
          ccSessionId: isConv ? undefined : key,
          dirId: e.dirId,
          dirLabel: e.dirLabel,
          prompt: e.prompt,
          status: 'queued',
          startedAt: e.queuedAt,
          events: e.events,
        });
      }
    }
    const cutoff = Date.now() - 30 * 60_000; // 近 30 分钟内结束的也带上，便于重连恢复
    const rest = [...this.tasks.values()]
      .filter((t) => t.status === 'running' || t.startedAt >= cutoff)
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((t) => ({
        taskId: t.taskId,
        convId: t.convId,
        dirId: t.dirId,
        dirLabel: t.dirLabel,
        prompt: t.prompt,
        status: t.status,
        startedAt: t.startedAt,
        ccSessionId: t.ccSessionId,
        events: t.events,
      }));
    return [...queued, ...rest];
  }

  listSessions() {
    return listConversations();
  }

  private activeTasks(): ActiveTask[] {
    return [...this.tasks.values()].filter((t) => t.status === 'running');
  }

  /** 白名单目录移除前的占用检查 */
  isDirBusy(dirId: string): boolean {
    return this.activeTasks().some((t) => t.dirId === dirId);
  }

  /** iCloud 文件中转站接入：附加目录 + 系统提示（未配置时为空对象） */
  private fileDropOptions(): Pick<Options, 'additionalDirectories' | 'systemPrompt'> {
    const root = fileDropRoot(this.cfg);
    if (!root || !this.cfg.fileDrop?.addToAgentScope) return {};
    const inbox = path.join(root, 'inbox');
    const outbox = path.join(root, 'outbox');
    return {
      additionalDirectories: [root],
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append:
          `用户正在通过手机与你远程交互，双方用 iCloud 同步目录交换文件：` +
          `用户从手机发来的文件会出现在 ${inbox}，你可以直接读取；` +
          `当你需要把文件发给用户（例如用户说"发给我/给我看/导出"），` +
          `请把文件复制到 ${outbox}，它会自动同步到用户的手机，然后在回复里告知文件名。`,
      },
    };
  }

  // ---------- 任务执行 ----------

  private async runTask(task: ActiveTask, dir: DirEntry, resumeFrom?: string): Promise<void> {
    const q = query({
      prompt: task.prompt,
      options: {
        cwd: dir.path,
        resume: resumeFrom,
        // auto 档：CC 分类器自动判定安全性，安全操作直接放行，高危仍走 canUseTool 推手机；
        // manual 档：default + 强制 ask 规则，每个敏感操作都推手机
        permissionMode: task.mode === 'auto' ? 'auto' : 'default',
        allowedTools: [...this.cfg.autoAllowTools],
        canUseTool: (toolName, input, opts) =>
          this.broker.request(
            task.taskId,
            toolName,
            input,
            {
              title: opts.title,
              displayName: opts.displayName,
              description: opts.description,
              suggestions: opts.suggestions,
            },
            opts.signal,
          ),
        includePartialMessages: true,
        abortController: task.abort,
        maxTurns: this.cfg.maxTurns,
        // flag 层设置（高于用户/项目 settings.json）：
        // - manual 档：ask 规则强制敏感工具走手机审批（覆盖 CC 的安全命令自动放行）
        // - auto 档：不加 ask 规则，让分类器决定；高危仍会经 canUseTool 推手机
        // - 任何档位都禁止读取工作目录之外的文件
        settings: {
          permissions: {
            ...(task.mode === 'manual' && this.cfg.strictApproval ? { ask: STRICT_ASK_TOOLS } : {}),
            blockReadsOutsideWorkingDirectories: true,
          },
        },
        ...this.fileDropOptions(),
      },
    });

    try {
      for await (const m of q) {
        this.handleMessage(task, m as LooseMessage);
      }
      if (!task.doneEmitted) {
        // 流正常结束却没收到 result —— 通常是被 abort
        this.completeTask(task, task.abort.signal.aborted ? 'aborted' : 'error', {
          message: task.abort.signal.aborted ? '任务已被停止' : '事件流意外结束（未收到 result）',
        });
      }
    } catch (err) {
      if (!task.doneEmitted) {
        const aborted = task.abort.signal.aborted;
        this.completeTask(task, aborted ? 'aborted' : 'error', {
          message: aborted ? '任务已被停止' : errText(err),
        });
      }
    } finally {
      this.broker.cancelTask(task.taskId);
      this.drainQueue(task); // 唤起本会话的下一条排队消息
    }
  }

  private handleMessage(task: ActiveTask, m: LooseMessage): void {
    switch (m.type) {
      case 'system': {
        if (m.subtype === 'init' && typeof m.session_id === 'string' && m.session_id) {
          task.ccSessionId = m.session_id;
          updateConversation(task.convId, { ccSessionId: m.session_id });
          // 捕获可用斜杠命令（过滤终端专属命令），缓存供手机命令面板
          const names = Array.isArray(m.slash_commands) ? (m.slash_commands as string[]) : [];
          const terminal = Array.isArray(m.terminal_slash_commands)
            ? (m.terminal_slash_commands as string[])
            : [];
          rememberCommandsFromInit(names, terminal);
          // CC 技能清单（同样以 /name 调用），供面板「技能」tab
          const skills = Array.isArray(m.skills) ? (m.skills as string[]) : [];
          rememberSkills(skills);
          const hidden = new Set(terminal.map((n) => n.replace(/^\//, '')));
          const commands = names
            .map((n) => n.replace(/^\//, ''))
            .filter((n) => n && !hidden.has(n));
          this.emit(task, {
            type: 'task_init',
            taskId: task.taskId,
            ccSessionId: m.session_id,
            model: typeof m.model === 'string' ? m.model : undefined,
            commands: commands.length ? commands : undefined,
          });
        } else if (m.subtype === 'commands_changed') {
          const list = Array.isArray(m.commands) ? (m.commands as Array<Record<string, unknown>>) : [];
          rememberCommandDetails(
            list
              .map((c) => ({
                name: String(c.name ?? '').replace(/^\//, ''),
                description: typeof c.description === 'string' ? c.description : undefined,
                argumentHint: typeof c.argumentHint === 'string' ? c.argumentHint : undefined,
              }))
              .filter((c) => c.name),
          );
        } else if (m.subtype === 'local_command_output' && typeof m.content === 'string') {
          // 本地斜杠命令的输出，按助手文本渲染
          this.emit(task, {
            type: 'agent_message',
            taskId: task.taskId,
            blocks: [{ type: 'text', text: m.content }],
          });
        }
        break;
      }
      case 'stream_event': {
        const ev = m.event as
          | { type?: string; delta?: { type?: string; text?: string } }
          | undefined;
        if (
          ev?.type === 'content_block_delta' &&
          ev.delta?.type === 'text_delta' &&
          typeof ev.delta.text === 'string' &&
          ev.delta.text
        ) {
          this.emit(task, { type: 'agent_text', taskId: task.taskId, text: ev.delta.text });
        }
        break;
      }
      case 'assistant': {
        const message = m.message as
          | {
              content?: Array<{
                type: string;
                text?: string;
                thinking?: string;
                id?: string;
                name?: string;
                input?: unknown;
              }>;
            }
          | undefined;
        const blocks: AssistantBlock[] = [];
        for (const b of message?.content ?? []) {
          if (b.type === 'text' && typeof b.text === 'string' && b.text) {
            blocks.push({ type: 'text', text: b.text });
          } else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking) {
            blocks.push({ type: 'thinking', thinking: b.thinking });
          } else if (b.type === 'tool_use' && b.id && b.name) {
            blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
          }
        }
        if (blocks.length) {
          this.emit(task, { type: 'agent_message', taskId: task.taskId, blocks });
        }
        break;
      }
      case 'user': {
        const message = m.message as
          | {
              content?: Array<{
                type: string;
                tool_use_id?: string;
                content?: unknown;
                is_error?: boolean;
              }>;
            }
          | undefined;
        for (const b of message?.content ?? []) {
          if (b.type === 'tool_result') {
            this.emit(task, {
              type: 'tool_result',
              taskId: task.taskId,
              toolUseId: b.tool_use_id ?? '',
              text: truncate(stringifyContent(b.content), TOOL_RESULT_MAX),
              isError: b.is_error === true,
            });
          }
        }
        break;
      }
      case 'result': {
        const subtype = typeof m.subtype === 'string' ? m.subtype : '';
        const isError = m.is_error === true || subtype !== 'success';
        const resultText = typeof m.result === 'string' ? m.result : undefined;
        this.completeTask(task, isError ? 'error' : 'done', {
          result: resultText,
          isError,
          numTurns: typeof m.num_turns === 'number' ? m.num_turns : undefined,
          durationMs: typeof m.duration_ms === 'number' ? m.duration_ms : undefined,
          totalCostUsd: typeof m.total_cost_usd === 'number' ? m.total_cost_usd : undefined,
          message: isError && !resultText ? `任务以 ${subtype || 'error'} 结束` : undefined,
        });
        break;
      }
      default:
        break; // 其他信息型消息（status/notification 等）v1 不转发
    }
  }

  private completeTask(
    task: ActiveTask,
    status: Exclude<TaskStatus, 'running'>,
    extra: {
      result?: string;
      isError?: boolean;
      numTurns?: number;
      durationMs?: number;
      totalCostUsd?: number;
      message?: string;
    },
  ): void {
    if (task.doneEmitted) return;
    task.doneEmitted = true;
    task.status = status;
    updateConversation(task.convId, { lastStatus: status, lastTaskAt: Date.now() });
    audit('task_finish', {
      taskId: task.taskId,
      convId: task.convId,
      status,
      numTurns: extra.numTurns,
      durationMs: extra.durationMs,
      message: extra.message,
    });
    this.emit(task, {
      type: 'task_done',
      taskId: task.taskId,
      status,
      result: extra.result,
      isError: extra.isError,
      numTurns: extra.numTurns,
      durationMs: extra.durationMs,
      totalCostUsd: extra.totalCostUsd,
      message: extra.message,
    });
  }

  // ---------- 事件缓冲与广播 ----------

  private buffer(task: ActiveTask | undefined, e: ServerEvent): void {
    if (!task) return;
    task.events.push(e);
    if (task.events.length > this.cfg.eventBufferCap) {
      task.events.splice(0, task.events.length - this.cfg.eventBufferCap);
    }
  }

  private emit(task: ActiveTask, e: ServerEvent): void {
    this.buffer(task, e);
    this.broadcast(e);
  }

  private pruneFinished(): void {
    const finished = [...this.tasks.values()]
      .filter((t) => t.status !== 'running')
      .sort((a, b) => a.startedAt - b.startedAt);
    const excess = finished.length - KEEP_FINISHED;
    for (let i = 0; i < excess; i++) this.tasks.delete(finished[i]!.taskId);
  }
}

// ---------- 小工具 ----------

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

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
