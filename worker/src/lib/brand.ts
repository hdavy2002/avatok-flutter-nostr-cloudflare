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
  apiHost: "api.hellofraands.com",
  apiOrigin: "https://api.hellofraands.com",
  mediaHost: "media.hellofraands.com",
  mediaOrigin: "https://media.hellofraands.com",
  authHost: "clerk.hellofraands.com",
  authOrigin: "https://clerk.hellofraands.com",
  mailHost: "mail.aumfe.com",
  /** Former domains. Their api./media. hosts stay attached forever (old app builds, old emails, stored image URLs). */
  legacyDomains: ["saathum.com", "aumfe.com"] as readonly string[],
  legacyMediaHosts: ["media.saathum.com", "media.aumfe.com"] as readonly string[],
  legacyApiHosts: ["api.saathum.com", "api.aumfe.com"] as readonly string[],
  emails: {
    support: "support@hellofraands.com",
    noreply: "noreply@aumfe.com",
    hello: "hello@aumfe.com",
  },
  emailFromName: "Aum Fe",
  /** PERMANENT — a Play package id can never change. */
  playPackageId: "com.saathum.app",
  /** PERMANENT — package id of the Android app wrapping the website (hf-app/). */
  hfPlayPackageId: "com.hellofraands.app",
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

/** True for the brand domain, any legacy domain, and any subdomain of either. */
export function isBrandOrLegacyHost(host: string): boolean {
  const h = host.toLowerCase();
  if (isBrandHost(h)) return true;
  return BRAND.legacyDomains.some((d) => h === d || h.endsWith(`.${d}`));
}
