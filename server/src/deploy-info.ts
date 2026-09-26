import { execFile } from 'node:child_process';
import fs from 'node:fs';

/**
 * 部署状态检测（设置页「部署与访问」面板数据源）。
 * 只读探测，不修改任何系统配置。
 */

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

function run(exe: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout ?? ''));
    });
  });
}

function findTailscale(): string | null {
  const candidates =
    process.platform === 'win32'
      ? ['C:\\Program Files\\Tailscale\\tailscale.exe', 'C:\\Program Files (x86)\\Tailscale\\tailscale.exe']
      : ['/usr/bin/tailscale', '/usr/local/bin/tailscale'];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return 'tailscale'; // 交给 PATH 解析，失败时 catch
}

export async function getDeployInfo(host: string, port: number): Promise<DeployInfo> {
  const info: DeployInfo = { bind: { host, port }, tailscale: null };
  const exe = findTailscale();
  if (!exe) return info;
  try {
    const out = await run(exe, ['status', '--json'], 5000);
    const j = JSON.parse(out) as {
      BackendState?: string;
      Self?: { DNSName?: string; TailscaleIPs?: string[] };
    };
    info.tailscale = {
      installed: true,
      loggedIn: j.BackendState === 'Running',
      dnsName: j.Self?.DNSName?.replace(/\.$/, '') || undefined,
      ip: j.Self?.TailscaleIPs?.[0],
    };
    if (info.tailscale.loggedIn) {
      try {
        const s = await run(exe, ['serve', 'status'], 5000);
        info.tailscale.serveActive = s.includes('https://') && s.includes(String(port));
      } catch {
        info.tailscale.serveActive = false;
      }
    }
  } catch {
    // tailscale 不在 PATH / 未运行：视为未安装
    info.tailscale = null;
  }
  return info;
}
