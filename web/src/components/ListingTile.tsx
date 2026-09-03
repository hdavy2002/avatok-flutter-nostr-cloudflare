import { useCallback, useState } from 'react';
import type { MouseEvent } from 'react';
import { cfImage } from '../lib/config';
import {
  toCardView, languageLabel, priceLabel,
  laneFor, pillLabel, uniformChips, cardBlurb, bottomRightForLane, buttonsForLane,
} from '../lib/card';
import { statusPill, ctaExtra } from '../lib/copy';
import type { Card as CardModel, CardView } from '../lib/types';
import type { Listing } from '../lib/types';
// [WEB-POSTHOG-1] Contract: Specs/SPEC-2026-09-02-TELEMETRY-CATALOG.md §2.3.
import { capture } from '../lib/analytics';
import { getActiveToken, requireGuestAuth } from '../lib/clerk';
import { addFavorite, removeFavorite, getListing } from '../lib/apiClient';
import { Modal } from './Modal';
import BookingFlow from '../islands/checkout/BookingFlow';

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
  /**
   * [LIST-TRUST-1 §2.3] A ≤30s sample-voice clip for an AI agent listing
   * (`listing_highlights` where `kind='voice'`, duration_s ≤ 30 — §4.4). Not on
   * the Card wire today, so this is a prop hook only: no caller passes it yet,
   * so `▶ SUNO` stays hidden on every agent card until one does. Do NOT wire a
   * click-to-play here without an actual audio element behind it.
   */
  voiceHighlightUrl?: string | null;
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

/** Compact, dependency-free metadata glyphs. The visible card only needs the
 *  shape; the complete value remains available to assistive tech and as a
 *  native hover tooltip on each item. */
function MetadataIcon({ slot }: { slot: number }) {
  const common = {
    width: 15,
    height: 15,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };

  if (slot === 0) {
    return <svg {...common}><path d="M3 8.5A2.5 2.5 0 0 0 3 13.5V17a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3.5a2.5 2.5 0 0 0 0-5V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2Z" /><path d="M13 5v2M13 11v2M13 17v2" /></svg>;
  }
  if (slot === 1) {
    return <svg {...common}><path d="m12 3 2.75 5.57 6.15.9-4.45 4.33 1.05 6.12L12 17.03l-5.5 2.89 1.05-6.12L3.1 9.47l6.15-.9Z" /></svg>;
  }
  return <svg {...common}><path d="M20.6 13.6 13.7 20.5a2 2 0 0 1-2.8 0L3.5 13.1a2 2 0 0 1-.6-1.4V5a2 2 0 0 1 2-2h6.7a2 2 0 0 1 1.4.6l7.6 7.2a2 2 0 0 1 0 2.8Z" /><circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" /></svg>;
}

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
 * comes from a real column or is replaced by something true.
 *
 * [LIST-TRUST-1 §2] The pill / chips / bottom-right / buttons are no longer one
 * generic ladder — `laneFor()` reads `free_entry` / `kind` / `schedule_mode` off
 * the raw listing and the four `*ForLane()` helpers in lib/card.ts pick the
 * §2.1–2.5 slot contents for that lane. This component only assembles markup;
 * it never decides what a lane shows.
 */
