const BLOCKED_ELEMENTS = [
  'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'base', 'link', 'meta', 'form', 'input', 'button', 'select', 'textarea',
  'svg', 'math', 'template', 'dialog', 'audio', 'video', 'source', 'track',
]
const URL_ATTRIBUTES = new Set(['href', 'src', 'action', 'formaction', 'poster', 'background', 'xlink:href'])
const DANGEROUS_CSS = /(?:expression\s*\(|(?:java|vb)script\s*:|behavior\s*:|-moz-binding\s*:|@import|:host(?:-context)?|position\s*:\s*fixed|[<>])/i

function safeUrl(value, attribute) {
  const normalized = String(value || '').replace(/[\u0000-\u0020\u007f]+/g, '').trim()
  if (!normalized || normalized.startsWith('#') || normalized.startsWith('/')) return true
  if (/^(?:https?:|mailto:|tel:|cid:)/i.test(normalized)) return true
  return attribute === 'src' && /^data:image\/(?:png|gif|jpe?g|webp);base64,[a-z0-9+/=]+$/i.test(normalized)
}

function safeStyle(value) {
  const style = String(value || '').trim()
  return style && !DANGEROUS_CSS.test(style) ? style : ''
}

export function sanitizeEmailHtml(source) {
  const document = new DOMParser().parseFromString(typeof source === 'string' ? source : '', 'text/html')
  document.querySelectorAll(BLOCKED_ELEMENTS.join(',')).forEach(element => element.remove())
  document.querySelectorAll('*').forEach(element => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase()
      if (name.startsWith('on') || ['srcdoc', 'srcset', 'ping'].includes(name)) {
        element.removeAttribute(attribute.name)
      } else if (URL_ATTRIBUTES.has(name) && !safeUrl(attribute.value, name)) {
        element.removeAttribute(attribute.name)
      } else if (name === 'style') {
        const style = safeStyle(attribute.value)
        if (style) element.setAttribute('style', style)
        else element.removeAttribute('style')
      }
    }
    if (element.tagName.toLowerCase() === 'a' && element.getAttribute('target') === '_blank') {
      element.setAttribute('rel', 'noopener noreferrer')
    }
  })
  document.querySelectorAll('style').forEach(element => {
    if (DANGEROUS_CSS.test(element.textContent || '')) element.remove()
  })

  const bodyStyle = safeStyle(document.body.getAttribute('style'))
  const headStyles = Array.from(document.head.querySelectorAll('style')).map(element => element.outerHTML).join('')
  return { bodyStyle, html: `${headStyles}${document.body.innerHTML}` }
}

export function sanitizeNoticeHtml(source) {
  const document = new DOMParser().parseFromString(typeof source === 'string' ? source : '', 'text/html')
  document.querySelectorAll([...BLOCKED_ELEMENTS, 'style'].join(',')).forEach(element => element.remove())
  document.querySelectorAll('*').forEach(element => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase()
      if (
        name.startsWith('on')
        || ['srcdoc', 'srcset', 'ping', 'style', 'class', 'id'].includes(name)
        || (URL_ATTRIBUTES.has(name) && !safeUrl(attribute.value, name))
      ) {
        element.removeAttribute(attribute.name)
      }
    }
    if (element.tagName.toLowerCase() === 'a' && element.getAttribute('target') === '_blank') {
      element.setAttribute('rel', 'noopener noreferrer')
    }
  })
  return document.body.innerHTML
}
