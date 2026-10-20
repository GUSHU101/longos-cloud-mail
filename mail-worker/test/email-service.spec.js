import { describe, expect, it } from 'vitest';
import {
	MAX_OUTBOUND_ATTACHMENT_BYTES,
	MAX_SEND_RECIPIENTS,
	validateSendAttachments,
	validateSendInput,
	validateSendMessageFields,
	normalizeOutboundRequestId,
} from '../src/service/email-service';

const validAttachment = () => ({
	content: 'aGVsbG8=',
	filename: 'hello.txt',
	contentType: 'text/plain',
});

describe('outbound message input validation', () => {
	it('requires at least one valid recipient', () => {
		expect(() => validateSendInput([], [])).toThrow();
		expect(() => validateSendInput(['not-an-email'], [])).toThrow();
		expect(validateSendInput(['Buyer@Example.com', 'buyer@example.com'], [])).toEqual(['buyer@example.com']);
	});

	it('limits the normalized recipient set', () => {
		const recipients = Array.from({ length: MAX_SEND_RECIPIENTS + 1 }, (_, index) => `buyer-${index}@example.com`);
		expect(() => validateSendInput(recipients, [])).toThrow(/50/);
	});

	it('rejects malformed attachment input', () => {
		expect(() => validateSendInput(['buyer@example.com'], null)).toThrow();
	});
});

describe('outbound attachment validation', () => {
	it('accepts attachments at the supported limits', () => {
		expect(() => validateSendAttachments(
			Array.from({ length: 10 }, validAttachment),
			Array.from({ length: 10 }, validAttachment),
		)).not.toThrow();
	});

	it('rejects excessive inline images before delivery', () => {
		expect(() => validateSendAttachments(Array.from({ length: 11 }, validAttachment), [])).toThrow();
	});

	it('rejects excessive file attachments before delivery', () => {
		expect(() => validateSendAttachments([], Array.from({ length: 11 }, validAttachment))).toThrow();
	});

	it('rejects malformed base64 and oversized total payloads', () => {
		expect(() => validateSendAttachments([], [{ ...validAttachment(), content: 'not base64!' }])).toThrow();
		expect(() => validateSendAttachments([], [{
			...validAttachment(),
			content: new Uint8Array(MAX_OUTBOUND_ATTACHMENT_BYTES + 1),
		}])).toThrow(/18 MB/);
	});
});

describe('outbound message field validation', () => {
	it('accepts a normal message and rejects header injection', () => {
		expect(() => validateSendMessageFields({
			name: 'Sales',
			subject: 'Hello',
			text: 'Plain text',
			content: '<p>Hello</p>',
		})).not.toThrow();
		expect(() => validateSendMessageFields({
			name: 'Sales',
			subject: 'Hello\r\nBcc: victim@example.com',
			text: 'Plain text',
			content: '',
		})).toThrow();
	});

	it('requires non-empty content', () => {
		expect(() => validateSendMessageFields({ name: '', subject: '', text: '', content: '' })).toThrow();
	});
});

describe('outbound request identity', () => {
	it('preserves a valid browser request ID across retries', () => {
		expect(normalizeOutboundRequestId('cloud-mail-ui:550e8400-e29b-41d4-a716-446655440000'))
			.toBe('cloud-mail-ui:550e8400-e29b-41d4-a716-446655440000');
	});

	it('generates an ID when absent and rejects unsafe values', () => {
		expect(normalizeOutboundRequestId()).toMatch(/^cloud-mail:/);
		expect(() => normalizeOutboundRequestId('bad id with spaces')).toThrow();
	});
});
