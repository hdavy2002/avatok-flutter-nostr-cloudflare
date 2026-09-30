import { BRAND } from '../brand';
/**
 * [SAATHUM-BRAND-CENTRAL-I18N-1] Reserved brand tokens for UI catalog text. Catalog and
 * markup copy write `{brand}` etc.; they are filled here from BRAND (Specs/brand.json),
 * so callers never pass them. See shared/i18n/README.md for the token table.
 */
export const BRAND_TOKENS: Readonly<Record<string, string>> = {
  brand: BRAND.nameCompact,
  brandCompactUpper: BRAND.nameCompact.toUpperCase(),
  brandDomain: BRAND.domain,
  brandSupportEmail: BRAND.emails.support,
};
export const expandBrand = (text: string): string =>
  text.replace(/\{(brand[A-Za-z]*)\}/g, (token, name) => Object.hasOwn(BRAND_TOKENS, name) ? BRAND_TOKENS[name] : token);
