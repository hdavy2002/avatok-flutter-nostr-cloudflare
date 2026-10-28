/* [HF-EXPLORE-PUBLIC-1] Server side (Astro frontmatter) loaders for /explore, /r/<id> and /i/<platform>/<handle>. Public API only, never a token. */
import { API_BASE } from './env';
import { playable, type ReelCreator, type ReelItem } from './hfExplore';

async function getJson<T>(path: string): Promise<{ status: number; body: T | null }> {
  try {
    const res = await fetch(`${API_BASE}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(4500) });
    return { status: res.status, body: res.ok ? ((await res.json()) as T) : null };
  } catch (err) {
    console.warn('[HF-EXPLORE-PUBLIC-1] fetch failed', path, err instanceof Error ? err.message : String(err));
    return { status: 0, body: null };
  }
}

/** First page of the public feed, with `startId` (when it is visible) moved to position 0. `start` is that reel, or null for an unknown / hidden id. */
export async function loadReels(startId?: string): Promise<{ items: ReelItem[]; nextCursor: string | null; start: ReelItem | null }> {
  const [feed, one] = await Promise.all([
    getJson<{ items?: ReelItem[]; nextCursor?: string | null }>('/api/hf/reels?limit=10'),
    startId && /^(hfrl|hfiv|hfin)_[a-z0-9]{8,40}$/.test(startId) ? getJson<{ item?: ReelItem }>(`/api/hf/reels/${startId}`) : Promise.resolve({ status: 0, body: null }),
  ]);
  const start = one.body?.item && playable([one.body.item]).length ? one.body.item : null;
  const rest = playable(feed.body?.items ?? []).filter(i => i.id !== start?.id);
  return { items: start ? [start, ...rest] : rest, nextCursor: feed.body?.nextCursor ?? null, start };
}

export interface InvitePage { creator: ReelCreator; reels: ReelItem[] }
/** GET /api/hf/invites/:platform/:handle. null = not found / feature off. */
export async function loadInvite(platform: string, handle: string): Promise<InvitePage | null> {
  const r = await getJson<{ ok?: boolean; creator?: ReelCreator; reels?: ReelItem[] }>(`/api/hf/invites/${encodeURIComponent(platform)}/${encodeURIComponent(handle)}`);
  return r.body?.creator ? { creator: r.body.creator, reels: r.body.reels ?? [] } : null;
}
