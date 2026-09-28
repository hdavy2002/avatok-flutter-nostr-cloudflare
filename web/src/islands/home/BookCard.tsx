// [MKT-V2-1 2026-09-27] The listing card, extracted from BookNowShelf.tsx so the
// homepage "Book now" shelf and the /marketplace page render the IDENTICAL card.
//
// NOTE FOR AI:
//  - Never invent numbers. Rating shows only when there are reviews; "booked"
//    = real bookings + attrs.booked_boost (the owner's own ad number, set in admin).
//    Prices come from the listing (admin-edited), always phrased "Starting from ₹X"
//    because checkout adds options; a ₹0 listing reads "Open to all · Free".
//  - Remind me = an "Add to Google Calendar" link (works signed-out).
//  - [SAATHUM-EVENT-TYPES 2026-09-27] All type-dependent wording (badge, colour,
//    countdown label, buttons, feature ticks, footer line) comes from
//    ../../lib/eventTypes.ts — never hardcode "havan"/"puja" text here.
//  - Telemetry is the caller's: pass `onAction` (homepage → home_booknow_click,
//    marketplace → marketplace_card_click).
import { useState } from 'react';
import type { Card } from '../../lib/types';
import { toCardView, scheduleStateOf, durationLabel } from '../../lib/card';
import { payAndJoinPath } from '../../lib/urls';
import { cfImage, publicImage } from '../../lib/config';
import { copyFor, eventTypeOf, socialProof, type EventType, type EventTypeCopy } from '../../lib/eventTypes';
import './BookNowShelf.css';

/** A ritual article: title, href and a RAW /assets image path (the card calls publicImage). */
export interface GuideLink { title: string; href: string; image: string }

export interface Item {
  id: string;
  title: string;
  deity: string | null;
  blurb: string | null;
  image: string | null;
  imageSrcSet: string | null;
  mode: 'live' | 'one_on_one';
  liveNow: boolean;
  /** [SAATHUM-WATCH-1 2026-09-28] The listing's YouTube stream is live right now
   *  (card.is_live_stream) — distinct from liveNow above (the schedule/session
   *  "live" concept). Drives the LIVE tile badge only. */
  isLiveStream: boolean;
  startsAt: number | null;
  durationMin: number | null;
  location: string | null;
  category: string | null;
  /** Raw attrs.intention key (education, luck, …) — marketplace filters on it. */
  intention: string | null;
  ratingAvg: number | null;
  ratingCount: number;
  booked: number;
  price: number | null;
  prasad: boolean;
  /** [SAATHUM-CHECKOUT §Owner decisions 1] renamed from "7-day replay". */
  videoDownload: boolean;
  /** [SAATHUM-CHECKOUT §Owner decisions 2] 'public' (default) or 'private' (1:1). */
  visibility: 'public' | 'private';
  /** [SAATHUM-EVENT-TYPES] Drives badge, colour, wording and feature ticks. */
  eventType: EventType;
  /** listings.performed_by, when the admin filled it in. */
  performedBy: string | null;
  /** attrs.performer_photo_url — a future field; absent listings fall back to initials. */
  performerPhotoUrl: string | null;
  href: string;
  bookHref: string;
  benefitsHref: string;
}

/** Mirrors ritualGuides ritualCategoryShort and the worker's INTENTIONS (admin2_events_logic.ts). */
export const INTENTION_LABELS: Record<string, string> = {
  education: 'Education', luck: 'Good luck', wealth: 'Wealth', career: 'Career', health: 'Health',
  family: 'Family', peace: 'Peace', life: 'Life events', festival: 'Festivals',
};
const IST = 'Asia/Kolkata';
/** Retina-friendly srcset widths for the listing photo (owner rule: images must cache). */
const IMG_WIDTHS = [480, 720, 960] as const;

