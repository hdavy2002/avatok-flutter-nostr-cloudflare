// [SAATHUM-BOOKNOW-1 2026-09-26] OWNER DECISION: a "Book now" section on the
// homepage between the intention cards and the havan knowledge cards.
//
// NOTE FOR AI:
//  - Shows up to FOUR real, bookable, upcoming (or live) listings from the
//    public /api/explore feed, soonest first. No listings → the island renders
//    NOTHING (not an empty state) — owner rule: "if no havan is listed then
//    nothing shows in this section".
//  - Never invent numbers. Rating shows only when rating_count > 0; "booked"
//    only when joined_count > 0. Prices come from the listing (admin-edited),
//    always phrased "Starting from ₹X" because checkout adds options.
//  - `?booknow=preview` renders four SAMPLE cards so the owner can see the
//    design while prod has no listings. Samples are labelled and noindex'd by
//    virtue of needing the query param; never render them by default.
//  - Remind me = an "Add to Google Calendar" link (works signed-out).
import { useEffect, useMemo, useState } from 'react';
import type { Card } from '../../lib/types';
import { getExplore } from '../../lib/apiClient';
import { toCardView, scheduleStateOf, durationLabel } from '../../lib/card';
import { listingPath, payAndJoinPath } from '../../lib/urls';
import { capture, captureException } from '../../lib/analytics';
import { publicImage } from '../../lib/config';
import './BookNowShelf.css';

export interface GuideLink { title: string; href: string; image: string }

interface Props {
  /** Every ritual article: used for "Read benefits" and as poster fallback. `image` is a raw /assets path. */
  guides: GuideLink[];
  /** Four featured havans, used ONLY for ?booknow=preview sample cards. */
  samples: GuideLink[];
  /** Base URL of the marketplace ("Our Pujas"). */
  exploreHref?: string;
}

interface Item {
  id: string;
  title: string;
  deity: string | null;
  blurb: string | null;
  image: string | null;
  mode: 'live' | 'one_on_one';
  liveNow: boolean;
  startsAt: number | null;
  durationMin: number | null;
  location: string | null;
  category: string | null;
  ratingAvg: number | null;
  ratingCount: number;
  booked: number;
  price: number | null;
  prasad: boolean;
  replay: boolean;
  href: string;
  bookHref: string;
  benefitsHref: string;
}

const MAX = 4;
/** Mirrors ritualGuides ritualCategoryShort and the worker's INTENTIONS (admin2_events_logic.ts). */
const INTENTION_LABELS: Record<string, string> = {
  education: 'Education', luck: 'Good luck', wealth: 'Wealth', career: 'Career', health: 'Health',
  family: 'Family', peace: 'Peace', life: 'Life events', festival: 'Festivals',
};
const IST = 'Asia/Kolkata';

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function guideFor(title: string, guides: GuideLink[]): GuideLink | null {
  const t = norm(title);
  let best: GuideLink | null = null;
  for (const g of guides) {
    const n = norm(g.title);
    if (n && t.includes(n) && (!best || n.length > norm(best.title).length)) best = g;
  }
  return best;
}

function attrBool(attrs: Record<string, unknown> | null | undefined, keys: string[], fallback: boolean): boolean {
  for (const k of keys) {
    const v = attrs?.[k];
    if (typeof v === 'boolean') return v;
    if (v === 'yes' || v === 'true' || v === 1) return true;
    if (v === 'no' || v === 'false' || v === 0) return false;
  }
  return fallback;
}

function toItem(card: Card, guides: GuideLink[], now: number): Item | null {
  const c = toCardView(card);
  const state = scheduleStateOf(card, now);
  if (state === 'ended' || state === 'cancelled' || state === 'expired' || state === 'unpublished') return null;
  const liveNow = state === 'live' || c.live;
  if (!liveNow && (c.startsAt == null || c.startsAt <= now)) return null;
  const attrsEarly = (card.attrs ?? null) as Record<string, unknown> | null;
  // [SAATHUM-EVENT-FIELDS-1] The admin links the article explicitly; title matching is the fallback.
  const linkedSlug = typeof attrsEarly?.guide_slug === 'string' ? (attrsEarly.guide_slug as string) : '';
  const guide = (linkedSlug && guides.find((g) => g.href.replace(/\/$/, '').endsWith('/' + linkedSlug))) || guideFor(c.title, guides);
  const oneOnOne = String(card.kind ?? '') === 'consult';
  const attrs = (card.attrs ?? null) as Record<string, unknown> | null;
  const href = listingPath({ id: c.id, handle: c.creator?.handle ?? null, slug: card.slug ?? null });
  return {
    id: c.id,
    title: c.title,
    deity: typeof attrs?.deity === 'string' ? (attrs.deity as string) : null,
    blurb: card.blurb ?? c.oneLiner,
    image: c.poster ?? c.aiPoster?.url ?? (guide ? publicImage(guide.image, { width: 900, fit: 'scale-down' }) : null),
    mode: oneOnOne ? 'one_on_one' : 'live',
    liveNow,
    startsAt: c.startsAt,
    durationMin: c.durationMin,
    location: c.location,
    // [SAATHUM-EVENT-FIELDS-1] The intention pill ("Good luck", "Wealth") set in admin wins over the listing category.
    category: (typeof attrs?.intention === 'string' && INTENTION_LABELS[attrs.intention as string]) || (c.categoryLabel ?? null),
    ratingAvg: c.ratingCount > 0 ? c.ratingAvg : null,
    ratingCount: c.ratingCount,
    booked: c.joinedCount,
    price: c.price,
    // Saa Thum couriers prasad (incl. international) by default; a listing can opt out via attrs.
    prasad: attrBool(attrs, ['prasad_courier', 'prasad_delivery', 'prasad'], true),
    replay: !oneOnOne && attrBool(attrs, ['replay', 'replay_available'], true),
    href,
    bookHref: payAndJoinPath(c.id),
    benefitsHref: guide?.href ?? href + '#about',
  };
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
      image: publicImage(g.image, { width: 900, fit: 'scale-down' }), mode: p.mode, liveNow: false, startsAt: now + p.off, durationMin: 120,
      location: p.city, category: null, ratingAvg: p.r, ratingCount: p.rc, booked: p.booked, price: p.price,
      prasad: p.prasad, replay: p.mode === 'live', href: g.href, bookHref: '/marketplace', benefitsHref: g.href,
    };
  });
}

