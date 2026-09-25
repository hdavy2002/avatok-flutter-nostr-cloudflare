// [DASH2-FOUNDATION 2026-09-25] Server-side read of a platform flag for Astro
// pages (prerender = false). There was no server-side config read in web/
// before this — islands fetch /api/config in the browser. Pages that must pick
// a whole layout by flag (e.g. /dashboard: Dashboard 2 vs archived v1) cannot
// wait for the browser, so they read the same public endpoint here.
//
// Fails CLOSED: a timeout, non-200 or bad body returns the fallback (false),
// so a Worker outage keeps serving the v1 dashboard rather than a half-built one.
// /api/config is edge-cached for 60s; this isolate adds its own 30s memo.
import { API_BASE } from './config';

type ConfigBlob = Record<string, unknown>;
let memo: { at: number; cfg: ConfigBlob } | null = null;
const MEMO_MS = 30_000;

async function readConfig(timeoutMs: number): Promise<ConfigBlob | null> {
  if (memo && Date.now() - memo.at < MEMO_MS) return memo.cfg;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}/api/config`, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const cfg = (await res.json()) as ConfigBlob;
    if (!cfg || typeof cfg !== 'object') return null;
    memo = { at: Date.now(), cfg };
    return cfg;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** A boolean platform flag, `fallback` when unknown. */
export async function readBooleanFlag(key: string, fallback = false, timeoutMs = 1500): Promise<boolean> {
  const cfg = await readConfig(timeoutMs);
  const v = cfg?.[key];
  return typeof v === 'boolean' ? v : fallback;
}

/** Cookie that lets the owner/QA preview Dashboard 2 before the flag is on. */
export const DASH2_PREVIEW_COOKIE = 'dash2_preview';

interface AstroLike {
  url: URL;
  cookies: {
    get(name: string): { value: string } | undefined;
    set(name: string, value: string, opts?: Record<string, unknown>): void;
    delete(name: string, opts?: Record<string, unknown>): void;
  };
}

/**
 * Is Dashboard 2 on for this request? `dashboard2Enabled` (platform flag), OR
 * a per-browser preview: `?dash2=1` sets a 7-day cookie, `?dash2=0` clears it.
 */
export async function isDashboard2Enabled(astro: AstroLike): Promise<boolean> {
  const q = astro.url.searchParams.get('dash2');
  if (q === '1') {
    astro.cookies.set(DASH2_PREVIEW_COOKIE, '1', { path: '/', maxAge: 60 * 60 * 24 * 7, sameSite: 'lax', secure: true, httpOnly: true });
    return true;
  }
  if (q === '0') {
    astro.cookies.delete(DASH2_PREVIEW_COOKIE, { path: '/' });
  } else if (astro.cookies.get(DASH2_PREVIEW_COOKIE)?.value === '1') {
    return true;
  }
  return readBooleanFlag('dashboard2Enabled', false);
}
