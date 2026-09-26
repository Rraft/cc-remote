import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { audit } from './audit.js';
import type { AppConfig } from './config.js';
import { isPathInside } from './config.js';

/**
 * iCloud 文件中转站。
 *   <root>/inbox  —— 手机 → PC：用户在 iPhone「文件」App 里放进来，agent 可直接读取
 *   <root>/outbox —— PC → 手机：agent（或 API）把文件复制进来，iCloud 自动同步到手机
 * 安全约束：所有文件名必须是单段（不含路径分隔符），resolve 后必须仍在对应 box 内。
 */

export type BoxName = 'inbox' | 'outbox';

export type FileEntry = {
  name: string;
  size: number;
  mtime: number;
  /** iCloud 占位文件（未下载到本地），内容不可读 */
  isPlaceholder: boolean;
};

export function fileDropRoot(cfg: AppConfig): string | null {
  return cfg.fileDrop?.root ?? null;
}

export function boxDir(cfg: AppConfig, box: BoxName): string {
  const root = fileDropRoot(cfg);
  if (!root) throw new Error('文件中转站未配置（config.json 的 fileDrop.root）');
  return path.join(root, box);
}

/** 确保 root/inbox、root/outbox 存在（幂等，启动与配置热加载时调用；异步不阻塞） */
export async function ensureFileDrop(cfg: AppConfig): Promise<void> {
  const root = fileDropRoot(cfg);
  if (!root) return;
  try {
    await fsp.mkdir(path.join(root, 'inbox'), { recursive: true });
    await fsp.mkdir(path.join(root, 'outbox'), { recursive: true });
  } catch (err) {
    console.warn('[files] 创建中转站目录失败:', err instanceof Error ? err.message : err);
  }
}

export async function listBox(cfg: AppConfig, box: BoxName): Promise<FileEntry[]> {
  const dir = boxDir(cfg, box);
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return []; // 目录不存在/不可读
  }
  const out: FileEntry[] = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (ent.name.startsWith('.') || ent.name.toLowerCase() === 'desktop.ini') continue;
    try {
      const st = await fsp.stat(path.join(dir, ent.name));
      out.push({
        name: ent.name,
        size: st.size,
        mtime: st.mtimeMs,
        isPlaceholder: ent.name.toLowerCase().endsWith('.icloud'),
      });
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** 校验并解析 box 内的文件名（拒绝路径分隔符/越界/占位文件） */
export function resolveInBox(cfg: AppConfig, box: BoxName, name: string, allowPlaceholder = false): string {
  if (typeof name !== 'string' || !name || name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error(`非法文件名: ${name}`);
  }
  const abs = path.resolve(boxDir(cfg, box), name);
  if (!isPathInside(abs, boxDir(cfg, box))) throw new Error('文件名越界');
  if (!allowPlaceholder && abs.toLowerCase().endsWith('.icloud')) {
    throw new Error('该文件尚未从 iCloud 下载到本地（占位文件），请先在手机上点开它完成下载');
  }
  return abs;
}

/** 把项目产物复制进 outbox（源必须在白名单目录或中转站内；异步复制大文件不卡循环） */
export async function copyToOutbox(cfg: AppConfig, srcPath: string): Promise<FileEntry> {
  if (typeof srcPath !== 'string' || !srcPath.trim()) throw new Error('srcPath 不能为空');
  const src = path.resolve(srcPath);
  let srcStat: fs.Stats;
  try {
    srcStat = await fsp.stat(src);
  } catch {
    throw new Error(`源文件不存在: ${src}`);
  }
  if (!srcStat.isFile()) throw new Error(`源文件不是普通文件: ${src}`);

  const root = fileDropRoot(cfg);
  const inWhitelist = cfg.directories.some((d) => isPathInside(src, d.path));
  const inDrop = root ? isPathInside(src, root) : false;
  if (!inWhitelist && !inDrop) {
    throw new Error('源文件必须位于目录白名单或文件中转站内');
  }

  const outbox = boxDir(cfg, 'outbox');
  await fsp.mkdir(outbox, { recursive: true });
  let dest = path.join(outbox, path.basename(src));
  if (fs.existsSync(dest)) {
    const ext = path.extname(dest);
    const base = path.basename(dest, ext);
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    dest = path.join(outbox, `${base}-${stamp}${ext}`);
  }
  await fsp.copyFile(src, dest);
  const st = await fsp.stat(dest);
  audit('file_send', { src, dest: path.basename(dest), size: st.size });
  return { name: path.basename(dest), size: st.size, mtime: st.mtimeMs, isPlaceholder: false };
}

export async function deleteInBox(cfg: AppConfig, box: BoxName, name: string): Promise<void> {
  const abs = resolveInBox(cfg, box, name, true); // 占位文件也允许删除
  try {
    await fsp.unlink(abs);
  } catch {
    throw new Error('文件不存在');
  }
  audit('file_delete', { box, name });
}
