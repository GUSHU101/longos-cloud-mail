import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolvePnpmCommand} from './pnpm-command.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const relayRoot = resolve(repositoryRoot, 'mail-relay');
let npmCommand = 'npm';
let npmPrefix = [];
if (process.platform === 'win32') {
  const npmCliCandidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);
  const npmCli = npmCliCandidates.find(candidate => existsSync(candidate));
  if (!npmCli) {
    console.error('[验证失败] 找不到与当前 Node.js 配套的 npm CLI。');
    process.exit(1);
  }
  npmCommand = process.execPath;
  npmPrefix = [npmCli];
}
let pnpmCommand;
let pnpmPrefix;
let pnpmCleanup = () => {};
try {
  ({
    command: pnpmCommand,
    prefix: pnpmPrefix,
    cleanup: pnpmCleanup = () => {},
  } = resolvePnpmCommand());
} catch (error) {
  console.error(`[验证失败] ${error.message}`);
  process.exit(1);
}
process.once('exit', () => pnpmCleanup());

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repositoryRoot,
    env: process.env,
    encoding: 'utf8',
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) {
    console.error(`[验证失败] ${command} 无法启动：${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[验证失败] ${command} ${args.join(' ')} 退出码 ${result.status}。`);
    process.exit(result.status || 1);
  }
}

function pnpm(args) {
  run(pnpmCommand, [...pnpmPrefix, ...args]);
}

function npm(args, options = {}) {
  run(npmCommand, [...npmPrefix, ...args], options);
}

console.log('[验证] 安装锁定依赖（仅允许 pnpm-workspace.yaml 明确批准的构建脚本）');
pnpm(['--dir', 'mail-worker', 'install', '--frozen-lockfile']);
pnpm(['--dir', 'mail-vue', 'install', '--frozen-lockfile']);
npm(['ci'], {cwd: relayRoot});

console.log('[验证] 审计生产依赖');
pnpm(['--dir', 'mail-worker', 'audit', '--prod', '--audit-level', 'moderate']);
pnpm(['--dir', 'mail-vue', 'audit', '--prod', '--audit-level', 'moderate']);
npm(['audit', '--omit=dev', '--audit-level', 'moderate'], {cwd: relayRoot});

console.log('[验证] 执行 Worker 测试、部署安全测试与前端生产构建');
pnpm(['--dir', 'mail-worker', 'run', 'test:unit']);
npm(['test'], {cwd: relayRoot});
pnpm(['--dir', 'mail-vue', 'run', 'build']);
run(process.execPath, [
  '--test',
  'scripts/cloudflare-auth.test.mjs',
  'scripts/cloudflare-preflight.test.mjs',
  'scripts/cloudflare-resource-state.test.mjs',
  'scripts/deploy-input-security.test.mjs',
  'scripts/email-routing.test.mjs',
  'scripts/frontend-security.test.mjs',
  'scripts/github-deployment.test.mjs',
  'scripts/local-deployment.test.mjs',
  'scripts/longos-dns-sync.test.mjs',
  'scripts/pnpm-command.test.mjs',
  'scripts/deploy-validation.test.mjs',
  'scripts/workflow-security.test.mjs',
]);

console.log('[验证通过] Worker、前端、中继、依赖、构建和部署安全策略均通过。');
