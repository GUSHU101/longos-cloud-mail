import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {generateSecureCode} from '../mail-vue/src/utils/secure-code.js';

test('invite codes use cryptographic randomness and safe defaults', () => {
  const codes = new Set(Array.from({length: 128}, () => generateSecureCode()));
  assert.equal(codes.size, 128);
  for (const code of codes) {
    assert.equal(code.length, 16);
    assert.match(code, /^[A-HJ-NP-Za-km-z2-9]+$/);
  }
});

test('invite code generation rejects unsafe lengths', () => {
  assert.throws(() => generateSecureCode(7), RangeError);
  assert.throws(() => generateSecureCode(65), RangeError);
});

test('invite code UI does not fall back to Math.random', () => {
  const source = readFileSync(new URL('../mail-vue/src/views/reg-key/index.vue', import.meta.url), 'utf8');
  assert.match(source, /generateSecureCode\(\)/);
  assert.match(source, /\^\[A-Za-z0-9_-\]\{8,64\}\$/);
  assert.doesNotMatch(source, /Math\.random/);
  assert.doesNotMatch(source, /message:\s*\$\(/);
});
