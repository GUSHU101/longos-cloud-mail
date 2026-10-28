import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {readSecret} from '../src/secret.mjs';

function withSecretFile(contents, callback) {
  const directory = mkdtempSync(join(tmpdir(), 'longos-relay-secret-'));
  const path = join(directory, 'secret');
  writeFileSync(path, contents, {mode: 0o600});
  try {
    return callback(path);
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
}

test('loads a Docker/Coolify secret file without retaining its trailing newline', () => {
  withSecretFile('0123456789abcdef0123456789abcdef\n', path => {
    assert.equal(readSecret('LONGOS_RELAY_SHARED_SECRET', {
      LONGOS_RELAY_SHARED_SECRET_FILE: path,
    }), '0123456789abcdef0123456789abcdef');
  });
});

test('preserves the compatible direct environment-secret path', () => {
  assert.equal(readSecret('RELAY_SHARED_SECRET', {
    RELAY_SHARED_SECRET: '0123456789abcdef0123456789abcdef',
  }), '0123456789abcdef0123456789abcdef');
});

test('rejects ambiguous, relative, empty, multiline and oversized secret files', () => {
  withSecretFile('0123456789abcdef0123456789abcdef', path => {
    assert.throws(() => readSecret('RELAY_SHARED_SECRET', {
      RELAY_SHARED_SECRET: 'direct-secret-value-that-is-long-enough',
      RELAY_SHARED_SECRET_FILE: path,
    }), /cannot both be configured/);
  });
  assert.throws(() => readSecret('RELAY_SHARED_SECRET', {
    RELAY_SHARED_SECRET_FILE: 'relative/secret',
  }), /absolute path/);
  withSecretFile('', path => {
    assert.throws(() => readSecret('RELAY_SHARED_SECRET', {
      RELAY_SHARED_SECRET_FILE: path,
    }), /between 1 and 8192 bytes/);
  });
  withSecretFile('first-line\nsecond-line', path => {
    assert.throws(() => readSecret('RELAY_SHARED_SECRET', {
      RELAY_SHARED_SECRET_FILE: path,
    }), /exactly one non-empty text line/);
  });
  withSecretFile('x'.repeat(8193), path => {
    assert.throws(() => readSecret('RELAY_SHARED_SECRET', {
      RELAY_SHARED_SECRET_FILE: path,
    }), /between 1 and 8192 bytes/);
  });
});
