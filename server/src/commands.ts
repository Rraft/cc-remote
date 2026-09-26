import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 斜杠命令清单缓存（供手机端命令面板）。
 * 数据来源：每个任务 system/init 事件的 slash_commands（过滤 terminal_slash_commands——
 * SDK 文档明确：终端绑定命令应从手机/远程 UI 隐藏）+ commands_changed 消息补充描述。
 * 持久化到 data/commands.json，重启后首个任务前也有数据。
 *
 * 模型列表来源：~/.claude/settings.json 的 model 相关字段（只读模型名，绝不触碰 token）。
 */

export type CommandEntry = {
  name: string;
  description?: string;
  argumentHint?: string;
  /** command = 常规斜杠命令；skill = CC 技能（同样以 /name 调用） */
  kind?: 'command' | 'skill';
};
export type ModelEntry = { id: string; slots: string[] };

/** 首次运行（还没有任何任务 init 过）时的兜底清单 */
const DEFAULTS: CommandEntry[] = [
  { name: 'help', description: '查看帮助' },
  { name: 'model', description: '查看/切换当前会话模型', argumentHint: '[model]' },
  { name: 'status', description: '查看会话状态（模型、目录、账号等）' },
  { name: 'context', description: '查看上下文占用' },
  { name: 'cost', description: '查看会话费用' },
  { name: 'usage', description: '查看用量/限额' },
  { name: 'compact', description: '压缩会话历史以释放上下文', argumentHint: '[instructions]' },
  { name: 'clear', description: '清空会话上下文（开始新话题）' },
  { name: 'permissions', description: '查看/管理工具权限规则' },
  { name: 'review', description: '审查 PR/代码变更' },
  { name: 'init', description: '为当前项目生成 CLAUDE.md' },
];

let cacheFile = '';
let cache: CommandEntry[] | null = null;

export function initCommands(dataDir: string): void {
  cacheFile = path.join(dataDir, 'commands.json');
  try {
    if (fs.existsSync(cacheFile)) {
      const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (Array.isArray(parsed) && parsed.length) cache = parsed as CommandEntry[];
    }
  } catch {
    cache = null;
  }
}

function persist(): void {
  if (!cacheFile || !cache) return;
  try {
    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
  } catch {
    /* 缓存写失败不影响主流程 */
  }
}

function merge(entries: CommandEntry[]): void {
  const byKey = new Map<string, CommandEntry>();
  for (const e of [...DEFAULTS, ...(cache ?? []), ...entries]) {
    if (!e.name) continue;
    const kind = e.kind ?? 'command';
    const key = `${kind}:${e.name}`;
    const prev = byKey.get(key);
    byKey.set(key, {
      name: e.name,
      kind,
      description: e.description ?? prev?.description,
      argumentHint: e.argumentHint ?? prev?.argumentHint,
    });
  }
  cache = [...byKey.values()];
  persist();
}

/** system/init：命令名列表（去掉终端专属命令） */
export function rememberCommandsFromInit(names: string[], terminalNames: string[]): void {
  const hidden = new Set(terminalNames.map((n) => n.replace(/^\//, '')));
  const entries = names
    .map((n) => n.replace(/^\//, ''))
    .filter((n) => n && !hidden.has(n))
    .map((name) => ({ name }));
  if (entries.length) merge(entries);
}

/** commands_changed：带描述与参数提示的完整列表 */
export function rememberCommandDetails(cmds: CommandEntry[]): void {
  if (cmds.length) merge(cmds);
}

/** system/init 的 skills 字段：CC 技能清单（以 /skill-name 调用） */
export function rememberSkills(skills: string[]): void {
  const entries = skills
    .map((s) => String(s).replace(/^\//, '').trim())
    .filter(Boolean)
    .map((name) => ({ name, kind: 'skill' as const }));
  if (entries.length) merge(entries);
}

export function getCommands(): CommandEntry[] {
  return (cache ?? DEFAULTS).filter((c) => (c.kind ?? 'command') === 'command');
}

export function getSkills(): CommandEntry[] {
  return (cache ?? []).filter((c) => c.kind === 'skill');
}

/** 从 ~/.claude/settings.json 提取模型清单（仅模型名，绝不读取 token） */
export function readSettingsModels(): ModelEntry[] {
  try {
    const p = path.join(os.homedir(), '.claude', 'settings.json');
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as {
      model?: string;
      env?: Record<string, string>;
    };
    const slotMap: Array<[string | undefined, string]> = [
      [raw.env?.ANTHROPIC_MODEL, 'default'],
      [raw.env?.ANTHROPIC_DEFAULT_OPUS_MODEL, 'opus 档'],
      [raw.env?.ANTHROPIC_DEFAULT_SONNET_MODEL, 'sonnet 档'],
      [raw.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'haiku 档'],
      [raw.env?.CLAUDE_CODE_SUBAGENT_MODEL, '子代理'],
      [raw.model, 'settings.model'],
    ];
    const byId = new Map<string, string[]>();
    for (const [id, slot] of slotMap) {
      if (!id) continue;
      const arr = byId.get(id) ?? [];
      if (!arr.includes(slot)) arr.push(slot);
      byId.set(id, arr);
    }
    return [...byId.entries()].map(([id, slots]) => ({ id, slots }));
  } catch {
    return [];
  }
}
