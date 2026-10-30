/* [HF-DASH-CACHE-1] Last-visit cache for the dashboard, in sessionStorage (this tab only; gone when the tab closes).
 * Two entries: the boot entry (last /api/hf/me body + feature flags, tagged with its uid) and the shell entry per uid (summary, insights,
 * wallet, profile, favourites). They let a repeat visit paint at once while fresh data loads in the background.
 * Safety: every access is try/catch (storage can be blocked or empty); an entry is only used for the uid it was written for, is dropped when
 * /api/hf/me answers 401 or a different uid, and is ignored while Clerk says nobody is signed in. */
import { clearCachedFetch, invalidateMe, looksSignedOut } from '../../../lib/hfCallsApi';

const PREFIX = 'hf_dash_';
const BOOT_KEY = `${PREFIX}me_v1`;
const SHELL_KEY = (uid: string) => `${PREFIX}shell_v1:${uid}`;
const MAX_AGE_MS = 6 * 3600_000;

export interface BootFlags { bookingOn: boolean; favouritesOn: boolean; merchOn: boolean; photoOn: boolean }
export interface BootEntry<A = { uid: string }> { uid: string; at: number; me: A; flags: BootFlags }

function get(k: string): string | null { try { return sessionStorage.getItem(k); } catch { return null; } }
function set(k: string, v: string): void { try { sessionStorage.setItem(k, v); } catch { /* blocked or full: the dashboard just loads normally */ } }

export function readBoot<A extends { uid: string }>(): BootEntry<A> | null {
  if (looksSignedOut()) return null;
  const raw = get(BOOT_KEY);
  if (!raw) return null;
  try {
    const e = JSON.parse(raw) as BootEntry<A>;
    if (!e || typeof e.uid !== 'string' || !e.me || e.me.uid !== e.uid || typeof e.at !== 'number' || Date.now() - e.at > MAX_AGE_MS || !e.flags) return null;
    return e;
  } catch { return null; }
}
export function writeBoot<A extends { uid: string }>(me: A, flags: BootFlags): void { set(BOOT_KEY, JSON.stringify({ uid: me.uid, at: Date.now(), me, flags })); }

export interface ShellSnap { at: number; insights?: unknown; summary?: unknown; wallet?: unknown; favs?: unknown; profile?: unknown }
export function readShell(uid: string): ShellSnap | null {
  const raw = get(SHELL_KEY(uid));
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as ShellSnap;
    return s && typeof s.at === 'number' && Date.now() - s.at < MAX_AGE_MS ? s : null;
  } catch { return null; }
}
export function writeShell(uid: string, snap: Omit<ShellSnap, 'at'>): void { set(SHELL_KEY(uid), JSON.stringify({ ...snap, at: Date.now() })); }

/** Forget everything kept for the dashboard: sessionStorage entries, the shared /me and the per-endpoint caches. Call on 401 / another person. */
export function dropDashCaches(): void {
  try {
    const dead: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); if (k && k.startsWith(PREFIX)) dead.push(k); }
    dead.forEach(k => sessionStorage.removeItem(k));
  } catch { /* blocked */ }
  invalidateMe();
  clearCachedFetch();
}
