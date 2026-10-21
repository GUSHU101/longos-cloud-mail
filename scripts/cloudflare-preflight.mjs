const cloudflareApi = 'https://api.cloudflare.com/client/v4';

async function request(fetchImpl, token, path) {
  const response = await fetchImpl(`${cloudflareApi}${path}`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
    headers: {accept: 'application/json', authorization: `Bearer ${token}`},
  });
  const text = await response.text();
  let body = {};
  try { body = JSON.parse(text); } catch {}
  return {response, body, text};
}

function apiMessage(result, fallback) {
  const messages = Array.isArray(result.body?.errors)
    ? result.body.errors.map(item => item?.message).filter(Boolean).join('; ')
    : '';
  return messages || result.text || fallback;
}

export async function preflightCloudflareZones({
  token,
  accountId,
  customDomain = '',
  mailDomains = [],
  autoConfigureEmailRouting = true,
  fetchImpl = fetch,
}) {
  const findExactZone = async domain => {
    const query = new URLSearchParams({name: domain, 'account.id': accountId, status: 'active', per_page: '2'});
    const result = await request(fetchImpl, token, `/zones?${query}`);
    const zones = Array.isArray(result.body?.result) ? result.body.result : [];
    const zone = zones.find(item => item?.name?.toLowerCase() === domain && item?.account?.id === accountId);
    if (!result.response.ok || result.body.success !== true || !zone?.id) {
      throw new Error(`无法读取活动 Zone ${domain}（HTTP ${result.response.status}）：${apiMessage(result, '请检查 Zone:Read 和资源范围')}。`);
    }
    return zone;
  };

  const findParentZone = async hostname => {
    const labels = hostname.split('.');
    for (let index = 0; index < labels.length - 1; index += 1) {
      const candidate = labels.slice(index).join('.');
      const query = new URLSearchParams({name: candidate, 'account.id': accountId, status: 'active', per_page: '2'});
      const result = await request(fetchImpl, token, `/zones?${query}`);
      const zone = Array.isArray(result.body?.result)
        ? result.body.result.find(item => item?.name?.toLowerCase() === candidate && item?.account?.id === accountId)
        : null;
      if (result.response.ok && result.body.success === true && zone?.id) return zone;
      if ([401, 403].includes(result.response.status)) {
        throw new Error(`无权读取 ${hostname} 所在 Zone；请增加 Zone:Read，并把该 Zone 加入 Token 资源范围。`);
      }
    }
    throw new Error(`找不到 ${hostname} 所在的活动 Zone；请确认域名状态为 Active 且属于当前账户。`);
  };

  const customZone = customDomain ? await findParentZone(customDomain) : null;
  const routing = [];
  if (autoConfigureEmailRouting) {
    for (const domain of mailDomains) {
      const zone = await findExactZone(domain);
      const settings = await request(fetchImpl, token, `/zones/${encodeURIComponent(zone.id)}/email/routing`);
      if ([401, 403].includes(settings.response.status)) {
        throw new Error(`无权读取 ${domain} 的 Email Routing（HTTP ${settings.response.status}）：${apiMessage(settings, '请增加 Zone Settings:Write 和 Email Routing Rules:Write')}。`);
      }
      routing.push({domain, zone, enabled: settings.response.ok && settings.body?.result?.enabled === true});
    }
  }
  return {customZone, routing};
}
