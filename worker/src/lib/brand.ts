/**
 * GENERATED FROM Specs/brand.json by scripts/gen_brand.py — DO NOT EDIT.
 * To change the brand name or domain, edit Specs/brand.json and re-run the script.
 */

export const BRAND = {
  /** How the name is written in sentences. */
  name: "Aum Fe",
  /** Headings / logo text. */
  nameUpper: "AUM FE",
  /** Display name used inside customer-visible sentences ({brand} i18n token). Same as name unless the brand wants a variant. */
  nameCompact: "Aum Fe",
  /** Lowercase, no spaces — hashtags, file names, UA markers. */
  slug: "aumfe",
  nameHindi: "ॐ फ़े",
  slogan: "Faith, brought home to you.",
  /** One-sentence meaning of the name (front page). */
  nameMeaningShort: "Aum (ॐ) is the sacred sound of the East; Fe is the word for faith in Spanish and Portuguese. Aum Fe is a meeting ground for East and West.",
  /** Full story of the name (About page, help). */
  nameMeaningLong: "Our name joins two words from two worlds. Aum — written ॐ and also spoken as Om — is the ancient Sanskrit syllable that Hindu tradition holds as the sound at the heart of every prayer. Fe is the plain word for faith in Spanish and Portuguese. The East has Aum; the West speaks of faith. Aum Fe is where the two meet: a home for anyone, anywhere, who wants to take part in a havan or puja performed with devotion in the Himalayas.",
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
  /** Former domains. Their api./media. hosts stay attached forever (old app builds, old emails, stored image URLs). */
  legacyDomains: ["saathum.com", "aumfe.com"] as readonly string[],
  legacyMediaHosts: ["media.saathum.com", "media.aumfe.com"] as readonly string[],
  legacyApiHosts: ["api.saathum.com", "api.aumfe.com"] as readonly string[],
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

/** True for the brand domain, any legacy domain, and any subdomain of either. */
export function isBrandOrLegacyHost(host: string): boolean {
  const h = host.toLowerCase();
  if (isBrandHost(h)) return true;
  return BRAND.legacyDomains.some((d) => h === d || h.endsWith(`.${d}`));
}
