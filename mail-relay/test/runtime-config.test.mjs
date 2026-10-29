import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const entrypoint = readFileSync(new URL('../entrypoint.sh', import.meta.url), 'utf8');
const server = readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');

test('refreshes the persistent Postfix chroot resolver on every start', () => {
  assert.match(entrypoint, /postfix_chroot_etc/);
  assert.match(entrypoint, /cp -L "\$postfix_runtime_source"/);
  assert.match(entrypoint, /resolv\.conf hosts nsswitch\.conf services/);
});

test('health fails closed when Postfix DNS is unavailable or stale', () => {
  assert.match(server, /postfixResolverFilesReady\(\)/);
  assert.match(server, /getent', \['ahostsv4', 'example\.com'\]/);
  assert.match(server, /dns: dns\.ok && postfixResolverFilesReady\(\)/);
});
