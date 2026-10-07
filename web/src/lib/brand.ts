/**
 * GENERATED FROM Specs/brand.json by scripts/gen_brand.py — DO NOT EDIT.
 * To change the brand name or domain, edit Specs/brand.json and re-run the script.
 */

export const BRAND = {
  /** How the name is written in sentences. */
  name: "Hello Fraands",
  /** Headings / logo text. */
  nameUpper: "HELLO FRAANDS",
  /** Display name used inside customer-visible sentences ({brand} i18n token). Same as name unless the brand wants a variant. */
  nameCompact: "Hello Fraands",
  /** Lowercase, no spaces — hashtags, file names, UA markers. */
  slug: "aumfe",
  nameHindi: "हेलो फ़्रैंड्स",
  slogan: "Real people. Baat se baat banti hai.",
  /** One-sentence meaning of the name (front page). */
  nameMeaningShort: "Hello Fraands is a friendly hello and an invitation to talk to a real person in your language.",
  /** Full story of the name (About page, help). */
  nameMeaningLong: "Hello Fraands is our way of saying you can start a conversation. Talk to a real person in your language about everyday life, with a clear per-minute price and a call connection that keeps personal phone numbers private. The site is a preview while calling and verification are being prepared.",
  /** Bare host, no scheme. */
  domain: "hellofraands.com",
  /** https://<domain> — no trailing slash. */
  webOrigin: "https://hellofraands.com",
  apiHost: "api.aumfe.com",
  apiOrigin: "https://api.aumfe.com",
  mediaHost: "media.aumfe.com",
  mediaOrigin: "https://media.aumfe.com",
  authHost: "clerk.aumfe.com",
  authOrigin: "https://clerk.aumfe.com",
  mailHost: "mail.aumfe.com",
  emails: {
    support: "support@aumfe.com",
    noreply: "noreply@aumfe.com",
    hello: "hello@aumfe.com",
  },
  emailFromName: "Aum Fe",
  /** PERMANENT — a Play package id can never change. */
  playPackageId: "com.saathum.app",
} as const;

/** Absolute URL on the public website: brandUrl('/l/abc') -> https://<domain>/l/abc */
export function brandUrl(path = '/'): string {
  return BRAND.webOrigin + (path.startsWith('/') ? path : `/${path}`);
}

/** True for the brand domain and any subdomain of it. */
export function isBrandHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === BRAND.domain || h.endsWith(`.${BRAND.domain}`);
}
