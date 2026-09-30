/**
 * GENERATED FROM Specs/brand.json by scripts/gen_brand.py — DO NOT EDIT.
 * To change the brand name or domain, edit Specs/brand.json and re-run the script.
 */

export const BRAND = {
  /** How the name is written in sentences. */
  name: "Saa Thum",
  /** Headings / logo text. */
  nameUpper: "SAA THUM",
  /** One word, capitalised (alternate spelling for SEO). */
  nameCompact: "Saathum",
  /** Lowercase, no spaces — hashtags, file names, UA markers. */
  slug: "saathum",
  nameHindi: "सा थम",
  slogan: "Faith, brought home to you.",
  /** Bare host, no scheme. */
  domain: "saathum.com",
  /** https://<domain> — no trailing slash. */
  webOrigin: "https://saathum.com",
  apiHost: "api.saathum.com",
  apiOrigin: "https://api.saathum.com",
  mediaHost: "media.saathum.com",
  mediaOrigin: "https://media.saathum.com",
  authHost: "clerk.saathum.com",
  authOrigin: "https://clerk.saathum.com",
  mailHost: "mail.saathum.com",
  emails: {
    support: "support@saathum.com",
    noreply: "noreply@saathum.com",
    hello: "hello@saathum.com",
  },
  emailFromName: "Saa Thum",
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
