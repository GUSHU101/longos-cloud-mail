const cloudflareApi = 'https://api.cloudflare.com/client/v4';

function responseError(body, text, status) {
  const details = Array.isArray(body?.errors)
    ? body.errors
      .map(error => [
        error?.code === undefined ? '' : `code ${error.code}`,
        String(error?.message || '').trim(),
      ].filter(Boolean).join(': '))
      .filter(Boolean)
      .join('; ')
    : '';
  return details || String(text || '').trim() || `HTTP ${status}`;
}

export async function inspectCloudflareR2Bucket({
  token,
  accountId,
  bucketName,
  fetchImpl = fetch,
}) {
  let response;
  try {
    response = await fetchImpl(
      `${cloudflareApi}/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucketName)}`,
      {
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
        headers: {accept: 'application/json', authorization: `Bearer ${token}`},
      },
    );
  } catch (error) {
    throw new Error(`读取 R2 ${bucketName} 时连接失败：${error.message}`);
  }

  const text = await response.text();
  let body = {};
  try { body = JSON.parse(text); } catch {}

  // The exact-bucket endpoint has an unambiguous 404. Other failures can mean
  // bad credentials, a missing permission, rate limiting or a control-plane
  // outage and must never be treated as permission to create a new bucket.
  if (response.status === 404) return {exists: false, bucket: null};
  if (!response.ok || body.success !== true || !body.result) {
    throw new Error(`无法读取 R2 ${bucketName}（HTTP ${response.status}）：${responseError(body, text, response.status)}`);
  }

  const actualName = String(body.result.name || '');
  if (actualName && actualName !== bucketName) {
    throw new Error(`Cloudflare 返回了不匹配的 R2：期望 ${bucketName}，实际 ${actualName}`);
  }
  return {exists: true, bucket: body.result};
}

export async function waitForCloudflareR2Bucket({
  inspect,
  bucketName,
  attempts = 8,
  delayMs = 2_500,
  delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await inspect();
    if (result.exists) return result.bucket;
    if (attempt < attempts) await delay(delayMs);
  }
  throw new Error(`R2 ${bucketName} 创建成功后未在 Cloudflare 控制面出现，请直接重跑部署。`);
}
