const TAGS = /<[^>]*>/g;
const SPACE = /\s+/g;

export function plainText(value: string | null | undefined): string {
  return String(value ?? '')
    .replace(TAGS, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(SPACE, ' ')
    .trim();
}

export function truncateAtWord(value: string, max = 165): string {
  const text = plainText(value);
  if (text.length <= max) return text;
  const chars = Array.from(text);
  const clipped = chars.slice(0, max + 1).join('');
  const boundary = Math.max(clipped.lastIndexOf(' '), clipped.lastIndexOf('—'));
  const safe = boundary >= Math.floor(max * 0.65) ? clipped.slice(0, boundary) : chars.slice(0, max).join('');
  return `${safe.replace(/[\s,;:–—-]+$/u, '')}…`;
}

export function validIso(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

/** Safe for an inline application/ld+json script, including user-authored text. */
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function stableRevision(parts: Array<string | number | boolean | null | undefined>): string {
  const input = parts.map((part) => String(part ?? '')).join('\u001f');
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
