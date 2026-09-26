import { useCallback, useEffect, useState } from 'react';
import { api, type FilesListing } from '../lib/api';
import { relTime } from '../lib/format';
import { useStore } from '../store';

/**
 * iCloud 文件中转站。
 *   outbox：agent 发给你的文件（说"把 xx 发给我"即可），iCloud 自动同步；也可直接 HTTPS 下载
 *   inbox ：你从 iPhone「文件」App 放进来的文件，agent 可直接读取
 */
export default function Files() {
  const { config } = useStore();
  const [box, setBox] = useState<'inbox' | 'outbox'>('outbox');
  const [data, setData] = useState<FilesListing | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await api.files(box);
    setLoading(false);
    if (r.body) setData(r.body);
  }, [box]);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(name: string) {
    setMsg(null);
    const r = await api.deleteFile(box, name);
    if (r.body?.ok) void load();
    else setMsg(r.body?.error ?? '删除失败');
  }

  async function copyPath(f: { name: string; isPlaceholder: boolean }) {
    if (!data?.root) return;
    const p = `${data.root}\\inbox\\${f.name}`;
    setMsg(null);
    try {
      await navigator.clipboard.writeText(p);
      setMsg(`已复制路径，粘贴到任务里即可让 agent 读取：\n${p}`);
    } catch {
      // 非安全上下文（http 直连）时剪贴板不可用，直接展示路径供长按复制
      setMsg(`路径（长按复制）：${p}`);
    }
  }

  if (config && !config.fileDrop.configured) {
    return (
      <div className="h-full overflow-y-auto p-6 text-sm text-zinc-400">
        <h2 className="font-bold text-zinc-200 mb-2">📁 文件中转站未配置</h2>
        <p className="mb-2">
          在 PC 上编辑 <span className="font-mono text-xs">server\config.json</span>，加入：
        </p>
        <pre className="rounded-lg bg-zinc-900 border border-zinc-800 p-3 text-xs overflow-x-auto mb-2">
{`"fileDrop": {
  "root": "C:\\\\Users\\\\<你>\\\\iCloudDrive\\\\cc-remote",
  "addToAgentScope": true
}`}
        </pre>
        <p className="text-xs text-zinc-500">
          保存即生效（自动创建 inbox/outbox 子目录）。inbox = 手机→PC；outbox = PC→手机（iCloud 自动同步）。
        </p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <header className="flex items-center justify-between px-4 py-3 border-b border-zinc-800/70">
        <h1 className="font-bold text-sm">文件中转</h1>
        <button onClick={() => void load()} className="text-xs text-zinc-400 px-2">
          刷新
        </button>
      </header>

      <div className="flex gap-1.5 px-3 py-2 border-b border-zinc-800/60">
        <button
          onClick={() => setBox('outbox')}
          className={`rounded-lg px-3 py-1.5 text-xs border ${
            box === 'outbox'
              ? 'border-emerald-600 bg-emerald-950/60 text-emerald-300'
              : 'border-zinc-700 bg-zinc-800/60 text-zinc-400'
          }`}
        >
          ⬇ 发给我的（outbox）
        </button>
        <button
          onClick={() => setBox('inbox')}
          className={`rounded-lg px-3 py-1.5 text-xs border ${
            box === 'inbox'
              ? 'border-emerald-600 bg-emerald-950/60 text-emerald-300'
              : 'border-zinc-700 bg-zinc-800/60 text-zinc-400'
          }`}
        >
          ⬆ 我发去的（inbox）
        </button>
      </div>

      {msg && (
        <div className="px-3 py-2 text-xs text-amber-200 bg-amber-950/40 whitespace-pre-wrap break-all">
          {msg}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-3 py-2">
        {loading && !data && <div className="p-8 text-center text-sm text-zinc-600">加载中…</div>}
        {data?.files.length === 0 && !loading && (
          <div className="p-8 text-center text-sm text-zinc-600">
            {box === 'outbox' ? (
              <>
                还没有文件
                <br />
                对 agent 说「把 xx 发给我」，它会放到这里
              </>
            ) : (
              <>
                还没有文件
                <br />
                在 iPhone「文件」App 里找到 cc-remote/inbox，把文件放进去
              </>
            )}
          </div>
        )}
        {data?.files.map((f) => (
          <div
            key={f.name}
            className="flex items-center gap-2 mb-1.5 rounded-xl border border-zinc-800 bg-zinc-900/50 px-3 py-2.5"
          >
            <span className="text-lg">{f.isPlaceholder ? '⏳' : '📄'}</span>
            <div className="flex-1 min-w-0">
              <div className="text-sm truncate">{f.name.replace(/\.icloud$/i, '')}</div>
              <div className="text-[11px] text-zinc-500">
                {f.isPlaceholder ? 'iCloud 占位（在手机上点开下载）' : `${fmtSize(f.size)} · ${relTime(f.mtime)}`}
              </div>
            </div>
            {box === 'outbox' && !f.isPlaceholder && (
              <a
                href={api.fileDownloadUrl('outbox', f.name)}
                className="shrink-0 rounded-lg border border-sky-800 px-2.5 py-1 text-xs text-sky-300"
              >
                下载
              </a>
            )}
            {box === 'inbox' && (
              <button
                onClick={() => void copyPath(f)}
                className="shrink-0 rounded-lg border border-emerald-800 px-2.5 py-1 text-xs text-emerald-300"
              >
                引用
              </button>
            )}
            <button
              onClick={() => void remove(f.name)}
              className="shrink-0 text-zinc-600 px-1.5 text-sm"
              aria-label="删除"
            >
              🗑
            </button>
          </div>
        ))}
      </div>

      <footer className="px-3 py-2 border-t border-zinc-800 text-[11px] text-zinc-600 safe-bottom">
        {data?.root ? `同步目录：${data.root}` : '通过 iCloud 在手机与 PC 间同步'}
      </footer>
    </div>
  );
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
