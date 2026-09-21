import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';
import type { Card, CardView } from '../../lib/types';
import { durationLabel, languageLabel, priceLabel } from '../../lib/card';
import { ListingTile, listingHref } from '../../components/ListingTile';
import { capture } from '../../lib/analytics';
import {
  createHomeEventsController,
  type HomeEventsController,
  type HomeEventsState,
  type HomeEventsTab,
} from '../../lib/spiritualHomeEvents';
import './SpiritualEventShelves.css';

/**
 * [SHV2-S3] `HomeEventsState` (contracts.md §2) exposes normalized `CardView[]`,
 * but `ListingTile` (and the lane/pill helpers it calls) read the raw wire-shaped
 * `Card` — snake_case fields `ListingTile` re-normalizes itself via `toCardView`.
 * This losslessly maps the already-normalized fields back onto the wire shape so
 * `ListingTile`'s own re-normalization reconstructs the same values. Fields that
 * exist only on `Card` (free_entry, schedule_mode, vibe_tags, billing_unit,
 * price_semantics, credential, slug) are not on `CardView` at all, so they are
 * left absent — the lane ladders in lib/card.ts already have honest fallbacks
 * for an absent field, never a fabricated one. Flagged for the coordinator in
 * the hand-back note: the clean fix is `HomeEventsState` exposing `Card[]`.
 */
export function toPseudoCard(c: CardView): Card {
  return {
    id: c.id,
    kind: c.kind ?? undefined,
    title: c.title,
    one_liner: c.oneLiner,
    poster: c.poster,
    cover_media: c.poster ? [{ type: 'image', url: c.poster }] : null,
    price: c.price,
    effective_price: c.price,
    promo_pct: c.promoPct,
    currency_display: c.currency,
    category: c.category,
    category_label: c.categoryLabel ?? null,
    country: c.country,
    location: c.location,
    rating_avg: c.ratingAvg,
    rating_count: c.ratingCount,
    review_count: c.reviewCount,
    joined_count: c.joinedCount,
    creator: c.creator
      ? {
        uid: c.creator.id,
        handle: c.creator.handle,
        name: c.creator.name,
        avatar_url: c.creator.avatar,
        kyc_verified: c.creator.verified,
      }
      : null,
    live: c.live,
    status: c.status,
    schedule_state: c.scheduleState,
    starts_at: c.startsAt,
    duration_min: c.durationMin,
    capacity: c.capacity,
    spoken_lang: c.spokenLang,
    adults_only: c.adultsOnly,
    seats_left: c.seatsLeft,
    watching: c.watching,
    favorited: c.favorited,
    created_at: c.createdAt,
  };
}

/** Browser-local time with a visible zone label and an explicit IST fallback
 *  (A4.2/AC-08). Returns null when there is no start time to show at all. */
