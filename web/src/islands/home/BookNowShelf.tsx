// [SAATHUM-BOOKNOW-1 2026-09-26] OWNER DECISION: a "Book now" section on the
// homepage between the intention cards and the havan knowledge cards.
//
// NOTE FOR AI:
//  - Shows up to FOUR real, bookable, upcoming (or live) listings from the
//    public /api/explore feed, soonest first. No listings → the island renders
//    NOTHING (not an empty state) — owner rule: "if no havan is listed then
//    nothing shows in this section".
//  - Never invent numbers. Rating shows only when rating_count > 0; "booked"
//    = real bookings + attrs.booked_boost (the owner's own ad number, set in admin);
//    only when joined_count > 0. Prices come from the listing (admin-edited),
//    always phrased "Starting from ₹X" because checkout adds options.
//  - `?booknow=preview` renders four SAMPLE cards so the owner can see the
//    design while prod has no listings. Samples are labelled and noindex'd by
//    virtue of needing the query param; never render them by default.
//  - Remind me = an "Add to Google Calendar" link (works signed-out).
//  - [SAATHUM-EVENT-TYPES 2026-09-27] All type-dependent wording (badge, colour,
//    countdown label, buttons, feature ticks, footer line) comes from
//    ../../lib/eventTypes.ts — never hardcode "havan"/"puja" text here.
import { useEffect, useMemo, useState } from 'react';
import { getExplore } from '../../lib/apiClient';
import { capture, captureException } from '../../lib/analytics';
import { publicImage } from '../../lib/config';
import type { EventType } from '../../lib/eventTypes';
// [MKT-V2-1] The card itself lives in BookCard.tsx, shared with /marketplace.
import { BookCard, norm, toItem, type GuideLink, type Item } from './BookCard';
import './BookNowShelf.css';
import { BRAND } from '../../lib/brand';

export type { GuideLink } from './BookCard';

interface Props {
  /** Every ritual article: used for "Read benefits" and as poster fallback. `image` is a raw /assets path. */
  guides: GuideLink[];
  /** Four featured havans, used ONLY for ?booknow=preview sample cards. */
  samples: GuideLink[];
  /** Base URL of the marketplace ("Our Pujas"). */
  exploreHref?: string;
}

const MAX = 4;

/** Owner-picked event types for the four preview articles (2026-09-27). */
function eventTypeForSample(title: string): EventType {
  const t = norm(title);
  if (t.includes('navagraha')) return 'puja';
  return 'havan'; // ganapati, lakshmi, mahamrityunjaya (and any other sample) → havan
}

function sampleItems(samples: GuideLink[], now: number): Item[] {
  const H = 3600e3;
  const plan = [
    { off: 3 * H + 13 * 60e3, city: 'Haridwar', price: 111, booked: 1240, r: 4.9, rc: 128, mode: 'live' as const, prasad: true },
    { off: 26 * H, city: 'Kashi', price: 111, booked: 3862, r: 5, rc: 311, mode: 'live' as const, prasad: true },
    { off: 53 * H, city: 'Ujjain', price: 151, booked: 918, r: 4.8, rc: 76, mode: 'live' as const, prasad: false },
    { off: 96 * H, city: 'Gaya', price: 1100, booked: 204, r: 4.9, rc: 41, mode: 'one_on_one' as const, prasad: true },
  ];
  return samples.slice(0, MAX).map((g, i) => {
    const p = plan[i % plan.length];
    return {
      id: 'sample-' + i, title: g.title, deity: null,
      blurb: 'Sample card — shown only with ?booknow=preview so the design can be reviewed before real listings exist.',
      image: publicImage(g.image, { width: 900, fit: 'scale-down' }), imageSrcSet: null,
      mode: p.mode, liveNow: false, isLiveStream: false, startsAt: now + p.off, durationMin: 120,
      location: p.city, category: null, intention: null, ratingAvg: p.r, ratingCount: p.rc, booked: p.booked, price: p.price,
      prasad: p.prasad, videoDownload: p.mode === 'live', visibility: 'public',
      eventType: eventTypeForSample(g.title), performedBy: null, performerPhotoUrl: null,
      href: g.href, bookHref: '/marketplace', benefitsHref: g.href,
    };
  });
}

export default function BookNowShelf({ guides, samples, exploreHref = '/marketplace' }: Props) {
  const [items, setItems] = useState<Item[]>([]);
  const [sample, setSample] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const origin = typeof window !== 'undefined' ? window.location.origin : BRAND.webOrigin;

  useEffect(() => {
    const ctrl = new AbortController();
    const t0 = performance.now();
    const preview = new URLSearchParams(window.location.search).get('booknow') === 'preview';
    (async () => {
      try {
        const collected: Item[] = [];
        const seen = new Set<string>();
        let cursor: string | undefined;
        for (let page = 0; page < 3 && collected.length < 12; page++) {
          const res = await getExplore({ limit: 30, cursor }, ctrl.signal);
          const t = Date.now();
          for (const card of res.listings ?? []) {
            const it = toItem(card, guides, t);
            if (!it || seen.has(it.id)) continue;
            seen.add(it.id);
            collected.push(it);
          }
          cursor = (res as { cursor?: string | null }).cursor ?? undefined;
          if (!cursor) break;
        }
        collected.sort((a, b) => Number(b.isLiveStream) - Number(a.isLiveStream) || Number(b.liveNow) - Number(a.liveNow) || (a.startsAt ?? 0) - (b.startsAt ?? 0));
        const top = collected.slice(0, MAX);
        if (top.length === 0 && preview) { setSample(true); setItems(sampleItems(samples, Date.now())); }
        else setItems(top);
        capture('home_booknow_loaded', { count: top.length, preview, ms: Math.round(performance.now() - t0) });
      } catch (err) {
        if (ctrl.signal.aborted) return;
        captureException(err, { surface: 'home_booknow' });
        if (preview) { setSample(true); setItems(sampleItems(samples, Date.now())); }
      }
    })();
    return () => ctrl.abort();
  }, [guides, samples]);

  const hasTimers = useMemo(() => items.some(i => !i.liveNow && i.startsAt != null), [items]);
  useEffect(() => {
    if (!hasTimers) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [hasTimers]);

  if (items.length === 0) return null;

  return (
    <section className="bn-section" id="book-now" aria-labelledby="bn-title" data-home-section="book-now">
      <div className="bn-inner">
        <div className="bn-head">
          <h2 id="bn-title"><span aria-hidden="true">✽</span> Book now</h2>
          <p>Upcoming havans, performed by temple priests. Join from anywhere.</p>
          {sample && <p className="bn-sample-note">Preview with sample cards — real listings replace these automatically.</p>}
        </div>
        <div className={'bn-grid bn-grid--' + items.length}>
          {items.map((it, i) => <BookCard key={it.id} it={it} now={now} origin={origin} onAction={(action) => capture('home_booknow_click', { action, listing_id: it.id, position: i, sample })} />)}
        </div>
        <div className="bn-more">
          <a className="bn-more-btn" href={exploreHref} data-home-cta="booknow-explore" onClick={() => capture('home_booknow_click', { action: 'explore_more', sample })}>Explore all pujas &amp; havans <span aria-hidden="true">→</span></a>
        </div>
      </div>
    </section>
  );
}
