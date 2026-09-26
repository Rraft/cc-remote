import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, type AppSettings, type DeployInfo, type GatewayView } from '../lib/api';
import DirBrowser from './DirBrowser';
import { useStore } from '../store';

/**
 * 设置页 —— 所有「运行时可远程配置」项集中在此（热生效，无需重启）：
 * 部署状态 / 模型网关(API key、base URL、模型目录) / 权限与任务 / 工作目录 / 文件中转 / 修改密码。
 * 首次部署级配置（绑定端口、数据目录、初始密码、穿透方式）在服务端 setup / 部署文档中完成。
 */
export default function Settings() {
  const { logout, refreshConfig } = useStore();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [gateway, setGateway] = useState<GatewayView | null>(null);
  const [deploy, setDeploy] = useState<DeployInfo | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [dirOpen, setDirOpen] = useState(false);

  const load = useCallback(async () => {
    const [s, g, d] = await Promise.all([api.settings(), api.gateway(), api.deploy()]);
    if (s.body) setSettings(s.body);
    if (g.body) setGateway(g.body);
    if (d.body) setDeploy(d.body);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 4000);
    return () => clearTimeout(t);
  }, [msg]);

  const ok = (text: string) => setMsg({ kind: 'ok', text });
  const err = (text: string) => setMsg({ kind: 'err', text });

  if (!settings) {
    return <div className="p-8 text-center text-sm text-zinc-600 animate-pulse">加载设置…</div>;
  }

  return (
    <div className="h-full flex flex-col">
      <header className="flex items-center justify-between px-4 py-3 border-b border-zinc-800/70">
        <h1 className="font-bold text-sm">设置</h1>
        <button
          onClick={() => void logout()}
          className="text-xs text-zinc-500 px-2 py-1"
        >
          退出登录
        </button>
      </header>

      {msg && (
        <div
          className={`px-4 py-2 text-xs ${
            msg.kind === 'ok' ? 'bg-emerald-950/60 text-emerald-300' : 'bg-red-950/60 text-red-300'
          }`}
        >
          {msg.text}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        <DeploySection deploy={deploy} port={settings.port} />
        <GatewaySection gateway={gateway} onSaved={(g) => { setGateway(g); ok('模型网关已保存，新任务立即生效'); }} onError={err} />
        <PermissionSection settings={settings} onSaved={async () => { await refreshConfig(); void load(); ok('已保存并热生效'); }} onError={err} />
        <DirsSection settings={settings} onManage={() => setDirOpen(true)} />
        <FileDropSection settings={settings} onSaved={async () => { await refreshConfig(); void load(); ok('文件中转已保存'); }} onError={err} />
        <PasswordSection onDone={() => { ok('密码已修改，请重新登录'); setTimeout(() => void logout(), 1200); }} onError={err} />
        <div className="py-2 text-center text-[11px] text-zinc-600">
          CC Remote · 配置分层说明见项目 README / deploy/DEPLOY.md
        </div>
      </div>

      {dirOpen && <DirBrowser onClose={() => { setDirOpen(false); void load(); }} />}
    </div>
  );
}

// ---------- 通用小组件 ----------

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-3.5">
      <h2 className="text-sm font-semibold mb-2.5">{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block mb-2.5">
      <span className="block text-[11px] text-zinc-500 mb-1">{label}</span>
      {children}
    </label>
  );
}