export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function guideFor(title: string, guides: GuideLink[]): GuideLink | null {
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

/** [SAATHUM-IMG-CACHE-1] Routes a listing photo (poster/AI poster) through the
 *  Cloudflare image transform so it caches instead of reloading on every visit. */
function listingImage(raw: string | null): { image: string | null; srcSet: string | null } {
  if (!raw) return { image: null, srcSet: null };
  const image = cfImage(raw, { width: 900, quality: 70 });
  const srcSet = IMG_WIDTHS.map((w) => `${cfImage(raw, { width: w, quality: 70 })} ${w}w`).join(', ');
  return { image, srcSet };
}

export function toItem(card: Card, guides: GuideLink[], now: number): Item | null {
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
  // [SAATHUM-EVENT-PAGE 2026-09-26] The card's art/title now open the new
  // /book/<id> event page (not the old /l/<id> listing detail) — that page is
  // the marketing surface now. "Book now" goes one step further, to checkout.
  const href = payAndJoinPath(c.id);
  const bookHref = href + '/checkout';
  const rawPoster = c.poster ?? c.aiPoster?.url ?? null;
  const { image, srcSet } = rawPoster
    ? listingImage(rawPoster)
    : { image: guide ? publicImage(guide.image, { width: 900, fit: 'scale-down' }) : null, srcSet: null };
  // [SAATHUM-SOCIAL-PROOF-1] Real numbers + the owner's admin-set boosts, via the
  // shared eventTypes helper — never hand-rolled here.
  const sp = socialProof(attrs, { booked: c.joinedCount, ratingAvg: c.ratingAvg, ratingCount: c.ratingCount });
  // listings.performed_by is a top-level card field (worker shapeCard); may be absent
  // on an older client/worker pairing, so read it defensively.
  const performedByRaw = (card as Card & { performed_by?: string | null }).performed_by;
  const performedBy = typeof performedByRaw === 'string' && performedByRaw.trim() ? performedByRaw.trim() : null;
  const performerPhotoUrl = typeof attrs?.performer_photo_url === 'string' && attrs.performer_photo_url
    ? cfImage(attrs.performer_photo_url as string, { width: 56, quality: 70 })
    : null;
  return {
    id: c.id,
    title: c.title,
    deity: typeof attrs?.deity === 'string' ? (attrs.deity as string) : null,
    blurb: card.blurb ?? c.oneLiner,
    image,
    imageSrcSet: srcSet,
    mode: oneOnOne ? 'one_on_one' : 'live',
    liveNow,
    isLiveStream: !!card.is_live_stream,
    startsAt: c.startsAt,
    durationMin: c.durationMin,
    location: c.location,
    // [SAATHUM-EVENT-FIELDS-1] The intention pill ("Good luck", "Wealth") set in admin wins over the listing category.
    category: (typeof attrs?.intention === 'string' && INTENTION_LABELS[attrs.intention as string]) || (c.categoryLabel ?? null),
    intention: typeof attrs?.intention === 'string' && attrs.intention ? (attrs.intention as string) : null,
    ratingAvg: sp.rating,
    ratingCount: sp.reviews,
    booked: sp.booked,
    price: c.price,
    // Saa Thum couriers prasad (incl. international) by default; a listing can opt out via attrs.
    prasad: attrBool(attrs, ['prasad_courier', 'prasad_delivery', 'prasad'], true),
    // [SAATHUM-CHECKOUT §Data] video_download replaces replay; either legacy
    // attrs key still wins over the true default when set.
    videoDownload: !oneOnOne && attrBool(attrs, ['video_download', 'replay', 'replay_available'], true),
    visibility: attrs?.visibility === 'private' ? 'private' : 'public',
    eventType: eventTypeOf(attrs),
    performedBy,
    performerPhotoUrl,
    href,
    bookHref,
    benefitsHref: guide?.href ?? href + '#about',
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

export function whenLabel(startsAt: number | null, durationMin: number | null): string {
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
    details: `Details: ${origin}${it.href}`,
  });
  return 'https://calendar.google.com/calendar/render?' + q.toString();
}

function waHref(it: Item, origin: string): string {
  const price = it.price != null ? ` Starting from ₹${it.price.toLocaleString('en-IN')}.` : '';
  const when = it.startsAt ? ` ${whenLabel(it.startsAt, null)}.` : '';
  return 'https://wa.me/?text=' + encodeURIComponent(`🙏 ${it.title} on Saa Thum.${when}${price} ${origin}${it.href}`);
}

/** Two-letter initials for the performer-photo fallback, e.g. "Pandit Ramesh" → "PR". */
function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean).slice(0, 2);
  const s = parts.map((w) => w[0]?.toUpperCase() ?? '').join('');
  return s || '🙏';
}

const Tick = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>;
const Cross = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>;

export function Feat({ on, label, tip, tipId, onOpen }: { on: boolean; label: string; tip?: string; tipId?: string; onOpen?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={'bn-feat' + (on ? '' : ' bn-feat--off') + (open ? ' bn-feat--show' : '')} tabIndex={tip ? 0 : undefined}>
      <span className={on ? 'bn-yes' : 'bn-no'}>{on ? <Tick /> : <Cross />}</span>
      <span>{label}<span className="bn-sr">{on ? ': yes' : ': no'}</span></span>
      {tip && (
        <>
          <button
            type="button"
            className="bn-info"
            aria-describedby={tipId}
            aria-label={`More info: ${label}`}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((v) => { if (!v) onOpen?.(); return !v; }); }}
          >i</button>
          <span className="bn-tip" role="tooltip" id={tipId}>{tip}</span>
        </>
      )}
    </div>
  );
}

const VIDEO_TIP = 'You can download your video anytime.';
const VISIBILITY_TIP = 'Public: many devotees join the same event together. Private: a 1:1 session just for your family.';

/** [SAATHUM-EVENT-TYPES §Ticks] Ritual types (havan/puja) show sankalp + prasad;
 *  satsang/sermon/meditation never do (owner was explicit). A one-on-one
 *  consult swaps the "Video download" slot for "Private 1:1 call" either way. */
