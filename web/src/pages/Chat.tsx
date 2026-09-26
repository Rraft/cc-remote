import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { ApprovalCard, Markdown, StatusDot, ToolCard } from '../components';
import CommandPalette from '../components/CommandPalette';
import ModeToggle from '../components/ModeToggle';
import { buildItems, type Item } from '../lib/derive';
import { fmtCost, fmtDuration } from '../lib/format';
import type { PermissionModeChoice, ServerEvent, TaskStatus } from '../lib/protocol';
import { loadPermMode, savePermMode } from '../lib/prefs';
import { useStore } from '../store';

/**
 * 聊天视图 = CC 转录回放（历史）+ 实时任务事件流（现在）。
 * 会话身份以 CC 的 session_id 为准：追问一律 resume 最新 ccSessionId，
 * 新会话在收到 task_init 后自动获得真实 session_id。
 * 历史分页：首屏最近一页立即渲染；后台静默补全 + 上滑到顶按需加载（带动画）。
 */
export type ChatSessionKey = {
  /** CC session_id（从历史列表进入） */
  sessionId?: string;
  /** 内部任务组 id（新任务/运行中任务入口，task_init 后能拿到真实 sessionId） */
  convId?: string;
  title?: string;
  cwd?: string;
  dirId?: string;
};

/** 去掉转录与实时事件的重叠：转录里已包含正在运行任务的开头时，从那里截断 */
function trimOverlap(transcript: ServerEvent[], livePrompts: string[]): ServerEvent[] {
  if (!livePrompts.length) return transcript;
  const set = new Set(livePrompts.map((p) => p.trim()));
  for (let i = 0; i < transcript.length; i++) {
    const e = transcript[i];
    if (e.type === 'task_started' && set.has(e.prompt.trim())) return transcript.slice(0, i);
  }
  return transcript;
}

