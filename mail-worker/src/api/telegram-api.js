import app from '../hono/hono';
import telegramService from '../service/telegram-service';

function applyTelegramContentHeaders(c) {
	c.header('Cache-Control', 'private, no-store');
	c.header(
		'Content-Security-Policy',
		"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https: data:; font-src https: data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
	);
}

app.get('/telegram/getEmail/:token', async (c) => {
	const content = await telegramService.getEmailContent(c, c.req.param());
	applyTelegramContentHeaders(c);
	return c.html(content)
});

export { applyTelegramContentHeaders };

