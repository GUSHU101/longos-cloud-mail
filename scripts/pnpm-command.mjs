import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {isSensitiveEnvironmentName} from './deployment-environment.mjs';

export const PINNED_PNPM_VERSION = '11.25.0';
export const NPM_REGISTRY = 'https://registry.npmjs.org/';

function locateWindowsWrappers(commandName) {
  const located = spawnSync('where.exe', [commandName], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (located.status !== 0) return [];

  return located.stdout
    .split(/\r?\n/)
    .map(value => value.trim())
    .filter(wrapper => existsSync(wrapper) && wrapper.toLowerCase().endsWith('.cmd'));
}

function windowsEntrypoint(commandName, entryPattern) {
  for (const wrapper of locateWindowsWrappers(commandName)) {
    const source = readFileSync(wrapper, 'utf8');
    for (const match of source.matchAll(/"([^"]+\.(?:cjs|mjs|js))"/gi)) {
      if (!entryPattern.test(match[1])) continue;
      const relative = match[1].replace(/^%~dp0/i, '');
      const entrypoint = resolve(dirname(wrapper), relative);
      if (existsSync(entrypoint)) return entrypoint;
    }
  }
  return '';
}

function windowsNpmEntrypoint() {
  for (const wrapper of locateWindowsWrappers('npm.cmd')) {
    const candidate = join(dirname(wrapper), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (existsSync(candidate)) return candidate;
  }
  return '';
}

function npmEntrypoint() {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    process.platform === 'win32' ? windowsNpmEntrypoint() : '',
  ].filter(Boolean);

  return candidates.find(candidate =>
    basename(candidate).toLowerCase() === 'npm-cli.js' && existsSync(candidate)
  ) || '';
}

export function sanitizedBootstrapEnvironment(environment = process.env) {
  const clean = {};
  for (const [name, value] of Object.entries(environment)) {
    if (isSensitiveEnvironmentName(name)) continue;
    if (/^npm_config_userconfig$/i.test(name)) continue;
    clean[name] = value;
  }
  clean.npm_config_registry = NPM_REGISTRY;
  clean.npm_config_ignore_scripts = 'true';
  clean.npm_config_audit = 'false';
  clean.npm_config_fund = 'false';
  return clean;
}

export function resolveNpmCommand() {
  if (process.platform === 'win32') {
    const entrypoint = npmEntrypoint();
    if (!entrypoint) {
      throw new Error('找不到与当前 Node.js 配套的 npm CLI；请重新安装包含 npm 的 Node.js 22 或更高版本。');
    }
    return {command: process.execPath, prefix: [entrypoint], entrypoint};
  }

  if (spawnSync('npm', ['--version'], {windowsHide: true}).status === 0) {
    return {command: 'npm', prefix: [], entrypoint: ''};
  }
  throw new Error('找不到 npm；请安装包含 npm 的 Node.js 22 或更高版本。');
}

export function isPinnedPnpmEntrypoint(entrypoint) {
  if (!entrypoint || !existsSync(entrypoint)) return false;

  try {
    const actualEntrypoint = realpathSync(entrypoint);
    if (!/(?:^|[\\/])pnpm[\\/]bin[\\/]pnpm\.cjs$/i.test(actualEntrypoint)) return false;
    const packageJsonPath = resolve(dirname(actualEntrypoint), '..', 'package.json');
    const metadata = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    return metadata.name === 'pnpm' && metadata.version === PINNED_PNPM_VERSION;
  } catch {
    return false;
  }
}

export function bootstrapArguments(toolDirectory) {
  return [
    'install',
    '--prefix', toolDirectory,
    '--no-save',
    '--package-lock=false',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    `--registry=${NPM_REGISTRY}`,
    `pnpm@${PINNED_PNPM_VERSION}`,
  ];
}

function bootstrapPinnedPnpm() {
  const npmCli = npmEntrypoint();
  if (!npmCli) {
    throw new Error(
      '找不到 pnpm、Corepack 或 npm。请安装包含 npm 的 Node.js 22 或更高版本后重试。',
    );
  }

  const toolDirectory = mkdtempSync(join(tmpdir(), 'longos-cloud-mail-pnpm-'));
  const cleanup = () => rmSync(toolDirectory, {recursive: true, force: true});
  console.log(
    `[准备] 未检测到 pnpm/Corepack，正在临时安装固定版本 pnpm ${PINNED_PNPM_VERSION}（部署结束自动删除）。`,
  );

  const installed = spawnSync(
    process.execPath,
    [npmCli, ...bootstrapArguments(toolDirectory)],
    {
      env: sanitizedBootstrapEnvironment(),
      stdio: 'inherit',
      windowsHide: true,
    },
  );
  const entrypoint = join(toolDirectory, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
  if (installed.status !== 0 || !isPinnedPnpmEntrypoint(entrypoint)) {
    cleanup();
    throw new Error(
      `无法从 npm 官方注册表安全准备 pnpm ${PINNED_PNPM_VERSION}（退出码 ${installed.status ?? '未知'}）。`,
    );
  }

  return {
    command: process.execPath,
    prefix: [entrypoint],
    entrypoint,
    source: 'npm-bootstrap',
    cleanup,
  };
}

export function resolvePnpmCommand() {
  const inheritedEntrypoint = process.env.LONGOS_PNPM_ENTRYPOINT;
  if (isPinnedPnpmEntrypoint(inheritedEntrypoint)) {
    return {
      command: process.execPath,
      prefix: [inheritedEntrypoint],
      entrypoint: inheritedEntrypoint,
      source: 'inherited-bootstrap',
      cleanup: () => {},
    };
  }

  if (process.platform === 'win32') {
    const pnpmEntrypoint = windowsEntrypoint('pnpm.cmd', /(?:^|[\\/])pnpm\.(?:cjs|mjs)$/i);
    if (pnpmEntrypoint) {
      return {
        command: process.execPath,
        prefix: [pnpmEntrypoint],
        entrypoint: pnpmEntrypoint,
        source: 'system-pnpm',
        cleanup: () => {},
      };
    }

    const corepackEntrypoint = windowsEntrypoint('corepack.cmd', /(?:^|[\\/])corepack\.js$/i);
    if (corepackEntrypoint) {
      return {
        command: process.execPath,
        prefix: [corepackEntrypoint, 'pnpm'],
        entrypoint: '',
        source: 'system-corepack',
        cleanup: () => {},
      };
    }
    return bootstrapPinnedPnpm();
  }

  if (spawnSync('pnpm', ['--version'], {windowsHide: true}).status === 0) {
    return {command: 'pnpm', prefix: [], entrypoint: '', source: 'system-pnpm', cleanup: () => {}};
  }
  if (spawnSync('corepack', ['--version'], {windowsHide: true}).status === 0) {
    return {
      command: 'corepack',
      prefix: ['pnpm'],
      entrypoint: '',
      source: 'system-corepack',
      cleanup: () => {},
    };
  }
  return bootstrapPinnedPnpm();
}
