import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api, type CcSession } from '../lib/api';
import { relTime } from '../lib/format';
import { StatusDot } from '../components';
import ModeToggle from '../components/ModeToggle';
import DirBrowser from './DirBrowser';
import type { ChatSessionKey } from './Chat';
import type { PermissionModeChoice } from '../lib/protocol';
import { loadPermMode, savePermMode } from '../lib/prefs';
import { useStore } from '../store';

/**
 * 统一会话列表：直接展示 CC 原生会话（~/.claude/projects 的转录），
 * 不区分"远程创建"与"PC 终端本地跑的"——保存历史的逻辑完全交给 CC。
 */
export default function Sessions({ onOpen }: { onOpen: (s: ChatSessionKey) => void }) {
  const store = useStore();
  const { runningTasks, logout, config } = store;
  const pinned = config?.directories ?? [];
  const [sheetOpen, setSheetOpen] = useState(false);
  const [dirOpen, setDirOpen] = useState(false);
  const [dirFilter, setDirFilter] = useState('');
  const [sessions, setSessions] = useState<CcSession[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // 会话操作（重命名/删除）
  const [actionFor, setActionFor] = useState<CcSession | null>(null);
  const [renameFor, setRenameFor] = useState<CcSession | null>(null);
  const [deleteFor, setDeleteFor] = useState<CcSession | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    const r = await api.ccSessions(dirFilter ? { dirId: dirFilter, limit: 50 } : { limit: 50 });
    setLoading(false);
    if (r.body?.sessions) setSessions(r.body.sessions);
    else setErr(r.body?.error ?? '加载会话失败');
  }, [dirFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="h-full flex flex-col">
      <header className="flex items-center justify-between px-4 py-3 border-b border-zinc-800/70">
        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full ${store.wsState === 'open' ? 'bg-emerald-400' : 'bg-amber-400'}`}
          />
          <h1 className="font-bold">CC Remote</h1>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => void load()} className="text-xs text-zinc-500 px-1.5">
            刷新
          </button>
          <button
            onClick={() => setDirOpen(true)}
            className="rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 active:bg-zinc-800"
          >
            目录
          </button>
          <button
            onClick={() => setSheetOpen(true)}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold active:bg-emerald-500"
          >
            ＋ 新任务
          </button>
          <button onClick={() => void logout()} className="text-xs text-zinc-500 px-1">
            退出
          </button>
        </div>
      </header>

      {dirOpen && <DirBrowser onClose={() => setDirOpen(false)} />}

      {/* 目录过滤 */}
      <div className="flex gap-1.5 px-3 py-2 overflow-x-auto border-b border-zinc-800/60">
        <Chip active={dirFilter === ''} onClick={() => setDirFilter('')} label="全部项目" />
        {pinned.map((d) => (
          <Chip key={d.id} active={dirFilter === d.id} onClick={() => setDirFilter(d.id)} label={d.label} />
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        {runningTasks.length > 0 && (
          <section>
            <h2 className="text-xs text-zinc-500 mb-1.5">运行中</h2>
            {runningTasks.map((t) => (
              <button
                key={t.taskId}
                onClick={() => onOpen({ convId: t.convId, title: t.prompt, dirId: t.dirId })}
                className="w-full mb-1.5 rounded-xl border border-emerald-900/60 bg-emerald-950/20 px-3 py-2.5 text-left"
              >
                <div className="flex items-center gap-2 text-sm">
                  <StatusDot status="running" />
                  <span className="flex-1 truncate">{t.prompt}</span>
                </div>
                <div className="text-xs text-zinc-500 mt-0.5">{t.dirLabel}</div>
              </button>
            ))}
          </section>
        )}

        <section>
          <h2 className="text-xs text-zinc-500 mb-1.5">会话</h2>
          {err && <div className="p-4 text-center text-sm text-red-400">{err}</div>}
          {loading && !sessions && (
            <div className="p-8 text-center text-sm text-zinc-600">加载中…</div>
          )}
          {sessions?.length === 0 && !loading && (
            <div className="text-center text-sm text-zinc-600 py-12">
              还没有会话
              <br />
              在 PC 终端跑过 claude、或点「新任务」，都会出现在这里
            </div>
          )}
          {sessions?.map((s) => (
            <div
              key={s.sessionId}
              onClick={() => onOpen({ sessionId: s.sessionId, title: s.title, cwd: s.cwd })}
              className="w-full mb-1.5 rounded-xl border border-zinc-800 bg-zinc-900/50 px-3 py-2.5 text-left active:bg-zinc-800/60 cursor-pointer"
            >
              <div className="flex items-center gap-2">
                <span className="flex-1 min-w-0 truncate text-sm">{s.title}</span>
                <span className="text-xs text-zinc-600 shrink-0">{relTime(s.lastModified)}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setActionFor(s);
                  }}
                  className="shrink-0 text-zinc-500 px-1.5 text-base leading-none"
                  aria-label="会话操作"
                >
                  ⋯
                </button>
              </div>
              <div className="flex items-center gap-2 mt-1 text-[11px] text-zinc-500">
                {s.gitBranch && <span className="rounded bg-zinc-800 px-1.5 py-0.5">⎇ {s.gitBranch}</span>}
                {s.sizeKb != null && <span>{s.sizeKb} KB</span>}
                {s.cwd && <span className="truncate font-mono">{s.cwd}</span>}
              </div>
            </div>
          ))}
        </section>
      </div>

      {sheetOpen && (
        <NewTaskSheet
          onClose={() => setSheetOpen(false)}
          onOpen={onOpen}
          onBrowseDirs={() => setDirOpen(true)}
        />
      )}

      {actionFor && (
        <Sheet onClose={() => setActionFor(null)}>
          <div className="text-xs text-zinc-500 truncate mb-3">{actionFor.title}</div>
          <button
            onClick={() => {
              setRenameFor(actionFor);
              setActionFor(null);
            }}
            className="w-full rounded-xl border border-zinc-700 py-3 text-sm mb-2 active:bg-zinc-800"
          >
            ✏️ 重命名
          </button>
          <button
            onClick={() => {
              setDeleteFor(actionFor);
              setActionFor(null);
            }}
            className="w-full rounded-xl border border-red-900 bg-red-950/40 text-red-300 py-3 text-sm mb-2 active:bg-red-950"
          >
            🗑 删除会话
          </button>
          <button
            onClick={() => setActionFor(null)}
            className="w-full rounded-xl bg-zinc-800 py-3 text-sm text-zinc-300"
          >
            取消
          </button>
        </Sheet>
      )}

      {renameFor && (
        <RenameSheet
          session={renameFor}
          onClose={() => setRenameFor(null)}
          onDone={() => {
            setRenameFor(null);
            void load();
          }}
        />
      )}

      {deleteFor && (
        <DeleteSheet
          session={deleteFor}
          onClose={() => setDeleteFor(null)}
          onDone={() => {
            setDeleteFor(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function Sheet({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div className="absolute inset-0 z-40 flex flex-col justify-end bg-black/60" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="rounded-t-2xl border-t border-zinc-800 bg-zinc-900 p-4 safe-bottom"
      >
        {children}
      </div>
    </div>
  );
}

function RenameSheet({
  session,
  onClose,
  onDone,
}: {
  session: CcSession;
  onClose: () => void;
  onDone: () => void;
}) {
  const [title, setTitle] = useState(session.title);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    setErr(null);
    const r = await api.renameCcSession(session.sessionId, t);
    setBusy(false);
    if (r.body?.ok) onDone();
    else setErr(r.body?.error ?? `重命名失败（HTTP ${r.status}）`);
  }

  return (
    <Sheet onClose={onClose}>
      <h3 className="font-semibold text-sm mb-3">重命名会话</h3>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={80}
        autoFocus
        className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm outline-none focus:border-emerald-600"
      />
      {err && <div className="mt-2 text-xs text-red-400">{err}</div>}
      <div className="mt-3 flex gap-2">
        <button onClick={onClose} className="flex-1 rounded-xl bg-zinc-800 py-3 text-sm text-zinc-300">
          取消
        </button>
        <button
          onClick={() => void save()}
          disabled={busy || !title.trim()}
          className="flex-1 rounded-xl bg-emerald-600 py-3 text-sm font-semibold active:bg-emerald-500 disabled:opacity-40"
        >
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
      <p className="mt-2 text-center text-[11px] text-zinc-600">重命名写入 CC 转录，终端里同样生效</p>
    </Sheet>
  );
}

function DeleteSheet({
  session,
  onClose,
  onDone,
}: {
  session: CcSession;
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    const r = await api.deleteCcSession(session.sessionId);
    setBusy(false);
    if (r.body?.ok) onDone();
    else setErr(r.body?.error ?? `删除失败（HTTP ${r.status}）`);
  }

  return (
    <Sheet onClose={onClose}>
      <h3 className="font-semibold text-sm mb-2">删除会话</h3>
      <div className="rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-2 text-xs text-zinc-400 truncate mb-2">
        {session.title}
      </div>
      <p className="text-xs text-red-400/80 mb-3">
        将永久删除该会话的转录文件（含完整对话历史），无法恢复。确定删除？
      </p>
      {err && <div className="mb-2 text-xs text-red-400">{err}</div>}
      <div className="flex gap-2">
        <button onClick={onClose} className="flex-1 rounded-xl bg-zinc-800 py-3 text-sm text-zinc-300">
          取消
        </button>
        <button
          onClick={() => void confirm()}
          disabled={busy}
          className="flex-1 rounded-xl bg-red-700 py-3 text-sm font-semibold text-white active:bg-red-600 disabled:opacity-40"
        >
          {busy ? '删除中…' : '永久删除'}
        </button>
      </div>
    </Sheet>
  );
}

function Chip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 rounded-lg px-2.5 py-1 text-xs border ${
        active
          ? 'border-emerald-600 bg-emerald-950/60 text-emerald-300'
          : 'border-zinc-700 bg-zinc-800/60 text-zinc-400'
      }`}
    >
      {label}
    </button>
  );
}

