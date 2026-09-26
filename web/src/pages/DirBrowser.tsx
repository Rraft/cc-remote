import { useCallback, useEffect, useState } from 'react';
import { api, type FsListing } from '../lib/api';
import { useStore } from '../store';

/**
 * 目录浏览器（全屏弹层）：浏览 PC 文件系统 → 一键固定为工作目录（写入白名单，热生效）。
 * 等价于本地使用 CC 时的 cd + 启动位置选择，但受白名单安全模型约束。
 */
export default function DirBrowser({ onClose }: { onClose: () => void }) {
  const { config, refreshConfig, notify } = useStore();
  const [listing, setListing] = useState<FsListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const pinned = config?.directories ?? [];

  const load = useCallback(async (p?: string) => {
    setLoading(true);
    setMsg(null);
    const r = await api.fsList(p);
    setLoading(false);
    if (r.body) setListing(r.body);
    else setMsg(r.status === 401 ? '登录已过期' : '无法读取该目录');
  }, []);

  useEffect(() => {
    void load(); // 初始：驱动器列表
  }, [load]);

  async function pin(p: string) {
    setMsg(null);
    const r = await api.addDir(p);
    if (r.body?.ok) {
      await refreshConfig();
      setMsg(r.body.existed ? '该目录已在白名单中' : `已固定「${r.body.dir.label}」`);
    } else {
      const e = r.body?.error ?? '固定失败';
      setMsg(e);
      notify(`固定失败：${e}`);
    }
  }

  async function unpin(id: string) {
    setMsg(null);
    const r = await api.removeDir(id);
    if (r.body?.ok) {
      await refreshConfig();
      setMsg('已移除');
    } else {
      // 失败原因用全局醒目提示（常见：该目录下有任务正在运行）
      const e = r.body?.error ?? `移除失败（HTTP ${r.status}）`;
      setMsg(e);
      notify(`移除失败：${e}`);
    }
  }

  const isPinned = (p: string) =>
    pinned.some((d) => d.path.toLowerCase() === p.toLowerCase());

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-zinc-950">
      <header className="flex items-center justify-between px-3 py-2.5 border-b border-zinc-800">
        <h3 className="font-semibold text-sm">浏览目录</h3>
        <button onClick={onClose} className="text-sm text-zinc-400 px-2 py-1">
          完成
        </button>
      </header>

      {/* 已固定目录（快捷跳转 + 移除） */}
      <div className="px-3 py-2 border-b border-zinc-800/60">
        <div className="text-[11px] text-zinc-500 mb-1">已固定的工作目录</div>
        <div className="flex flex-wrap gap-1.5">
          {pinned.map((d) => (
            <span
              key={d.id}
              className="inline-flex items-center gap-1 rounded-lg border border-emerald-900/60 bg-emerald-950/40 px-2 py-1 text-xs text-emerald-300"
            >
              <button onClick={() => void load(d.path)}>{d.label}</button>
              <button
                onClick={() => void unpin(d.id)}
                className="text-zinc-500 hover:text-red-400 px-0.5"
                aria-label={`移除 ${d.label}`}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      </div>

      {/* 当前路径 */}
      {listing && listing.path !== 'DRIVES' && (
        <button
          onClick={() => listing.parent && void load(listing.parent)}
          className="px-3 py-2 text-left text-[11px] text-zinc-500 font-mono truncate border-b border-zinc-800/60"
        >
          ↰ {listing.path}
        </button>
      )}

      {msg && <div className="px-3 py-1.5 text-xs text-amber-300 bg-amber-950/40">{msg}</div>}

      <div className="flex-1 overflow-y-auto">
        {loading && <div className="p-6 text-center text-sm text-zinc-600">加载中…</div>}
        {!loading && listing?.dirs.length === 0 && (
          <div className="p-6 text-center text-sm text-zinc-600">（无子目录）</div>
        )}
        {!loading &&
          listing?.dirs.map((d) => (
            <div
              key={d.path}
              className="flex items-center gap-2 px-3 py-2.5 border-b border-zinc-900 active:bg-zinc-900"
            >
              <button className="flex-1 min-w-0 text-left text-sm truncate" onClick={() => void load(d.path)}>
                📁 {d.name}
              </button>
              {isPinned(d.path) ? (
                <span className="text-xs text-zinc-600 shrink-0">✓ 已固定</span>
              ) : (
                <button
                  onClick={() => void pin(d.path)}
                  className="shrink-0 rounded-lg border border-emerald-800 px-2.5 py-1 text-xs text-emerald-400 active:bg-emerald-950"
                >
                  ＋ 固定
                </button>
              )}
            </div>
          ))}
      </div>

      <footer className="px-3 py-2 border-t border-zinc-800 text-[11px] text-zinc-600 safe-bottom">
        固定后的目录出现在「新任务」的工作目录选项中；agent 只能在白名单目录内工作
      </footer>
    </div>
  );
}
