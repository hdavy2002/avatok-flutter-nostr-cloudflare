import { cfImage } from '../lib/config';
import { toCardView, durationLabel, languageLabel, priceLabel } from '../lib/card';
import type { Card as CardModel } from '../lib/types';
import { Pill } from './Pill';

export interface ListingTileProps {
  listing: CardModel;
  /** Override the link target. Defaults to the listing route `/l/<id>`. */
  href?: string;
  /** Poster width hint for the image transform. */
  width?: number;
  className?: string;
}

/**
 * [DEMO-LISTING-1 2026-08-26] Shareable listing URL: /<creator handle>/<slug>.
 * Falls back to /l/<id> when the listing carries no handle — an id always
 * exists, a handle does not, and a card that links nowhere is worse than an
 * ugly link. Both routes stay live: /l/<id> is what every already-shared link
 * uses, so it must keep working.
 */
export function listingHref(listing: CardModel): string {
  const handle = listing.creator?.handle?.trim();
  if (!handle) return `/l/${encodeURIComponent(listing.id)}`;
  // Prefer a server-supplied slug; otherwise derive one from the title. The id
  // is appended when deriving so two listings with the same title can't collide
  // on one URL — a slug is only a label until the Worker owns it.
  const slug =
    listing.slug?.trim() ||
    `${listing.title ?? ''}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
  if (!slug) return `/l/${encodeURIComponent(listing.id)}`;
  return `/${encodeURIComponent(handle)}/${encodeURIComponent(slug)}`;
}

/** "Tonight 8 PM", "Fri 9 PM", "12 Sep" — the status line the new card comps show. */
function whenLabel(startsAt: number | null): string | null {
  if (!startsAt) return null;
  const d = new Date(startsAt);
  if (!Number.isFinite(d.getTime())) return null;
  const now = new Date();
  const time = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `Tonight ${time}`;
  const days = Math.round((d.getTime() - now.getTime()) / 86_400_000);
  if (days > 0 && days < 7) return `${d.toLocaleDateString('en-IN', { weekday: 'short' })} ${time}`;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

/**
 * Poster card used in marketplace grids (mirrors the app's listing tile):
 * ink-bordered poster with hard shadow, title, creator + price footer, and a
 * LIVE pill when joinable.
 *
 * [CARD-MODEL-1] Everything below now comes through toCardView(). It used to read
 * `listing.poster`, `listing.rating` and `listing.currency` — three fields the worker
 * has never sent — so in production every card fell through to the "no poster"
 * placeholder and no rating ever rendered. The price label was wrong twice over as
 * well: it printed `$` and divided by 100 above 1000, so a ₹1,500 listing displayed as
 * "$15". Per [TOKENS-INR-1] the unit is a token, 1 token = ₹1, and no wallet or listing
 * amount ever prints a `$`.
 */
export function ListingTile({ listing, href, width = 360, className = '' }: ListingTileProps) {
  const c = toCardView(listing);
  const target = href ?? listingHref(listing);
  const price = priceLabel(c.price, listing.price_semantics);
  const discounted = c.promoPct > 0 && c.listPrice != null && c.listPrice !== c.price;
  const duration = durationLabel(c.durationMin);
  const language = languageLabel(c.spokenLang);
  const when = c.live ? null : whenLabel(c.startsAt);
  const place = c.location;

  return (
    <a
      href={target}
      className={[
        'group block rounded-zine border-zine border-ink bg-card shadow-zine-sm overflow-hidden',
        'transition-transform duration-zine ease-out',
        'hover:-translate-x-[1px] hover:-translate-y-[1px] active:translate-x-[2px] active:translate-y-[2px] active:shadow-zine-pressed',
        className,
      ].join(' ')}
    >
      <div className="relative aspect-[4/5] w-full bg-paper2 border-b-zine border-ink overflow-hidden">
        {c.poster ? (
          <img
            src={cfImage(c.poster, { width, fit: 'cover' })}
            alt={c.title}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center font-mono uppercase text-inkMute text-[12px] tracking-[0.08em]">
            {c.kind ?? 'listing'}
          </div>
        )}
        {c.live ? (
          <span className="absolute left-2 top-2"><Pill kind="no">● Live</Pill></span>
        ) : when ? (
          <span className="absolute left-2 top-2"><Pill kind="plain">{when}</Pill></span>
        ) : null}
        {c.category && (
          <span className="absolute right-2 top-2"><Pill kind="plain">{c.category}</Pill></span>
        )}
        {c.adultsOnly && (
          <span className="absolute bottom-2 right-2"><Pill kind="plain">18+</Pill></span>
        )}
      </div>

      <div className="p-3">
        {/* The comps' two-part micro line: category context on the left, language or
            place on the right. Both come from columns that already existed. */}
        {(language || place) && (
          <div className="mb-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.08em] text-inkMute">
            {language && <span className="truncate">{language}</span>}
            {language && place && <span aria-hidden="true">·</span>}
            {place && <span className="truncate">{place}</span>}
          </div>
        )}

        <h3 className="font-display font-semibold text-[17px] leading-tight text-ink line-clamp-2">{c.title}</h3>
        {c.oneLiner && (
          <p className="mt-1 font-body font-bold text-[13px] leading-snug text-inkSoft line-clamp-2">{c.oneLiner}</p>
        )}

        {/* Social proof. Only rendered when it is real — an unrated new listing shows
            nothing rather than "★ 0 · 0", which reads worse than silence. */}
        {(c.ratingAvg != null || c.joinedCount > 0) && (
          <div className="mt-2 flex items-center gap-3 font-mono text-[11px] text-inkSoft">
            {c.ratingAvg != null && (
              <span>★ {c.ratingAvg.toFixed(1)}{c.ratingCount > 0 ? ` · ${c.ratingCount}` : ''}</span>
            )}
            {c.joinedCount > 0 && <span>✓ {c.joinedCount} booked</span>}
          </div>
        )}

        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.06em] text-inkSoft">
            <span className="truncate">
              {c.creator?.handle ? `@${c.creator.handle}` : (c.creator?.name ?? '')}
            </span>
            {c.creator?.verified && <span className="text-blueInk" title="Identity verified">✓</span>}
          </span>
          <span className="flex items-center gap-2 whitespace-nowrap">
            {duration && <span className="font-mono text-[11px] text-inkMute">{duration}</span>}
            {discounted && (
              <span className="font-mono text-[11px] text-inkMute line-through">
                {priceLabel(c.listPrice, listing.price_semantics)}
              </span>
            )}
            {price && <span className="font-display font-semibold text-[16px] text-ink">{price}</span>}
          </span>
        </div>
      </div>
    </a>
  );
}

export default ListingTile;
