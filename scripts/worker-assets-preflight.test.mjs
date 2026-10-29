import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {
  CLOUDFLARE_ASSET_FILE_SIZE_LIMIT,
  CLOUDFLARE_FREE_ASSET_FILE_LIMIT,
  assertWorkerAssetsWithinLimits,
  inspectWorkerAssets,
} from './worker-assets-preflight.mjs';

test('builds a deterministic secret-free asset manifest summary', () => {
  const root = mkdtempSync(join(tmpdir(), 'longos-assets-'));
  try {
    mkdirSync(join(root, 'assets'));
    writeFileSync(join(root, 'index.html'), '<main>LONGOS</main>');
    writeFileSync(join(root, 'assets', 'app.js'), 'console.log("ready")');
    const first = inspectWorkerAssets(root);
    const second = inspectWorkerAssets(root);
    assert.equal(first.fileCount, 2);
    assert.equal(first.totalBytes, 39);
    assert.match(first.manifestSha256, /^[a-f0-9]{64}$/);
    assert.equal(first.manifestSha256, second.manifestSha256);
    assert.deepEqual(first.sensitivePaths, []);
    assert.deepEqual(first.symbolicLinks, []);
    assert.equal(Object.hasOwn(first.largestFiles[0], 'filesystemPath'), false);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('rejects asset counts and individual files outside Cloudflare free-plan limits', () => {
  assert.throws(() => assertWorkerAssetsWithinLimits({
    fileCount: CLOUDFLARE_FREE_ASSET_FILE_LIMIT + 1,
    largestFile: {path: '/app.js', size: 1},
    sensitivePaths: [],
    symbolicLinks: [],
  }), /超过 Cloudflare 免费版/);
  assert.throws(() => assertWorkerAssetsWithinLimits({
    fileCount: 1,
    largestFile: {path: '/video.bin', size: CLOUDFLARE_ASSET_FILE_SIZE_LIMIT + 1},
    sensitivePaths: [],
    symbolicLinks: [],
  }), /超过 Cloudflare 单文件/);
});

test('rejects empty, sensitive, and symbolic-link asset manifests', () => {
  const base = {fileCount: 1, largestFile: {path: '/index.html', size: 1}, sensitivePaths: [], symbolicLinks: []};
  assert.throws(() => assertWorkerAssetsWithinLimits({...base, fileCount: 0}), /目录为空/);
  assert.throws(() => assertWorkerAssetsWithinLimits({...base, sensitivePaths: ['/.env.production']}), /疑似包含密钥/);
  assert.throws(() => assertWorkerAssetsWithinLimits({...base, symbolicLinks: ['/outside']}), /包含符号链接/);
});