function ticksFor(it: Item, copy: EventTypeCopy): { on: boolean; label: string; tip?: string; kind?: 'video' | 'visibility' }[] {
  const videoTick = it.mode === 'live'
    ? { on: it.videoDownload, label: 'Video download', tip: VIDEO_TIP, kind: 'video' as const }
    : { on: true, label: 'Private 1:1 call' };
  const visibilityTick = {
    on: true,
    label: it.visibility === 'private' ? 'Private event' : 'Public event',
    tip: VISIBILITY_TIP,
    kind: 'visibility' as const,
  };
  if (copy.ritual) {
    return [
      { on: it.prasad, label: 'Prasad courier' },
      { on: true, label: 'Sankalp in your name' },
      videoTick,
      visibilityTick,
    ];
  }
  return [
    videoTick,
    { on: true, label: 'Join from anywhere' },
    visibilityTick,
  ];
}

export function Countdown({ startsAt, now }: { startsAt: number; now: number }) {
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

/** The one listing card, shared by the homepage "Book now" shelf and /marketplace.
 *  Each caller reports clicks with its own event name through `onAction`. */
export function BookCard({ it, now, origin, onAction }: { it: Item; now: number; origin: string; onAction?: (action: string) => void }) {
  const track = (action: string) => { onAction?.(action); };
  const copy = copyFor({ event_type: it.eventType });
  const ticks = ticksFor(it, copy);
  return (
    <article className="bn-card" data-listing-id={it.id}>
      <a className="bn-art" href={it.href} tabIndex={-1} aria-hidden="true" onClick={() => track('art')}>
        {it.image
          ? <img src={it.image} srcSet={it.imageSrcSet ?? undefined} sizes="(min-width: 1400px) 25vw, (min-width: 641px) 46vw, 92vw" alt="" loading="lazy" decoding="async" />
          : <span className="bn-art-empty" />}
        <span className="bn-top">
          <span className="bn-top-left">
            <span className="bn-type-badge" style={{ background: copy.color.bg, color: copy.color.fg }}>{copy.badge}</span>
            {/* [SAATHUM-WATCH-1 2026-09-28] The YouTube stream is live right now —
                reuses the existing red "live" pill style, distinct from the
                liveNow/"Happening now" pill below (a different, session-based
                notion of live). */}
            {it.isLiveStream && <span className="bn-pill bn-pill--live"><i />LIVE</span>}
            {it.visibility === 'private'
              ? <span className="bn-pill bn-pill--one">Private · 1:1</span>
              : it.mode === 'live'
                ? <span className="bn-pill bn-pill--live"><i />{it.liveNow ? 'Happening now' : 'Open to all'}</span>
                : <span className="bn-pill bn-pill--one">1:1 Puja</span>}
          </span>
          {it.category && <span className="bn-pill bn-pill--soft">{it.category}</span>}
        </span>
        <span className="bn-when">
          {!it.liveNow && it.startsAt != null && <>
            <span className="bn-cd-label">{copy.startsIn}</span>
            <Countdown startsAt={it.startsAt} now={now} />
          </>}
          {it.liveNow && <span className="bn-cd-label bn-cd-label--live">Happening now</span>}
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
          {ticks.map((t, i) => (
            <Feat
              key={i}
              on={t.on}
              label={t.label}
              tip={t.tip}
              tipId={t.tip ? `bn-tip-${t.kind}-${it.id}` : undefined}
              onOpen={t.tip ? () => track('tooltip') : undefined}
            />
          ))}
        </div>
        {/* [SAATHUM-CARD-POLISH 2026-09-27] Owner: the date on the photo was hard to read — it lives here now. */}
        {it.startsAt != null && (
          <div className="bn-datebar">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>
            <span>{whenLabel(it.startsAt, it.durationMin)}</span>
          </div>
        )}
        <div className="bn-price-row">
          {it.price != null && it.price > 0
            ? <div className="bn-price"><small>Starting from</small><b>₹{it.price.toLocaleString('en-IN')}</b></div>
            : it.price === 0
              ? <div className="bn-price"><small>Open to all</small><b>Free</b></div>
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
          <a className="bn-btn bn-btn--book" href={it.bookHref} onClick={() => track('book')}>{copy.ctaShort} <span aria-hidden="true">→</span></a>
          <a className="bn-btn bn-btn--ben" href={it.benefitsHref} onClick={() => track('benefits')}>{copy.readMore}</a>
        </div>
        <div className="bn-foot">
          <div className="bn-foot-performer" title={`${copy.performerLabel} ${it.performedBy || copy.performerFallback}`}>
            {it.performerPhotoUrl
              ? <img className="bn-performer-photo" src={it.performerPhotoUrl} alt="" width={40} height={40} loading="lazy" decoding="async" />
              : <span className="bn-performer-initials" aria-hidden="true">{initials(it.performedBy || copy.performerFallback)}</span>}
            <span className="bn-foot-name">{copy.performerLabel} <b>{it.performedBy || copy.performerFallback}</b></span>
          </div>
          <div className="bn-foot-cancel">Free cancellation 24 hrs before</div>
        </div>
      </div>
    </article>
  );
}

