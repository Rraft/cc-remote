import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { audit } from './audit.js';

/**
 * 模型网关配置（API key / base URL / 模型目录）读写。
 *
 * 直接操作 ~/.claude/settings.json 的 env 键 —— 与 PC 上的 Claude Code 共用同一份配置，
 * 改完对新任务立即生效（CC 进程每次启动都重读 settings）。
 *
 * 安全红线：
 * - token 读出时只返回掩码（是否已设置 + 尾 4 位），明文永不出服务端
 * - 审计只记字段名，绝不记值
 * - 写回保留 settings.json 里的所有无关字段（plugins、hooks、permissions…）
 */

function settingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

export type GatewayModels = {
  default?: string;
  opus?: string;
  sonnet?: string;
  haiku?: string;
  subagent?: string;
};

export type GatewayView = {
  exists: boolean;
  baseUrl?: string;
  tokenSet: boolean;
  tokenTail?: string;
  tokenKind?: 'AUTH_TOKEN' | 'API_KEY';
  models: GatewayModels;
};

export function readGateway(): GatewayView {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as {
      env?: Record<string, string>;
      model?: string;
    };
    const env = raw.env ?? {};
    const token = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '';
    return {
      exists: true,
      baseUrl: env.ANTHROPIC_BASE_URL,
      tokenSet: !!token,
      tokenTail: token ? token.slice(-4) : undefined,
      tokenKind: env.ANTHROPIC_AUTH_TOKEN
        ? 'AUTH_TOKEN'
        : env.ANTHROPIC_API_KEY
          ? 'API_KEY'
          : undefined,
      models: {
        default: env.ANTHROPIC_MODEL ?? raw.model,
        opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL,
        sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL,
        haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
        subagent: env.CLAUDE_CODE_SUBAGENT_MODEL,
      },
    };
  } catch {
    return { exists: false, tokenSet: false, models: {} };
  }
}

export type GatewayPatch = {
  /** undefined=不变；null 或 ''=清除 */
  baseUrl?: string | null;
  /** undefined 或 ''=不变；null=清除；其他=设置新 token（写入 ANTHROPIC_AUTH_TOKEN） */
  token?: string | null;
  models?: { [K in keyof GatewayModels]?: string | null };
};

const MODEL_ENV_KEYS: Array<[keyof GatewayModels, string]> = [
  ['default', 'ANTHROPIC_MODEL'],
  ['opus', 'ANTHROPIC_DEFAULT_OPUS_MODEL'],
  ['sonnet', 'ANTHROPIC_DEFAULT_SONNET_MODEL'],
  ['haiku', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'],
  ['subagent', 'CLAUDE_CODE_SUBAGENT_MODEL'],
];

export function writeGateway(patch: GatewayPatch): GatewayView {
  const p = settingsPath();
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
  } catch {
    raw = {}; // 不存在或损坏 → 新建（损坏时先备份）
    if (fs.existsSync(p)) fs.renameSync(p, p + '.bak');
  }
  const env: Record<string, string> = { ...((raw.env as Record<string, string>) ?? {}) };
  const changed: string[] = [];

  if (patch.baseUrl !== undefined) {
    if (patch.baseUrl === null || String(patch.baseUrl).trim() === '') {
      delete env.ANTHROPIC_BASE_URL;
      changed.push('baseUrl:cleared');
    } else {
      const url = String(patch.baseUrl).trim();
      if (!/^https?:\/\//i.test(url)) throw new Error('Base URL 必须以 http:// 或 https:// 开头');
      env.ANTHROPIC_BASE_URL = url;
      changed.push('baseUrl');
    }
  }

  if (patch.token === null) {
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_API_KEY;
    changed.push('token:cleared');
  } else if (typeof patch.token === 'string' && patch.token.trim()) {
    env.ANTHROPIC_AUTH_TOKEN = patch.token.trim();
    delete env.ANTHROPIC_API_KEY; // 二选一，避免歧义
    changed.push('token');
  }

  if (patch.models) {
    for (const [slot, key] of MODEL_ENV_KEYS) {
      const v = patch.models[slot];
      if (v === undefined) continue;
      if (v === null || String(v).trim() === '') {
        delete env[key];
        changed.push(`model.${slot}:cleared`);
      } else {
        env[key] = String(v).trim();
        changed.push(`model.${slot}`);
      }
    }
  }

  raw.env = env;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2));
  fs.renameSync(tmp, p);
  audit('gateway_update', { changed }); // 只记字段名，不记值
  return readGateway();
}
