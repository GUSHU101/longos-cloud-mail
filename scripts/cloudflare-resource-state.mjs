function selectCloudflareResource(rows, {
  pinnedId = '',
  expectedName,
  idField,
  nameField,
  label,
}) {
  if (!Array.isArray(rows)) throw new Error(`${label} 列表格式不正确。`);
  if (pinnedId) {
    const resource = rows.find(item => String(item?.[idField] || '') === pinnedId);
    if (!resource) throw new Error(`${label} ID 不属于当前 Cloudflare 账户。`);
    if (resource[nameField] !== expectedName) {
      throw new Error(`${label} ID 与名称 ${expectedName} 指向的资源不一致。`);
    }
    return resource;
  }

  const matches = rows.filter(item => item?.[nameField] === expectedName);
  if (matches.length > 1) {
    throw new Error(`发现多个名为 ${expectedName} 的 ${label}；请显式固定资源 ID。`);
  }
  return matches[0] || null;
}

async function waitForCloudflareResource({
  list,
  selection,
  attempts = 8,
  delayMs = 2_500,
  delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const resource = selectCloudflareResource(await list(), selection);
    if (resource) return resource;
    if (attempt < attempts) await delay(delayMs);
  }
  throw new Error(`${selection.label} ${selection.expectedName} 创建成功后未在控制面列表中出现，请直接重跑部署。`);
}

function resolveManagedR2BucketName(value, workerName) {
  const requested = String(value || '').trim();
  if (requested.toLowerCase() !== 'auto') return requested;
  const base = String(workerName || 'cloud-mail')
    .toLowerCase()
    .replaceAll('_', '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 51)
    .replace(/-$/g, '') || 'cloud-mail';
  return `${base}-attachments`;
}

export {
  resolveManagedR2BucketName,
  selectCloudflareResource,
  waitForCloudflareResource,
};