export default function Chat({ session, onBack }: { session: ChatSessionKey; onBack: () => void }) {
  const store = useStore();
  const { taskMeta, events, config, createTask, interrupt, refreshConfig, notify } = store;

  const [launchedIds, setLaunchedIds] = useState<string[]>([]);
  const [transcript, setTranscript] = useState<ServerEvent[] | null>(
    session.sessionId ? null : [],
  );
  const [tErr, setTErr] = useState<string | null>(null);
  const [tTitle, setTTitle] = useState<string | undefined>(session.title);
  const [tCwd, setTCwd] = useState<string | undefined>(session.cwd);
  // 权限档位（追问任务用），全局记忆上次选择
  const [mode, setMode] = useState<PermissionModeChoice>(() => loadPermMode());
  function changeMode(m: PermissionModeChoice) {
    setMode(m);
    savePermMode(m);
  }

  // 分页游标（before = 全量事件下标）、prepend 滚动补偿、后台加载状态
  const pageRef = useRef({ from: 0, hasMore: false });
  const pendingScrollAdjust = useRef(0);
  const bgBusy = useRef(false);
  const [bgLoading, setBgLoading] = useState(false);
  const [histHasMore, setHistHasMore] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);

  /** 向更早方向加载一页（后台循环与上滑到顶共用；返回是否还有更早） */
  const fetchOlder = useCallback(async (): Promise<boolean> => {
    const sid = session.sessionId;
    if (!sid || bgBusy.current || !pageRef.current.hasMore) return false;
    bgBusy.current = true;
    setBgLoading(true);
    try {
      const p = await api.ccTranscript(sid, { limit: 400, before: pageRef.current.from });
      if (!p.body?.events) {
        pageRef.current.hasMore = false;
        setHistHasMore(false);
        return false;
      }
      pageRef.current = { from: p.body.from, hasMore: p.body.hasMore };
      setHistHasMore(p.body.hasMore);
      const el = scrollRef.current;
      pendingScrollAdjust.current = el ? el.scrollHeight - el.scrollTop : 0;
      const older = p.body.events;
      setTranscript((prev) => (prev ? [...older, ...prev] : older));
      return p.body.hasMore;
    } finally {
      bgBusy.current = false;
      setBgLoading(false);
    }
  }, [session.sessionId]);

  // 加载 CC 转录：首屏只取最近一页立即渲染，随后后台静默逐页补全
  useEffect(() => {
    if (!session.sessionId) {
      setTranscript([]);
      setHistHasMore(false);
      return;
    }
    const sid = session.sessionId;
    let cancelled = false;
    void (async () => {
      try {
        const first = await api.ccTranscript(sid, { limit: 100 });
        if (cancelled) return;
        if (!first.body?.events) {
          setTErr(first.body?.error ?? `历史记录加载失败（HTTP ${first.status}）`);
          setTranscript([]);
          setHistHasMore(false);
          return;
        }
        pageRef.current = { from: first.body.from, hasMore: first.body.hasMore };
        setHistHasMore(first.body.hasMore);
        setTranscript(first.body.events);
        setTErr(null);
        if (first.body.title) setTTitle(first.body.title);
        if (first.body.cwd) setTCwd(first.body.cwd);
        // 隐形全量加载：逐页补全，用户上滑时即秒开
        while (pageRef.current.hasMore && !cancelled) {
          const more = await fetchOlder();
          if (!more) break;
        }
      } catch (ex) {
        if (!cancelled) {
          setTErr(ex instanceof Error ? ex.message : String(ex));
          setTranscript((t) => t ?? []);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session.sessionId, fetchOlder]);

  // 属于本视图的任务：实时元数据匹配（convId / ccSessionId）+ 本视图发起的
  const myTaskIds = useMemo(() => {
    const ids: string[] = [];
    const push = (id: string) => {
      if (!ids.includes(id)) ids.push(id);
    };
    for (const m of Object.values(taskMeta)) {
      if (
        (session.convId && m.convId === session.convId) ||
        (session.sessionId && m.ccSessionId === session.sessionId)
      ) {
        push(m.taskId);
      }
    }
    for (const id of launchedIds) push(id);
    ids.sort((a, b) => (taskMeta[a]?.startedAt ?? 0) - (taskMeta[b]?.startedAt ?? 0));
    return ids;
  }, [taskMeta, launchedIds, session.convId, session.sessionId]);

  // 最新 CC 会话 id：resume 后以最近一次 task_init 为准
  const liveCount = myTaskIds.reduce((n, id) => n + (events[id]?.length ?? 0), 0);
  const liveCcId = useMemo(() => {
    let id = session.sessionId;
    for (const tid of myTaskIds) {
      for (const ev of events[tid] ?? []) {
        if (ev.type === 'task_init') id = ev.ccSessionId;
      }
    }
    return id;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myTaskIds, liveCount, session.sessionId]);

  const dirs = config?.directories ?? [];
  const matchedDir = useMemo(() => {
    if (session.dirId) return dirs.find((d) => d.id === session.dirId);
    if (tCwd) return dirs.find((d) => d.path.toLowerCase() === tCwd.toLowerCase());
    for (const tid of myTaskIds) {
      const m = taskMeta[tid];
      if (m) return dirs.find((d) => d.id === m.dirId);
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirs, tCwd, session.dirId, myTaskIds.length]);

  const runningTask = myTaskIds.map((id) => taskMeta[id]).find((m) => m?.status === 'running');
  const title =
    tTitle ?? (myTaskIds.length ? taskMeta[myTaskIds[0]]?.prompt : undefined) ?? '新会话';
  const dirLabel = matchedDir?.label ?? (tCwd ? tCwd.split(/[\\/]/).pop() : '');

  // 历史条目（去除与实时任务的重叠）
  const historyItems = useMemo(() => {
    if (!transcript) return null;
    const livePrompts = myTaskIds
      .map((id) => taskMeta[id]?.prompt)
      .filter((p): p is string => !!p);
    return buildItems(trimOverlap(transcript, livePrompts));
  }, [transcript, myTaskIds, taskMeta]);

  // 渲染窗口化：长会话只渲染最近 INITIAL_ITEMS 条，向上按需扩展（手机端流畅度关键）
  const INITIAL_ITEMS = 120;
  const [itemLimit, setItemLimit] = useState(INITIAL_ITEMS);
  useEffect(() => {
    setItemLimit(INITIAL_ITEMS);
  }, [session.sessionId]);
  const hiddenCount = historyItems ? Math.max(0, historyItems.length - itemLimit) : 0;

  const tCount = transcript?.length ?? 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (el && nearBottom.current) el.scrollTop = el.scrollHeight;
  }, [tCount, liveCount]);

  // 向头部 prepend 历史后补偿 scrollTop，保持用户当前视口不跳动
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pendingScrollAdjust.current) {
      el.scrollTop = el.scrollHeight - pendingScrollAdjust.current;
      pendingScrollAdjust.current = 0;
    }
  }, [transcript]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    // 上滑到顶且还有更早历史 → 立即补一页（后台循环空闲时）
    if (el.scrollTop < 80 && pageRef.current.hasMore && !bgBusy.current) {
      void fetchOlder();
    }
  }

  async function sendFollowUp(p: string): Promise<void> {
    let dirId = matchedDir?.id;
    // 目录未固定时自动固定（用户点发送即视为同意），并明确告知——避免"删掉的目录悄悄复活"的困惑
    if (!dirId && tCwd) {
      const add = await api.addDir(tCwd);
      await refreshConfig();
      if (add.body?.ok) {
        dirId = add.body.dir.id;
        if (!add.body.existed) {
          notify(`已自动将「${add.body.dir.label}」加入工作目录白名单（续接该会话需要）`);
        }
      } else {
        throw new Error(add.body?.error ?? '无法固定该会话的工作目录');
      }
    }
    if (!dirId) throw new Error('无法确定工作目录（该会话缺少目录信息）');
    const r = await createTask(p, dirId, undefined, liveCcId, mode);
    setLaunchedIds((prev) => [...prev, r.taskId]);
  }

  return (
    <div className="h-full flex flex-col">
      <header className="flex items-center gap-2 px-3 py-2.5 border-b border-zinc-800/70">
        <button onClick={onBack} className="text-zinc-400 px-1.5 py-1 text-lg leading-none">
          ‹
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <StatusDot status={runningTask ? 'running' : 'done'} />
            <span className="truncate text-sm font-semibold">{title}</span>
          </div>
          {dirLabel && <div className="text-[11px] text-zinc-500 truncate">{dirLabel}</div>}
        </div>
        {runningTask && (
          <button
            onClick={() => interrupt(runningTask.taskId)}
            className="rounded-lg border border-red-900 bg-red-950/60 px-3 py-1.5 text-xs font-semibold text-red-300 active:bg-red-900"
          >
            ■ 停止
          </button>
        )}
      </header>

      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-3 py-3">
        {/* 上滑翻页加载动画 */}
        {bgLoading && (
          <div className="py-2 flex items-center justify-center gap-2 text-xs text-zinc-500">
            <span className="inline-block w-3.5 h-3.5 border-2 border-zinc-700 border-t-emerald-400 rounded-full animate-spin" />
            正在加载更早的记录…
          </div>
        )}
        {!bgLoading && histHasMore && transcript !== null && (
          <button
            onClick={() => void fetchOlder()}
            className="w-full py-2 text-center text-xs text-zinc-600"
          >
            ↑ 加载更早的记录
          </button>
        )}
        {tErr && <div className="my-2 text-center text-xs text-red-400">{tErr}</div>}
        {historyItems === null && (
          <div className="py-10 text-center text-sm text-zinc-600 animate-pulse">加载历史…</div>
        )}
        {hiddenCount > 0 && (
          <button
            onClick={() => setItemLimit((l) => l + 300)}
            className="w-full my-2 py-2 text-center text-xs text-zinc-400 border border-zinc-800 rounded-lg active:bg-zinc-900"
          >
            ↑ 显示更早的消息（还有 {hiddenCount} 条）
          </button>
        )}
        {historyItems
          ?.slice(hiddenCount)
          .map((item, i) => <ItemView key={`h${hiddenCount + i}`} item={item} />)}
        {myTaskIds.map((tid) => (
          <TaskView key={tid} taskId={tid} />
        ))}
        {historyItems?.length === 0 && myTaskIds.length === 0 && (
          <div className="py-16 text-center text-sm text-zinc-600">发送第一条指令开始</div>
        )}
      </div>

      <FollowUpBar
        disabled={!matchedDir && !tCwd}
        hint={runningTask ? '任务执行中，新消息将排队自动执行' : undefined}
        mode={mode}
        onModeChange={changeMode}
        onSend={sendFollowUp}
      />
    </div>
  );
}