const inputCls =
  'w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-emerald-600 font-mono';

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  // 滑块用 translate 位移（轨道 44px，滑块 20px，左右各留 2px），overflow-hidden 兜底防溢出
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      className={`relative w-11 h-6 rounded-full transition-colors overflow-hidden shrink-0 ${
        value ? 'bg-emerald-600' : 'bg-zinc-700'
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform duration-150 ${
          value ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

function SaveButton({ busy, onClick, label = '保存' }: { busy: boolean; onClick: () => void; label?: string }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="w-full rounded-xl bg-emerald-600 py-2.5 text-sm font-semibold active:bg-emerald-500 disabled:opacity-40"
    >
      {busy ? '保存中…' : label}
    </button>
  );
}

// ---------- 部署与访问 ----------

function DeploySection({ deploy, port }: { deploy: DeployInfo | null; port: number }) {
  const ts = deploy?.tailscale;
  return (
    <Card title="🌐 部署与访问">
      <div className="text-xs text-zinc-400 space-y-1.5">
        <div>
          服务绑定：<span className="font-mono">{deploy ? `${deploy.bind.host}:${deploy.bind.port}` : `127.0.0.1:${port}`}</span>
          <span className="text-zinc-600">（仅回环，公网/局域网不可达）</span>
        </div>
        {ts === null && deploy && (
          <div className="text-amber-300">未检测到 Tailscale —— 可用任意隧道方案，见下方说明</div>
        )}
        {ts && (
          <div>
            Tailscale：{ts.loggedIn ? '✅ 已登录' : '⚠️ 未登录'}
            {ts.dnsName && (
              <>
                {' · '}
                <a className="text-emerald-400 underline break-all" href={`https://${ts.dnsName}`}>
                  https://{ts.dnsName}
                </a>
              </>
            )}
            {ts.loggedIn && (
              <div className={ts.serveActive ? 'text-emerald-400' : 'text-amber-300'}>
                {ts.serveActive ? '✅ tailscale serve 已转发本服务' : '⚠️ 未检测到 serve 转发，执行: tailscale serve --bg ' + port}
              </div>
            )}
          </div>
        )}
      </div>
      <details className="mt-2.5 text-xs text-zinc-500">
        <summary className="cursor-pointer select-none text-zinc-400">其他接入方式（服务与穿透解耦，任意转发到回环的方案均可）</summary>
        <div className="mt-2 space-y-2 pl-1">
          <p>
            <b className="text-zinc-300">Cloudflare Tunnel</b>：<span className="font-mono">cloudflared tunnel --url http://127.0.0.1:{port}</span>，获得公网 HTTPS 域名；务必保持本服务的登录密码强度，并建议在 Cloudflare Access 上再加一层。
          </p>
          <p>
            <b className="text-zinc-300">frp（自有 VPS）</b>：frpc 将 <span className="font-mono">127.0.0.1:{port}</span> 映射到 VPS 端口，配合 TLS 与访问控制。
          </p>
          <p>
            <b className="text-zinc-300">局域网直连</b>：同一 WiFi 下将 config.json 的 host 改为 PC 局域网 IP（会降低安全性，仅临时调试用）。
          </p>
          <p className="text-zinc-600">详细说明见部署包 deploy/DEPLOY.md。</p>
        </div>
      </details>
    </Card>
  );
}

// ---------- 模型网关 ----------

