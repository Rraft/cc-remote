import type { PermissionModeChoice } from '../lib/protocol';

/**
 * 权限档位切换：
 *  🛡 手动 —— 每个敏感操作都推手机审批（最安全）
 *  ⚡ 自动 —— CC 分类器自动放行安全操作，只有高危操作才推手机（省心）
 * 两档都保留：目录边界、审批超时拒绝、高危推手机、全程审计。
 */
export default function ModeToggle({
  value,
  onChange,
}: {
  value: PermissionModeChoice;
  onChange: (m: PermissionModeChoice) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-zinc-700 overflow-hidden text-[11px] shrink-0">
      <button
        type="button"
        onClick={() => onChange('manual')}
        className={`px-2 py-1 ${
          value === 'manual'
            ? 'bg-emerald-950/80 text-emerald-300'
            : 'bg-zinc-900 text-zinc-500'
        }`}
      >
        🛡 手动
      </button>
      <button
        type="button"
        onClick={() => onChange('auto')}
        className={`px-2 py-1 ${
          value === 'auto' ? 'bg-amber-950/80 text-amber-300' : 'bg-zinc-900 text-zinc-500'
        }`}
      >
        ⚡ 自动
      </button>
    </div>
  );
}