function TaskView({ taskId }: { taskId: string }) {
  const store = useStore();
  const evs = store.events[taskId] ?? [];
  const items = useMemo(() => buildItems(evs), [evs]);
  const meta = store.taskMeta[taskId];
  return (
    <div className="mb-4">
      {items.map((item, i) => (
        <ItemView key={i} item={item} />
      ))}
      {meta?.status === 'queued' && (
        <button
          onClick={() => store.interrupt(taskId)}
          className="my-1.5 w-full rounded-lg border border-amber-900/60 bg-amber-950/30 px-3 py-1.5 text-center text-[11px] text-amber-300"
        >
          ⏳ 已排队，当前任务结束后自动执行 · 点击取消
        </button>
      )}
    </div>
  );
}

function ItemView({ item }: { item: Item }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="flex justify-end my-2">
          <div className="max-w-[85%] rounded-2xl rounded-br-md bg-emerald-700/90 px-3.5 py-2.5 text-sm whitespace-pre-wrap break-words">
            {item.text}
          </div>
        </div>
      );
    case 'text':
      return (
        <div className="my-2 max-w-full">
          <div className="rounded-2xl rounded-bl-md bg-zinc-900 border border-zinc-800/70 px-3.5 py-2.5">
            <Markdown text={item.text} />
            {!item.final && (
              <span className="inline-block w-1.5 h-4 ml-0.5 bg-emerald-400 animate-pulse align-text-bottom" />
            )}
          </div>
        </div>
      );
    case 'thinking':
      return (
        <details className="my-1.5 rounded-xl border border-zinc-800/60 bg-zinc-900/30 px-3 py-1.5 text-xs text-zinc-500">
          <summary className="cursor-pointer select-none">💭 思考过程</summary>
          <div className="mt-1.5 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
            {item.text}
          </div>
        </details>
      );
    case 'tool':
      return <ToolCard item={item} />;
    case 'approval':
      return <ApprovalCard item={item} />;
    case 'done':
      return <DoneChip item={item} />;
  }
}

