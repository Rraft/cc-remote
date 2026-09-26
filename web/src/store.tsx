import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, type PublicConfig } from './lib/api';
import type {
  PendingApprovalInfo,
  PermissionModeChoice,
  ServerEvent,
  SessionRecord,
  TaskStatus,
} from './lib/protocol';
import { wsClient, type WsState } from './lib/ws-client';

export type TaskMeta = {
  taskId: string;
  convId: string;
  dirId: string;
  dirLabel: string;
  prompt: string;
  status: TaskStatus;
  startedAt: number;
  /** task_init 后填入：该任务实际运行在哪个 CC 会话上 */
  ccSessionId?: string;
};

type State = {
  wsState: WsState;
  config: PublicConfig | null;
  sessions: SessionRecord[];
  taskMeta: Record<string, TaskMeta>;
  taskOrder: Record<string, string[]>; // convId -> taskId[]
  events: Record<string, ServerEvent[]>; // taskId -> 事件流
  pending: Record<string, PendingApprovalInfo>; // requestId -> 未决审批
  lastError: string | null;
  /** 全局轻通知（琥珀色），如"移除失败原因"、"已自动固定目录" */
  notice: string | null;
};

type Action =
  | { type: 'ws_state'; state: WsState }
  | { type: 'event'; e: ServerEvent }
  | { type: 'set_config'; config: PublicConfig }
  | { type: 'set_sessions'; sessions: SessionRecord[] }
  | { type: 'clear_error' }
  | { type: 'notice'; msg: string }
  | { type: 'clear_notice' };

const initial: State = {
  wsState: 'closed',
  config: null,
  sessions: [],
  taskMeta: {},
  taskOrder: {},
  events: {},
  pending: {},
  lastError: null,
  notice: null,
};

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'ws_state':
      return { ...s, wsState: a.state };
    case 'set_config':
      return { ...s, config: a.config };
    case 'set_sessions':
      return { ...s, sessions: a.sessions };
    case 'clear_error':
      return { ...s, lastError: null };
    case 'notice':
      return { ...s, notice: a.msg };
    case 'clear_notice':
      return { ...s, notice: null };
    case 'event':
      return applyEvent(s, a.e);
  }
}

