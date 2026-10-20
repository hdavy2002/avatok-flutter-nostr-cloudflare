// [HF-ADMIN-CACHE-1] Stale-while-revalidate store for admin GETs, plus the remembered admin verdict.
//
// Why: every admin page is a full page load (Astro MPA), so the React island re-mounts and every list
// refetches from scratch behind Clerk init -> token -> /whoami -> data. On a slow network that is seconds of
// skeleton on every click. A cached copy from the last visit paints at once; the real fetch still runs and
// replaces it, so nothing is trusted past the next response.
//
// Rules:
//  - Per admin uid, sessionStorage (dies with the tab) + in-memory. Never localStorage for data.
//  - Only GETs that opt in (adminCall `onCached`). Entries older than MAX_AGE_MS are ignored.
//  - ANY non-GET admin call clears the whole cache, so a list never shows pre-write data as current after
//    the user changed something (refunds, payouts, wallet credits...). The post-write reload then fetches live.
//  - The verdict flag only lets the shell render early; the worker still enforces requireAdmin on every route
//    and AdminNav's /whoami probe still runs and overrides the flag.

const MAX_AGE_MS = 30 * 60_000;
const MAX_ENTRY_CHARS = 400_000;
const PREFIX = 'a2c:';
const GATE_KEY = 'admin2:gate';
const GATE_TTL_MS = 12 * 3600_000;

const mem = new Map<string, { t: number; v: unknown }>();
let uid = '';

function ss(): Storage | null { try { return typeof sessionStorage === 'undefined' ? null : sessionStorage; } catch { return null; } }
function ls(): Storage | null { try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } }

export function setCacheUser(next: string | null | undefined): void { uid = next ?? ''; }

function keyOf(path: string, query?: Record<string, unknown>): string {
  const q = query ? Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '').sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${String(v)}`).join('&') : '';
  return `${PREFIX}${uid}|${path}|${q}`;
}

export function cacheGet<T>(path: string, query?: Record<string, unknown>): T | undefined {
  if (!uid) return undefined;
  const k = keyOf(path, query);
  let e = mem.get(k);
  if (!e) {
    try {
      const raw = ss()?.getItem(k);
      if (raw) { e = JSON.parse(raw) as { t: number; v: unknown }; mem.set(k, e); }
    } catch { /* unreadable entry: treat as a miss */ }
  }
  if (!e || Date.now() - e.t > MAX_AGE_MS) return undefined;
  return e.v as T;
}

export function cachePut(path: string, query: Record<string, unknown> | undefined, v: unknown): void {
  if (!uid) return;
  const k = keyOf(path, query);
  const e = { t: Date.now(), v };
  mem.set(k, e);
  try {
    const s = JSON.stringify(e);
    if (s.length <= MAX_ENTRY_CHARS) ss()?.setItem(k, s);
  } catch { /* quota or private mode: memory copy is enough */ }
}

/** Drop every cached admin read (all users in this tab). Called on any write and on logout. */
export function cacheClear(): void {
  mem.clear();
  const s = ss();
  if (!s) return;
  try {
    const drop: string[] = [];
    for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k && k.startsWith(PREFIX)) drop.push(k); }
    drop.forEach((k) => s.removeItem(k));
  } catch { /* ignore */ }
}

/* ── remembered verdict (lets the shell and first fetches skip the /whoami round trip) ── */

export function readGate(): { uid: string; email: string | null } | null {
  try {
    const raw = ls()?.getItem(GATE_KEY);
    if (!raw) return null;
    const g = JSON.parse(raw) as { uid?: string; email?: string | null; t?: number };
    if (!g.uid || !g.t || Date.now() - g.t > GATE_TTL_MS) return null;
    return { uid: g.uid, email: g.email ?? null };
  } catch { return null; }
}
export function writeGate(me: { uid: string; email: string | null } | null): void {
  try {
    if (me) ls()?.setItem(GATE_KEY, JSON.stringify({ uid: me.uid, email: me.email, t: Date.now() }));
    else ls()?.removeItem(GATE_KEY);
  } catch { /* ignore */ }
}
/** Sign-out: forget the verdict and every cached read. */
export function forgetAdminSession(): void { writeGate(null); cacheClear(); uid = ''; }