export function formatLocalStart(startsAtMs: number | null): { iso: string; label: string; zone: string } | null {
  if (!startsAtMs) return null;
  const d = new Date(startsAtMs);
  if (!Number.isFinite(d.getTime())) return null;
  let timeZone = 'Asia/Kolkata';
  let zone = 'IST';
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (resolved) timeZone = resolved;
  } catch {
    // Intl unavailable — IST fallback above stands.
  }
  try {
    const parts = new Intl.DateTimeFormat(undefined, { timeZone, timeZoneName: 'short' }).formatToParts(d);
    const tz = parts.find((p) => p.type === 'timeZoneName')?.value;
    if (tz) zone = tz;
  } catch {
    // Keep the IST fallback.
  }
  let label: string;
  try {
    label = d.toLocaleString(undefined, {
      timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch {
    label = d.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  }
  return { iso: d.toISOString(), label, zone };
}

interface EventCardProps {
  card: CardView;
  position: number;
  section: 'home_live' | 'home_upcoming' | 'home_new';
  joinable: boolean;
}

/** One shelf card: the shared `ListingTile` visual + booking gate, plus the
 *  honest supplemental line A4.2 requires (title, creator, time, duration,
 *  price basis, language/location if supplied) and the fail-closed
 *  Join now / View details action. */
function EventCard({ card, position, section, joinable }: EventCardProps) {
  const pseudo = useMemo(() => toPseudoCard(card), [card]);
  const href = useMemo(() => listingHref(pseudo), [pseudo]);
  const start = useMemo(() => formatLocalStart(card.startsAt), [card.startsAt]);
  const duration = durationLabel(card.durationMin);
  const price = priceLabel(card.price, null, null);
  const language = languageLabel(card.spokenLang);
  const creatorName = card.creator?.name ?? null;

  const onActionClick = useCallback(() => {
    capture('market_card_click', {
      listing_id: card.id, kind: card.kind, position, section,
      cta: joinable ? 'join_now' : 'view_details',
    });
  }, [card.id, card.kind, position, section, joinable]);

  return (
    <div className="shv2-card">
      <ListingTile listing={pseudo} href={href} width={420} position={position} section={section} enableSkeleton />
      <div className="shv2-card-meta">
        <p className="shv2-card-title">{card.title}</p>
        <p className="shv2-card-line">
          {creatorName && <span className="shv2-card-creator">{creatorName}</span>}
          {language && <span>{language}</span>}
          {card.location && <span>{card.location}</span>}
        </p>
        <p className="shv2-card-line">
          {start && (
            <time dateTime={start.iso} className="shv2-card-time">
              {start.label} <span className="shv2-card-zone">{start.zone}</span>
            </time>
          )}
          {duration && <span>{duration}</span>}
          {price && <span className="shv2-card-price">{price}</span>}
        </p>
        <a
          className="shv2-card-action rail-button rail-button--ink"
          href={href}
          data-cta={joinable ? 'join_now' : 'view_details'}
          onClick={onActionClick}
        >
          {joinable ? 'Join now' : 'View details'}
        </a>
      </div>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="shv2-card shv2-skeleton" aria-hidden="true">
      <div className="shv2-skeleton-poster" />
      <div className="shv2-skeleton-line shv2-skeleton-line--wide" />
      <div className="shv2-skeleton-line" />
      <div className="shv2-skeleton-line shv2-skeleton-line--short" />
    </div>
  );
}

function SkeletonShelf({ count }: { count: number }) {
  return (
    <div className="shv2-shelf" role="presentation">
      {Array.from({ length: count }, (_, i) => <SkeletonCard key={i} />)}
    </div>
  );
}

interface ShelfProps {
  cards: CardView[];
  section: 'home_live' | 'home_upcoming' | 'home_new';
  state: HomeEventsState;
}

function Shelf({ cards, section, state }: ShelfProps) {
  const capped = cards.slice(0, 6);
  return (
    <div className="shv2-shelf">
      {capped.map((card, i) => (
        <EventCard key={card.id} card={card} position={i} section={section} joinable={state.joinable(card)} />
      ))}
    </div>
  );
}

const TABS: { id: HomeEventsTab; label: string }[] = [
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'newest', label: 'Newly added' },
];

interface UpcomingTabsProps {
  state: HomeEventsState;
}

/** WAI-ARIA tabs pattern: roving tabindex, arrow-key navigation, automatic
 *  activation (A8, AC-13). */
function UpcomingTabs({ state }: UpcomingTabsProps) {
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const activeIndex = TABS.findIndex((t) => t.id === state.tab);

  const focusAndSelect = useCallback((index: number) => {
    const wrapped = (index + TABS.length) % TABS.length;
    const tab = TABS[wrapped];
    state.selectTab(tab.id);
    tabRefs.current[tab.id]?.focus();
  }, [state]);

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); focusAndSelect(activeIndex + 1); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); focusAndSelect(activeIndex - 1); }
    else if (e.key === 'Home') { e.preventDefault(); focusAndSelect(0); }
    else if (e.key === 'End') { e.preventDefault(); focusAndSelect(TABS.length - 1); }
  }, [activeIndex, focusAndSelect]);

  return (
    <div className="shv2-tablist" role="tablist" aria-label="Upcoming events">
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          id={`shv2-tab-${t.id}`}
          aria-selected={state.tab === t.id}
          aria-controls={`shv2-panel-${t.id}`}
          tabIndex={state.tab === t.id ? 0 : -1}
          ref={(el) => { tabRefs.current[t.id] = el; }}
          onKeyDown={onKeyDown}
          onClick={() => state.selectTab(t.id)}
          className="shv2-tab"
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function UpcomingPanel({ state }: { state: HomeEventsState }) {
  const activeCards = state.tab === 'newest' ? state.newest : state.upcoming;
  const section = state.tab === 'newest' ? 'home_new' : 'home_upcoming';
  const isNewestLoading = state.tab === 'newest' && state.newestStatus === 'loading';
  const isNewestError = state.tab === 'newest' && state.newestStatus === 'error';

  return (
    <div
      id={`shv2-panel-${state.tab}`}
      role="tabpanel"
      aria-labelledby={`shv2-tab-${state.tab}`}
    >
      {isNewestLoading || activeCards === null ? (
        <SkeletonShelf count={6} />
      ) : isNewestError ? (
        <p className="shv2-inline-error">
          Couldn't load newly added events.{' '}
          <button type="button" className="shv2-retry" onClick={() => state.selectTab('newest')}>Retry</button>
        </p>
      ) : activeCards.length === 0 ? (
        <p className="shv2-empty-note">No events in this list yet.</p>
      ) : (
        <Shelf cards={activeCards} section={section} state={state} />
      )}
      <a className="shv2-explore-all" href="/marketplace">Explore all events →</a>
    </div>
  );
}

interface SpiritualEventShelvesProps {
  /** Injectable for tests / local mocking; production callers never pass this. */
  controller?: HomeEventsController;
}

export function SpiritualEventShelves({ controller: injected }: SpiritualEventShelvesProps = {}) {
  const controllerRef = useRef<HomeEventsController | null>(null);
  if (!controllerRef.current) controllerRef.current = injected ?? createHomeEventsController();
  const controller = controllerRef.current;

  const [state, setState] = useState<HomeEventsState>(() => controller.getState());

  useEffect(() => {
    const unsubscribe = controller.subscribe(setState);
    controller.start();
    return () => {
      unsubscribe();
      controller.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller]);

  let liveContent: ReactElement;
  let upcomingContent: ReactElement | null = null;

  if (state.status === 'loading') {
    liveContent = <SkeletonShelf count={6} />;
    upcomingContent = <SkeletonShelf count={6} />;
  } else if (state.status === 'error') {
    liveContent = (
      <p className="shv2-inline-error">
        Couldn't load events.{' '}
        <button type="button" className="shv2-retry" onClick={() => state.retry()}>Retry</button>
        {' '}<a href="/marketplace">Browse the marketplace</a>
      </p>
    );
  } else if (state.status === 'none') {
    liveContent = (
      <p className="shv2-none-strip">
        New experiences are added as organisers publish them.{' '}
        <a href="/marketplace">Explore marketplace</a> ·{' '}
        <a href="/organisers">Become an organiser</a>
      </p>
    );
  } else if (state.status === 'upcoming_only') {
    liveContent = <p className="shv2-live-strip">Nothing live right now</p>;
    upcomingContent = (
      <>
        <h2 className="shv2-shelf-heading">Upcoming events</h2>
        <UpcomingTabs state={state} />
        <UpcomingPanel state={state} />
      </>
    );
  } else {
    // 'full'
    liveContent = (
      <>
        <h2 className="shv2-shelf-heading">Live now</h2>
        <Shelf cards={state.live} section="home_live" state={state} />
      </>
    );
    upcomingContent = (
      <>
        <h2 className="shv2-shelf-heading">Upcoming events</h2>
        <UpcomingTabs state={state} />
        <UpcomingPanel state={state} />
      </>
    );
  }

  return (
    <div className="shv2-events">
      <noscript>
        <style>{'.shv2-skeleton{display:none}'}</style>
        <p className="shv2-noscript">
          <a href="/marketplace?section=live_streaming">Browse live events</a>
          {' · '}
          <a href="/marketplace">Browse upcoming events</a>
        </p>
      </noscript>
      <section id="live-now" aria-label="Live now">{liveContent}</section>
      <section id="upcoming-events" aria-label="Upcoming events">{upcomingContent}</section>
    </div>
  );
}

export default SpiritualEventShelves;
