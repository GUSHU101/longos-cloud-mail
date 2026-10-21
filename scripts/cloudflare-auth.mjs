const TOKEN_VERIFY_ENDPOINT = 'https://api.cloudflare.com/client/v4/user/tokens/verify';

export async function verifyCloudflareApiToken({token, fetchImpl = fetch}) {
  const value = String(token || '').trim();
  if (!value || value !== token || /[\r\n]/.test(value)) {
    throw new Error('CLOUDFLARE_API_TOKEN 格式不正确。请使用 Cloudflare API Token，不要使用 Global API Key。');
  }

  let response;
  try {
    response = await fetchImpl(TOKEN_VERIFY_ENDPOINT, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${value}`,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error(`无法连接 Cloudflare 验证 API Token：${error.message}`);
  }

  let body = {};
  try {
    body = await response.json();
  } catch {}

  if (!response.ok || body.success !== true || body.result?.status !== 'active') {
    const reason = body.errors?.[0]?.message || `HTTP ${response.status}`;
    throw new Error(`Cloudflare API Token 无效或未激活（${reason}）。Global API Key 不受支持；请创建仅限目标账户和域名的 API Token。`);
  }

  return {
    id: body.result.id || '',
    status: body.result.status,
    expiresOn: body.result.expires_on || null,
  };
}