function GatewaySection({
  gateway,
  onSaved,
  onError,
}: {
  gateway: GatewayView | null;
  onSaved: (g: GatewayView) => void;
  onError: (m: string) => void;
}) {
  const [baseUrl, setBaseUrl] = useState(gateway?.baseUrl ?? '');
  const [token, setToken] = useState('');
  const [models, setModels] = useState({ ...(gateway?.models ?? {}) });
  const [busy, setBusy] = useState(false);
  const [inited, setInited] = useState(false);

  useEffect(() => {
    if (gateway && !inited) {
      setBaseUrl(gateway.baseUrl ?? '');
      setModels({ ...gateway.models });
      setInited(true);
    }
  }, [gateway, inited]);

  async function save() {
    setBusy(true);
    const r = await api.updateGateway({
      baseUrl: baseUrl.trim() || null,
      token: token.trim() || undefined, // 留空 = 不变
      models: Object.fromEntries(
        Object.entries(models).map(([k, v]) => [k, (v ?? '').trim() || null]),
      ),
    });
    setBusy(false);
    if (r.body?.ok && r.body.gateway) {
      setToken('');
      onSaved(r.body.gateway);
    } else {
      onError(r.body?.error ?? `保存失败（HTTP ${r.status}）`);
    }
  }

  const slots: Array<[keyof GatewayView['models'], string]> = [
    ['default', '默认模型'],
    ['opus', 'opus 档'],
    ['sonnet', 'sonnet 档'],
    ['haiku', 'haiku 档'],
    ['subagent', '子代理'],
  ];

  return (
    <Card title="🧠 模型网关（API Key / Base URL / 模型目录）">
      <p className="text-[11px] text-zinc-500 mb-2.5">
        写入 PC 的 <span className="font-mono">~/.claude/settings.json</span>（与本机 Claude Code 共用），保存后新任务立即生效。Token 只显示尾 4 位，留空表示不修改。
      </p>
      <Field label="Base URL（Anthropic 兼容网关）">
        <input className={inputCls} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.anthropic.com" />
      </Field>
      <Field label={gateway?.tokenSet ? `API Token（已设置 ••••${gateway.tokenTail ?? ''}，${gateway.tokenKind ?? ''}）` : 'API Token（未设置）'}>
        <input className={inputCls} type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="留空保持不变" autoComplete="off" />
      </Field>
      {slots.map(([key, label]) => (
        <Field key={key} label={label}>
          <input
            className={inputCls}
            value={models[key] ?? ''}
            onChange={(e) => setModels((m) => ({ ...m, [key]: e.target.value }))}
            placeholder="未设置"
          />
        </Field>
      ))}
      <SaveButton busy={busy} onClick={() => void save()} label="保存网关配置" />
    </Card>
  );
}

// ---------- 权限与任务 ----------

function PermissionSection({
  settings,
  onSaved,
  onError,
}: {
  settings: AppSettings;
  onSaved: () => Promise<void>;
  onError: (m: string) => void;
}) {
  const [strict, setStrict] = useState(settings.strictApproval);
  const [timeoutS, setTimeoutS] = useState(String(Math.round(settings.approvalTimeoutMs / 1000)));
  const [maxTurns, setMaxTurns] = useState(String(settings.maxTurns));
  const [maxConc, setMaxConc] = useState(String(settings.maxConcurrentTasks));
  const [tools, setTools] = useState<string[]>(settings.autoAllowTools);
  const [newTool, setNewTool] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    const r = await api.updateSettings({
      strictApproval: strict,
      approvalTimeoutMs: Math.max(5, Number(timeoutS) || 120) * 1000,
      maxTurns: Number(maxTurns) || 60,
      maxConcurrentTasks: Number(maxConc) || 2,
      autoAllowTools: tools,
    });
    setBusy(false);
    if (r.body?.ok) await onSaved();
    else onError(r.body?.error ?? `保存失败（HTTP ${r.status}）`);
  }

  return (
    <Card title="🛡 权限与任务">
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs text-zinc-400">
          严格审批
          <span className="block text-[11px] text-zinc-600">所有命令/编辑/网络工具都必须手机批准（关闭后由 CC 自行放行"安全命令"）</span>
        </div>
        <Toggle value={strict} onChange={setStrict} />
      </div>
      <div className="grid grid-cols-3 gap-2 mb-3">
        <Field label="审批超时(秒)">
          <input className={inputCls} type="number" min={5} value={timeoutS} onChange={(e) => setTimeoutS(e.target.value)} />
        </Field>
        <Field label="单任务轮数上限">
          <input className={inputCls} type="number" min={1} value={maxTurns} onChange={(e) => setMaxTurns(e.target.value)} />
        </Field>
        <Field label="并发任务数">
          <input className={inputCls} type="number" min={1} max={8} value={maxConc} onChange={(e) => setMaxConc(e.target.value)} />
        </Field>
      </div>
      <Field label="自动放行工具（免审批，应只放只读工具）">
        <div className="flex flex-wrap gap-1.5 mb-1.5">
          {tools.map((t) => (
            <span key={t} className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-800/60 px-2 py-1 text-xs font-mono text-zinc-300">
              {t}
              <button onClick={() => setTools((arr) => arr.filter((x) => x !== t))} className="text-zinc-500 hover:text-red-400">✕</button>
            </span>
          ))}
        </div>
        <div className="flex gap-1.5">
          <input
            className={inputCls}
            value={newTool}
            onChange={(e) => setNewTool(e.target.value)}
            placeholder="工具名，如 Read"
          />
          <button
            onClick={() => {
              const t = newTool.trim();
              if (t && !tools.includes(t)) setTools((arr) => [...arr, t]);
              setNewTool('');
            }}
            className="shrink-0 rounded-lg border border-zinc-700 px-3 text-sm text-zinc-300"
          >
            添加
          </button>
        </div>
      </Field>
      <SaveButton busy={busy} onClick={() => void save()} />
    </Card>
  );
}

