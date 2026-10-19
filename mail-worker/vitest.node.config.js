import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: [
			'test/auth-rate-limit.spec.js',
			'test/cors.spec.js',
			'test/crypto-utils.spec.js',
			'test/domain-utils.spec.js',
			'test/html-sanitizer.spec.js',
			'test/email-service.spec.js',
			'test/init-authorization.spec.js',
			'test/index.spec.js',
			'test/jwt-utils.spec.js',
			'test/self-hosted-mail-service.spec.js',
			'test/mail-provider.spec.js',
			'test/oauth-service.spec.js',
			'test/public-service.spec.js',
			'test/resend-service.spec.js',
			'test/session-service.spec.js',
			'test/setting-service.spec.js',
			'test/turnstile-service.spec.js',
		],
	},
});
