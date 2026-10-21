import {isIP} from 'node:net';

const cloudflareApi = 'https://api.cloudflare.com/client/v4';

function validRecordName(value) {
  const name = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  return name.length <= 253
    && name.includes('.')
    && name.split('.').every(label => /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/i.test(label));
}

function apiError(body, fallback) {
  const message = Array.isArray(body?.errors)
    ? body.errors.map(error => error?.message).filter(Boolean).join('; ')
    : '';
  return message || fallback;
}

async function request(fetchImpl, token, path, options = {}) {
  const response = await fetchImpl(`${cloudflareApi}${path}`, {
    ...options,
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      ...(options.body ? {'content-type': 'application/json'} : {}),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body = {};
  try { body = JSON.parse(text); } catch {}
  if (!response.ok || body.success !== true) {
    throw new Error(apiError(body, `Cloudflare DNS API 请求失败（HTTP ${response.status}）`));
  }
  return body.result;
}

function isSpfPolicy(value) {
  return /^v=spf1(?:\s|$)/i.test(String(value || '').trim().replace(/^"|"$/g, ''));
}

export function mergeSpfPolicies(policies, requiredMechanism, name) {
  const mechanisms = [];
  const seen = new Set();
  const modifiers = new Map();
  const allRank = new Map([['-', 0], ['~', 1], ['?', 2], ['+', 3]]);
  let all = null;

  for (const rawPolicy of policies) {
    const policy = String(rawPolicy || '').trim().replace(/^"|"$/g, '');
    if (!isSpfPolicy(policy)) throw new Error(`${name} 包含格式无效的 SPF 版本标记。`);
    const tokens = policy.split(/\s+/).slice(1);
    for (const token of tokens) {
      const allMatch = token.match(/^([+\-~?]?)(all)$/i);
      if (allMatch) {
        const qualifier = allMatch[1] || '+';
        if (qualifier === '+') throw new Error(`${name} 的 SPF 包含 +all，已拒绝不安全策略。`);
        if (all === null || allRank.get(qualifier) > allRank.get(all)) all = qualifier;
        continue;
      }
      const modifierMatch = token.match(/^(redirect|exp)=/i);
      if (modifierMatch) {
        const key = modifierMatch[1].toLowerCase();
        if (!modifiers.has(key)) modifiers.set(key, new Map());
        modifiers.get(key).set(token.toLowerCase(), token);
        continue;
      }
      const key = token.toLowerCase();
      if (key && !seen.has(key)) {
        seen.add(key);
        mechanisms.push(token);
      }
    }
  }

  if (modifiers.has('redirect')) throw new Error(`${name} 的 SPF 使用 redirect=，无法安全自动合并。`);
  if ((modifiers.get('exp')?.size || 0) > 1) throw new Error(`${name} 的 SPF 包含多个不同 exp= 修饰符。`);
  if (!seen.has(requiredMechanism.toLowerCase())) mechanisms.push(requiredMechanism);
  for (const values of modifiers.values()) mechanisms.push(values.values().next().value);

  const lookups = mechanisms.filter(value => /^[+\-~?]?(?:include:|a(?::|\/|$)|mx(?::|\/|$)|ptr(?::|$)|exists:)/i.test(value)).length;
  if (lookups > 10) throw new Error(`${name} 的 SPF 至少需要 ${lookups} 次 DNS 查询，超过 10 次上限。`);
  return `v=spf1 ${[...mechanisms, `${all || '-'}all`].join(' ')}`;
}

function validateManifest(records) {
  if (!Array.isArray(records) || records.length === 0 || records.length > 100) {
    throw new Error('LONGOS 返回的邮件 DNS 清单为空或超过 100 条。');
  }

  const seen = new Set();
  const normalized = records.map(record => {
    const type = String(record?.type || '').toUpperCase();
    const name = String(record?.name || '').trim().toLowerCase().replace(/\.$/, '');
    const value = String(record?.value || '').trim();
    const mode = String(record?.mode || '');
    if (record?.available !== true || !['A', 'AAAA', 'TXT'].includes(type)
      || !validRecordName(name) || !['managed', 'merged', 'if_missing'].includes(mode)
      || !value || value.length > 4096 || /[\r\n]/.test(value)) {
      throw new Error('LONGOS 返回了无效或尚未就绪的邮件 DNS 记录。');
    }
    if (type === 'A' && isIP(value) !== 4) throw new Error(`${name} 的 A 记录值无效。`);
    if (type === 'AAAA' && isIP(value) !== 6) throw new Error(`${name} 的 AAAA 记录值无效。`);
    if (['A', 'AAAA'].includes(type) && mode !== 'managed') throw new Error(`${name} 的地址记录模式无效。`);
    if (mode === 'managed' && type === 'TXT' && !/^v=DKIM1;/i.test(value)) throw new Error(`${name} 的 DKIM 记录值无效。`);
    if (mode === 'merged' && (type !== 'TXT' || !/^v=spf1\s+a:[a-z0-9.-]+\s+-all$/i.test(value))) throw new Error(`${name} 的 SPF 清单值无效。`);
    if (mode === 'if_missing' && (type !== 'TXT' || !/^v=DMARC1;/i.test(value))) throw new Error(`${name} 的 DMARC 清单值无效。`);
    const key = `${type}\0${name}\0${value}\0${mode}`;
    if (seen.has(key)) throw new Error(`LONGOS DNS 清单包含重复记录：${type} ${name}`);
    seen.add(key);
    return {type, name, value, mode};
  });

  const spfRecords = normalized.filter(record => record.mode === 'merged');
  const signingDomains = new Set(spfRecords.map(record => record.name));
  const mailHosts = new Set(spfRecords.map(record => record.value.split(/\s+/)[1].slice(2).toLowerCase()));
  for (const record of normalized) {
    if (record.type === 'TXT' && record.mode === 'managed') {
      const match = record.name.match(/^[a-z0-9][a-z0-9_-]{0,62}\._domainkey\.(.+)$/i);
      if (!match || !signingDomains.has(match[1])) throw new Error(`${record.name} 不是已声明发件域的 DKIM 记录。`);
    }
    if (record.mode === 'if_missing' && !record.name.startsWith('_dmarc.')) {
      throw new Error(`${record.name} 不是有效的 DMARC 记录名。`);
    }
    if (record.mode === 'if_missing' && !signingDomains.has(record.name.slice('_dmarc.'.length))) {
      throw new Error(`${record.name} 不属于已声明的发件域。`);
    }
    if (['A', 'AAAA'].includes(record.type) && !mailHosts.has(record.name)) {
      throw new Error(`${record.name} 未被 SPF 清单声明为邮件主机。`);
    }
  }
  for (const domain of signingDomains) {
    if (!normalized.some(record => record.type === 'TXT' && record.mode === 'managed' && record.name.endsWith(`._domainkey.${domain}`))) {
      throw new Error(`${domain} 缺少 DKIM 公开记录。`);
    }
    if (!normalized.some(record => record.mode === 'if_missing' && record.name === `_dmarc.${domain}`)) {
      throw new Error(`${domain} 缺少 DMARC 建议记录。`);
    }
  }

  return normalized;
}

async function fetchManifest({relayUrl, integrationToken, fetchImpl}) {
  const response = await fetchImpl(`${relayUrl.replace(/\/$/, '')}/dns/manifest`, {
    method: 'GET',
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
    headers: {accept: 'application/json', authorization: `Bearer ${integrationToken}`},
  });
  const text = await response.text();
  let body = {};
  try { body = JSON.parse(text); } catch {}
  if (!response.ok || body?.status !== 'ok') {
    const error = new Error(body?.message || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return validateManifest(body.records);
}

/**
 * LONGOS exposes only public DKIM/SPF/DMARC/address material. The protected
 * deployment runner performs every Cloudflare API request, so its API Token
 * is never transmitted to or stored by LONGOS.
 */
export async function syncLongosOutboundDns({
  relayUrl,
  integrationToken,
  cloudflareToken,
  accountId = '',
  fetchImpl = fetch,
  delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
}) {
  if (!relayUrl || !integrationToken) return {configured: false, skipped: true, reason: 'LONGOS gateway is not configured'};

  try {
    let manifest;
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      try {
        manifest = await fetchManifest({relayUrl, integrationToken, fetchImpl});
        break;
      } catch (error) {
        if (error.status !== 503 || attempt === 6) throw error;
        await delay(5_000);
      }
    }
    const result = {created: [], updated: [], removed: [], preserved: [], warnings: []};
    const zoneCache = new Map();

    const resolveZone = async name => {
      const labels = name.split('.');
      for (let index = 0; index < labels.length - 1; index += 1) {
        const candidate = labels.slice(index).join('.');
        if (zoneCache.has(candidate)) return zoneCache.get(candidate);
        const query = new URLSearchParams({name: candidate, status: 'active', per_page: '2'});
        if (accountId) query.set('account.id', accountId);
        const zones = await request(fetchImpl, cloudflareToken, `/zones?${query}`);
        const zone = Array.isArray(zones) ? zones.find(item => item?.name?.toLowerCase() === candidate
          && (!accountId || item?.account?.id === accountId)) : null;
        if (zone?.id) {
          zoneCache.set(candidate, zone);
          return zone;
        }
      }
      throw new Error(`Cloudflare Token 无法访问 ${name} 所在的活动 Zone。`);
    };

    const recordsFor = async (zoneId, type, name) => {
      const query = new URLSearchParams({type, name, per_page: '100'});
      const records = await request(fetchImpl, cloudflareToken, `/zones/${encodeURIComponent(zoneId)}/dns_records?${query}`);
      return Array.isArray(records) ? records : [];
    };

    const applyManagedTxt = async record => {
      const zone = await resolveZone(record.name);
      const existing = await recordsFor(zone.id, record.type, record.name);
      if (existing.length > 1) throw new Error(`${record.name} 存在多条 ${record.type} 记录，已停止以避免覆盖人工配置。`);
      if (existing.length === 1 && !existing[0]?.id) throw new Error(`${record.name} 的 ${record.type} 记录缺少 ID。`);
      const label = `${record.type} ${record.name}`;
      const payload = {type: record.type, name: record.name, content: record.value, ttl: 1, proxied: false};
      if (existing.length === 0) {
        await request(fetchImpl, cloudflareToken, `/zones/${zone.id}/dns_records`, {method: 'POST', body: JSON.stringify(payload)});
        result.created.push(label);
      } else if (String(existing[0].content || '').replace(/^"|"$/g, '') === record.value && existing[0].proxied !== true) {
        result.preserved.push(label);
      } else {
        await request(fetchImpl, cloudflareToken, `/zones/${zone.id}/dns_records/${existing[0].id}`, {method: 'PUT', body: JSON.stringify(payload)});
        result.updated.push(label);
      }
    };

    const applySpf = async record => {
      const zone = await resolveZone(record.name);
      let existing = await recordsFor(zone.id, 'TXT', record.name);
      let policies = existing.filter(item => isSpfPolicy(item?.content));
      if (policies.some(item => item?.locked === true)) {
        await request(fetchImpl, cloudflareToken, `/zones/${zone.id}/email/routing/dns`, {method: 'PATCH'});
        existing = await recordsFor(zone.id, 'TXT', record.name);
        policies = existing.filter(item => isSpfPolicy(item?.content));
      }
      if (policies.some(item => item?.locked === true)) throw new Error(`${record.name} 的 SPF 仍被 Cloudflare 锁定。`);
      const requiredMechanism = record.value.split(/\s+/)[1];
      const label = `TXT ${record.name}`;
      if (policies.length === 0) {
        await request(fetchImpl, cloudflareToken, `/zones/${zone.id}/dns_records`, {
          method: 'POST', body: JSON.stringify({type: 'TXT', name: record.name, content: record.value, ttl: 1, proxied: false}),
        });
        result.created.push(label);
        return;
      }
      if (policies.some(item => !item?.id)) throw new Error(`${record.name} 的 SPF 记录缺少 ID。`);
      const contents = policies.map(item => String(item.content || '').trim().replace(/^"|"$/g, ''));
      const merged = mergeSpfPolicies(contents, requiredMechanism, record.name);
      if (policies.length === 1 && contents[0].replace(/\s+/g, ' ').toLowerCase() === merged.toLowerCase()) {
        result.preserved.push(label);
        return;
      }
      await request(fetchImpl, cloudflareToken, `/zones/${zone.id}/dns_records/${policies[0].id}`, {
        method: 'PATCH', body: JSON.stringify({content: merged}),
      });
      result.updated.push(label);
      for (const duplicate of policies.slice(1)) {
        await request(fetchImpl, cloudflareToken, `/zones/${zone.id}/dns_records/${duplicate.id}`, {method: 'DELETE'});
        result.removed.push(label);
      }
    };

    const applyIfMissing = async record => {
      const zone = await resolveZone(record.name);
      const existing = await recordsFor(zone.id, 'TXT', record.name);
      const policies = existing.filter(item => /^v=DMARC1;/i.test(String(item?.content || '').trim().replace(/^"|"$/g, '')));
      const label = `TXT ${record.name}`;
      if (policies.length > 0) {
        result.preserved.push(label);
        if (policies.length > 1) result.warnings.push(`${record.name} 存在多条 DMARC 策略，请人工合并。`);
        return;
      }
      await request(fetchImpl, cloudflareToken, `/zones/${zone.id}/dns_records`, {
        method: 'POST', body: JSON.stringify({type: 'TXT', name: record.name, content: record.value, ttl: 1, proxied: false}),
      });
      result.created.push(label);
    };

    for (const record of manifest.filter(item => item.type === 'TXT')) {
      if (record.mode === 'managed') await applyManagedTxt(record);
      else if (record.mode === 'merged') await applySpf(record);
      else await applyIfMissing(record);
    }

    const addressGroups = new Map();
    for (const record of manifest.filter(item => ['A', 'AAAA'].includes(item.type))) {
      const key = `${record.type}\0${record.name}`;
      if (!addressGroups.has(key)) addressGroups.set(key, []);
      addressGroups.get(key).push(record);
    }
    for (const records of addressGroups.values()) {
      const {type, name} = records[0];
      const zone = await resolveZone(name);
      const existing = await recordsFor(zone.id, type, name);
      if (existing.some(item => !item?.id)) throw new Error(`${name} 的 ${type} 记录缺少 ID。`);
      const used = new Set();
      for (const record of records) {
        const match = existing.find(item => !used.has(item.id) && item.content === record.value);
        const label = `${type} ${name}`;
        if (match && match.proxied !== true) {
          used.add(match.id);
          result.preserved.push(label);
        } else if (match) {
          await request(fetchImpl, cloudflareToken, `/zones/${zone.id}/dns_records/${match.id}`, {
            method: 'PUT', body: JSON.stringify({type, name, content: record.value, ttl: 1, proxied: false}),
          });
          used.add(match.id);
          result.updated.push(label);
        } else {
          const created = await request(fetchImpl, cloudflareToken, `/zones/${zone.id}/dns_records`, {
            method: 'POST', body: JSON.stringify({type, name, content: record.value, ttl: 1, proxied: false}),
          });
          if (created?.id) used.add(created.id);
          result.created.push(label);
        }
      }
      for (const stale of existing.filter(item => !used.has(item.id))) {
        await request(fetchImpl, cloudflareToken, `/zones/${zone.id}/dns_records/${stale.id}`, {method: 'DELETE'});
        result.removed.push(`${type} ${name}`);
      }
    }

    return {configured: true, skipped: false, sync: result};
  } catch (error) {
    return {configured: false, skipped: error.status === 404, reason: error.message};
  }
}