const pad = (n: number) => String(n).padStart(2, '0');

function whenLabel(startsAt: number | null, durationMin: number | null): string {
  if (startsAt == null) return '';
  const d = new Date(startsAt);
  const day = d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: IST });
  const time = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: IST });
  const dur = durationLabel(durationMin);
  return `${day} · ${time} IST${dur ? ' · ' + dur : ''}`;
}

function gcalHref(it: Item, origin: string): string {
  const start = it.startsAt ?? Date.now();
  const end = start + (it.durationMin ?? 60) * 60e3;
  const f = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const q = new URLSearchParams({
    action: 'TEMPLATE',
    text: `${it.title} — Saa Thum`,
    dates: `${f(start)}/${f(end)}`,
    details: `Join live: ${origin}${it.href}`,
  });
  return 'https://calendar.google.com/calendar/render?' + q.toString();
}

function waHref(it: Item, origin: string): string {
  const price = it.price != null ? ` Starting from ₹${it.price.toLocaleString('en-IN')}.` : '';
  const when = it.startsAt ? ` ${whenLabel(it.startsAt, null)}.` : '';
  return 'https://wa.me/?text=' + encodeURIComponent(`🙏 ${it.title} on Saa Thum.${when}${price} ${origin}${it.href}`);
}

const Tick = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>;
const Cross = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>;

function Feat({ on, label }: { on: boolean; label: string }) {
  return (
    <div className={'bn-feat' + (on ? '' : ' bn-feat--off')}>
      <span className={on ? 'bn-yes' : 'bn-no'}>{on ? <Tick /> : <Cross />}</span>
      <span>{label}<span className="bn-sr">{on ? ': yes' : ': no'}</span></span>
    </div>
  );
}

function Countdown({ startsAt, now }: { startsAt: number; now: number }) {
  const s = Math.max(0, Math.floor((startsAt - now) / 1000));
  const parts: [string, number][] = [['Day', Math.floor(s / 86400)], ['Hrs', Math.floor((s % 86400) / 3600)], ['Min', Math.floor((s % 3600) / 60)], ['Sec', s % 60]];
  return (
    <div className="bn-cd" role="timer" aria-label={`${parts[0][1]} days ${parts[1][1]} hours ${parts[2][1]} minutes`}>
      {parts.map(([label, v], i) => (
        <span key={label} className="bn-cd-group">
          {i > 0 && <em aria-hidden="true">:</em>}
          <span className={'bn-cd-cell' + (label === 'Sec' ? ' bn-cd-cell--sec' : '')} aria-hidden="true"><b>{pad(v)}</b><small>{label}</small></span>
        </span>
      ))}
    </div>
  );
}