// ---------- 工作目录 ----------

function DirsSection({ settings, onManage }: { settings: AppSettings; onManage: () => void }) {
  return (
    <Card title="📂 工作目录白名单">
      <div className="space-y-1 mb-2.5">
        {settings.directories.map((d) => (
          <div key={d.id} className="text-xs">
            <span className="text-zinc-300">{d.label}</span>
            <span className="block text-[11px] text-zinc-600 font-mono truncate">{d.path}</span>
          </div>
        ))}
      </div>
      <button
        onClick={onManage}
        className="w-full rounded-xl border border-zinc-700 py-2.5 text-sm text-zinc-300 active:bg-zinc-800"
      >
        浏览文件系统并管理…
      </button>
    </Card>
  );
}

// ---------- 文件中转 ----------

function FileDropSection({
  settings,
  onSaved,
  onError,
}: {
  settings: AppSettings;
  onSaved: () => Promise<void>;
  onError: (m: string) => void;
}) {
  const [root, setRoot] = useState(settings.fileDrop?.root ?? '');
  const [inScope, setInScope] = useState(settings.fileDrop?.addToAgentScope ?? true);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    const r = await api.updateSettings({
      fileDrop: root.trim() ? { root: root.trim(), addToAgentScope: inScope } : null,
    });
    setBusy(false);
    if (r.body?.ok) await onSaved();
    else onError(r.body?.error ?? `保存失败（HTTP ${r.status}）`);
  }

  return (
    <Card title="📁 文件中转站（iCloud / 任意同步盘）">
      <Field label="同步根目录（其下自动创建 inbox / outbox）">
        <input className={inputCls} value={root} onChange={(e) => setRoot(e.target.value)} placeholder="如 C:\Users\me\iCloudDrive\cc-remote" />
      </Field>
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs text-zinc-400">
          纳入 agent 工作范围
          <span className="block text-[11px] text-zinc-600">agent 可直接读 inbox、写 outbox（"把文件发给我"）</span>
        </div>
        <Toggle value={inScope} onChange={setInScope} />
      </div>
      <SaveButton busy={busy} onClick={() => void save()} label="保存中转站配置" />
    </Card>
  );
}

// ---------- 修改密码 ----------

function PasswordSection({ onDone, onError }: { onDone: () => void; onError: (m: string) => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    if (next.length < 8) {
      onError('新密码至少 8 位');
      return;
    }
    if (next !== confirm) {
      onError('两次输入的新密码不一致');
      return;
    }
    setBusy(true);
    const r = await api.changePassword(current, next);
    setBusy(false);
    if (r.body?.ok) {
      setCurrent(''); setNext(''); setConfirm('');
      onDone();
    } else {
      onError(r.body?.error ?? `修改失败（HTTP ${r.status}）`);
    }
  }

  return (
    <Card title="🔑 修改登录密码">
      <Field label="当前密码">
        <input className={inputCls} type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
      </Field>
      <Field label="新密码（至少 8 位）">
        <input className={inputCls} type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
      </Field>
      <Field label="确认新密码">
        <input className={inputCls} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
      </Field>
      <SaveButton busy={busy} onClick={() => void save()} label="修改密码" />
      <p className="mt-2 text-center text-[11px] text-zinc-600">修改后所有设备需重新登录</p>
    </Card>
  );
}
