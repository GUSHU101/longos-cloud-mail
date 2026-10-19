import { parseHTML } from 'linkedom';

const BLOCKED_ELEMENTS = [
	'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
	'base', 'link', 'meta', 'form', 'input', 'button', 'select', 'textarea',
	'svg', 'math', 'template', 'dialog', 'audio', 'video', 'source', 'track',
];
const URL_ATTRIBUTES = new Set(['href', 'src', 'action', 'formaction', 'poster', 'background', 'xlink:href']);
const DANGEROUS_CSS = /(?:expression\s*\(|(?:java|vb)script\s*:|behavior\s*:|-moz-binding\s*:|@import|:host(?:-context)?|position\s*:\s*fixed|[<>])/i;

function safeUrl(value, attribute) {
	const normalized = String(value || '').replace(/[\u0000-\u0020\u007f]+/g, '').trim();
	if (!normalized) return true;
	if (normalized.startsWith('#') || normalized.startsWith('/')) return true;
	if (/^(?:https?:|mailto:|tel:|cid:)/i.test(normalized)) return true;
	return attribute === 'src' && /^data:image\/(?:png|gif|jpe?g|webp);base64,[a-z0-9+/=]+$/i.test(normalized);
}

function safeStyle(value) {
	const style = String(value || '').trim();
	return style && !DANGEROUS_CSS.test(style) ? style : '';
}

function sanitizeDocument(document) {
	document.querySelectorAll(BLOCKED_ELEMENTS.join(',')).forEach(element => element.remove());
	document.querySelectorAll('*').forEach(element => {
		for (const attribute of [...element.attributes]) {
			const name = attribute.name.toLowerCase();
			if (name.startsWith('on') || ['srcdoc', 'srcset', 'ping'].includes(name)) {
				element.removeAttribute(attribute.name);
				continue;
			}
			if (URL_ATTRIBUTES.has(name) && !safeUrl(attribute.value, name)) {
				element.removeAttribute(attribute.name);
				continue;
			}
			if (name === 'style') {
				const style = safeStyle(attribute.value);
				if (style) element.setAttribute('style', style);
				else element.removeAttribute('style');
			}
		}
		if (element.tagName?.toLowerCase() === 'a' && element.getAttribute('target') === '_blank') {
			element.setAttribute('rel', 'noopener noreferrer');
		}
	});
	document.querySelectorAll('style').forEach(element => {
		if (DANGEROUS_CSS.test(element.textContent || '')) element.remove();
	});
	return document;
}

function sanitizeEmailHtml(html) {
	const source = typeof html === 'string' ? html : '';
	const { document } = parseHTML(source);
	return sanitizeDocument(document).toString();
}

export { safeStyle, safeUrl, sanitizeDocument, sanitizeEmailHtml };
