import {existsSync, readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

function windowsEntrypoint(commandName, entryPattern) {
  const located = spawnSync('where.exe', [commandName], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (located.status !== 0) return '';

  for (const wrapper of located.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
    if (!existsSync(wrapper) || !wrapper.toLowerCase().endsWith('.cmd')) continue;
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

export function resolvePnpmCommand() {
  if (process.platform === 'win32') {
    const pnpmEntrypoint = windowsEntrypoint('pnpm.cmd', /(?:^|[\\/])pnpm\.(?:cjs|mjs)$/i);
    if (pnpmEntrypoint) return {command: process.execPath, prefix: [pnpmEntrypoint]};

    const corepackEntrypoint = windowsEntrypoint('corepack.cmd', /(?:^|[\\/])corepack\.js$/i);
    if (corepackEntrypoint) return {command: process.execPath, prefix: [corepackEntrypoint, 'pnpm']};
    throw new Error('找不到可安全执行的 pnpm 或 Corepack JavaScript 入口。');
  }

  if (spawnSync('pnpm', ['--version'], {windowsHide: true}).status === 0) {
    return {command: 'pnpm', prefix: []};
  }
  if (spawnSync('corepack', ['--version'], {windowsHide: true}).status === 0) {
    return {command: 'corepack', prefix: ['pnpm']};
  }
  throw new Error('找不到 pnpm；请安装 pnpm 或启用 Corepack。');
}
