/**
 * 初始化脚本：设置访问密码 + 目录白名单，生成 config.json。
 * 用法：
 *   npm run setup                       # 交互输入密码，白名单默认只有本项目目录
 *   npm run setup -- --dir "标签=路径" [--dir ...] [--port 8787] [--force]
 * 密码只以 scrypt 哈希落盘，明文永不写入任何文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { hashPassword } from './auth.js';
import { configPath, serverRoot } from './config.js';
import type { DirEntry } from './config.js';

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
    label
      .toLowerCase()
      .replace(/[^a-z0-9一-鿿]+/g, '-')
      .replace(/^-+|-+$/g, '') || `dir-${index + 1}`;
  return { id, label, path: resolved };
}

/** TTY 交互式输入（回显打码）；仅在 process.stdin.isTTY 时调用 */
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
      } else if (s === '\u0003') {
        // Ctrl+C
        stdin.setRawMode(false);
        process.stdout.write('\n已取消\n');
        process.exit(130);
      } else if (s === '\u007f' || s === '\b') {
        buf = buf.slice(0, -1);
      } else {
        buf += s;
      }
    };
    stdin.on('data', onKey);
  });
}

async function main(): Promise<void> {
  const { dirs: dirSpecs, port, force } = parseArgs(process.argv.slice(2));

  if (fs.existsSync(configPath) && !force) {
    // npm 会吞掉 `npm run setup -- --force` 里的 --force（当作 npm 自己的参数），
    // 所以交互式运行时直接询问确认，不依赖命令行参数
    if (process.stdin.isTTY) {
      const rlAsk = readline.createInterface({ input: process.stdin, output: process.stdout });
      const ans = (await rlAsk.question('config.json 已存在。重新生成将覆盖密码与目录白名单，继续？(y/N): '))
        .trim()
        .toLowerCase();
      rlAsk.close();
      if (ans !== 'y' && ans !== 'yes') {
        console.log('已取消');
        process.exit(0);
      }
    } else {
      console.error('config.json 已存在。重新生成请运行: npx tsx src/setup.ts --force');
      process.exit(1);
    }
  }

  // 工作目录白名单：--dir 参数 或 交互式输入；源码中不内置任何个人路径默认值
  let directories: DirEntry[];
  if (dirSpecs.length > 0) {
    directories = dirSpecs.map(toDirEntry);
  } else if (process.stdin.isTTY) {
    console.log('配置工作目录白名单（agent 只能在白名单目录内工作）');
    console.log('逐个输入目录绝对路径，直接回车结束；至少需要一个。');
    const dirLines: string[] = [];
    const rlDir = readline.createInterface({ input: process.stdin, output: process.stdout });
    for (;;) {
      const line = (await rlDir.question(`目录 ${dirLines.length + 1}（回车结束）: `)).trim();
      if (!line) break;
      dirLines.push(line);
    }
    rlDir.close();
    if (!dirLines.length) {
      console.error('未输入任何工作目录，已退出。也可用参数指定: npm run setup -- --dir "标签=路径"');
      process.exit(1);
    }
    directories = dirLines.map(toDirEntry);
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

  let pw1: string;
  let pw2: string;
  if (process.stdin.isTTY) {
    pw1 = await askHidden('设置访问密码（至少 8 位）: ');
    pw2 = await askHidden('再输入一次: ');
  } else {
    // 管道/重定向：一次性读完所有行再取前两行（避免 question 注册晚于行到达导致挂起）
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

  const password = await hashPassword(pw1);
  const cfg = {
    host: '127.0.0.1',
    port: port ?? 8787,
    password,
    directories,
    autoAllowTools: ['Read', 'Grep', 'Glob'],
    strictApproval: true,
    approvalTimeoutMs: 120_000,
    maxTurns: 60,
    maxConcurrentTasks: 2,
    dataDir: './data',
    eventBufferCap: 800,
  };
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  fs.mkdirSync(path.resolve(serverRoot, cfg.dataDir), { recursive: true });

  console.log(`\n✔ 已写入 ${configPath}`);
  console.log(`  端口: ${cfg.port}（只绑定 127.0.0.1）`);
  console.log(`  白名单目录:`);
  for (const d of directories) console.log(`    - ${d.id}: ${d.path}`);
  console.log(`  自动放行工具: ${cfg.autoAllowTools.join(', ')}；其余工具全部走手机审批（超时 ${cfg.approvalTimeoutMs / 1000}s 拒绝）`);
  console.log('\n下一步: npm run dev 启动，然后手机浏览器访问（先局域网，后 tailscale serve）');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