function applyEvent(s: State, e: ServerEvent): State {
  switch (e.type) {
    case 'snapshot': {
      const next: State = {
        ...s,
        taskMeta: { ...s.taskMeta },
        taskOrder: { ...s.taskOrder },
        events: { ...s.events },
        pending: {},
      };
      for (const p of e.pendingApprovals) next.pending[p.requestId] = p;
      for (const t of e.activeTasks) {
        const meta: TaskMeta = {
          taskId: t.taskId,
          convId: t.convId,
          dirId: t.dirId,
          dirLabel: t.dirLabel,
          prompt: t.prompt,
          status: t.status,
          startedAt: t.startedAt,
          ccSessionId: t.ccSessionId,
        };
        next.taskMeta[t.taskId] = meta;
        next.events[t.taskId] = [...t.events];
        const order = next.taskOrder[t.convId] ?? [];
        if (!order.includes(t.taskId)) {
          next.taskOrder = { ...next.taskOrder, [t.convId]: [...order, t.taskId] };
        }
        // 事件缓冲里可能带 task_done（重连时任务已结束）——同步状态
        for (const ev of t.events) {
          if (ev.type === 'task_done') meta.status = ev.status;
        }
      }
      return next;
    }
    case 'task_queued': {
      // 排队消息：先建 meta（status=queued），出队执行时 task_started 会覆盖
      const meta: TaskMeta = {
        taskId: e.taskId,
        convId: '',
        dirId: e.dirId,
        dirLabel: e.dirLabel,
        prompt: e.prompt,
        status: 'queued',
        startedAt: e.at,
      };
      return {
        ...s,
        taskMeta: { ...s.taskMeta, [e.taskId]: meta },
        events: { ...s.events, [e.taskId]: [...(s.events[e.taskId] ?? []), e] },
      };
    }
    case 'task_started': {
      const prevMeta = s.taskMeta[e.taskId];
      const meta: TaskMeta = {
        taskId: e.taskId,
        convId: e.convId,
        dirId: e.dirId,
        dirLabel: e.dirLabel,
        prompt: e.prompt,
        status: 'running',
        startedAt: prevMeta?.startedAt ?? e.at,
        ccSessionId: prevMeta?.ccSessionId,
      };
      const order = s.taskOrder[e.convId] ?? [];
      return {
        ...s,
        taskMeta: { ...s.taskMeta, [e.taskId]: meta },
        taskOrder: {
          ...s.taskOrder,
          [e.convId]: order.includes(e.taskId) ? order : [...order, e.taskId],
        },
        events: { ...s.events, [e.taskId]: [...(s.events[e.taskId] ?? []), e] },
      };
    }
    case 'tool_request': {
      const p: PendingApprovalInfo = {
        requestId: e.requestId,
        taskId: e.taskId,
        toolName: e.toolName,
        input: e.input,
        title: e.title,
        displayName: e.displayName,
        description: e.description,
        canAlwaysAllow: e.canAlwaysAllow,
        expiresAt: e.expiresAt,
      };
      return withEvent({ ...s, pending: { ...s.pending, [e.requestId]: p } }, e);
    }
    case 'tool_resolved': {
      const pending = { ...s.pending };
      delete pending[e.requestId];
      return withEvent({ ...s, pending }, e);
    }
    case 'task_done': {
      const meta = s.taskMeta[e.taskId];
      return withEvent(
        {
          ...s,
          taskMeta: meta ? { ...s.taskMeta, [e.taskId]: { ...meta, status: e.status } } : s.taskMeta,
        },
        e,
      );
    }
    case 'task_init': {
      const meta = s.taskMeta[e.taskId];
      return withEvent(
        {
          ...s,
          taskMeta: meta
            ? { ...s.taskMeta, [e.taskId]: { ...meta, ccSessionId: e.ccSessionId } }
            : s.taskMeta,
        },
        e,
      );
    }
    case 'sessions':
      return { ...s, sessions: e.sessions };
    case 'error':
      return { ...s, lastError: e.message };
    default:
      return withEvent(s, e);
  }
}

function withEvent(s: State, e: ServerEvent): State {
  const taskId = (e as { taskId?: string }).taskId;
  if (!taskId) return s;
  return { ...s, events: { ...s.events, [taskId]: [...(s.events[taskId] ?? []), e] } };
}

// ---------- Context ----------

type CreateResult = { taskId: string; convId: string };
type LoginResult = { ok: true } | { ok: false; error: string; retryAfterMs?: number };

type Store = State & {
  booted: boolean;
  authed: boolean;
  login: (password: string) => Promise<LoginResult>;
  logout: () => Promise<void>;
  createTask: (
    prompt: string,
    dirId: string,
    convId?: string,
    ccSessionId?: string,
    mode?: PermissionModeChoice,
  ) => Promise<CreateResult>;
  approve: (requestId: string, allow: boolean, alwaysAllow?: boolean) => void;
  interrupt: (taskId: string) => void;
  refreshSessions: () => Promise<void>;
  refreshConfig: () => Promise<void>;
  clearError: () => void;
  notify: (msg: string) => void;
  clearNotice: () => void;
  runningTasks: TaskMeta[];
};

const StoreContext = createContext<Store | null>(null);

