import { useEffect, useMemo, useState } from 'react';
import { api, type CommandEntry, type ModelEntry } from '../lib/api';

/**
 * 斜杠命令面板 —— 还原 CC CLI 的 "/" 菜单体验：
 * - 「指令」tab：命令 + 技能合并列表（技能带 🧩 徽标），随输入实时过滤
 * - 「模型」tab：本机 settings.json 里的真实模型清单（带档位标签），点选生成 /model <id>
 * 清单来自服务端缓存（每个任务 init 事件上报的真实 slash_commands/skills，
 * 已过滤 terminal 专属命令），首次运行前有兜底列表。
 */

let cache: { commands: CommandEntry[]; skills: CommandEntry[]; models: ModelEntry[] } | null = null;

type MergedEntry = CommandEntry & { isSkill?: boolean };

export default function CommandPalette({
  query,
  onPick,
  onClose,
}: {
  /** 当前 "/" 后已输入的过滤词（不含斜杠） */
  query: string;
  /** 选中后回填到输入框的完整文本 */
  onPick: (text: string) => void;
  onClose: () => void;
}) {
  const [data, setData] = useState(cache);
  const [tab, setTab] = useState<'cmds' | 'models'>('cmds');

  useEffect(() => {
    if (cache) return;
    let cancel = false;
    void api.commands().then((r) => {
      if (cancel || !r.body) return;
      cache = r.body;
      setData(r.body);
    });
    return () => {
      cancel = true;
    };
  }, []);

  const q = query.trim().toLowerCase();

  // 指令与技能合并（技能同名时以指令为准）
  const merged = useMemo<MergedEntry[]>(() => {
    const cmds = data?.commands ?? [];
    const names = new Set(cmds.map((c) => c.name));
    const skills = (data?.skills ?? [])
      .filter((s) => !names.has(s.name))
      .map((s) => ({ ...s, isSkill: true }));
    return [...cmds, ...skills];
  }, [data]);

  const filtered = useMemo(() => {
    if (!q) return merged;
    return merged.filter(
      (c) => c.name.toLowerCase().includes(q) || (c.description ?? '').toLowerCase().includes(q),
    );
  }, [merged, q]);

  // 输入 /model… 时自动跳到模型 tab
  useEffect(() => {
    if (q.startsWith('model') && (data?.models.length ?? 0) > 0) setTab('models');
  }, [q, data]);

  function pick(c: MergedEntry) {
    if (!c.isSkill && c.name === 'model' && (data?.models.length ?? 0) > 0) {
      setTab('models'); // /model 先进模型选择
      return;
    }
    // 技能与带参命令补一个尾随空格方便继续输入参数
    onPick(c.isSkill || c.argumentHint ? `/${c.name} ` : `/${c.name}`);
  }

  return (
    <div className="absolute left-2 right-2 bottom-full mb-2 z-30">
      <div className="rounded-2xl border border-zinc-700 bg-zinc-900 shadow-2xl overflow-hidden">
        {/* tabs */}
        <div className="flex border-b border-zinc-800">
          <button
            onClick={() => setTab('cmds')}
            className={`flex-1 py-2 text-xs font-semibold ${
              tab === 'cmds' ? 'text-emerald-400 border-b-2 border-emerald-500' : 'text-zinc-500'
            }`}
          >
            ⌘ 指令
          </button>
          <button
            onClick={() => setTab('models')}
            className={`flex-1 py-2 text-xs font-semibold ${
              tab === 'models' ? 'text-emerald-400 border-b-2 border-emerald-500' : 'text-zinc-500'
            }`}
          >
            🧠 模型
          </button>
          <button onClick={onClose} className="px-3 text-zinc-500 text-sm">
            ✕
          </button>
        </div>

        <div className="max-h-64 overflow-y-auto">
          {tab === 'cmds' && (
            <>
              {filtered.length === 0 && (
                <div className="p-4 text-center text-xs text-zinc-600">
                  {data ? `没有匹配 "/${q}" 的指令或技能` : '加载中…'}
                </div>
              )}
              {filtered.map((c) => (
                <button
                  key={`${c.isSkill ? 's' : 'c'}:${c.name}`}
                  onClick={() => pick(c)}
                  className="w-full flex items-baseline gap-2 px-3 py-2.5 text-left border-b border-zinc-800/60 active:bg-zinc-800"
                >
                  <span
                    className={`font-mono text-sm shrink-0 ${c.isSkill ? 'text-sky-400' : 'text-emerald-400'}`}
                  >
                    /{c.name}
                  </span>
                  {c.isSkill && (
                    <span className="shrink-0 rounded bg-sky-950 border border-sky-900 px-1 text-[10px] text-sky-400">
                      技能
                    </span>
                  )}
                  {c.argumentHint && (
                    <span className="font-mono text-[10px] text-zinc-600 shrink-0">{c.argumentHint}</span>
                  )}
                  <span className="flex-1 min-w-0 truncate text-xs text-zinc-400">
                    {c.description ?? ''}
                  </span>
                </button>
              ))}
            </>
          )}

          {tab === 'models' && (
            <>
              {(data?.models.length ?? 0) === 0 && (
                <div className="p-4 text-center text-xs text-zinc-600">
                  {data ? '未从 settings.json 读到模型配置' : '加载中…'}
                </div>
              )}
              {data?.models.map((m) => (
                <button
                  key={m.id}
                  onClick={() => onPick(`/model ${m.id}`)}
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-left border-b border-zinc-800/60 active:bg-zinc-800"
                >
                  <span className="flex-1 min-w-0 truncate font-mono text-sm text-zinc-200">{m.id}</span>
                  {m.slots.slice(0, 2).map((s) => (
                    <span key={s} className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500">
                      {s}
                    </span>
                  ))}
                </button>
              ))}
            </>
          )}
        </div>

        <div className="px-3 py-1.5 text-[10px] text-zinc-600 border-t border-zinc-800/60">
          由 PC 上的 Claude Code 执行，行为与终端一致 · 清单来自会话真实上报
        </div>
      </div>
    </div>
  );
}
