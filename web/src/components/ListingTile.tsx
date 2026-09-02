import { useCallback } from 'react';
import { cfImage } from '../lib/config';
import { toCardView, durationLabel, languageLabel, priceLabel } from '../lib/card';
import { chips as chipCopy, statusPill } from '../lib/copy';
import type { Card as CardModel, CardView } from '../lib/types';
// [WEB-POSTHOG-1] Contract: Specs/SPEC-2026-09-02-TELEMETRY-CATALOG.md §2.3.
import { capture } from '../lib/analytics';

export interface ListingTileProps {
  listing: CardModel;
  /** Override the link target. Defaults to the listing route `/l/<id>`. */
  href?: string;
  /** Poster width hint for the image transform. */
  width?: number;
  className?: string;
  /** 0-based position within its section/rail, for market_card_impression/click. */
  position?: number;
  /** The bazaar section (vertical id) or rail this card renders in, e.g. 'live_now'. */
  section?: string;
}

// ── §2.3 market_card_impression — ONE event per batch, up to 50 entries, flushed
// every 2s via a shared IntersectionObserver across every mounted ListingTile.
// A per-card capture would be 24+ events per page load; this is one. ──────────
type Impression = { listing_id: string; position: number; section: string };
let impressionQueue: Impression[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
const seenImpressions = new Set<string>();

function queueImpression(imp: Impression): void {
  const key = `${imp.section}:${imp.listing_id}:${imp.position}`;
  if (seenImpressions.has(key)) return; // one impression per card per page view
  seenImpressions.add(key);
  impressionQueue.push(imp);
  if (impressionQueue.length >= 50) flushImpressions();
  if (!flushTimer && typeof window !== 'undefined') {
    flushTimer = setInterval(flushImpressions, 2000);
  }
}

function flushImpressions(): void {
  if (impressionQueue.length === 0) return;
  const batch = impressionQueue.slice(0, 50);
  impressionQueue = impressionQueue.slice(50);
  capture('market_card_impression', { impressions: batch });
}

let sharedObserver: IntersectionObserver | null = null;
const observedCallbacks = new WeakMap<Element, () => void>();

function getSharedObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === 'undefined') return null;
  if (!sharedObserver) {
    sharedObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const cb = observedCallbacks.get(entry.target);
          if (cb) cb();
          sharedObserver?.unobserve(entry.target);
          observedCallbacks.delete(entry.target);
        }
      },
      { threshold: 0.5 },
    );
  }
  return sharedObserver;
}

/**
 * Returns a ref callback to attach to the card's anchor. A callback ref (not
 * `useRef` + `useEffect`) because a plain ref object's assignment doesn't
 * trigger a re-render, so an effect keyed on `.current` would never see the
 * mounted node — this fires the moment React attaches the DOM node.
 */
function useCardImpression(imp: Impression): (el: HTMLAnchorElement | null) => void {
  return useCallback(
    (el: HTMLAnchorElement | null) => {
      const observer = getSharedObserver();
      if (!observer || !el) return;
      observedCallbacks.set(el, () => queueImpression(imp));
      observer.observe(el);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [imp.listing_id, imp.position, imp.section],
  );
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

/* ── The bazaar palette ──────────────────────────────────────────────────────
 * Lifted verbatim from design/live-streaming/avaTOK Marketplace.dc.html (the
 * PAL object), so the real cards and the comp cannot drift apart. `dark` flips
 * the whole card to cream-on-colour, which changes text, chip and hairline
 * colours together — that is why it is one table and not four loose values.
 */
type Pal = {
  fill: string; photo: string; shad: string; dark: boolean; stub: string;
};

const PAL: Record<string, Pal> = {
  teal: { fill: '#2d7180', photo: '#1e5f66', shad: '#0f3f45', dark: true, stub: '#d6ecee' },
  butter: { fill: '#f4d8a0', photo: '#c9a86a', shad: '', dark: false, stub: '#5a3d33' },
  oat: { fill: '#d9c3a0', photo: '#b09a76', shad: '', dark: false, stub: '#5a3d33' },
  brick: { fill: '#b8382a', photo: '#a4352a', shad: '#7d271e', dark: true, stub: '#fbe4df' },
};
const PAL_ORDER = ['teal', 'butter', 'oat', 'brick'] as const;

const INK = '#161614';
const CREAM = '#fdf1d3';

/**
 * Which colour a listing gets. Derived from its id, NOT its position in the
 * grid, so a card keeps the same colour when the list is filtered, sorted or
 * paginated — a tile that changes colour when you sort looks like a bug.
 */
function paletteFor(id: string): Pal {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PAL[PAL_ORDER[h % PAL_ORDER.length]];
}

/** "TONIGHT 2 AM", "FRI 9 PM", "6 SEPT" — the comp's status pill copy. */
function statusLabel(c: CardView): string {
  if (c.live) return 'LIVE';
  if (!c.startsAt) return 'AVAILABLE NOW';
  const d = new Date(c.startsAt);
  if (!Number.isFinite(d.getTime())) return 'AVAILABLE NOW';
  const time = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }).toUpperCase();
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return `TONIGHT ${time}`;
  const days = Math.round((d.getTime() - now.getTime()) / 86_400_000);
  if (days > 0 && days < 7) return `${d.toLocaleDateString('en-IN', { weekday: 'short' }).toUpperCase()} ${time}`;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }).toUpperCase();
}

