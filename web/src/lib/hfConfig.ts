/* [HF-DASH-CACHE-1] One GET /api/config per page. Every `xxxEnabled()` helper in the dashboard libs reads from this single shared promise
 * (before, the dashboard sent four to five identical requests in parallel). Any failure resolves to {} = every flag off, exactly like the
 * old per-helper `.catch(() => false)`; the failure is kept for the page lifetime, as it was. */
import { request } from './apiClient';

export type PublicConfig = Record<string, unknown>;
let cfgP: Promise<PublicConfig> | null = null;

export function publicConfig(): Promise<PublicConfig> {
  if (!cfgP) cfgP = request<PublicConfig>('/api/config', { timeoutMs: 8000 }).then(c => (c && typeof c === 'object' ? c : {})).catch(() => ({}));
  return cfgP;
}

/** Test hook only. */
export function resetPublicConfigForTests(): void { cfgP = null; }