function BookCard({ it, now, origin, index, sample }: { it: Item; now: number; origin: string; index: number; sample: boolean }) {
  const track = (action: string) => capture('home_booknow_click', { action, listing_id: it.id, position: index, sample });
  return (
    <article className="bn-card" data-listing-id={it.id}>
      <a className="bn-art" href={it.href} tabIndex={-1} aria-hidden="true" onClick={() => track('art')}>
        {it.image ? <img src={it.image} alt="" loading="lazy" decoding="async" /> : <span className="bn-art-empty" />}
        <span className="bn-top">
          {it.mode === 'live'
            ? <span className="bn-pill bn-pill--live"><i />{it.liveNow ? 'Live now' : 'Live'}</span>
            : <span className="bn-pill bn-pill--one">1:1 Puja</span>}
          {it.category && <span className="bn-pill bn-pill--soft">{it.category}</span>}
        </span>
        <span className="bn-when">
          {it.startsAt != null && (
            <span className="bn-date">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>
              {whenLabel(it.startsAt, it.durationMin)}
            </span>
          )}
          {!it.liveNow && it.startsAt != null && <>
            <span className="bn-cd-label">{it.mode === 'live' ? 'Havan starts in' : 'Puja starts in'}</span>
            <Countdown startsAt={it.startsAt} now={now} />
          </>}
          {it.liveNow && <span className="bn-cd-label bn-cd-label--live">Happening now — join live</span>}
        </span>
      </a>
      <div className="bn-body">
        <h3 className="bn-title"><a href={it.href} onClick={() => track('title')}>{it.title}</a></h3>
        {it.deity && <div className="bn-deity">{it.deity}</div>}
        {it.blurb && <p className="bn-desc">{it.blurb}</p>}
        <div className="bn-blips">
          {it.location && <span className="bn-blip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z" /><circle cx="12" cy="9.5" r="2.5" /></svg>{it.location}</span>}
          {it.ratingAvg != null && <span className="bn-blip bn-blip--star"><svg viewBox="0 0 24 24" fill="#e0a100" aria-hidden="true"><path d="M12 2.8l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.6l-5.8 3.1 1.1-6.5L2.6 9.6l6.5-.9z" /></svg>{it.ratingAvg.toFixed(1)}/5 <a href={it.href + '#reviews'} onClick={() => track('reviews')}>{it.ratingCount} reviews</a></span>}
          {it.booked > 0 && <span className="bn-blip bn-blip--booked"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5" /><path d="M16 4.8a3.5 3.5 0 0 1 0 6.4M18 14.8c2 .7 3.2 2.4 3.5 5.2" /></svg>{it.booked.toLocaleString('en-IN')} booked</span>}
        </div>
        <div className="bn-feats">
          <Feat on={it.prasad} label="Prasad courier" />
          <Feat on label="Sankalp in your name" />
          {it.mode === 'live' ? <Feat on={it.replay} label="7-day replay" /> : <Feat on label="Private 1:1 call" />}
          <Feat on label={it.mode === 'live' ? 'Live stream' : 'Video with priest'} />
        </div>
        <div className="bn-price-row">
          {it.price != null
            ? <div className="bn-price"><small>Starting from</small><b>₹{it.price.toLocaleString('en-IN')}</b></div>
            : <div className="bn-price" />}
          <div className="bn-icons">
            {it.startsAt != null && !it.liveNow && (
              <a className="bn-ib bn-ib--bell" href={gcalHref(it, origin)} target="_blank" rel="noopener" title="Remind me" aria-label={'Remind me about ' + it.title} onClick={() => track('remind')}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" /><path d="M10 20.5a2 2 0 0 0 4 0" /></svg>
              </a>
            )}
            <a className="bn-ib bn-ib--wa" href={waHref(it, origin)} target="_blank" rel="noopener" title="Share on WhatsApp" aria-label={'Share ' + it.title + ' on WhatsApp'} onClick={() => track('whatsapp')}>
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.6.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.2-.4.8-1.4.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a.9.9 0 0 0-.7.3 2.8 2.8 0 0 0-.9 2.1 4.9 4.9 0 0 0 1 2.6 11.2 11.2 0 0 0 4.3 3.8c1.6.7 2.2.7 3 .6a2.6 2.6 0 0 0 1.7-1.2 2.1 2.1 0 0 0 .1-1.2c0-.1-.2-.2-.5-.3z" /></svg>
            </a>
          </div>
        </div>
        <div className="bn-btns">
          <a className="bn-btn bn-btn--book" href={it.bookHref} onClick={() => track('book')}>Book now <span aria-hidden="true">→</span></a>
          <a className="bn-btn bn-btn--ben" href={it.benefitsHref} onClick={() => track('benefits')}>Read benefits</a>
        </div>
        <div className="bn-foot">Performed by temple priests · Free cancellation 24 hrs before</div>
      </div>
    </article>
  );
}

export default function BookNowShelf({ guides, samples, exploreHref = '/marketplace' }: Props) {
  const [items, setItems] = useState<Item[]>([]);
  const [sample, setSample] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://saathum.com';

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
        collected.sort((a, b) => Number(b.liveNow) - Number(a.liveNow) || (a.startsAt ?? 0) - (b.startsAt ?? 0));
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
          <p>Upcoming havans, performed live by temple priests. Join from anywhere.</p>
          {sample && <p className="bn-sample-note">Preview with sample cards — real listings replace these automatically.</p>}
        </div>
        <div className={'bn-grid bn-grid--' + items.length}>
          {items.map((it, i) => <BookCard key={it.id} it={it} now={now} origin={origin} index={i} sample={sample} />)}
        </div>
        <div className="bn-more">
          <a className="bn-more-btn" href={exploreHref} data-home-cta="booknow-explore" onClick={() => capture('home_booknow_click', { action: 'explore_more', sample })}>Explore all pujas &amp; havans <span aria-hidden="true">→</span></a>
        </div>
      </div>
    </section>
  );
}
