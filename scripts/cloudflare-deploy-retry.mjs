const DEFAULT_DELAYS_MS = Object.freeze([5_000, 15_000, 30_000]);

function deploymentOutput(result) {
  return `${result?.stdout || ''}\n${result?.stderr || ''}`;
}

export function isRetryableCloudflareAssetsFailure(result) {
  if (!result || result.status === 0) return false;

  const output = deploymentOutput(result);
  if (!/assets-upload-session/i.test(output)) return false;

  return /(?:\b(?:HTTP\s*)?5\d{2}\b|Internal Server Error|\bcode\s*[:=]?\s*10013\b|\[code:\s*10013\]|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up)/i.test(output);
}

export async function deployWithCloudflareRetry(runAttempt, {
  delaysMs = DEFAULT_DELAYS_MS,
  sleep = delayMs => new Promise(resolve => setTimeout(resolve, delayMs)),
  onRetry = () => {},
} = {}) {
  if (typeof runAttempt !== 'function') throw new TypeError('runAttempt must be a function.');
  if (!Array.isArray(delaysMs)) throw new TypeError('delaysMs must be an array.');

  const maximumAttempts = delaysMs.length + 1;
  let result;

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    result = await runAttempt(attempt);
    if (result?.status === 0) return {...result, attempts: attempt};
    if (!isRetryableCloudflareAssetsFailure(result) || attempt === maximumAttempts) {
      return {...result, attempts: attempt};
    }

    const delayMs = delaysMs[attempt - 1];
    onRetry({attempt, delayMs, maximumAttempts, result});
    await sleep(delayMs);
  }

  return {...result, attempts: maximumAttempts};
}
