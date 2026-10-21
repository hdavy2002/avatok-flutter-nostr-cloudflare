import { BRAND } from './brand';

// HF-SEC-HEADERS-1: phase one. Script restrictions below are REPORT ONLY.
// No per-request nonce is emitted: public HTML is shared through the edge cache.
export const ENFORCED_CSP = "object-src 'none'; base-uri 'self'; frame-ancestors 'self'";

// Source inventory and remaining browser gates: web/test/security-headers-inventory.md.
// Unknown/dynamic origins deliberately report violations instead of being covered
// by wildcard script sources. Inline scripts remain visible as violations too.
export const REPORT_ONLY_CSP = [
  "default-src 'self'",
  `script-src 'self' ${BRAND.authOrigin} https://challenges.cloudflare.com https://eu-assets.i.posthog.com https://sdk.cashfree.com https://checkout.razorpay.com https://www.youtube.com`,
  `connect-src 'self' ${BRAND.apiOrigin} ${BRAND.authOrigin} ${BRAND.mediaOrigin} https://eu.i.posthog.com https://eu-assets.i.posthog.com https://challenges.cloudflare.com https://api.cashfree.com https://api.razorpay.com`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${BRAND.mediaOrigin} https://img.clerk.com https://i.ytimg.com`,
  "font-src 'self' data:",
  `media-src 'self' blob: ${BRAND.mediaOrigin}`,
  "frame-src 'self' https://challenges.cloudflare.com https://www.youtube.com https://www.youtube-nocookie.com https://www.instagram.com https://sdk.cashfree.com https://payments.cashfree.com https://api.razorpay.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'self'",
].join('; ');

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy': ENFORCED_CSP,
  'Content-Security-Policy-Report-Only': REPORT_ONLY_CSP,
} as const;

export function withSecurityHeaders(response: Response, url: URL): Response {
  // Cached/redirect responses may have immutable headers. Preserve status, stream,
  // cookies and cache semantics while applying the current policy even on HITs.
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) out.headers.set(name, value);
  // Restrict initial HSTS to the canonical production origin. Do not trust a
  // forwarded host, apply to preview domains, or opt subdomains into HSTS.
  if (url.protocol === 'https:' && url.origin === BRAND.webOrigin) {
    out.headers.set('Strict-Transport-Security', 'max-age=86400');
  }
  return out;
}
