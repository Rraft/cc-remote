import { useEffect, useReducer, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { fmtCountdown } from './lib/format';
import type { Item } from './lib/derive';
import type { TaskStatus } from './lib/protocol';
import { useStore } from './store';

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown>{text}</ReactMarkdown>
    </div>
  );
}

export function StatusDot({ status }: { status: TaskStatus | string }) {
  const cls =
    status === 'running'
      ? 'bg-emerald-400 animate-pulse'
      : status === 'done'
        ? 'bg-zinc-500'
        : status === 'error'
          ? 'bg-red-500'
          : status === 'aborted'
            ? 'bg-amber-500'
            : 'bg-zinc-600';
  return <span className={`inline-block w-2 h-2 rounded-full ${cls}`} />;
}

function inputBrief(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    for (const k of ['command', 'file_path', 'pattern', 'path', 'url', 'prompt', 'description']) {
      if (typeof o[k] === 'string') return o[k] as string;
    }
  }
  return '';
}

function InputDetail({ input }: { input: unknown }) {
  const brief = inputBrief(input);
  const cmd = input && typeof input === 'object' && typeof (input as Record<string, unknown>).command === 'string';
  return (
    <pre className="mt-2 rounded-lg bg-zinc-950 border border-zinc-800 p-2.5 text-xs text-zinc-300 overflow-x-auto whitespace-pre-wrap break-all max-h-48">
      {cmd ? (input as Record<string, string>).command : brief || JSON.stringify(input, null, 2)}
    </pre>
  );
}

/** 工具调用卡片（自动放行的只读工具 + 已审批工具的执行记录） */
export function ToolCard({ item }: { item: Extract<Item, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  const brief = inputBrief(item.input);
  const status = !item.result ? (
    <span className="text-emerald-400 animate-pulse">运行中</span>
  ) : item.result.isError ? (
    <span className="text-red-400">出错</span>
  ) : (
    <span className="text-zinc-500">完成</span>
  );
  return (
    <div className="my-1.5 rounded-xl border border-zinc-800 bg-zinc-900/60 overflow-hidden">
      <button className="w-full px-3 py-2 flex items-center gap-2 text-left" onClick={() => setOpen(!open)}>
        <span className="text-zinc-500 text-xs shrink-0">🔧 {item.name}</span>
        <span className="flex-1 min-w-0 truncate text-xs text-zinc-400 font-mono">{brief}</span>
        <span className="text-xs shrink-0">{status}</span>
        <span className="text-zinc-600 text-xs">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="px-3 pb-3">
          <InputDetail input={item.input} />
          {item.result && (
            <pre
              className={`mt-2 rounded-lg border p-2.5 text-xs overflow-x-auto whitespace-pre-wrap break-all max-h-64 ${
                item.result.isError
                  ? 'border-red-900 bg-red-950/40 text-red-300'
                  : 'border-zinc-800 bg-zinc-950 text-zinc-300'
              }`}
            >
              {item.result.text || '(无输出)'}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/** 审批卡片：核心安全交互。允许 / 总是允许 / 拒绝 + 倒计时 */
export function ApprovalCard({ item }: { item: Extract<Item, { kind: 'approval' }> }) {
  const { approve } = useStore();
  const [, tick] = useReducer((x: number) => x + 1, 0);
  const resolved = item.resolved;

  useEffect(() => {
    if (resolved) return;
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [resolved]);

  if (resolved) {
    const label =
      resolved.decision === 'allow'
        ? `✔ 已允许${resolved.alwaysAllow ? '（本会话内不再询问）' : ''}`
        : `✖ 已拒绝${resolved.reason === 'timeout' ? '（超时自动拒绝）' : resolved.reason === 'aborted' ? '（任务中断）' : ''}`;
    return (
      <div className="my-1.5 rounded-xl border border-zinc-800/60 bg-zinc-900/30 px-3 py-2 text-xs text-zinc-500">
        {label} · {item.displayName || item.toolName}
        {inputBrief(item.input) && <span className="font-mono"> · {inputBrief(item.input).slice(0, 60)}</span>}
      </div>
    );
  }

  const expired = Date.now() >= item.expiresAt;
  return (
    <div className="my-2 rounded-xl border-2 border-amber-600/70 bg-amber-950/30 p-3 shadow-lg">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-amber-300">
            ⚠ 请求授权：{item.displayName || item.toolName}
          </div>
          {(item.title || item.description) && (
            <div className="text-xs text-amber-200/70 mt-0.5 break-words">
              {item.title || item.description}
            </div>
          )}
        </div>
        <div className="text-xs text-amber-400 tabular-nums shrink-0">{fmtCountdown(item.expiresAt)}</div>
      </div>
      <InputDetail input={item.input} />
      <div className="mt-3 grid grid-cols-3 gap-2">
        <button
          disabled={expired}
          onClick={() => approve(item.requestId, false)}
          className="rounded-lg border border-zinc-700 bg-zinc-800 py-2.5 text-sm text-zinc-300 active:bg-zinc-700 disabled:opacity-40"
        >
          拒绝
        </button>
        <button
          disabled={expired || !item.canAlwaysAllow}
          onClick={() => approve(item.requestId, true, true)}
          className="rounded-lg border border-sky-800 bg-sky-950/60 py-2.5 text-sm text-sky-300 active:bg-sky-900 disabled:opacity-40"
        >
          总是允许
        </button>
        <button
          disabled={expired}
          onClick={() => approve(item.requestId, true)}
          className="rounded-lg bg-emerald-600 py-2.5 text-sm font-semibold text-white active:bg-emerald-500 disabled:opacity-40"
        >
          允许
        </button>
      </div>
    </div>
  );
}
