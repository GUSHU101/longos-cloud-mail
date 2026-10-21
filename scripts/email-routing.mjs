const cloudflareApi = 'https://api.cloudflare.com/client/v4';

function errorMessage(body, fallback) {
  const message = Array.isArray(body?.errors)
    ? body.errors.map(error => error?.message).filter(Boolean).join('; ')
    : '';
  return message || fallback;
}
async function request(fetchImpl, token, path, options = {}) {
  try {
    const response = await fetchImpl(`${cloudflareApi}${path}`, {
      ...options,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(options.body ? {'content-type': 'application/json'} : {}),
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let body = {};
    try { body = JSON.parse(text); } catch {}
    return {ok: response.ok && body.success === true, status: response.status, body, text};
  } catch (error) {
    return {ok: false, status: 0, body: {}, text: error.message};
  }
}
function catchesAllToWorker(rule, workerName) {
  return rule?.enabled === true
    && rule?.matchers?.some(matcher => matcher?.type === 'all')
    && rule?.actions?.some(action => action?.type === 'worker' && action?.value?.[0] === workerName);
}

/**
 * Best-effort inbound setup. The Worker remains published with an older
 * token; callers receive exact domains so final acceptance can fail clearly.
 */
export async function configureEmailRouting({token, accountId, workerName, domains, fetchImpl = fetch}) {
  const configured = [];
  const manual = [];
  const warnings = [];

  for (const domain of domains) {
    const query = new URLSearchParams({name: domain, 'account.id': accountId, status: 'active', per_page: '2'});
    const zoneLookup = await request(fetchImpl, token, `/zones?${query}`);
    const zones = Array.isArray(zoneLookup.body?.result) ? zoneLookup.body.result : [];
    const zone = zones.find(item => item?.name?.toLowerCase() === domain && item?.account?.id === accountId)
      || zones.find(item => item?.name?.toLowerCase() === domain);
    if (!zoneLookup.ok || !zone?.id) {
      manual.push({
        domain,
        reason: errorMessage(zoneLookup.body, `无法读取活动 Zone（HTTP ${zoneLookup.status || 'network'}）`),
      });
      continue;
    }

    const base = `/zones/${encodeURIComponent(zone.id)}/email/routing`;
    const settings = await request(fetchImpl, token, base);
    let routingStatus = settings.body?.result?.status || '';
    if (!settings.ok && [401, 403].includes(settings.status)) {
      manual.push({domain, reason: errorMessage(settings.body, `Token 无 Email Routing 设置权限（HTTP ${settings.status}）`)});
      continue;
    }
    if (!settings.ok || settings.body?.result?.enabled !== true) {
      const enabled = await request(fetchImpl, token, `${base}/dns`, {method: 'POST'});
      if (!enabled.ok || enabled.body?.result?.enabled !== true) {
        manual.push({
          domain,
          reason: errorMessage(enabled.body, `无法启用 Email Routing（HTTP ${enabled.status || 'network'}）`),
        });
        continue;
      }
      routingStatus = enabled.body?.result?.status || routingStatus;
    }

    const markConfigured = () => {
      configured.push(domain);
      if (routingStatus && routingStatus !== 'ready') {
        warnings.push({
          domain,
          reason: `Email Routing 已启用且 Catch-all 正确，但 DNS 状态为 ${routingStatus}；请检查该域的 MX/SPF 冲突。`,
        });
      }
    };

    const catchAllPath = `${base}/rules/catch_all`;
    const current = await request(fetchImpl, token, catchAllPath);
    if (current.ok && catchesAllToWorker(current.body?.result, workerName)) {
      markConfigured();
      continue;
    }
    if (!current.ok && [401, 403].includes(current.status)) {
      manual.push({domain, reason: errorMessage(current.body, `Token 无 Email Routing Rules 权限（HTTP ${current.status}）`)});
      continue;
    }

    const updated = await request(fetchImpl, token, catchAllPath, {
      method: 'PUT',
      body: JSON.stringify({
        name: `LONGOS Cloud Mail → ${workerName}`,
        enabled: true,
        matchers: [{type: 'all'}],
        actions: [{type: 'worker', value: [workerName]}],
      }),
    });
    if (!updated.ok || !catchesAllToWorker(updated.body?.result, workerName)) {
      manual.push({
        domain,
        reason: errorMessage(updated.body, `Catch-all 配置验收失败（HTTP ${updated.status || 'network'}）`),
      });
      continue;
    }

    markConfigured();
  }

  return {configured, manual, warnings};
}
