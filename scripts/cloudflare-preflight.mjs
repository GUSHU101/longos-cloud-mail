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

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function preflightCloudflareZones({
  token,
  accountId,
  customDomain = '',
  mailDomains = [],
  autoConfigureEmailRouting = true,
  fetchImpl = fetch,
}) {
  // Cache promises, not only completed responses. The custom hostname and its
  // inbound domain commonly resolve to the same Zone, and both checks start in
  // parallel. Promise caching guarantees only one Cloudflare API request.
  const zoneLookups = new Map();
  const lookupZone = domain => {
    const normalized = String(domain || '').trim().toLowerCase();
    if (!zoneLookups.has(normalized)) {
      const query = new URLSearchParams({
        name: normalized,
        'account.id': accountId,
        status: 'active',
        per_page: '2',
      });
      zoneLookups.set(normalized, request(fetchImpl, token, `/zones?${query}`).then(result => {
        const zones = Array.isArray(result.body?.result) ? result.body.result : [];
        const zone = zones.find(item => (
          item?.name?.toLowerCase() === normalized && item?.account?.id === accountId
        ));
        return {domain: normalized, zone, ...result};
      }));
    }
    return zoneLookups.get(normalized);
  };

  const findExactZone = async domain => {
    let result;
    try {
      result = await lookupZone(domain);
    } catch (error) {
      throw new Error(`读取活动 Zone ${domain} 时连接失败：${errorMessage(error)}。`);
    }
    if (!result.response.ok || result.body.success !== true || !result.zone?.id) {
      throw new Error(`无法读取活动 Zone ${domain}（HTTP ${result.response.status}）：${apiMessage(result, '请检查 Zone:Read 和资源范围')}。`);
    }
    return result.zone;
  };

  const findParentZone = async hostname => {
    const labels = hostname.split('.');
    for (let index = 0; index < labels.length - 1; index += 1) {
      const candidate = labels.slice(index).join('.');
      let result;
      try {
        result = await lookupZone(candidate);
      } catch (error) {
        throw new Error(`读取 ${hostname} 所在 Zone 时连接失败：${errorMessage(error)}。`);
      }
      if (result.response.ok && result.body.success === true && result.zone?.id) return result.zone;
      if ([401, 403].includes(result.response.status)) {
        throw new Error(`无权读取 ${hostname} 所在 Zone；请增加 Zone:Read，并把该 Zone 加入 Token 资源范围。`);
      }
      // An empty successful lookup means only that this candidate is not a
      // Zone apex, so parent discovery may continue. Server/API failures must
      // not be silently misreported as a missing domain.
      if (!result.response.ok || result.body.success !== true) {
        throw new Error(`读取 ${candidate} 时 Cloudflare API 失败（HTTP ${result.response.status}）：${apiMessage(result, '未知 API 错误')}。`);
      }
    }
    throw new Error(`找不到 ${hostname} 所在的活动 Zone；请确认域名状态为 Active 且属于当前账户。`);
  };

  const customZoneTask = customDomain ? findParentZone(customDomain) : Promise.resolve(null);
  const mailZoneTasks = autoConfigureEmailRouting
    ? mailDomains.map(domain => findExactZone(domain))
    : [];
  const zoneResults = await Promise.allSettled([customZoneTask, ...mailZoneTasks]);
  const issues = [];
  const customZoneResult = zoneResults[0];
  if (customZoneResult.status === 'rejected') {
    issues.push(`自定义域 ${customDomain}：${errorMessage(customZoneResult.reason)}`);
  }

  const resolvedMailZones = [];
  zoneResults.slice(1).forEach((result, index) => {
    const domain = mailDomains[index];
    if (result.status === 'fulfilled') {
      resolvedMailZones.push({domain, zone: result.value});
    } else {
      issues.push(`收信域 ${domain}：${errorMessage(result.reason)}`);
    }
  });

  // Email Routing settings are independent per Zone. Probe all readable Zones
  // concurrently and report every missing permission/API failure in one run.
  const routingResults = await Promise.allSettled(resolvedMailZones.map(async ({domain, zone}) => {
    let settings;
    try {
      settings = await request(fetchImpl, token, `/zones/${encodeURIComponent(zone.id)}/email/routing`);
    } catch (error) {
      throw new Error(`读取 Email Routing 时连接失败：${errorMessage(error)}。`);
    }
    if (!settings.response.ok || settings.body.success !== true || !settings.body?.result) {
      throw new Error(`无法读取 Email Routing（HTTP ${settings.response.status}）：${apiMessage(settings, '请增加 Zone Settings:Write 和 Email Routing Rules:Write')}。`);
    }
    return {domain, zone, enabled: settings.body.result.enabled === true};
  }));

  const routing = [];
  routingResults.forEach((result, index) => {
    const domain = resolvedMailZones[index].domain;
    if (result.status === 'fulfilled') {
      routing.push(result.value);
    } else {
      issues.push(`收信域 ${domain}：${errorMessage(result.reason)}`);
    }
  });

  if (issues.length > 0) {
    throw new Error(`Cloudflare Zone / Email Routing 预检发现 ${issues.length} 项问题：\n- ${issues.join('\n- ')}`);
  }

  return {
    customZone: customZoneResult.value,
    routing,
  };
}