function DoneChip({ item }: { item: Extract<Item, { kind: 'done' }> }) {
  const color: Record<TaskStatus, string> = {
    done: item.isError ? 'text-red-400 border-red-900/60' : 'text-zinc-500 border-zinc-800',
    error: 'text-red-400 border-red-900/60',
    aborted: 'text-amber-400 border-amber-900/60',
    running: 'text-emerald-400 border-emerald-900/60',
    queued: 'text-amber-400 border-amber-900/60',
  };
  const label: Record<TaskStatus, string> = {
    done: item.isError ? '完成（有错误）' : '任务完成',
    error: '任务失败',
    aborted: '已停止',
    running: '运行中',
    queued: '排队中',
  };
  const parts = [
    label[item.status],
    item.numTurns != null ? `${item.numTurns} 轮` : '',
    fmtDuration(item.durationMs),
    fmtCost(item.totalCostUsd),
    item.message ?? '',
  ].filter(Boolean);
  return (
    <div
      className={`my-2 rounded-lg border px-3 py-1.5 text-center text-[11px] ${color[item.status]}`}
    >
      {parts.join(' · ')}
    </div>
  );
}

function FollowUpBar({
  disabled,
  hint,
  mode,
  onModeChange,
  onSend,
}: {
  disabled: boolean;
  hint?: string;
  mode: PermissionModeChoice;
  onModeChange: (m: PermissionModeChoice) => void;
  onSend: (prompt: string) => Promise<void>;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const busyRef = useRef(false);
  // 斜杠命令面板：手动按钮打开，或输入 "/xxx" 单 token 时自动弹出过滤
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [suppressPalette, setSuppressPalette] = useState(false);
  const slashMatch = /^\/(\S*)$/.exec(text);
  const showPalette = !suppressPalette && (paletteOpen || !!slashMatch);
  const paletteQuery = slashMatch ? slashMatch[1] : '';

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const p = text.trim();
    if (!p || disabled || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setErr(null);
    try {
      await onSend(p);
      setText('');
      setPaletteOpen(false);
      setSuppressPalette(false);
      if (taRef.current) taRef.current.style.height = 'auto';
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function autoSize() {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
  }

  return (
    <form
      onSubmit={onSubmit}
      className="relative border-t border-zinc-800/70 bg-zinc-950/95 px-3 py-2 safe-bottom"
    >
      {showPalette && (
        <CommandPalette
          query={paletteQuery}
          onPick={(t) => {
            setText(t);
            setPaletteOpen(false);
            setSuppressPalette(true); // 选中无参命令后不立即重开面板
            taRef.current?.focus();
          }}
          onClose={() => {
            setPaletteOpen(false);
            setSuppressPalette(true);
          }}
        />
      )}
      {err && <div className="pb-1 text-center text-[11px] text-red-400">{err}</div>}
      <div className="flex items-center justify-between gap-2 pb-1">
        <span className="text-[11px] text-zinc-600 truncate">{hint ?? ''}</span>
        <ModeToggle value={mode} onChange={onModeChange} />
      </div>
      <div className="flex items-end gap-2">
        <button
          type="button"
          onClick={() => {
            setSuppressPalette(false);
            setPaletteOpen((v) => !v);
            taRef.current?.focus();
          }}
          className={`rounded-full border w-11 h-11 shrink-0 text-base font-mono ${
            showPalette
              ? 'border-emerald-600 bg-emerald-950/60 text-emerald-300'
              : 'border-zinc-700 bg-zinc-900 text-zinc-400'
          }`}
          aria-label="斜杠指令"
        >
          /
        </button>
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setSuppressPalette(false);
            autoSize();
          }}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') void onSubmit(e);
          }}
          placeholder={disabled ? '无法确定工作目录' : '继续追问或发新指令，/ 唤起命令…'}
          rows={1}
          disabled={disabled}
          className="flex-1 rounded-2xl border border-zinc-700 bg-zinc-900 px-3.5 py-2.5 text-sm outline-none focus:border-emerald-600 resize-none disabled:opacity-50 max-h-[140px]"
        />
        <button
          type="submit"
          disabled={disabled || busy || !text.trim()}
          className="rounded-full bg-emerald-600 w-11 h-11 shrink-0 text-lg active:bg-emerald-500 disabled:opacity-40"
          aria-label="发送"
        >
          ↑
        </button>
      </div>
    </form>
  );
}
