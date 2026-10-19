export function selectExternalMailProvider({
	mailEngine,
	relayUrl,
	hasRelayCredential,
	useCloudflareEmail,
	hasResendToken,
}) {
	if (mailEngine !== 'auto') {
		return mailEngine;
	}

	if (relayUrl && hasRelayCredential) {
		return 'self_hosted';
	}

	if (useCloudflareEmail) {
		return 'cloudflare';
	}

	return hasResendToken ? 'resend' : '';
}
