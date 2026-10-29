import {writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

function combinedOutput(result) {
  return `${result?.stdout || ''}\n${result?.stderr || ''}`;
}

function extract(pattern, source) {
  return source.match(pattern)?.[1] || '';
}

export function buildCloudflareSupportReport({
  result,
  workerName,
  accountId,
  wranglerVersion,
  assets,
}) {
  const output = combinedOutput(result);
  const endpoint = extract(/(\/accounts\/[a-f0-9]{32}\/workers\/scripts\/[^\s)]+\/assets-upload-session)/i, output);
  const errorCode = extract(/(?:\[code:\s*|\bcode\s*[:=]?\s*)(\d{4,6})/i, output);
  const httpStatus = extract(/(?:HTTP\s+|API RESPONSE:\s+[^\n]*?\s)(5\d{2})\b/i, output)
    || (/Internal Server Error/i.test(output) ? '500' : '');
  const wranglerLog = extract(/Logs were written to\s+["']([^"']+)["']/i, output);

  return {
    reportVersion: 1,
    generatedAt: new Date().toISOString(),
    product: 'LONGOS Cloud Mail',
    failure: {
      category: 'cloudflare-workers-assets-upload-session',
      httpStatus,
      errorCode,
      attempts: result?.attempts || 1,
      endpoint,
      wranglerLog,
      existingDeploymentChanged: false,
    },
    environment: {
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.versions.node,
      wranglerVersion,
    },
    target: {
      workerName,
      accountId,
    },
    assets: assets ? {
      fileCount: assets.fileCount,
      totalBytes: assets.totalBytes,
      largestFile: assets.largestFile,
      manifestSha256: assets.manifestSha256,
    } : null,
    references: {
      workersAssetsStatus: 'https://www.cloudflarestatus.com/',
      workersSdkIssue: 'https://github.com/cloudflare/workers-sdk/issues/13118',
    },
  };
}

export function writeCloudflareSupportReport(details) {
  const report = buildCloudflareSupportReport(details);
  const timestamp = report.generatedAt.replace(/[:.]/g, '-');
  const path = join(tmpdir(), `longos-cloud-mail-support-${timestamp}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, {encoding: 'utf8', mode: 0o600});
  return path;
}
