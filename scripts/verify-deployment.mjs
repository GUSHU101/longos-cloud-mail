import {spawnSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveNpmCommand, resolvePnpmCommand} from './pnpm-command.mjs';
import {classifyAuditResult, conciseAuditFailure} from './dependency-audit.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const relayRoot = resolve(repositoryRoot, 'mail-relay');
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
  console.error(`[验证失败] 需要 Node.js 22 或更高版本，当前为 ${process.versions.node}。`);
  process.exit(1);
}
let npmCommand;
let npmPrefix;
let pnpmCommand;
let pnpmPrefix;
let pnpmCleanup = () => {};
try {
  ({command: npmCommand, prefix: npmPrefix} = resolveNpmCommand());
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

const strictDependencyAudit = process.env.GITHUB_ACTIONS === 'true'
  || process.env.LONGOS_STRICT_DEPENDENCY_AUDIT === 'true';

function audit(command, args, {label, cwd = repositoryRoot}) {
  console.log(`[审计] ${label}`);
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  const category = classifyAuditResult(result);
  if (category === 'passed') {
    console.log(`✓ ${label} 未发现中危、高危或严重生产依赖漏洞。`);
    return;
  }
  if (category === 'transient-network' && !strictDependencyAudit) {
    console.warn(`[审计警告] ${label} 无法连接 npm 安全公告服务：${conciseAuditFailure(result)}`);
    console.warn('本地部署继续执行；这不是“审计通过”。GitHub Actions 仍会强制完成审计，真实漏洞和未知错误仍会阻止部署。');
    return;
  }
  if (result.stdout) console.error(result.stdout.trim());
  if (result.stderr) console.error(result.stderr.trim());
  if (result.error) console.error(result.error.message);
  const reason = category === 'vulnerabilities'
    ? '发现达到 moderate 阈值的生产依赖漏洞'
    : category === 'transient-network'
      ? 'CI 中安全公告服务不可用'
      : '审计返回未知错误';
  console.error(`[验证失败] ${label}：${reason}（退出码 ${result.status ?? '未知'}）。`);
  process.exit(result.status || 1);
}

console.log('[验证] 安装锁定依赖（仅允许 pnpm-workspace.yaml 明确批准的构建脚本）');
pnpm(['--dir', 'mail-worker', 'install', '--frozen-lockfile']);
pnpm(['--dir', 'mail-vue', 'install', '--frozen-lockfile']);
npm(['ci', '--no-audit', '--no-fund'], {cwd: relayRoot});

console.log('[验证] 审计生产依赖');
audit(pnpmCommand, [...pnpmPrefix, '--dir', 'mail-worker', 'audit', '--prod', '--audit-level', 'moderate', '--json'], {
  label: 'Worker',
});
audit(pnpmCommand, [...pnpmPrefix, '--dir', 'mail-vue', 'audit', '--prod', '--audit-level', 'moderate', '--json'], {
  label: '前端',
});
audit(npmCommand, [...npmPrefix, 'audit', '--omit=dev', '--audit-level', 'moderate', '--json'], {
  label: 'LONGOS 邮件中继',
  cwd: relayRoot,
});

console.log('[验证] 执行 Worker 测试、部署安全测试与前端生产构建');
pnpm(['--dir', 'mail-worker', 'run', 'test:unit']);
npm(['test'], {cwd: relayRoot});
pnpm(['--dir', 'mail-vue', 'run', 'build']);
const deploymentTests = readdirSync(resolve(repositoryRoot, 'scripts'), {withFileTypes: true})
  .filter(entry => entry.isFile() && entry.name.endsWith('.test.mjs'))
  .map(entry => `scripts/${entry.name}`)
  .sort();
if (deploymentTests.length === 0) {
  console.error('[验证失败] scripts 目录中没有找到部署安全测试。');
  process.exit(1);
}
run(process.execPath, ['--test', ...deploymentTests]);

console.log('[验证通过] Worker、前端、中继、依赖、构建和部署安全策略均通过。');
