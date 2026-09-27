// [SAATHUM-UPI-SETTINGS 2026-09-27, owner decision] The UPI address that
// customers pay to is set from /admin → "UPI settings", not only a Worker
// secret. KV `upi_settings:v1` (TOKENS namespace, same as pricing:v1) holds
// { vpa, payee_name }; when it is empty the HDFC_UPI_VPA / HDFC_UPI_PAYEE_NAME
// secrets are the fallback, so an unset admin value never breaks checkout.
//
// ⚠️ Payment confirmation is by the HDFC credit SMS (account suffix
// HDFC_SMS_ACCOUNT_SUFFIX) + the buyer's 12-digit UTR. The VPA set here MUST
// credit that same HDFC account, or the SMS never arrives and every checkout
// ends in review. The admin screen says so.
import type { Env } from '../types';

export const UPI_SETTINGS_KEY = 'upi_settings:v1';
export const VPA_RE = /^[A-Za-z0-9._-]{2,200}@[A-Za-z0-9.-]{2,80}$/;

export interface UpiSettings { vpa: string | null; payee_name: string | null; updated_at: number | null; updated_by: string | null }
export interface EffectiveUpi { vpa: string; payee_name: string; source: 'admin' | 'env' | 'none' }

let cache: { at: number; value: UpiSettings } | null = null;
const CACHE_MS = 15_000;

export function clearUpiSettingsCache() { cache = null; }

export async function readUpiSettings(env: Env): Promise<UpiSettings> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  let value: UpiSettings = { vpa: null, payee_name: null, updated_at: null, updated_by: null };
  try {
    const stored = (await env.TOKENS.get(UPI_SETTINGS_KEY, 'json')) as Partial<UpiSettings> | null;
    if (stored) value = { ...value, ...stored };
  } catch { /* fall back to env */ }
  cache = { at: Date.now(), value };
  return value;
}

export async function effectiveUpi(env: Env): Promise<EffectiveUpi> {
  const s = await readUpiSettings(env);
  const adminVpa = s.vpa?.trim() ?? '';
  if (VPA_RE.test(adminVpa)) {
    return { vpa: adminVpa, payee_name: s.payee_name?.trim() || env.HDFC_UPI_PAYEE_NAME?.trim() || 'Saa Thum', source: 'admin' };
  }
  const envVpa = env.HDFC_UPI_VPA?.trim() ?? '';
  return { vpa: envVpa, payee_name: env.HDFC_UPI_PAYEE_NAME?.trim() || 'Saa Thum', source: VPA_RE.test(envVpa) ? 'env' : 'none' };
}
