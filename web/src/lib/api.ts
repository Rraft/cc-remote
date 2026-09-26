import type { ServerEvent, SessionRecord } from './protocol';

export type PublicConfig = {
  directories: Array<{ id: string; label: string; path: string }>;
  autoAllowTools: string[];
  approvalTimeoutMs: number;
  maxTurns: number;
  maxConcurrentTasks: number;
  fileDrop: { configured: boolean; root?: string };
};

export type FsListing = {
  path: string;
  parent: string | null;
  dirs: Array<{ name: string; path: string }>;
};

export type CcSession = {
  sessionId: string;
  title: string;
  lastModified: number;
  createdAt?: number;
  gitBranch?: string;
  cwd?: string;
  sizeKb?: number;
  remoteConvId?: string;
};

export type CommandEntry = { name: string; description?: string; argumentHint?: string };
export type ModelEntry = { id: string; slots: string[] };

export type TranscriptPage = {
  sessionId: string;
  title?: string;
  cwd?: string;
  events: ServerEvent[];
  /** 全量事件数 */
  total: number;
  /** 本页首条事件的全量下标（作为向更早翻页的 before 游标） */
  from: number;
  hasMore: boolean;
  error?: string;
};

export type AppSettings = {
  host: string;
  port: number;
  directories: Array<{ id: string; label: string; path: string }>;
  autoAllowTools: string[];
  strictApproval: boolean;
  approvalTimeoutMs: number;
  maxTurns: number;
  maxConcurrentTasks: number;
  fileDrop: { root: string; addToAgentScope: boolean } | null;
};

export type GatewayView = {
  exists: boolean;
  baseUrl?: string;
  tokenSet: boolean;
  tokenTail?: string;
  tokenKind?: 'AUTH_TOKEN' | 'API_KEY';
  models: { default?: string; opus?: string; sonnet?: string; haiku?: string; subagent?: string };
};

export type DeployInfo = {
  bind: { host: string; port: number };
  tailscale: {
    installed: boolean;
    loggedIn: boolean;
    dnsName?: string;
    ip?: string;
    serveActive?: boolean;
  } | null;
};

export type FileEntry = { name: string; size: number; mtime: number; isPlaceholder: boolean };
export type FilesListing = {
  configured: boolean;
  box: 'inbox' | 'outbox';
  root?: string;
  files: FileEntry[];
};

async function req<T>(path: string, opts?: RequestInit): Promise<{ status: number; body: T | null }> {
  const r = await fetch(path, {
    credentials: 'same-origin',
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts?.headers ?? {}) },
  });
  let body: T | null = null;
  try {
    body = (await r.json()) as T;
  } catch {
    /* 无 body */
  }
  return { status: r.status, body };
}

export const api = {
  me: () => req<{ authenticated: boolean; setupDone: boolean }>('/api/me'),
  login: (password: string) =>
    req<{ ok?: boolean; error?: string; retryAfterMs?: number }>('/api/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  logout: () => req<{ ok: boolean }>('/api/logout', { method: 'POST' }),
  config: () => req<PublicConfig>('/api/config'),
  sessions: () => req<{ sessions: SessionRecord[] }>('/api/sessions'),

  // 目录浏览与白名单
  fsList: (p?: string) => req<FsListing>('/api/fs' + (p ? `?path=${encodeURIComponent(p)}` : '')),
  addDir: (path: string, label?: string) =>
    req<{ ok: boolean; dir: { id: string; label: string; path: string }; existed: boolean; error?: string }>(
      '/api/dirs',
      { method: 'POST', body: JSON.stringify({ path, label }) },
    ),
  removeDir: (id: string) =>
    req<{ ok?: boolean; error?: string }>(`/api/dirs/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  // CC 本机会话历史
  ccSessions: (opts: { dirId?: string; path?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (opts.dirId) qs.set('dirId', opts.dirId);
    if (opts.path) qs.set('path', opts.path);
    if (opts.limit) qs.set('limit', String(opts.limit));
    const s = qs.toString();
    return req<{ sessions: CcSession[]; error?: string }>('/api/cc-sessions' + (s ? `?${s}` : ''));
  },
  renameCcSession: (sessionId: string, title: string) =>
    req<{ ok?: boolean; error?: string }>(`/api/cc-sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),
  deleteCcSession: (sessionId: string) =>
    req<{ ok?: boolean; error?: string }>(`/api/cc-sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    }),
  ccTranscript: (sessionId: string, opts: { limit?: number; before?: number } = {}) => {
    const qs = new URLSearchParams();
    if (opts.limit) qs.set('limit', String(opts.limit));
    if (opts.before != null) qs.set('before', String(opts.before));
    const s = qs.toString();
    return req<TranscriptPage>(
      `/api/cc-sessions/${encodeURIComponent(sessionId)}/transcript` + (s ? `?${s}` : ''),
    );
  },
  commands: () =>
    req<{ commands: CommandEntry[]; skills: CommandEntry[]; models: ModelEntry[] }>('/api/commands'),

  // iCloud 文件中转站
  files: (box: 'inbox' | 'outbox') => req<FilesListing>(`/api/files?box=${box}`),
  fileDownloadUrl: (box: 'inbox' | 'outbox', name: string) =>
    `/api/files/download?box=${box}&name=${encodeURIComponent(name)}`,
  deleteFile: (box: 'inbox' | 'outbox', name: string) =>
    req<{ ok?: boolean; error?: string }>(
      `/api/files?box=${box}&name=${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    ),
  sendToOutbox: (srcPath: string) =>
    req<{ ok?: boolean; file?: FileEntry; error?: string }>('/api/files/outbox', {
      method: 'POST',
      body: JSON.stringify({ srcPath }),
    }),

  // 运行时设置
  settings: () => req<AppSettings>('/api/settings'),
  updateSettings: (
    patch: Partial<Pick<AppSettings, 'autoAllowTools' | 'strictApproval' | 'approvalTimeoutMs' | 'maxTurns' | 'maxConcurrentTasks'>> & {
      fileDrop?: { root: string; addToAgentScope: boolean } | null;
    },
  ) => req<{ ok?: boolean; error?: string }>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  changePassword: (current: string, next: string) =>
    req<{ ok?: boolean; error?: string }>('/api/settings/password', {
      method: 'POST',
      body: JSON.stringify({ current, next }),
    }),
  gateway: () => req<GatewayView>('/api/settings/gateway'),
  updateGateway: (patch: {
    baseUrl?: string | null;
    token?: string | null;
    models?: Record<string, string | null>;
  }) =>
    req<{ ok?: boolean; gateway?: GatewayView; error?: string }>('/api/settings/gateway', {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  deploy: () => req<DeployInfo>('/api/settings/deploy'),
};
