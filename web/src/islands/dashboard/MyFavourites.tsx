/* [FAV-LIST-1 2026-09-06] "Saved" — the shows this person hearted.
 *
 * Owner: "lets build a proper fav. so we can pull this in users dashboard and
 * show its as list cards with name and tiny description, so i know which ones i
 * added to my fav. do this for the web right now. but later we will pull the
 * same info and create a flutter page around it."
 *
 * WHICH IS WHY THERE IS NO NEW ENDPOINT HERE. GET /api/marketplace/favorites
 * already returns the user's hearted listings as full cards, newest first
 * (worker/src/routes/listings.ts listFavorites) — the same card shape the
 * marketplace grid uses. The Flutter page will call that identical route and
 * get identical data; building a web-only "favourites summary" endpoint now
 * would mean two shapes to keep in step, and the app would get the worse one.
 *
 * `one_liner` is the tiny description the owner asked for: shapeCard() already
 * derives it as the first line of the description, capped at 120 chars. It is
 * not a new field and not a second copy of the description.
 *
 * Un-hearting from this page removes the row and drops the card. That is the
 * whole reason a saved list is worth having — otherwise the only way to unsave
 * something is to go and find it again.
 */
import { useCallback, useEffect, useState } from 'react';
import { getActiveTokenWaited as getActiveToken, SignInButton } from '../../lib/clerk';
import { request, ApiError } from '../../lib/apiClient';
import { Spinner } from '../../components/Spinner';
import { cfImage } from '../../lib/config';
import { inrOrFree } from '../../lib/money';
import { listingPath } from '../../lib/urls';
import { capture } from '../../lib/analytics';
import type { Card as ListingCard } from '../../lib/types';

/** The poster, at the shape a list row wants. Mirrors how the listing page
 *  resolves its hero: the generated poster first, a creator photo only as a
 *  fallback — a saved list is recognised by its posters. */
function thumbFor(c: ListingCard): string | null {
  const poster: any = (c as any).attrs?.poster ?? null;
  const usable = poster && (poster.status === 'draft' || poster.status === 'approved');
  const url = (usable ? poster.url : null) ?? c.cover_media?.[0]?.url ?? null;
  return url ? cfImage(url, { width: 240, fit: 'cover', quality: 70 }) : null;
}

function whenLabel(c: ListingCard): string | null {
  if (!c.starts_at) return null;
  try {
    return new Date(c.starts_at).toLocaleString(undefined, {
      weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
    });
  } catch { return null; }
}

export default function MyFavourites() {
  const [token, setToken] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [items, setItems] = useState<ListingCard[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => {
    void (async () => { setToken(await getActiveToken()); setAuthChecked(true); })();
  }, []);

  const load = useCallback(async (jwt: string) => {
    setLoading(true); setError(null);
    try {
      const r = await request<{ listings: ListingCard[] }>('/api/marketplace/favorites', { auth: jwt });
      setItems(r.listings ?? []);
    } catch (e) {
      setError(e instanceof ApiError ? e.error : 'Could not load your saved shows.');
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (token) void load(token); }, [token, load]);

  async function unsave(id: string) {
    setRemoving(id);
    // Drop it from the list first — this is a removal the user just asked for,
    // and putting the row back on failure is clearer than a spinner on a row
    // they expect to be gone.
    const before = items ?? [];
    setItems(before.filter((c) => c.id !== id));
    try {
      const jwt = await getActiveToken();
      await request(`/api/marketplace/favorites`, {
        method: 'DELETE', auth: jwt, query: { listing_id: id },
      });
      capture('dashboard_favourite_removed', { listing_id: id });
    } catch {
      setItems(before);
      setError('Could not remove that one. Try again.');
    } finally {
      setRemoving(null);
    }
  }

  if (!authChecked) return <div className="flex items-center gap-3 p-6"><Spinner size={22} /></div>;

  if (!token) {
    return (
      <div className="rounded-zine border-zine border-ink bg-card p-6 shadow-zine-sm">
        <p className="font-body text-[15px] font-bold text-inkSoft">
          Sign in to see the shows you saved.
        </p>
        <div className="mt-4"><SignInButton mode="modal" /></div>
      </div>
    );
  }

  if (loading && items === null) return <div className="flex items-center gap-3 p-6"><Spinner size={22} /></div>;

  if (error && !items?.length) {
    return (
      <div role="alert" className="rounded-zine border-zine border-ink bg-coral p-4 font-body text-[14px] font-bold text-ink shadow-zine-sm">
        {error}
      </div>
    );
  }

  if (!items?.length) {
    return (
      <div className="rounded-zine border-zine border-ink bg-card p-6 shadow-zine-sm">
        <p className="font-display text-[20px] font-semibold text-ink">Nothing saved yet</p>
        <p className="mt-2 font-body text-[15px] font-bold text-inkSoft">
          Tap the heart on any show and it lands here, so you can find it again.
        </p>
        <a
          href="/marketplace"
          className="mt-4 inline-block rounded-full border-zine border-ink bg-lime px-4 py-2 font-mono text-[13px] font-bold uppercase tracking-[0.06em] text-ink no-underline shadow-zine-xs"
        >
          Browse shows
        </a>
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      {error && (
        <div role="alert" className="rounded-zine border-zine border-ink bg-coral p-3 font-body text-[13px] font-bold text-ink">
          {error}
        </div>
      )}
      {items.map((c) => {
        // shapeCard nests the creator under `creator` — there are no flat
        // creator_handle / creator_name fields on a card.
        const href = listingPath({ id: c.id, handle: c.creator?.handle ?? null, slug: c.slug ?? null });
        const thumb = thumbFor(c);
        const when = whenLabel(c);
        return (
          <article key={c.id} className="flex gap-4 rounded-zine border-zine border-ink bg-card p-3 shadow-zine-sm">
            <a href={href} className="shrink-0">
              {thumb ? (
                <img
                  src={thumb}
                  alt={c.title}
                  loading="lazy"
                  className="h-[92px] w-[72px] rounded-zine border-zine border-ink object-cover"
                />
              ) : (
                <div className="h-[92px] w-[72px] rounded-zine border-zine border-ink bg-paper2" />
              )}
            </a>

            <div className="min-w-0 flex-1">
              <a href={href} className="font-display text-[18px] font-semibold leading-tight text-ink no-underline">
                {c.title}
              </a>
              {/* The "tiny description" — shapeCard's one_liner. Falls back to
                  the blurb so a listing written before one_liner existed still
                  says something, rather than showing an empty row. */}
              {(c.one_liner || c.blurb) && (
                <p className="mt-1 line-clamp-2 font-body text-[14px] font-bold text-inkSoft">
                  {c.one_liner || c.blurb}
                </p>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[12px] font-bold uppercase tracking-[0.06em] text-inkSoft">
                {c.creator?.name && <span>{c.creator.name}</span>}
                {when && <span>{when}</span>}
                <span>{inrOrFree(c.effective_price ?? c.price)}</span>
                {c.status === 'live' && <span className="text-coralInk">Live now</span>}
              </div>
            </div>

            <button
              type="button"
              onClick={() => void unsave(c.id)}
              disabled={removing === c.id}
              aria-label={`Remove ${c.title} from saved`}
              title="Remove from saved"
              className="h-9 shrink-0 self-start rounded-full border-zine border-ink bg-paper2 px-3 font-body text-[15px] text-ink shadow-zine-xs disabled:opacity-50"
            >
              ♥
            </button>
          </article>
        );
      })}
    </div>
  );
}
