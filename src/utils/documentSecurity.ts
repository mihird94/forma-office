import DOMPurify from 'dompurify';

// Keep rich formatting and embedded media while excluding active content and background requests.
DOMPurify.addHook('uponSanitizeAttribute', (element, attribute) => {
  if (attribute.attrName === 'src' && element.localName === 'img') {
    attribute.keepAttr = /^(?:data:image\/(?:png|jpe?g|gif|webp|bmp|svg\+xml);|blob:)/i.test(attribute.attrValue);
  }
  if ((attribute.attrName === 'href' || attribute.attrName === 'xlink:href') &&
      element.namespaceURI === 'http://www.w3.org/2000/svg') {
    attribute.keepAttr = attribute.attrValue.startsWith('#');
  }
});

export function sanitizeDocumentHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, svg: true, mathMl: true },
    FORBID_TAGS: [
      'style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed',
      'base', 'meta', 'link', 'video', 'audio', 'source', 'foreignobject', 'image', 'feimage',
      'animate', 'animatetransform', 'animatemotion', 'set',
    ],
    FORBID_ATTR: ['srcset', 'ping', 'autofocus', 'action', 'formaction', 'contenteditable'],
  });
}