export function ListingTile({
  listing, href, width = 520, className = '', position = 0, section = 'unknown', voiceHighlightUrl = null,
}: ListingTileProps) {
  const c = toCardView(listing);
  const target = href ?? listingHref(listing);
  const p = paletteFor(c.id);
  const impressionRef = useCardImpression({ listing_id: c.id, position, section });

  const lane = laneFor(listing, c);
  const pill = pillLabel(lane, listing, c);
  // [CARD-UNIFORM-1] Three chips, same three slots, every lane — see uniformChips.
  const chips = uniformChips(lane, listing, c);
  const blurb = cardBlurb(lane, listing, c);
  const bottomRight = bottomRightForLane(lane, listing, c);
  const buttons = buttonsForLane(lane);
  // §2.3 the sample-voice preview only ever appears next to TALK NOW, and only
  // once a real clip exists — hidden by default (no caller passes the prop yet).
  const showSuno = lane === 'agent' && Boolean(voiceHighlightUrl);
  const [bookingListing, setBookingListing] = useState<Listing | null>(null);
  const [bookingLoading, setBookingLoading] = useState(false);

  const onCardClick = useCallback((e: MouseEvent<HTMLAnchorElement>) => {
    // [WEB-POSTHOG-1] §2.3 market_card_click. The whole card is one <a> so a
    // click on either CTA span bubbles here; `data-cta` on the span that was
    // actually clicked tells us which of book|details|calendar|talk|reserve it
    // was, defaulting to "details" for a click anywhere else on the card.
    const ctaTarget = (e.target as HTMLElement).closest<HTMLElement>('[data-cta]');
    const cta = ctaTarget?.dataset.cta ?? 'details';
    if (cta === 'book' || cta === 'talk' || cta === 'reserve' || cta === 'calendar') {
      e.preventDefault();
      setBookingLoading(true);
      void getListing(c.id).then((full) => setBookingListing(full)).catch(() => undefined).finally(() => setBookingLoading(false));
    }
    capture('market_card_click', { listing_id: c.id, kind: c.kind ?? listing.kind ?? null, position, section, cta });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.id, c.kind, listing.kind, position, section]);

  // Free cards never show a price in the title (§2.4) — not even "Free".
  const price = lane === 'free' ? '' : priceLabel(c.price, listing.price_semantics, listing.billing_unit);
  const language = languageLabel(c.spokenLang);
  const duration = bottomRight;
  const initials = (c.creator?.name || c.creator?.handle || '?')
    .split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();

  const textCol = p.dark ? CREAM : INK;
  const bodyCol = p.dark ? CREAM : '#4a3a20';
  const chipCol = p.dark ? CREAM : INK;
  const hairCol = p.dark ? 'rgba(253,241,211,.28)' : 'rgba(22,22,20,.2)';
  const stripe = p.dark
    ? 'repeating-linear-gradient(135deg, rgba(253,241,211,.14) 0 9px, transparent 9px 20px)'
    : 'repeating-linear-gradient(135deg, rgba(22,22,20,.12) 0 9px, transparent 9px 20px)';

  // [LIST-TRUST-1 §H.5] Favourite heart — optimistic toggle against
  // /api/marketplace/favorites. A guest (no session token) never reaches the
  // API: requireGuestAuth() opens the sign-in gate instead, and the optimistic
  // flip is reverted if they cancel it.
  const [favorited, setFavorited] = useState(c.favorited);
  const [favBusy, setFavBusy] = useState(false);
  const onFavoriteClick = useCallback((e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (favBusy) return;
    const next = !favorited;
    setFavorited(next);
    setFavBusy(true);
    void (async () => {
      try {
        let token = await getActiveToken();
        if (!token) {
          token = await requireGuestAuth(); // opens the sign-in gate for a guest
        }
        if (next) await addFavorite(c.id, token);
        else await removeFavorite(c.id, token);
        capture('market_favorite_toggle', { listing_id: c.id, on: next });
      } catch {
        setFavorited(!next); // revert — cancelled sign-in, or the write failed
      } finally {
        setFavBusy(false);
      }
    })();
  }, [c.id, favBusy, favorited]);

  // Keep sharing available from the compact card without changing the listing
  // contract. The canonical URL is the same href used by the card itself.
  const onShareClick = useCallback((e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const url = new URL(target, window.location.origin).toString();
    capture('market_card_click', { listing_id: c.id, kind: c.kind ?? listing.kind ?? null, position, section, cta: 'share' });
    if (navigator.share) {
      void navigator.share({ title: c.title, url }).catch(() => undefined);
    } else if (navigator.clipboard) {
      void navigator.clipboard.writeText(url).catch(() => undefined);
    }
  }, [c.id, c.kind, c.title, listing.kind, position, section, target]);

  // [LIST-TRUST-1 §2.2] The credential line under the host — only after KYC,
  // and only for a consult listing that actually filled one in.
  const credential = lane === 'consult' && c.creator?.verified ? listing.credential : null;

  return (
    <>
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
      {/* Poster-first artwork: generated posters carry the story, so give them a
          generous portrait canvas and keep the metadata below compact. */}
      <div style={{ height: 'clamp(230px, 28vw, 360px)', background: p.photo, position: 'relative' }}>
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
        {lane === 'free' && (
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
              width: 6, height: 6, borderRadius: '50%', flex: 'none',
              background: c.live ? '#ffd0c4' : '#8fd0c0',
              // [LIST-TRUST-1 §2.3] "ALWAYS ON" gets a pulsing dot, never a time.
              animation: lane === 'agent' ? 'avatok-pill-pulse 1.6s ease-in-out infinite' : undefined,
            }} />
            {pill}
          </span>

          {/* [LIST-TRUST-1 §H.5] The favourite heart — top-right, per the comp. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 'none' }}>
            {c.adultsOnly && (
              <span style={{
                fontFamily: 'Nunito, system-ui, sans-serif', fontWeight: 800, fontSize: '0.6875rem',
                background: CREAM, color: INK, border: `1.5px solid ${INK}`,
                borderRadius: 100, padding: '5px 9px', flex: 'none',
              }}>18+</span>
            )}
            <button
              type="button"
              aria-label={favorited ? 'Remove from favourites' : 'Add to favourites'}
              aria-pressed={favorited}
              onClick={onFavoriteClick}
              style={{
                width: 30, height: 30, flex: 'none', borderRadius: '50%', border: `1.5px solid ${INK}`,
                background: favorited ? '#d93825' : CREAM, color: favorited ? CREAM : INK,
                display: 'grid', placeItems: 'center', fontSize: '0.9375rem', lineHeight: 1,
                cursor: favBusy ? 'wait' : 'pointer',
              }}
            >
              {favorited ? '♥' : '♡'}
            </button>
            <button
              type="button"
              aria-label="Share listing"
              onClick={onShareClick}
              style={{
                width: 30, height: 30, flex: 'none', borderRadius: '50%', border: `1.5px solid ${INK}`,
                background: CREAM, color: INK, display: 'grid', placeItems: 'center',
                fontSize: '0.875rem', lineHeight: 1, cursor: 'pointer',
              }}
            >↗</button>
          </div>
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

        {/* [CARD-UNIFORM-1] Title and body are FIXED-HEIGHT blocks — two lines
            each, clamped. Without this a three-word title and a forty-word one
            push everything below them to different heights, which is what made
            a row of cards look like some were half-finished. `line-height ×
            lines` is set as BOTH min and max height so a short title reserves
            its second line and a long one is cut rather than reflowing the
            card. 1.07 line-height on Anton: the display face carries a hard
            shadow, and a tighter leading makes a wrapped second line collide
            with the shadow of the first (CLAUDE.md type rules). */}
        <span className="sr-only">{c.title}. {blurb}</span>
        <h4 aria-hidden="true" style={{
          fontFamily: 'Anton, Impact, sans-serif', fontWeight: 400, fontSize: '1.4375rem',
          lineHeight: 1.07, textTransform: 'uppercase', color: textCol, margin: 0,
          // Never negative tracking on display type — CLAUDE.md standing rule.
          letterSpacing: '.02em', wordSpacing: '.08em',
          textShadow: p.dark && p.shad ? `3px 3px 0 ${p.shad}` : 'none',
          display: 'none', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2,
          overflow: 'hidden', height: 'calc(1.4375rem * 1.07 * 2)',
        }}>
          {c.title}{price ? ` · ${price}` : ''}
        </h4>

        <p aria-hidden="true" style={{
          margin: 0, fontSize: '0.875rem', fontWeight: 500, lineHeight: 1.45, color: bodyCol,
          display: 'none', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2,
          overflow: 'hidden', height: 'calc(0.875rem * 1.45 * 2)',
        }}>
          {blurb}
        </p>

        <div
          role="group"
          aria-label="Listing highlights"
          style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 30 }}
        >
          {chips.map((chip, i) => (
            <span
              key={`${chip}-${i}`}
              aria-label={chip}
              title={chip}
              style={{
                minHeight: 26, maxWidth: '48%', padding: '3px 8px', flex: '0 1 auto', display: 'grid', placeItems: 'center',
                border: `1.5px solid ${chipCol}`, borderRadius: 100, color: chipCol,
                fontFamily: 'Nunito, system-ui, sans-serif', fontSize: '0.625rem', fontWeight: 800,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}
            >
              {chip}
            </span>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 9, marginTop: 'auto' }}>
          {showSuno && (
            <span data-cta="suno" style={{
              flex: 'none', textAlign: 'center', fontFamily: 'Nunito, system-ui, sans-serif', fontWeight: 800,
              fontSize: '0.75rem', letterSpacing: '.08em', padding: '13px 12px', borderRadius: 100,
              border: `2px solid ${INK}`, background: CREAM, color: INK,
            }}>{ctaExtra.SUNO}</span>
          )}
          <span data-cta={buttons.primaryCta} style={{
            flex: 1, textAlign: 'center', fontFamily: 'Nunito, system-ui, sans-serif', fontWeight: 800,
            fontSize: '0.75rem', letterSpacing: '.08em', padding: '13px 8px', borderRadius: 100,
            border: `2px solid ${INK}`, background: '#d93825', color: CREAM,
          }}>{buttons.primaryLabel}</span>
          <span data-cta={buttons.secondaryCta} style={{
            flex: 1, textAlign: 'center', fontFamily: 'Nunito, system-ui, sans-serif', fontWeight: 800,
            fontSize: '0.75rem', letterSpacing: '.08em', padding: '13px 8px', borderRadius: 100,
            border: `2px solid ${INK}`, background: CREAM, color: INK,
          }}>MORE INFO</span>
        </div>

        <div style={{
          display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap',
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
            {/* [LIST-TRUST-1 §2.3] The AI badge replaces the ✓ on an agent card —
                the tick belongs to the human behind it, shown on the detail page,
                never here. Every other lane's tick is EARNED, never unconditional. */}
            {lane === 'agent' ? ' · AI' : c.creator?.verified ? ' ✓' : ''}
          </span>
          {duration && (
            <span style={{
              marginLeft: 'auto', fontFamily: 'Nunito, system-ui, sans-serif', fontWeight: 800,
              fontSize: '0.6875rem', letterSpacing: '.08em', color: p.stub, whiteSpace: 'nowrap',
            }}>{duration.toUpperCase()}</span>
          )}
          {credential && (
            <span style={{
              flexBasis: '100%', fontFamily: 'Nunito, system-ui, sans-serif', fontWeight: 700,
              fontSize: '0.6875rem', letterSpacing: '.04em', color: p.stub,
            }}>{credential}</span>
          )}
        </div>
      </div>
    </a>
    {(bookingLoading || bookingListing) && (
      <Modal
        open
        dismissable={false}
        maxWidth={560}
        title={<div className="flex items-center justify-between gap-3"><span>{bookingListing?.title ?? 'Opening booking…'}</span><button type="button" aria-label="Close booking" onClick={() => { setBookingListing(null); setBookingLoading(false); }} className="text-2xl leading-none text-ink">×</button></div>}
      >
        {bookingListing ? <BookingFlow listing={bookingListing} /> : <div className="py-8 text-center font-mono font-bold text-inkSoft">Loading booking…</div>}
      </Modal>
    )}
    </>
  );
}

export default ListingTile;
