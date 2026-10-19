const domainUtils = {
	toOssDomain(domain) {

		if (!domain) {
			return null
		}

		if (!domain.startsWith('http')) {
			return 'https://' + domain
		}

		if (domain.endsWith("/")) {
			domain = domain.slice(0, -1);
		}

		return domain
	}
}

function isPrivateHostname(hostname) {
	const normalized = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
	if (
		!normalized
		|| normalized === 'localhost'
		|| normalized.endsWith('.localhost')
		|| normalized.endsWith('.local')
		|| normalized.endsWith('.internal')
		|| normalized.endsWith('.home.arpa')
	) return true;
	if (normalized.includes(':')) {
		const compact = normalized.replace(/^0+(?=[0-9a-f])/g, '');
		return compact.startsWith('::')
			|| compact.startsWith('fc')
			|| compact.startsWith('fd')
			|| /^fe[89ab]/.test(compact);
	}
	const parts = normalized.split('.').map(Number);
	if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
	return parts[0] === 10
		|| parts[0] === 127
		|| (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
		|| (parts[0] === 169 && parts[1] === 254)
		|| (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
		|| (parts[0] === 192 && parts[1] === 168)
		|| (parts[0] === 192 && parts[1] === 0 && (parts[2] === 0 || parts[2] === 2))
		|| (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19 || (parts[1] === 51 && parts[2] === 100)))
		|| (parts[0] === 203 && parts[1] === 0 && parts[2] === 113)
		|| parts[0] === 0
		|| parts[0] >= 224;
}

function normalizeWebhookUrl(value) {
	const raw = String(value || '').trim();
	if (!raw) return '';

	let url;
	try {
		url = new URL(raw);
	} catch {
		throw new Error('Invalid webhook URL');
	}
	if (url.protocol !== 'https:') throw new Error('Webhook URL must use HTTPS');
	if (url.username || url.password) throw new Error('Webhook URL must not contain credentials');
	if (url.hash) throw new Error('Webhook URL must not contain a fragment');
	if (isPrivateHostname(url.hostname)) throw new Error('Webhook URL must use a public host');
	url.pathname = url.pathname || '/';
	return url.toString();
}

function normalizePublicImageUrl(value) {
	const raw = String(value || '').trim();
	if (!raw) return '';
	if (raw.length > 2048) throw new Error('Image URL is too long');

	let url;
	try {
		url = new URL(raw);
	} catch {
		throw new Error('Invalid image URL');
	}
	if (url.protocol !== 'https:') throw new Error('Image URL must use HTTPS');
	if (url.username || url.password) throw new Error('Image URL must not contain credentials');
	if (url.hash) throw new Error('Image URL must not contain a fragment');
	if (isPrivateHostname(url.hostname)) throw new Error('Image URL must use a public host');
	return url.toString();
}

function normalizePublicBaseUrl(value, label = 'URL') {
	const raw = String(value || '').trim();
	if (!raw) return '';
	if (raw.length > 2048) throw new Error(`${label} is too long`);

	let url;
	try {
		url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
	} catch {
		throw new Error(`Invalid ${label}`);
	}
	if (url.protocol !== 'https:') throw new Error(`${label} must use HTTPS`);
	if (url.username || url.password) throw new Error(`${label} must not contain credentials`);
	if (url.search || url.hash) throw new Error(`${label} must not contain a query or fragment`);
	if (isPrivateHostname(url.hostname)) throw new Error(`${label} must use a public host`);
	return url.toString().replace(/\/+$/, '');
}

export { isPrivateHostname, normalizePublicBaseUrl, normalizePublicImageUrl, normalizeWebhookUrl };
export default domainUtils
