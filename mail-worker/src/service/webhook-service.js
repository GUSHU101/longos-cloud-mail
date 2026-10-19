import { normalizeWebhookUrl } from '../utils/domain-uitls';

const MAX_WEBHOOK_ATTEMPTS = 4;
const WEBHOOK_TIMEOUT_MS = 10_000;

const webhookService = {

	async sendEmail(c, emailRow, webhookUrl, retry = 0, webhookSecret) {

		try {
			webhookUrl = normalizeWebhookUrl(webhookUrl);
		} catch (error) {
			console.error(`Webhook 配置无效: ${error.message}`);
			return;
		}
		if (!webhookUrl) {
			return;
		}

		retry = Number(retry);
		if (!Number.isSafeInteger(retry) || retry < 0) {
			retry = 0;
		}
		retry = Math.min(retry, MAX_WEBHOOK_ATTEMPTS - 1);

		const headers = {
			'Content-Type': 'application/json'
		};

		if (webhookSecret) {
			headers['Authorization'] = webhookSecret;
		}

		const body = JSON.stringify({
			emailId: emailRow.emailId,
			sendEmail: emailRow.sendEmail,
			sendName: emailRow.name,
			toEmail: emailRow.toEmail,
			toName: emailRow.toName,
			subject: emailRow.subject,
			text: emailRow.text,
			content: emailRow.content,
			code: emailRow.code,
			createTime: emailRow.createTime
		});

		let lastError = '';

		for (let i = 0; i <= retry; i++) {
			try {
				const res = await fetch(webhookUrl, {
					method: 'POST',
					headers,
					body,
					signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
				});

				if (res.ok) {
					return;
				}

				lastError = `status: ${res.status}`;
			} catch (e) {
				lastError = e.message;
			}
		}

		console.error(`Webhook 推送失败: ${lastError}`);
	}

};

export { MAX_WEBHOOK_ATTEMPTS, WEBHOOK_TIMEOUT_MS };
export default webhookService;