/**
 * The comp's two social-proof chips, ALWAYS both filled so the row never
 * collapses and every card has the same shape.
 *
 * ⚠️ THEY ARE FILLED FROM REAL DATA, NOT FROM THE COMP'S STRINGS. The comp reads
 * "♡ 300 REGULARS" and "★ 4.9 · 620" on every card; those are mock copy. Printing
 * them on a live listing would show a buyer a rating and a following that do not
 * exist, next to a real Book button — invented evidence at the exact moment
 * someone decides to spend money. So the SLOTS are always filled (the owner asked
 * for that, and the layout needs it), but with facts the listing actually has:
 * bookings, seats, rating, language, category, or an honest "NEW LISTING".
 */
/**
 * [LIST-FREE-1] Free-entry chip 1 is always "spots baaki" (§2.4: cap-derived
 * seats remaining, `→ FULL` at zero) — it outranks the regulars/seats/duration
 * ladder the paid chip uses, because on a free card "how many spots are left"
 * is the single fact a buyer needs before the other proof chip.
 */
function freeChip1(c: CardView): string {
  if (c.seatsLeft === 0) return 'FULL';
  if (c.seatsLeft != null) return chipCopy.seatsLeft(c.seatsLeft).replace('SEATS', 'SPOTS');
  if (c.capacity != null) return chipCopy.seatsLeft(c.capacity).replace('SEATS', 'SPOTS');
  return 'NEW LISTING';
}

function chipsFor(c: CardView, freeEntry: boolean): [string, string] {
  const one = freeEntry
    ? freeChip1(c)
    : c.joinedCount > 0 ? `✓ ${c.joinedCount.toLocaleString('en-IN')} BOOKED`
      : c.capacity ? `${c.capacity} SEATS`
        : c.durationMin ? `${durationLabel(c.durationMin)?.toUpperCase()}`
          : 'NEW LISTING';
  const two =
    c.ratingAvg != null
      ? `★ ${c.ratingAvg.toFixed(1)}${c.ratingCount > 0 ? ` · ${c.ratingCount}` : ''}`
      : c.seatsLeft != null && c.seatsLeft > 0 && c.seatsLeft <= 5 ? `◷ ${c.seatsLeft} LEFT`
        : c.location ? c.location.toUpperCase()
          : c.live && c.watching ? `👁 ${c.watching} WATCHING`
            : 'JUST ADDED';
  return [one, two];
}

/**
 * The bazaar marketplace card, rendered from REAL listing data.
 *
 * [CARD-BAZAAR-1 2026-08-30, owner decision] This replaces the plain poster tile
 * with the design from design/live-streaming/avaTOK Marketplace.dc.html: 3px ink
 * border, 26px radius, a 6×7px hard shadow, a coloured card body, the scalloped
 * ticket edge under the photo, status pill, favourite heart, two stub lines, two
 * chips, BOOK NOW / CALENDAR and a creator footer.
 *
 * Every measurement here is the comp's. What differs is the SOURCE: the comp is
 * hardcoded mock data and this reads the API, so anything the comp faked either
 * comes from a real column or is replaced by something true (see chipsFor).
 */
