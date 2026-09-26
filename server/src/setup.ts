/**
 * 初始化向导：密码 / 端口 / 目录白名单 / 文件中转站 / 模型网关（Base URL、API Key、模型目录）。
 * 用法：npm run setup [--force] [--dir "标签=路径"]... [--port 8787]
 * 非交互（管道）：必须 --dir；密码从 stdin 读两行；网关/中转站跳过（可稍后在 Web 设置页配）。
 * 密码只存 scrypt 哈希；网关写入 ~/.claude/settings.json（与 Claude Code 共用），token 不回显。
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { hashPassword } from './auth.js';
import { configPath, serverRoot } from './config.js';
import type { DirEntry } from './config.js';
import { readGateway, writeGateway, type GatewayModels, type GatewayPatch } from './gateway.js';

function parseArgs(argv: string[]): { dirs: string[]; port?: number; force: boolean } {
  const dirs: string[] = [];
  let port: number | undefined;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') dirs.push(argv[++i] ?? '');
    else if (a === '--port') port = Number(argv[++i]);
    else if (a === '--force') force = true;
  }
  return { dirs, port, force };
}

function toDirEntry(spec: string, index: number): DirEntry {
  const eq = spec.indexOf('=');
  const label = eq > 0 ? spec.slice(0, eq) : path.basename(path.resolve(eq > 0 ? spec.slice(eq + 1) : spec));
  const p = eq > 0 ? spec.slice(eq + 1) : spec;
  if (!p) throw new Error(`--dir 参数无效: "${spec}"（格式: 标签=路径 或 路径）`);
  const resolved = path.resolve(p);
  if (!fs.existsSync(resolved)) throw new Error(`目录不存在: ${resolved}`);
  const id =
    label.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '-').replace(/^-+|-+$/g, '') || `dir-${index + 1}`;
  return { id, label, path: resolved };
}

/** 普通行输入（每次独立创建/关闭 readline，避免与 askHidden 的 raw 模式冲突） */
async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

const CTRL_C = String.fromCharCode(3);
const BACKSPACE = String.fromCharCode(127);

/** TTY 隐藏输入；仅在 process.stdin.isTTY 时调用 */
async function askHidden(question: string): Promise<string> {
  return new Promise<string>((resolve) => {
    process.stdout.write(question);
    let buf = '';
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    const onKey = (chunk: Buffer): void => {
      const s = chunk.toString('utf8');
      if (s === '\r' || s === '\n') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onKey);
        process.stdout.write('\n');
        resolve(buf);
      } else if (s === CTRL_C) {
        stdin.setRawMode(false);
        process.stdout.write('\n已取消\n');
        process.exit(130);
      } else if (s === BACKSPACE || s === '\b') {
        buf = buf.slice(0, -1);
      } else {
        buf += s;
      }
    };
    stdin.on('data', onKey);
  });
}

