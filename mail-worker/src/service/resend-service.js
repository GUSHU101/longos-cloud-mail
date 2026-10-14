import emailService from './email-service';
import { emailConst } from '../const/entity-const';
import BizError from '../error/biz-error';
import { Resend } from 'resend';

const resendWebhookVerifier = new Resend('re_webhook_verification_only');
const MAX_WEBHOOK_BYTES = 1024 * 1024;
const SUPPORTED_WEBHOOK_TYPES = new Set([
	'email.sent',
	'email.delivered',
	'email.complained',
	'email.bounced',
	'email.delivery_delayed',
	'email.failed',
]);

function verifyWebhook(c, payload) {
	const webhookSecret = String(c.env.RESEND_WEBHOOK_SECRET || '').trim();
	if (webhookSecret.length < 16) {
		throw new BizError('Resend webhook verification is not configured', 503);
	}
	if (typeof payload !== 'string' || new TextEncoder().encode(payload).byteLength > MAX_WEBHOOK_BYTES) {
		throw new BizError('Webhook payload is too large', 413);
	}

	try {
		return resendWebhookVerifier.webhooks.verify({
			payload,
			headers: {
				id: c.req.header('svix-id') || '',
				timestamp: c.req.header('svix-timestamp') || '',
				signature: c.req.header('svix-signature') || '',
			},
			webhookSecret,
		});
	} catch {
		throw new BizError('Invalid Resend webhook signature', 400);
	}
}

function statusUpdateForWebhook(body) {
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		throw new BizError('Invalid Resend webhook payload', 400);
	}
	if (!SUPPORTED_WEBHOOK_TYPES.has(body.type)) return null;

	const resendEmailId = body.data?.email_id;
	if (typeof resendEmailId !== 'string' || !resendEmailId || resendEmailId.length > 200) {
		throw new BizError('Invalid Resend email ID', 400);
	}

	const params = { resendEmailId, status: emailConst.status.SENT, message: null };
	switch (body.type) {
		case 'email.sent':
			return params;
		case 'email.delivered':
			params.status = emailConst.status.DELIVERED;
			return params;
		case 'email.complained':
			params.status = emailConst.status.COMPLAINED;
			return params;
		case 'email.bounced':
			params.status = emailConst.status.BOUNCED;
			params.message = JSON.stringify(body.data?.bounce || {}).slice(0, 16_000);
			return params;
		case 'email.delivery_delayed':
			params.status = emailConst.status.DELAYED;
			return params;
		case 'email.failed':
			params.status = emailConst.status.FAILED;
			params.message = String(body.data?.failed?.reason || 'Delivery failed').slice(0, 4_000);
			return params;
		default:
			return null;
	}
}

const resendService = {

	async webhooks(c, body) {
		const params = statusUpdateForWebhook(body);
		if (!params) return { processed: false };

		const emailRow = await emailService.updateEmailStatus(c, params)

		return { processed: !!emailRow };

	}
}

export { MAX_WEBHOOK_BYTES, SUPPORTED_WEBHOOK_TYPES, statusUpdateForWebhook, verifyWebhook };
export default resendService
