// [HF-SUPPORT-DESK] A small allow-list HTML sanitizer for the places the desk renders HTML it did not type itself
// (support replies with signatures, the signature editor and its previews). Browser only (DOMParser).
// It is deliberately strict: unknown tags are unwrapped, scripts/frames/forms are dropped with their contents,
// event handlers and non-http(s)/mailto/tel links are removed, and inline styles are filtered by property.

const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'link', 'meta', 'svg', 'math', 'noscript', 'template', 'video', 'audio']);
const ALLOWED_TAGS = new Set([
  'a', 'b', 'strong', 'i', 'em', 'u', 's', 'br', 'p', 'div', 'span', 'ul', 'ol', 'li', 'table', 'tbody', 'thead', 'tr', 'td', 'th',
  'img', 'hr', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'small', 'sub', 'sup', 'pre', 'code',
]);
const ALLOWED_STYLE = new Set([
  'color', 'background', 'background-color', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-decoration', 'text-align',
  'line-height', 'letter-spacing', 'margin', 'margin-top', 'margin-bottom', 'margin-left', 'margin-right', 'padding', 'padding-top',
  'padding-bottom', 'padding-left', 'padding-right', 'border', 'border-top', 'border-bottom', 'border-left', 'border-right',
  'border-radius', 'border-collapse', 'width', 'max-width', 'height', 'min-width', 'vertical-align', 'display', 'white-space',
  'border-spacing', 'border-color', 'border-style', 'border-width', 'overflow', 'word-break',
]);
const TABLE_ATTRS = new Set(['colspan', 'rowspan', 'width', 'height', 'align', 'valign', 'bgcolor', 'cellpadding', 'cellspacing', 'border', 'role']);

function safeStyle(raw: string): string {
  const out: string[] = [];
  for (const decl of raw.split(';')) {
    const i = decl.indexOf(':');
    if (i < 1) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const val = decl.slice(i + 1).trim();
    if (!ALLOWED_STYLE.has(prop) || !val) continue;
    if (/url\s*\(|expression|javascript:|@import|behavior|-moz-binding|<|>/i.test(val)) continue;
    if (prop === 'display' && !/^(block|inline|inline-block|table|table-cell|none)$/i.test(val)) continue;
    out.push(`${prop}:${val}`);
  }
  return out.join(';');
}

function safeUrl(u: string, kind: 'link' | 'img'): string | null {
  const v = u.trim();
  if (kind === 'link') return /^(https?:\/\/|mailto:|tel:)/i.test(v) ? v : null;
  if (/^https:\/\//i.test(v)) return v;
  if (/^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(v) && v.length < 400_000) return v;
  return null;
}

function walk(src: Node, dst: Node, doc: Document): void {
  src.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) {
      dst.appendChild(doc.createTextNode(n.textContent ?? ''));
      return;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const el = n as HTMLElement;
    const tag = el.tagName.toLowerCase();
    if (DROP_WITH_CONTENT.has(tag)) return;
    if (!ALLOWED_TAGS.has(tag)) { walk(el, dst, doc); return; }
    const out = doc.createElement(tag);
    const style = el.getAttribute('style');
    if (style) { const s = safeStyle(style); if (s) out.setAttribute('style', s); }
    if (tag === 'a') {
      const href = safeUrl(el.getAttribute('href') ?? '', 'link');
      if (href) { out.setAttribute('href', href); out.setAttribute('target', '_blank'); out.setAttribute('rel', 'noopener noreferrer'); }
    } else if (tag === 'img') {
      const src2 = safeUrl(el.getAttribute('src') ?? '', 'img');
      if (!src2) return;
      out.setAttribute('src', src2);
      out.setAttribute('alt', el.getAttribute('alt') ?? '');
      for (const a of ['width', 'height']) { const v = el.getAttribute(a); if (v && /^\d{1,4}$/.test(v)) out.setAttribute(a, v); }
    } else if (tag === 'td' || tag === 'th' || tag === 'table' || tag === 'tr' || tag === 'div' || tag === 'p') {
      for (const a of TABLE_ATTRS) {
        const v = el.getAttribute(a);
        if (v != null && /^[#a-z0-9%.\s-]{1,24}$/i.test(v)) out.setAttribute(a, v);
      }
    }
    walk(el, out, doc);
    dst.appendChild(out);
  });
}

/** Returns safe HTML (a string) for dangerouslySetInnerHTML. Empty string for anything unusable. */
export function sanitizeHtml(html: string | null | undefined): string {
  if (!html) return '';
  if (typeof DOMParser === 'undefined') return '';
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const holder = doc.createElement('div');
  walk(doc.body, holder, doc);
  return holder.innerHTML;
}

/** Visible text of an HTML string (for previews and plain-text parts). */
export function htmlToText(html: string): string {
  if (typeof DOMParser === 'undefined') return html.replace(/<[^>]+>/g, ' ');
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  doc.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
  doc.querySelectorAll('p,div,tr,li').forEach((b) => b.append('\n'));
  return (doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();
}
