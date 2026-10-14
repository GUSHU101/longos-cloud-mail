import resendService, { MAX_WEBHOOK_BYTES, verifyWebhook } from '../service/resend-service';
import app from '../hono/hono';
app.post('/webhooks',async (c) => {
	const contentLength = Number(c.req.header('content-length'));
	if (Number.isFinite(contentLength) && contentLength > MAX_WEBHOOK_BYTES) {
		return c.text('Webhook payload is too large', 413);
	}
	let event;
	try {
		event = verifyWebhook(c, await c.req.text());
	} catch (e) {
		const status = [400, 413, 503].includes(e.code) ? e.code : 400;
		if (status === 503) console.error(e.message);
		return c.text(status === 503 ? 'Webhook is not configured' : 'Invalid webhook', status);
	}

	try {
		await resendService.webhooks(c, event);
		return c.text('success', 200);
	} catch (e) {
		console.error('Resend webhook processing failed', e);
		return c.text('Webhook processing failed', 500);
	}
})