export function ListingTile({ listing, href, width = 520, className = '', position = 0, section = 'unknown' }: ListingTileProps) {
  const c = toCardView(listing);
  const target = href ?? listingHref(listing);
  const p = paletteFor(c.id);
  const impressionRef = useCardImpression({ listing_id: c.id, position, section });
  const onCardClick = useCallback(() => {
    // [WEB-POSTHOG-1] §2.3 market_card_click. The whole card is one <a> — there
    // is no separate BOOK NOW / DETAILS control today (both are decorative
    // spans, see below), so every click leads to the details route.
    capture('market_card_click', { listing_id: c.id, kind: c.kind ?? listing.kind ?? null, position, section, cta: 'details' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.id, c.kind, listing.kind, position, section]);
  // [LIST-FREE-1] Gated on `free_entry` alone (§2.4) — a listing that merely
  // prices at ₹0 without the flag is not this lane, and free_entry rows never
  // reach this component without it (server truth, not a promo).
  const isFreeEntry = Boolean(listing.free_entry);
  // Free cards never show a price in the title (§2.4) — not even "Free".
  const price = isFreeEntry ? '' : priceLabel(c.price, listing.price_semantics);
  const [chip1, chip2] = chipsFor(c, isFreeEntry);
  const language = languageLabel(c.spokenLang);
  const duration = durationLabel(c.durationMin);
  const initials = (c.creator?.name || c.creator?.handle || '?')
    .split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();

  const textCol = p.dark ? CREAM : INK;
  const bodyCol = p.dark ? CREAM : '#4a3a20';
  const chipCol = p.dark ? CREAM : INK;
  const hairCol = p.dark ? 'rgba(253,241,211,.28)' : 'rgba(22,22,20,.2)';
  const stripe = p.dark
    ? 'repeating-linear-gradient(135deg, rgba(253,241,211,.14) 0 9px, transparent 9px 20px)'
    : 'repeating-linear-gradient(135deg, rgba(22,22,20,.12) 0 9px, transparent 9px 20px)';

  return (
    <a
      ref={impressionRef}
      href={target}
      onClick={onCardClick}
      className={['group flex flex-col overflow-hidden no-underline', className].join(' ')}
      style={{
        border: `3px solid ${INK}`,
        borderRadius: 26,
        background: p.fill,
        boxShadow: `6px 7px 0 ${INK}`,
        transition: 'transform 120ms ease-out, box-shadow 120ms ease-out',
      }}
    >
      {/* Photo band. The comp is a flat colour; a real listing has a cover, so the
          colour becomes the backdrop the photo sits on and the fallback when there
          is none. */}
      <div style={{ height: 186, background: p.photo, position: 'relative' }}>
        {c.poster && (
          <img
            src={cfImage(c.poster, { width, fit: 'cover' })}
            alt={c.title}
            loading="lazy"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
          />
        )}
        <div style={{ position: 'absolute', inset: 0, backgroundImage: stripe }} />

        {/* [LIST-FREE-1] The free ribbon (§2.4) — a marigold stripe across the photo
            corner, reusing the existing --ava-marigold token (styles/ava-tokens.css)
            rather than a new hex literal. The parent <a> is `overflow-hidden`, which
            is what clips the rotated banner's corners to the card's rounded frame. */}
        {isFreeEntry && (
          <div style={{
            position: 'absolute', top: 16, right: -38, width: 136,
            transform: 'rotate(45deg)', textAlign: 'center', zIndex: 1,
            background: 'var(--ava-marigold)', color: INK,
            fontFamily: 'Nunito, system-ui, sans-serif', fontWeight: 900, fontSize: '0.6875rem',
            letterSpacing: '.08em', padding: '5px 0', boxShadow: `0 2px 0 ${INK}`,
          }}>
            {statusPill.FREE}
          </div>
        )}

        <div style={{
          position: 'absolute', top: 12, left: 12, right: 12,
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8,
        }}>
          <span style={{
            fontFamily: 'Nunito, system-ui, sans-serif', fontWeight: 800, fontSize: '0.6875rem',
            letterSpacing: '.08em', background: c.live ? '#d93825' : '#1e5f66', color: CREAM,
            borderRadius: 100, padding: '6px 11px', display: 'flex', alignItems: 'center', gap: 6, minWidth: 0,
          }}>
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: c.live ? '#ffd0c4' : '#8fd0c0', flex: 'none',
            }} />
            {statusLabel(c)}
          </span>
          {c.adultsOnly && (
            <span style={{
              fontFamily: 'Nunito, system-ui, sans-serif', fontWeight: 800, fontSize: '0.6875rem',
              background: CREAM, color: INK, border: `1.5px solid ${INK}`,
              borderRadius: 100, padding: '5px 9px', flex: 'none',
            }}>18+</span>
          )}
        </div>

        {/* The ticket-stub scallop that joins the photo to the card body. */}
        <div style={{
          position: 'absolute', left: 0, right: 0, bottom: -1, height: 18,
          background: `radial-gradient(circle at 11px 15px, ${p.fill} 11px, transparent 12px) 0 0/22px 18px repeat-x`,
        }} />
      </div>

      <div style={{ padding: '15px 17px 17px', display: 'flex', flexDirection: 'column', gap: 11, flex: 1 }}>
        {/* Stub line: category on the left, language on the right — the comp's s1/s2. */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', gap: 8,
          fontFamily: 'Nunito, system-ui, sans-serif', fontWeight: 800, fontSize: '0.6875rem',
          letterSpacing: '.1em', color: p.stub, textTransform: 'uppercase',
        }}>
          <span className="truncate">{c.category ?? c.kind ?? 'LISTING'}</span>
          <span className="truncate">{language ?? 'AVATOK'}</span>
        </div>

        <h4 style={{
          fontFamily: 'Anton, Impact, sans-serif', fontWeight: 400, fontSize: '1.4375rem',
          lineHeight: 1.07, textTransform: 'uppercase', color: textCol, margin: 0,
          // Never negative tracking on display type — CLAUDE.md standing rule.
          letterSpacing: '.02em', wordSpacing: '.08em',
          textShadow: p.dark && p.shad ? `3px 3px 0 ${p.shad}` : 'none',
        }}>
          {c.title}{price ? ` · ${price}` : ''}
        </h4>

        {c.oneLiner && (
          <p style={{ margin: 0, fontSize: '0.875rem', fontWeight: 500, lineHeight: 1.45, color: bodyCol }}>
            {c.oneLiner}
          </p>
        )}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
          {[chip1, chip2].map((chip) => (
            <span key={chip} style={{
              fontFamily: 'Nunito, system-ui, sans-serif', fontWeight: 800, fontSize: '0.6875rem',
              letterSpacing: '.05em', border: `1.5px solid ${chipCol}`, borderRadius: 100,
              padding: '6px 10px', color: chipCol,
            }}>{chip}</span>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 9, marginTop: 'auto' }}>
          <span style={{
            flex: 1, textAlign: 'center', fontFamily: 'Nunito, system-ui, sans-serif', fontWeight: 800,
            fontSize: '0.75rem', letterSpacing: '.08em', padding: '13px 8px', borderRadius: 100,
            border: `2px solid ${INK}`, background: '#d93825', color: CREAM,
          }}>BOOK NOW</span>
          <span style={{
            flex: 1, textAlign: 'center', fontFamily: 'Nunito, system-ui, sans-serif', fontWeight: 800,
            fontSize: '0.75rem', letterSpacing: '.08em', padding: '13px 8px', borderRadius: 100,
            border: `2px solid ${INK}`, background: CREAM, color: INK,
          }}>DETAILS</span>
        </div>

        <div style={{
          display: 'flex', alignItems: 'center', gap: 9,
          paddingTop: 11, borderTop: `1.5px solid ${hairCol}`,
        }}>
          <span style={{
            width: 26, height: 26, flex: 'none', borderRadius: '50%', border: `1.5px solid ${chipCol}`,
            display: 'grid', placeItems: 'center', fontFamily: 'Nunito, system-ui, sans-serif',
            fontWeight: 800, fontSize: '0.6875rem', color: chipCol, overflow: 'hidden',
          }}>
            {c.creator?.avatar
              ? <img src={cfImage(c.creator.avatar, { width: 52 })} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : initials}
          </span>
          <span style={{ fontSize: '0.8125rem', fontWeight: 600, color: textCol }} className="truncate">
            {c.creator?.name ?? (c.creator?.handle ? `@${c.creator.handle}` : 'avaTOK')}
            {/* The tick is EARNED — the comp draws it on every card unconditionally. */}
            {c.creator?.verified ? ' ✓' : ''}
          </span>
          {duration && (
            <span style={{
              marginLeft: 'auto', fontFamily: 'Nunito, system-ui, sans-serif', fontWeight: 800,
              fontSize: '0.6875rem', letterSpacing: '.08em', color: p.stub, whiteSpace: 'nowrap',
            }}>{duration.toUpperCase()}</span>
          )}
        </div>
      </div>
    </a>
  );
}

export default ListingTile;
