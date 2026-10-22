const cloudflareApi = 'https://api.cloudflare.com/client/v4';

const resourceChecks = [
  {
    key: 'workers',
    label: 'Worker',
    path: accountId => `/accounts/${encodeURIComponent(accountId)}/workers/scripts`,
    permission: 'Workers 产品范围 Admin（首次创建）或 Editor（更新）；旧界面为 Workers Scripts Write/Edit',
  },
  {
    key: 'd1',
    label: 'D1',
    path: accountId => `/accounts/${encodeURIComponent(accountId)}/d1/database?per_page=10`,
    permission: 'Account / D1 / Write（旧界面为 Edit）',
  },
  {
    key: 'kv',
    label: 'KV',
    path: accountId => `/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces?per_page=1`,
    permission: 'Account / Workers KV Storage / Write（旧界面为 Edit）',
  },
  {
    key: 'r2',
    label: 'R2',
    path: accountId => `/accounts/${encodeURIComponent(accountId)}/r2/buckets?per_page=1`,
    permission: 'Account / Workers R2 Storage / Write（旧界面为 Edit）',
    optional: 'r2',
  },
];

function responseError(body, text, status) {
  const errors = Array.isArray(body?.errors) ? body.errors : [];
  const details = errors
    .map(error => {
      const code = error?.code === undefined ? '' : `code ${error.code}`;
      const message = String(error?.message || '').trim();
      return [code, message].filter(Boolean).join(': ');
    })
    .filter(Boolean)
    .join('; ');
  return details || String(text || '').trim() || `HTTP ${status}`;
}

async function probe({check, token, accountId, fetchImpl}) {
  let response;
  try {
    response = await fetchImpl(`${cloudflareApi}${check.path(accountId)}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
      headers: {accept: 'application/json', authorization: `Bearer ${token}`},
    });
  } catch (error) {
    return {...check, ok: false, status: 0, reason: `连接失败：${error.message}`};
  }

  const text = await response.text();
  let body = {};
  try { body = JSON.parse(text); } catch {}
  if (!response.ok || body.success !== true) {
    return {
      ...check,
      ok: false,
      status: response.status,
      reason: responseError(body, text, response.status),
    };
  }
  return {...check, ok: true, status: response.status};
}

export async function preflightCloudflareAccountResources({
  token,
  accountId,
  includeR2 = false,
  fetchImpl = fetch,
}) {
  const checks = resourceChecks.filter(check => check.optional !== 'r2' || includeR2);
  const results = await Promise.all(checks.map(check => probe({
    check,
    token,
    accountId,
    fetchImpl,
  })));
  const failures = results.filter(result => !result.ok);
  if (failures.length > 0) {
    const detail = failures
      .map(result => `${result.label}（HTTP ${result.status || '不可用'}，${result.reason}；需要 ${result.permission}）`)
      .join('；');
    throw new Error(`账户级资源权限不足：${detail}。请重新创建 API Token，并把 Account Resources 限定到当前账户。`);
  }
  return results;
}
