import { useEffect, useState, type FormEvent } from 'react';
import { useStore } from '../store';

export default function Login() {
  const { login } = useStore();
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [retryMs, setRetryMs] = useState(0);

  useEffect(() => {
    if (retryMs <= 0) return;
    const t = setInterval(() => setRetryMs((m) => Math.max(0, m - 1000)), 1000);
    return () => clearInterval(t);
  }, [retryMs]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy || retryMs > 0) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await login(pw.trim()); // 手机粘贴常带首尾空格
      if (!r.ok) {
        setErr(r.error);
        setPw('');
        if (r.retryAfterMs) setRetryMs(r.retryAfterMs);
      }
    } catch {
      setErr('无法连接服务器（请确认 PC 上服务已启动、Tailscale 已连接）');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full flex flex-col items-center justify-center px-8">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="text-4xl mb-2">⌘</div>
          <h1 className="text-xl font-bold">CC Remote</h1>
          <p className="text-sm text-zinc-500 mt-1">远程控制 PC 上的 Claude Code</p>
        </div>
        <form onSubmit={onSubmit} className="space-y-3">
          <input
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            placeholder="访问密码"
            autoComplete="current-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            className="w-full rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3.5 text-base outline-none focus:border-emerald-600"
          />
          <button
            type="submit"
            disabled={busy || !pw || retryMs > 0}
            className="w-full rounded-xl bg-emerald-600 py-3.5 text-base font-semibold text-white active:bg-emerald-500 disabled:opacity-40"
          >
            {busy ? '登录中…' : retryMs > 0 ? `锁定中 ${Math.ceil(retryMs / 1000)}s` : '登录'}
          </button>
        </form>
        {err && <div className="mt-3 text-center text-sm text-red-400">{err}</div>}
        <p className="mt-8 text-center text-xs text-zinc-600">
          所有数据经你自己掌控的加密隧道直达你的 PC
        </p>
      </div>
    </div>
  );
}
