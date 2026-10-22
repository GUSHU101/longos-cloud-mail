const transientAuditPatterns = [
  /\bEAI_AGAIN\b/i,
  /\bECONNRESET\b/i,
  /\bECONNREFUSED\b/i,
  /\bENETUNREACH\b/i,
  /\bENOTFOUND\b/i,
  /\bETIMEDOUT\b/i,
  /\bERR_PNPM_AUDIT_BAD_RESPONSE\b/i,
  /\bERR_PNPM_META_FETCH_FAIL\b/i,
  /\bHTTP(?:Error)?\s+(?:408|425|429|5\d\d)\b/i,
  /operation was aborted due to timeout/i,
  /request timed out/i,
  /TimeoutError/i,
  /fetch failed/i,
  /socket hang up/i,
];

function parseReport(stdout) {
  const value = String(stdout || '').trim();
  if (!value.startsWith('{')) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function vulnerabilityCount(report) {
  const counts = report?.metadata?.vulnerabilities;
  if (counts && typeof counts === 'object') {
    return ['moderate', 'high', 'critical']
      .reduce((total, severity) => total + Number(counts[severity] || 0), 0);
  }
  if (report?.advisories && typeof report.advisories === 'object') {
    return Object.values(report.advisories)
      .filter(advisory => ['moderate', 'high', 'critical'].includes(advisory?.severity))
      .length;
  }
  return 0;
}

export function classifyAuditResult({status, stdout = '', stderr = '', error = null}) {
  if (status === 0 && !error) return 'passed';

  const report = parseReport(stdout);
  if (vulnerabilityCount(report) > 0) return 'vulnerabilities';

  const errorCode = String(error?.code || report?.error?.code || '');
  const combined = [errorCode, error?.message, report?.error?.summary, report?.error?.detail, stdout, stderr]
    .filter(Boolean)
    .join('\n');
  if (transientAuditPatterns.some(pattern => pattern.test(combined))) return 'transient-network';
  return 'failure';
}

export function conciseAuditFailure({stdout = '', stderr = '', error = null}) {
  const combined = [error?.message, stderr, stdout]
    .filter(Boolean)
    .join('\n');
  const line = combined
    .split(/\r?\n/)
    .map(value => value.trim())
    .find(value => transientAuditPatterns.some(pattern => pattern.test(value)));
  return line || '安全公告服务暂时不可用';
}
