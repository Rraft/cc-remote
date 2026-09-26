import type { PermissionModeChoice } from './protocol';

const KEY = 'ccr.permMode';
const DIR_KEY = 'ccr.lastDirId';

export function loadPermMode(): PermissionModeChoice {
  try {
    return localStorage.getItem(KEY) === 'auto' ? 'auto' : 'manual';
  } catch {
    return 'manual';
  }
}

export function savePermMode(m: PermissionModeChoice): void {
  try {
    localStorage.setItem(KEY, m);
  } catch {
    /* 隐私模式下忽略 */
  }
}

/** 新会话默认工作目录：记住上次选择（跨会话生效） */
export function loadLastDirId(): string | null {
  try {
    return localStorage.getItem(DIR_KEY);
  } catch {
    return null;
  }
}

export function saveLastDirId(id: string): void {
  try {
    localStorage.setItem(DIR_KEY, id);
  } catch {
    /* 隐私模式下忽略 */
  }
}
