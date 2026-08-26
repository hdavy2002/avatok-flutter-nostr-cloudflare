import { cfImage } from '../lib/config';
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

function priceLabel(listing: CardModel): string | null {
  if (listing.price == null) return null;
  const cur = (listing.currency ?? 'USD').toUpperCase();
  // Worker prices are minor units; show a simple major-unit figure.
  const major = listing.price >= 1000 ? (listing.price / 100).toFixed(0) : String(listing.price);
  return `${cur === 'USD' ? '$' : cur + ' '}${major}`;
}

/**
 * Poster card used in marketplace grids (mirrors the app's listing tile):
 * ink-bordered poster with hard shadow, title, creator + price footer, and a
 * LIVE pill when joinable. Links to the listing route by default.
 */
export function ListingTile({ listing, href, width = 360, className = '' }: ListingTileProps) {
  const target = href ?? `/l/${encodeURIComponent(listing.id)}`;
  const price = priceLabel(listing);
  const isLive = listing.live || listing.joinable;

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
        {listing.poster ? (
          <img
            src={cfImage(listing.poster, { width, fit: 'cover' })}
            alt={listing.title}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center font-mono uppercase text-inkMute text-[12px] tracking-[0.08em]">
            {listing.kind ?? 'listing'}
          </div>
        )}
        {isLive && (
          <span className="absolute left-2 top-2">
            <Pill kind="no">● Live</Pill>
          </span>
        )}
        {listing.category && (
          <span className="absolute right-2 top-2">
            <Pill kind="plain">{listing.category}</Pill>
          </span>
        )}
      </div>

      <div className="p-3">
        <h3 className="font-display font-semibold text-[17px] leading-tight text-ink line-clamp-2">{listing.title}</h3>
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-inkSoft truncate">
            {listing.creator?.handle ? `@${listing.creator.handle}` : (listing.creator?.name ?? '')}
          </span>
          {price && <span className="font-display font-semibold text-[16px] text-ink whitespace-nowrap">{price}</span>}
        </div>
      </div>
    </a>
  );
}

export default ListingTile;
