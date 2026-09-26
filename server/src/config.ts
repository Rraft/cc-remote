import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type DirEntry = { id: string; label: string; path: string };
export type PasswordRecord = { salt: string; hash: string; keylen: number };

/** iCloud（或其他同步盘）文件中转站：inbox=手机→PC，outbox=PC→手机 */
export type FileDropConfig = {
  root: string;
  /** 是否把 root 加入 agent 的 additionalDirectories 并注入系统提示（推荐 true） */
  addToAgentScope: boolean;
};

export type AppConfig = {
  host: string;
  port: number;
  /** scrypt 哈希记录；null = 尚未运行 npm run setup */
  password: PasswordRecord | null;
  /** 目录白名单：agent 只允许在这些目录里工作 */
  directories: DirEntry[];
  /** 自动放行（不弹手机审批）的工具，应只包含只读工具 */
  autoAllowTools: string[];
  /**
   * 严格审批模式（默认开）：通过 settings.permissions.ask 规则强制
   * 所有命令执行/文件修改/网络类工具走手机审批——覆盖 CC 内置的
   * “安全命令自动放行”分析（否则 echo/dir 之类命令不会弹审批）。
   */
  strictApproval: boolean;
  /** 审批超时（毫秒），超时自动拒绝 */
  approvalTimeoutMs: number;
  maxTurns: number;
  maxConcurrentTasks: number;
  dataDir: string;
  eventBufferCap: number;
  /** 文件中转站；null = 未配置（相关接口返回 configured:false） */
  fileDrop: FileDropConfig | null;
};

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const configPath = path.join(serverRoot, 'config.json');
export { serverRoot };

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8787,
  autoAllowTools: ['Read', 'Grep', 'Glob'],
  strictApproval: true,
  approvalTimeoutMs: 120_000,
  maxTurns: 60,
  maxConcurrentTasks: 2,
  dataDir: './data',
  eventBufferCap: 800,
  fileDrop: null,
} as const;

export function loadConfig(): AppConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `缺少配置文件 ${configPath}\n请先运行: npm run setup  （生成密码哈希与目录白名单）`,
    );
  }
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<AppConfig>;
  const cfg: AppConfig = { ...DEFAULTS, ...raw } as AppConfig;
  cfg.dataDir = path.resolve(serverRoot, cfg.dataDir);

  if (!Array.isArray(cfg.directories) || cfg.directories.length === 0) {
    throw new Error('config.json: directories 白名单不能为空');
  }
  for (const d of cfg.directories) {
    if (!d.id || !d.path) throw new Error(`config.json: 目录项缺少 id/path: ${JSON.stringify(d)}`);
    d.label = d.label || d.id;
  }
  if (!isAllowedBindHost(cfg.host)) {
    // 安全红线：只允许回环地址或 Tailscale 网段（100.64.0.0/10）。
    // 前者配合 tailscale serve（HTTPS 边缘代理）；后者是未启用 tailnet HTTPS 证书时的
    // 备选——WireGuard 已加密全链路，100.x 地址仅私网内设备可达。
    // 严禁 0.0.0.0 / 局域网 IP / 公网 IP。
    throw new Error(
      `config.json: host 只允许 127.0.0.1 或 Tailscale 地址(100.64.0.0/10)，当前: ${cfg.host}`,
    );
  }
  if (!Number.isFinite(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    throw new Error('config.json: port 非法');
  }
  if (cfg.approvalTimeoutMs < 5_000) cfg.approvalTimeoutMs = 5_000;
  if (cfg.fileDrop) {
    if (typeof cfg.fileDrop.root !== 'string' || !cfg.fileDrop.root.trim()) {
      throw new Error('config.json: fileDrop.root 必须是绝对路径字符串');
    }
    cfg.fileDrop.root = path.resolve(cfg.fileDrop.root);
  }
  return cfg;
}

/**
 * 安全地读-改-写 config.json（保留密码哈希等所有字段）。
 * 写入用临时文件+rename 原子替换；写完后 fs.watch 会触发热加载。
 */
export function updateConfigFile(mutator: (raw: Record<string, unknown>) => void): void {
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  mutator(raw);
  const tmp = configPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2));
  fs.renameSync(tmp, configPath);
}

/**
 * 每次登录时从磁盘重读密码哈希 —— 用户跑 `npm run setup -- --force`
 * 改完密码立即生效，无需重启服务。文件缺失/损坏时返回 null（登录一律失败）。
 */
export function readCurrentPassword(): PasswordRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { password?: PasswordRecord };
    const p = raw.password;
    if (p && typeof p.salt === 'string' && typeof p.hash === 'string' && typeof p.keylen === 'number') {
      return p;
    }
    return null;
  } catch {
    return null;
  }
}

/** 按 id 解析白名单目录；不在白名单/不存在则抛错 */
export function resolveWhitelistedDir(dirId: string, cfg: AppConfig): DirEntry {
  const d = cfg.directories.find((x) => x.id === dirId);
  if (!d) throw new Error(`目录不在白名单: ${dirId}`);
  const resolved = path.resolve(d.path);
  if (!fs.existsSync(resolved)) throw new Error(`白名单目录不存在: ${resolved}`);
  return { ...d, path: resolved };
}

/** 允许绑定的地址：回环 或 Tailscale 网段 100.64.0.0/10 */
export function isAllowedBindHost(host: string): boolean {
  if (host === '127.0.0.1' || host === 'localhost') return true;
  const m = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (m) {
    const second = Number(m[1]);
    // 100.64.0.0/10 => 第二段 64..127
    if (second >= 64 && second <= 127) return true;
  }
  return false;
}

/** Windows 大小写不敏感的“child 是否在 parent 内”判断 */
export function isPathInside(child: string, parent: string): boolean {
  const c = path.resolve(child).toLowerCase();
  const p = path.resolve(parent).toLowerCase();
  const pWithSep = p.endsWith(path.sep) ? p : p + path.sep;
  return c === p || c.startsWith(pWithSep);
}