type Waiter = {
  prompt: string;
  resolve: (r: CreateResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);
  const [booted, setBooted] = useState(false);
  const [authed, setAuthed] = useState(false);
  const waiters = useRef<Waiter[]>([]);

  const refreshSessions = useCallback(async () => {
    const r = await api.sessions();
    if (r.body) dispatch({ type: 'set_sessions', sessions: r.body.sessions });
  }, []);

  const refreshConfig = useCallback(async () => {
    const r = await api.config();
    if (r.body) dispatch({ type: 'set_config', config: r.body });
  }, []);

  const afterLogin = useCallback(async () => {
    const [cfg, sess] = await Promise.all([api.config(), api.sessions()]);
    if (cfg.body) dispatch({ type: 'set_config', config: cfg.body });
    if (sess.body) dispatch({ type: 'set_sessions', sessions: sess.body.sessions });
    setAuthed(true);
    wsClient.connect();
  }, []);

  // 启动引导
  useEffect(() => {
    void (async () => {
      try {
        const me = await api.me();
        if (me.body?.authenticated) await afterLogin();
      } catch {
        /* 服务不可达：停在登录页 */
      }
      setBooted(true);
    })();
  }, [afterLogin]);

  // WS 订阅
  useEffect(() => {
    const offMsg = wsClient.onMessage((e) => {
      dispatch({ type: 'event', e });
      // createTask 的等待者在 task_started（立即执行）或 task_queued（排队）时都算送达
      if (e.type === 'task_started' || e.type === 'task_queued') {
        const i = waiters.current.findIndex((w) => w.prompt === e.prompt);
        if (i >= 0) {
          const [w] = waiters.current.splice(i, 1);
          clearTimeout(w!.timer);
          w!.resolve({
            taskId: e.taskId,
            convId: e.type === 'task_started' ? e.convId : '',
          });
        }
      }
      if (e.type === 'task_done') void refreshSessions();
      if (e.type === 'error') {
        for (const w of waiters.current.splice(0)) {
          clearTimeout(w.timer);
          w.reject(new Error(e.message));
        }
      }
    });
    const offState = wsClient.onState((s) => dispatch({ type: 'ws_state', state: s }));
    return () => {
      offMsg();
      offState();
    };
  }, [refreshSessions]);

  const login = useCallback(
    async (password: string): Promise<LoginResult> => {
      const r = await api.login(password);
      if (r.status === 200 && r.body?.ok) {
        await afterLogin();
        return { ok: true };
      }
      return {
        ok: false,
        error: r.body?.error ?? (r.status === 0 ? '无法连接服务器' : '登录失败'),
        retryAfterMs: r.body?.retryAfterMs,
      };
    },
    [afterLogin],
  );

  const logout = useCallback(async () => {
    wsClient.disconnect();
    try {
      await api.logout();
    } catch {
      /* 忽略 */
    }
    setAuthed(false);
  }, []);

  const createTask = useCallback(
    (
      prompt: string,
      dirId: string,
      convId?: string,
      ccSessionId?: string,
      mode?: PermissionModeChoice,
    ): Promise<CreateResult> => {
      return new Promise<CreateResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.current = waiters.current.filter((w) => w.timer !== timer);
          reject(new Error('未收到 task_started（15s 超时）'));
        }, 15_000);
        waiters.current.push({ prompt: prompt.trim(), resolve, reject, timer });
        const sent = wsClient.send({ type: 'create_task', prompt, dirId, convId, ccSessionId, mode });
        if (!sent) {
          clearTimeout(timer);
          waiters.current = waiters.current.filter((w) => w.timer !== timer);
          reject(new Error('WebSocket 未连接'));
        }
      });
    },
    [],
  );

  const approve = useCallback((requestId: string, allow: boolean, alwaysAllow = false) => {
    wsClient.send({ type: 'approval', requestId, allow, alwaysAllow });
  }, []);

  const interrupt = useCallback((taskId: string) => {
    wsClient.send({ type: 'interrupt', taskId });
  }, []);

  const clearError = useCallback(() => dispatch({ type: 'clear_error' }), []);

  const notify = useCallback((msg: string) => dispatch({ type: 'notice', msg }), []);
  const clearNotice = useCallback(() => dispatch({ type: 'clear_notice' }), []);

  const runningTasks = Object.values(state.taskMeta).filter((t) => t.status === 'running');

  const store: Store = {
    ...state,
    booted,
    authed,
    login,
    logout,
    createTask,
    approve,
    interrupt,
    refreshSessions,
    refreshConfig,
    clearError,
    notify,
    clearNotice,
    runningTasks,
  };
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const s = useContext(StoreContext);
  if (!s) throw new Error('useStore 必须在 StoreProvider 内使用');
  return s;
}