function NewTaskSheet({
  onClose,
  onOpen,
  onBrowseDirs,
}: {
  onClose: () => void;
  onOpen: (s: ChatSessionKey) => void;
  onBrowseDirs: () => void;
}) {
  const { config, createTask } = useStore();
  const dirs = config?.directories ?? [];
  const [dirId, setDirId] = useState(dirs[0]?.id ?? '');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<PermissionModeChoice>(() => loadPermMode());
  const busyRef = useRef(false); // 同步防重，拦截快速双击

  function changeMode(m: PermissionModeChoice) {
    setMode(m);
    savePermMode(m);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busyRef.current || !prompt.trim() || !dirId) return;
    busyRef.current = true;
    setBusy(true);
    setErr(null);
    try {
      const r = await createTask(prompt, dirId, undefined, undefined, mode);
      const p = prompt.trim();
      onClose();
      onOpen({ convId: r.convId, title: p.slice(0, 60), dirId });
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
      setBusy(false);
    } finally {
      busyRef.current = false;
    }
  }

  return (
    <div className="absolute inset-0 z-40 flex flex-col justify-end bg-black/60" onClick={onClose}>
      <form
        onSubmit={onSubmit}
        onClick={(e) => e.stopPropagation()}
        className="rounded-t-2xl border-t border-zinc-800 bg-zinc-900 p-4 safe-bottom"
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold">新任务</h3>
          <button type="button" onClick={onClose} className="text-zinc-500 text-sm px-2">
            取消
          </button>
        </div>
        <div className="mb-3">
          <div className="text-xs text-zinc-500 mb-1.5">工作目录（白名单）</div>
          <div className="flex flex-wrap gap-1.5">
            {dirs.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => setDirId(d.id)}
                className={`rounded-lg px-2.5 py-1.5 text-xs border ${
                  dirId === d.id
                    ? 'border-emerald-600 bg-emerald-950/60 text-emerald-300'
                    : 'border-zinc-700 bg-zinc-800/60 text-zinc-400'
                }`}
              >
                {d.label}
              </button>
            ))}
            <button
              type="button"
              onClick={onBrowseDirs}
              className="rounded-lg px-2.5 py-1.5 text-xs border border-dashed border-zinc-600 text-zinc-400"
            >
              ＋ 浏览目录
            </button>
          </div>
        </div>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="要交给 agent 的任务…（如：修复登录页的样式问题并跑一遍测试）"
          rows={4}
          autoFocus
          className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm outline-none focus:border-emerald-600 resize-none"
        />
        <div className="mt-2.5 flex items-center justify-between gap-2">
          <span className="text-[11px] text-zinc-500">
            {mode === 'auto' ? '⚡ 安全操作自动放行，高危才请你批准' : '🛡 每个敏感操作都需你批准'}
          </span>
          <ModeToggle value={mode} onChange={changeMode} />
        </div>
        {err && <div className="mt-2 text-xs text-red-400">{err}</div>}
        <button
          type="submit"
          disabled={busy || !prompt.trim() || !dirId}
          className="mt-3 w-full rounded-xl bg-emerald-600 py-3 text-sm font-semibold active:bg-emerald-500 disabled:opacity-40"
        >
          {busy ? '发送中…' : '发送任务'}
        </button>
        <p className="mt-2 text-center text-[11px] text-zinc-600">
          敏感操作会推送到这里等你审批，超时自动拒绝
        </p>
      </form>
    </div>
  );
}
