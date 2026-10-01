// [SAATHUM-BRAND-CENTRAL-WEB-3] Brand tokens for content that cannot import BRAND
// (markdown help articles, their frontmatter and the search index). Write
// {{brand.name}} etc. in the source; this fills them from Specs/brand.json.
// An unknown token throws so a typo can never reach the built site.
import { BRAND } from './brand';

const VALUES: Record<string, string> = {
  name: BRAND.name,
  nameCompact: BRAND.nameCompact,
  slug: BRAND.slug,
  domain: BRAND.domain,
  webOrigin: BRAND.webOrigin,
  supportEmail: BRAND.emails.support,
  nameHindi: BRAND.nameHindi,
  nameMeaningShort: BRAND.nameMeaningShort,
  nameMeaningLong: BRAND.nameMeaningLong,
};

const TOKEN = /\{\{brand\.(\w+)\}\}/g;

export function fillBrandTokens(text: string): string {
  return text.replace(TOKEN, (_m, key: string) => {
    const v = VALUES[key];
    if (v === undefined) throw new Error(`Unknown brand token {{brand.${key}}}`);
    return v;
  });
}

/** Fill every string inside a plain data structure (frontmatter). Dates etc. pass through. */
export function fillBrandTokensDeep<T>(value: T): T {
  if (typeof value === 'string') return fillBrandTokens(value) as unknown as T;
  if (Array.isArray(value)) return value.map(fillBrandTokensDeep) as unknown as T;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillBrandTokensDeep(v)])) as T;
  }
  return value;
}
