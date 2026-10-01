// [AUMFE-POD-CORE-1] The swappable print-partner boundary. Everything outside lib/pod/ imports from here only.
// Contract: Specs/SPEC-2026-10-01-AUMFE-POD-STUDIO.md section 3.
import type { Env } from '../../types';
import { readConfig } from '../../routes/config';
import { ManualProvider } from './manual';
import { PrintroveProvider, peekPrintroveToken, printroveLogin } from './printrove';
import type { PodProvider, PodProviderId } from './types';

export * from './types';
export { PRINT_SPECS, maxSharpInches, fitForProduct, estimatePrintCostRupees, areaFor } from './specs';
export { splitAddressForPartner, deliveryPhone10 } from './address';
export { ensurePodCatalog, loadStoredCatalog, syncCatalogToDb, runPodCatalogRefresh, referenceShippingRupees, CATALOG_MAX_AGE_MS, SHIP_REF_PINCODE } from './catalog_store';
export type { CatalogInfo } from './catalog_store';

export const POD_PROVIDER_IDS: PodProviderId[] = ['manual', 'printrove'];

const isProviderId = (v: unknown): v is PodProviderId => v === 'manual' || v === 'printrove';

/** The partner for `id`, or the one selected by config `shopPodProvider` (unknown values fall back to `manual`). */
export async function getPodProvider(env: Env, id?: PodProviderId): Promise<PodProvider> {
  const chosen: PodProviderId = id ?? (await readConfig(env).then((c) => (isProviderId(c.shopPodProvider) ? c.shopPodProvider : 'manual')));
  return chosen === 'printrove' ? new PrintroveProvider(env) : new ManualProvider();
}

/** True when the partner's secrets are present (manual always is). Never exposes the secret values. */
export function podProviderConfigured(env: Env, id: PodProviderId): boolean {
  if (id === 'manual') return true;
  return printroveLogin(env) !== null;
}

/** Cached-login status for the admin page without a network call: null when nothing is cached (or manual). */
export async function podConnectionPeek(env: Env, id: PodProviderId): Promise<{ ok: boolean; message: string; token_expires_at: number } | null> {
  if (id !== 'printrove') return null;
  const t = await peekPrintroveToken(env);
  return t ? { ok: true, message: 'Login token is valid.', token_expires_at: t.token_expires_at } : null;
}
