// [SAATHUM-BRAND-CENTRAL-WEB-2] Brand values for build-time checks and asset scripts.
// Reads Specs/brand.json directly (no TS import) and exposes the same derived fields
// as src/lib/brand.ts. Never type the brand name or domain in a check — import this.
import { readFileSync } from 'node:fs';

const j = JSON.parse(readFileSync(new URL('../../Specs/brand.json', import.meta.url), 'utf8'));

export const BRAND = {
  name: j.name,
  nameUpper: j.nameUpper,
  nameCompact: j.nameCompact,
  slug: j.slug,
  nameHindi: j.nameHindi,
  slogan: j.slogan,
  domain: j.domain,
  webOrigin: `https://${j.domain}`,
  apiHost: j.hosts.api,
  apiOrigin: `https://${j.hosts.api}`,
  mediaHost: j.hosts.media,
  mediaOrigin: `https://${j.hosts.media}`,
  authHost: j.hosts.auth,
  authOrigin: `https://${j.hosts.auth}`,
  mailHost: j.hosts.mail,
  emails: { ...j.emails },
  emailFromName: j.emailFromName,
  playPackageId: j.playPackageId,
};

/** Escape a string for literal use inside a RegExp. */
export const reEscape = (s) => String(s).replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&');
