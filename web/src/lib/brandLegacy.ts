/**
 * GENERATED FROM Specs/brand.json by scripts/gen_brand.py — DO NOT EDIT.
 * To change the brand name or domain, edit Specs/brand.json and re-run the script.
 */

/** SERVER-ONLY. Import behind `import.meta.env.SSR` so it never reaches a browser chunk. */
import { isBrandHost } from './brand';

export const LEGACY_DOMAINS: readonly string[] = ["saathum.com", "aumfe.com"] as readonly string[];
export const LEGACY_MEDIA_HOSTS: readonly string[] = ["media.saathum.com", "media.aumfe.com"] as readonly string[];
export const LEGACY_API_HOSTS: readonly string[] = ["api.saathum.com", "api.aumfe.com"] as readonly string[];

/** True for the brand domain, any legacy domain, and any subdomain of either. */
export function isBrandOrLegacyHost(host: string): boolean {
  const h = host.toLowerCase();
  if (isBrandHost(h)) return true;
  return LEGACY_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}
