const cloudflareApi = 'https://api.cloudflare.com/client/v4';

function apiFailure(body, fallback) {
  const messages = Array.isArray(body?.errors)
    ? body.errors.map(item => item?.message).filter(Boolean)
    : [];
  return messages.length > 0 ? messages.join('；') : fallback;
}

export async function assertWorkerCustomDomainOwnership({
  token,
  accountId,
  hostname,
  workerName,
  fetchImpl = fetch,
}) {
  if (!hostname) return {exists: false, service: ''};
  const normalizedHostname = String(hostname).trim().toLowerCase();
  const endpoint = new URL(`${cloudflareApi}/accounts/${accountId}/workers/domains`);
  endpoint.searchParams.set('hostname', normalizedHostname);
  endpoint.searchParams.set('per_page', '50');

  let response;
  try {
    response = await fetchImpl(endpoint, {
      headers: {authorization: `Bearer ${token}`, accept: 'application/json'},
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new Error(`无法检查 Worker 自定义域归属：${error.message}`);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`Worker 自定义域 API 返回了无效响应（HTTP ${response.status}）。`);
  }
  if (!response.ok || body?.success !== true) {
    throw new Error(`Worker 自定义域预检失败（HTTP ${response.status}）：${apiFailure(body, '请检查 Workers Scripts Read/Write 权限。')}`);
  }
  if (!Array.isArray(body.result)) throw new Error('Worker 自定义域 API 返回格式不正确。');

  const matches = body.result.filter(item => String(item?.hostname || '').toLowerCase() === normalizedHostname);
  if (matches.length > 1) {
    throw new Error(`Cloudflare 返回多个 ${normalizedHostname} 自定义域绑定；请先在 Workers & Pages 中清理重复项。`);
  }
  if (matches.length === 0) return {exists: false, service: ''};

  const service = String(matches[0]?.service || '').trim();
  if (!service) throw new Error(`自定义域 ${normalizedHostname} 已存在，但 Cloudflare 未返回其 Worker 名称。`);
  if (service !== workerName) {
    throw new Error(
      `升级保护：自定义域 ${normalizedHostname} 当前属于 Worker ${service}，`
      + `但本次填写的是 ${workerName}。请把 Worker 名称和 D1 名称改回 ${service}；`
      + '不要创建新 Worker、D1 或 KV，也不要删除现有邮件数据。',
    );
  }
  return {exists: true, service, enabled: matches[0]?.enabled !== false};
}

