import { UAParser } from 'ua-parser-js';

function boundedText(value, maximumLength = 255) {
	return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, maximumLength);
}

const reqUtils = {
	getIp(c) {
		const cloudflareIp = c.req.header('CF-Connecting-IP');
		const forwardedIp = String(c.req.header('X-Forwarded-For') || '').split(',')[0].trim();
		return boundedText(cloudflareIp || forwardedIp || 'Unknown', 64);
	},

	getUserAgent(c) {
		const ua = c.req.header('user-agent') || '';

		const parser = new UAParser(ua);
		const { browser, device, os } = parser.getResult();

		let browserInfo = null;
		let osInfo = null;

		if (browser.name) {
			browserInfo = browser.name + ' ' + browser.version;
		}

		if (os.name) {
			osInfo = os.name + os.version;
		}

		let deviceInfo = 'Desktop';

		const hasVendor = !!device?.vendor;
		const hasModel = !!device?.model;

		if (hasVendor || hasModel) {
			const vendor = device.vendor || '';
			const model = device.model || '';
			const type = device.type || '';

			const namePart = [vendor, model].filter(Boolean).join(' ');
			const typePart = type ? ` (${type})` : '';
			deviceInfo = (namePart + typePart).trim();
		}

		return {
			browser: boundedText(browserInfo),
			device: boundedText(deviceInfo),
			os: boundedText(osInfo),
		}
	}
}

export { boundedText };
export default reqUtils
