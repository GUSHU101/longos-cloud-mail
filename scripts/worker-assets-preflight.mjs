import {createHash} from 'node:crypto';
import {lstatSync, readdirSync, readFileSync} from 'node:fs';
import {join, relative, sep} from 'node:path';

export const CLOUDFLARE_FREE_ASSET_FILE_LIMIT = 20_000;
export const CLOUDFLARE_ASSET_FILE_SIZE_LIMIT = 25 * 1024 * 1024;

const sensitiveAssetPattern = /(?:^|\/)(?:\.env(?:\..*)?|\.dev\.vars|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:pem|key|p12|pfx))$/i;

function normalizedPath(root, path) {
  return `/${relative(root, path).split(sep).join('/')}`;
}

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

export function assertWorkerAssetsWithinLimits(summary) {
  if (summary.fileCount === 0) throw new Error('Worker 静态资源目录为空；拒绝发布空白前端。');
  if (summary.fileCount > CLOUDFLARE_FREE_ASSET_FILE_LIMIT) {
    throw new Error(`静态资源共有 ${summary.fileCount} 个，超过 Cloudflare 免费版每版本 ${CLOUDFLARE_FREE_ASSET_FILE_LIMIT} 个文件限制。`);
  }
  if (summary.largestFile?.size > CLOUDFLARE_ASSET_FILE_SIZE_LIMIT) {
    throw new Error(
      `静态资源 ${summary.largestFile.path} 为 ${formatBytes(summary.largestFile.size)}，`
      + `超过 Cloudflare 单文件 ${formatBytes(CLOUDFLARE_ASSET_FILE_SIZE_LIMIT)} 限制。`,
    );
  }
  if (summary.sensitivePaths.length > 0) {
    throw new Error(`静态资源目录疑似包含密钥文件：${summary.sensitivePaths.join(', ')}。`);
  }
  if (summary.symbolicLinks.length > 0) {
    throw new Error(`静态资源目录包含符号链接，无法保证上传边界：${summary.symbolicLinks.join(', ')}。`);
  }
  return summary;
}

export function inspectWorkerAssets(root) {
  const files = [];
  const symbolicLinks = [];
  const sensitivePaths = [];

  function visit(directory) {
    const entries = readdirSync(directory, {withFileTypes: true})
      .sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const publicPath = normalizedPath(root, path);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) {
        symbolicLinks.push(publicPath);
        continue;
      }
      if (metadata.isDirectory()) {
        visit(path);
        continue;
      }
      if (!metadata.isFile()) continue;
      if (sensitiveAssetPattern.test(publicPath)) sensitivePaths.push(publicPath);
      files.push({path: publicPath, size: metadata.size, filesystemPath: path});
    }
  }

  visit(root);
  const manifestHash = createHash('sha256');
  let totalBytes = 0;
  for (const file of files) {
    totalBytes += file.size;
    const contentHash = createHash('sha256').update(readFileSync(file.filesystemPath)).digest('hex');
    manifestHash.update(`${file.path}\0${file.size}\0${contentHash}\n`);
  }

  const largestFiles = files
    .map(({path, size}) => ({path, size}))
    .sort((left, right) => right.size - left.size || compareText(left.path, right.path))
    .slice(0, 5);
  const summary = {
    fileCount: files.length,
    totalBytes,
    largestFile: largestFiles[0] || null,
    largestFiles,
    manifestSha256: manifestHash.digest('hex'),
    sensitivePaths,
    symbolicLinks,
  };
  return assertWorkerAssetsWithinLimits(summary);
}
