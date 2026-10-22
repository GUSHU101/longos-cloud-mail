import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {
  NPM_REGISTRY,
  PINNED_PNPM_VERSION,
  bootstrapArguments,
  isPinnedPnpmEntrypoint,
  resolveNpmCommand,
  sanitizedBootstrapEnvironment,
} from './pnpm-command.mjs';

test('pnpm bootstrap pins the package and disables install scripts', () => {
  const argumentsList = bootstrapArguments('C:\\safe-tool-dir');

  assert.deepEqual(argumentsList, [
    'install',
    '--prefix', 'C:\\safe-tool-dir',
    '--no-save',
    '--package-lock=false',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    `--registry=${NPM_REGISTRY}`,
    `pnpm@${PINNED_PNPM_VERSION}`,
  ]);
  assert.equal(argumentsList.some(argument => argument.includes('@latest')), false);
});

test('pnpm bootstrap does not expose deployment credentials to npm', () => {
  const environment = sanitizedBootstrapEnvironment({
    PATH: 'C:\\Windows',
    CLOUDFLARE_API_TOKEN: 'token-value',
    CLOUDFLARE_GLOBAL_API_KEY: 'global-key',
    ADMIN_PASSWORD: 'admin-password',
    LONGOS_INTEGRATION_SECRET: 'integration-secret',
    HTTP_AUTHORIZATION: 'Bearer hidden',
    NPM_TOKEN: 'npm-token',
    NPM_CONFIG_USERCONFIG: 'C:\\private\\.npmrc',
    AWS_ACCESS_KEY_ID: 'access-key',
    SSH_PRIVATE_KEY: 'private-key',
  });

  assert.equal(environment.PATH, 'C:\\Windows');
  assert.equal(environment.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(environment.CLOUDFLARE_GLOBAL_API_KEY, undefined);
  assert.equal(environment.ADMIN_PASSWORD, undefined);
  assert.equal(environment.LONGOS_INTEGRATION_SECRET, undefined);
  assert.equal(environment.HTTP_AUTHORIZATION, undefined);
  assert.equal(environment.NPM_TOKEN, undefined);
  assert.equal(environment.NPM_CONFIG_USERCONFIG, undefined);
  assert.equal(environment.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(environment.SSH_PRIVATE_KEY, undefined);
  assert.equal(environment.npm_config_registry, NPM_REGISTRY);
  assert.equal(environment.npm_config_ignore_scripts, 'true');
});

test('resolves the npm CLI without shell execution', () => {
  const command = resolveNpmCommand();
  assert.ok(command.command);
  assert.ok(Array.isArray(command.prefix));
  if (process.platform === 'win32') {
    assert.equal(command.command, process.execPath);
    assert.match(command.entrypoint, /npm-cli\.js$/i);
  }
});

test('only the pinned pnpm package entrypoint is accepted', () => {
  const toolDirectory = mkdtempSync(join(tmpdir(), 'longos-pnpm-command-test-'));
  const packageDirectory = join(toolDirectory, 'node_modules', 'pnpm');
  const binDirectory = join(packageDirectory, 'bin');
  const entrypoint = join(binDirectory, 'pnpm.cjs');

  try {
    mkdirSync(binDirectory, {recursive: true});
    writeFileSync(entrypoint, '#!/usr/bin/env node\n');
    writeFileSync(
      join(packageDirectory, 'package.json'),
      JSON.stringify({name: 'pnpm', version: PINNED_PNPM_VERSION}),
    );
    assert.equal(isPinnedPnpmEntrypoint(entrypoint), true);

    writeFileSync(
      join(packageDirectory, 'package.json'),
      JSON.stringify({name: 'pnpm', version: '0.0.0'}),
    );
    assert.equal(isPinnedPnpmEntrypoint(entrypoint), false);
  } finally {
    rmSync(toolDirectory, {recursive: true, force: true});
  }
});
