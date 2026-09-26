import type { PermissionModeChoice } from './protocol';

const KEY = 'ccr.permMode';

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
