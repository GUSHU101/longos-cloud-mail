import { parseHTML } from 'linkedom';

const emailUtils = {
	normalizeAddress(email) {
		return typeof email === 'string' ? email.trim().toLowerCase() : '';
	},

	configuredDomains(value) {
		if (Array.isArray(value)) {
			return value.map(item => String(item).trim().toLowerCase()).filter(Boolean);
		}
		if (typeof value !== 'string' || !value.trim()) return [];
		const input = value.trim();
		if (input.startsWith('[')) {
			try {
				const parsed = JSON.parse(input);
				if (Array.isArray(parsed)) return this.configuredDomains(parsed);
			} catch {
				return [];
			}
		}
		return input.split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
	},

	isAllowedDomain(email, configuredDomains) {
		const domain = this.getDomain(this.normalizeAddress(email)).toLowerCase();
		return !!domain && this.configuredDomains(configuredDomains).includes(domain);
	},

	getDomain(email) {
		if (typeof email !== 'string') return '';
		const parts = email.split('@');
		return parts.length === 2 ? parts[1] : '';
	},

	getName(email) {
		if (typeof email !== 'string') return '';
		const parts = email.trim().split('@');
		return parts.length === 2 ? parts[0] : '';
	},

	getBaseEmail(email) {
		const parts = email.split('@');
		if (parts.length !== 2) return '';
		const localPart = parts[0].split('+')[0];
		return localPart + '@' + parts[1];
	},

	formatText(text) {
		if (!text) return ''
		return text
			.split('\n')
			.map(line => {
				return line.replace(/[\u200B-\u200F\uFEFF\u034F\u200B-\u200F\u00A0\u3000\u00AD]/g, '')
					.replace(/\s+/g, ' ')
					.trim();
			})
			.join('\n')
			.replace(/\n{3,}/g, '\n')
			.trim();
	},

	htmlToText(content) {
		if (!content) return ''
		try {
			const wrappedContent = content.includes('<body')
				? content
				: `<!DOCTYPE html><html><body>${content}</body></html>`;
			const { document } = parseHTML(wrappedContent);
			document.querySelectorAll('style, script, title').forEach(el => el.remove());
			let text = document.body.innerText;
			return this.formatText(text);
		} catch (e) {
			console.error(e)
			return ''
		}
	}
};

export default emailUtils;