async function main(): Promise<void> {
  const { dirs: dirSpecs, port: portArg, force } = parseArgs(process.argv.slice(2));
  const isTTY = !!process.stdin.isTTY;

  if (fs.existsSync(configPath) && !force) {
    if (isTTY) {
      const ans = (await ask('config.json 已存在。重新生成将覆盖密码/白名单等（网关配置不受影响），继续？(y/N): ')).toLowerCase();
      if (ans !== 'y' && ans !== 'yes') {
        console.log('已取消');
        process.exit(0);
      }
    } else {
      console.error('config.json 已存在。重新生成请运行: npx tsx src/setup.ts --force');
      process.exit(1);
    }
  }

  // ---------- 1. 工作目录白名单（源码不内置任何个人默认路径） ----------
  let directories: DirEntry[];
  if (dirSpecs.length > 0) {
    directories = dirSpecs.map(toDirEntry);
  } else if (isTTY) {
    console.log('── 工作目录白名单（agent 只能在白名单目录内工作）──');
    console.log('逐个输入目录绝对路径，直接回车结束；至少一个。');
    const lines: string[] = [];
    for (;;) {
      const line = await ask(`目录 ${lines.length + 1}（回车结束）: `);
      if (!line) break;
      lines.push(line);
    }
    if (!lines.length) {
      console.error('未输入任何工作目录，已退出。也可用参数: npm run setup -- --dir "标签=路径"');
      process.exit(1);
    }
    directories = lines.map(toDirEntry);
  } else {
    console.error('非交互模式必须用 --dir 指定工作目录，例如: npm run setup -- --dir "my-project=/path/to/project"');
    process.exit(1);
  }
  // id 去重
  const seen = new Set<string>();
  for (const d of directories) {
    let id = d.id;
    let n = 2;
    while (seen.has(id)) id = `${d.id}-${n++}`;
    seen.add(id);
    d.id = id;
  }

  // ---------- 2. 端口 ----------
  let port = portArg;
  if (!port && isTTY) {
    const p = await ask('服务端口 [默认 8787]: ');
    port = p ? Number(p) : 8787;
  }
  port = port ?? 8787;
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    console.error('端口非法');
    process.exit(1);
  }

  // ---------- 3. 登录密码 ----------
  let pw1: string;
  let pw2: string;
  if (isTTY) {
    console.log('── 登录密码（手机端访问用，只存哈希）──');
    pw1 = await askHidden('设置访问密码（至少 8 位）: ');
    pw2 = await askHidden('再输入一次: ');
  } else {
    console.log('（非交互模式：从 stdin 读入两行作为密码）');
    const lines: string[] = [];
    const rl = readline.createInterface({ input: process.stdin });
    for await (const line of rl) lines.push(line.trim());
    [pw1 = '', pw2 = ''] = lines;
  }
  if (pw1.length < 8) {
    console.error('密码至少 8 位');
    process.exit(1);
  }
  if (pw1 !== pw2) {
    console.error('两次输入不一致');
    process.exit(1);
  }

  // ---------- 4. 文件中转站（可选） ----------
  let fileDrop: { root: string; addToAgentScope: boolean } | null = null;
  if (isTTY) {
    console.log('── 文件中转站（可选，iCloud/OneDrive 等同步盘目录；回车跳过，可稍后在 Web 设置页配置）──');
    const root = await ask('同步根目录（其下自动创建 inbox/outbox）: ');
    if (root) {
      const scope = (await ask('纳入 agent 工作范围（可直接收发文件）? [Y/n]: ')).toLowerCase();
      fileDrop = { root: path.resolve(root), addToAgentScope: scope !== 'n' };
    }
  }

  // ---------- 5. 模型网关（可选，写 ~/.claude/settings.json） ----------
  let gwPatch: GatewayPatch | null = null;
  if (isTTY) {
    const cur = readGateway();
    console.log('── 模型网关（Anthropic 兼容端点；写入 ~/.claude/settings.json，与 Claude Code 共用）──');
    if (cur.exists) {
      console.log(`当前: BaseURL=${cur.baseUrl ?? '未设置'} | Token=${cur.tokenSet ? `已设置(••••${cur.tokenTail})` : '未设置'} | 默认模型=${cur.models.default ?? '未设置'}`);
    }
    const doGw = (await ask('现在配置模型网关? [y/N]: ')).toLowerCase();
    if (doGw === 'y' || doGw === 'yes') {
      const patch: GatewayPatch = {};
      const baseUrl = await ask(`Base URL [当前: ${cur.baseUrl ?? '无'}，回车保留]: `);
      if (baseUrl) patch.baseUrl = baseUrl;
      const tokenHint = cur.tokenSet ? `API Token [已设置 ••••${cur.tokenTail}，回车保留，输入覆盖]: ` : 'API Token（回车跳过）: ';
      const token = await askHidden(tokenHint);
      if (token) patch.token = token;
      const slots: Array<[keyof GatewayModels, string]> = [
        ['default', '默认模型'],
        ['opus', 'opus 档'],
        ['sonnet', 'sonnet 档'],
        ['haiku', 'haiku 档'],
        ['subagent', '子代理'],
      ];
      const models: Partial<Record<keyof GatewayModels, string>> = {};
      for (const [key, label] of slots) {
        const v = await ask(`${label} [当前: ${cur.models[key] ?? '无'}，回车保留]: `);
        if (v) models[key] = v;
      }
      if (Object.keys(models).length) patch.models = models;
      if (Object.keys(patch).length) gwPatch = patch;
    }
  } else {
    console.log('（非交互模式跳过模型网关配置，可稍后在 Web 设置页 → 模型网关 中配置）');
  }

  // ---------- 6. 落盘 ----------
  const password = await hashPassword(pw1);
  const cfg = {
    host: '127.0.0.1',
    port,
    password,
    directories,
    autoAllowTools: ['Read', 'Grep', 'Glob'],
    strictApproval: true,
    approvalTimeoutMs: 120_000,
    maxTurns: 60,
    maxConcurrentTasks: 2,
    dataDir: './data',
    eventBufferCap: 800,
    fileDrop,
  };
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  fs.mkdirSync(path.resolve(serverRoot, cfg.dataDir), { recursive: true });
  if (gwPatch) writeGateway(gwPatch);

  console.log(`\n✔ 配置完成: ${configPath}`);
  console.log(`  端口: ${port}（只绑定 127.0.0.1）`);
  console.log('  工作目录白名单:');
  for (const d of directories) console.log(`    - ${d.id}: ${d.path}`);
  if (fileDrop) console.log(`  文件中转站: ${fileDrop.root}（inbox/outbox）`);
  if (gwPatch) console.log('  模型网关: 已写入 ~/.claude/settings.json');
  console.log('\n下一步:');
  console.log('  启动服务: npm run start（或项目根目录 start.bat / start.sh）');
  console.log('  本机访问: http://127.0.0.1:' + port);
  console.log('  手机远程: 见 deploy/DEPLOY.md（Tailscale / Cloudflare Tunnel / frp）');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
