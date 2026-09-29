// [MKT-V2-1 2026-09-27] The data-driven half of /marketplace (owner-approved
// mockup "marketplace v2"). pages/marketplace.astro renders the static chrome
// (hero + search form, intention band via the `intentions` slot, steps,
// promises); this island renders everything that depends on real listings.
//
// NOTE FOR AI:
//  - REAL DATA ONLY. Listings come from /api/explore exactly like the homepage
//    "Book now" shelf (up to 3 pages × 30), plus /api/explore/live-now. The card
//    is the shared BookCard (islands/home/BookCard.tsx) — never fork it here.
//    Nothing listed → the empty state. NEVER render sample/fake cards.
//  - Search + filters run client-side over the fetched listings and live in the
//    URL (?q= ?type= ?intention= ?when= ?price= ?sort= ?prasad=1 ?private=1) via
//    history.replaceState, seeded from the URL on load. The hero form is a plain
//    GET form (works without JS); with JS this island intercepts its submit.
//  - `q` matches title, deity, event type (badge/noun + synonyms), intention
//    (label + synonyms such as "Studies" → education) and city, so the header /
//    footer / homepage links (?q=Puja, ?q=Havan, ?q=Festival, ?q=Studies …) all
//    land on sensible results.
//  - Every number shown (tab counts, hero stats, temple chips, deity and festival
//    counts, "Showing N of M") is computed from the fetched listings; a zero
//    stat is hidden, never faked.
//  - Props carry RAW /assets paths only (deity images). /cdn-cgi/image URLs in
//    serialized island props fail the built-image-source deploy check.
//  - Telemetry: marketplace_loaded / _search / _filter / _tab / _card_click
//    (Specs/SPEC-2026-09-02-TELEMETRY-CATALOG.md §2.3).
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Card } from '../../lib/types';
import { getExplore, getLiveNow } from '../../lib/apiClient';
import { capture, captureException } from '../../lib/analytics';
import { publicImage } from '../../lib/config';
import { EVENT_TYPE_COPY, type EventType } from '../../lib/eventTypes';
import { festivalEndMs, festivalStartMs, festivalTerms, upcomingFestivals, type Festival } from '../../lib/festivals';
import { BookCard, INTENTION_LABELS, guideFor, norm, toItem, type GuideLink, type Item } from '../home/BookCard';
import './MarketplaceV2.css';

export interface DeityLink { name: string; image: string }

interface Props {
  /** Every ritual article (raw /assets image paths) — poster fallback, "Read benefits", empty-state guide link. */
  guides: GuideLink[];
  /** "Browse by deity" portraits; `image` is a raw /assets path. */
  deities: DeityLink[];
  /** Astro-rendered intention band (named slot). */
  intentions?: ReactNode;
}

// ---------------------------------------------------------------- filters
type TypeKey = EventType | 'festival' | 'gathering';
const TYPE_KEYS: TypeKey[] = ['havan', 'puja', 'satsang', 'sermon', 'meditation', 'festival', 'gathering'];
const WHEN_KEYS = ['today', 'week', 'weekend', 'month'] as const;
const PRICE_KEYS = ['free', 'under200', '200to1000', 'above1000'] as const;
const SORT_KEYS = ['soonest', 'booked', 'price', 'rating'] as const;

interface Filters {
  q: string; type: string; intention: string; when: string; price: string; sort: string; prasad: boolean; priv: boolean;
}
const EMPTY: Filters = { q: '', type: '', intention: '', when: '', price: '', sort: 'soonest', prasad: false, priv: false };

const oneOf = (v: string | null, keys: readonly string[]) => { const s = (v ?? '').trim().toLowerCase(); return keys.includes(s) ? s : ''; };

function readFilters(search: string): Filters {
  const p = new URLSearchParams(search);
  return {
    q: (p.get('q') ?? '').trim().slice(0, 80),
    type: oneOf(p.get('type'), TYPE_KEYS),
    intention: oneOf(p.get('intention'), Object.keys(INTENTION_LABELS)),
    when: oneOf(p.get('when'), WHEN_KEYS),
    price: oneOf(p.get('price'), PRICE_KEYS),
    sort: oneOf(p.get('sort'), SORT_KEYS) || 'soonest',
    prasad: p.get('prasad') === '1',
    priv: p.get('private') === '1',
  };
}

function filtersQuery(f: Filters): string {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.type) p.set('type', f.type);
  if (f.intention) p.set('intention', f.intention);
  if (f.when) p.set('when', f.when);
  if (f.price) p.set('price', f.price);
  if (f.sort && f.sort !== 'soonest') p.set('sort', f.sort);
  if (f.prasad) p.set('prasad', '1');
  if (f.priv) p.set('private', '1');
  const s = p.toString();
  return s ? '?' + s : '';
}
const hrefFor = (patch: Partial<Filters>) => '/marketplace' + filtersQuery({ ...EMPTY, ...patch });

/** Anything that narrows the list (sort alone does not). */
const isSearching = (f: Filters) => Boolean(f.q || f.type || f.intention || f.when || f.price || f.prasad || f.priv);

// ---------------------------------------------------------------- matching
/** Search words that mean an intention (homepage tiles link ?q=Studies, ?q=Fresh start …). */
const INTENTION_SYNONYMS: Record<string, string[]> = {
  education: ['education', 'studies', 'study', 'exam', 'exams', 'student', 'students', 'learning', 'school'],
  luck: ['luck', 'good luck', 'fresh start', 'new start', 'new beginning', 'new beginnings', 'beginning'],
  wealth: ['wealth', 'prosperity', 'money', 'abundance', 'riches'],
  career: ['career', 'business', 'job', 'work'],
  health: ['health', 'healing', 'health peace', 'wellbeing'],
  family: ['family', 'love', 'love family', 'marriage', 'relationship', 'relationships', 'children'],
  peace: ['peace', 'protection', 'calm'],
  life: ['life events', 'life event', 'naming', 'new home', 'wedding'],
  festival: ['festival', 'festivals', 'festival pujas'],
};
/** Search words that mean an event type. */
const TYPE_SYNONYMS: Record<EventType, string[]> = {
  havan: ['havan', 'havans', 'hawan', 'homa', 'yagya', 'yajna', 'fire ritual'],
  puja: ['puja', 'pujas', 'pooja', 'poojas', 'pujan'],
  satsang: ['satsang', 'kirtan', 'bhajan'],
  sermon: ['sermon', 'sermons', 'katha', 'pravachan', 'discourse', 'path'],
  meditation: ['meditation', 'dhyan', 'dhyana', 'pranayama'],
};
/** Deity name groups — ?q=Ganesha also finds "Ganapati Havan". */
const DEITY_ALIASES: string[][] = [
  ['ganesha', 'ganesh', 'ganapati', 'ganpati', 'vinayak', 'vinayaka'],
  ['lakshmi', 'laxmi', 'mahalakshmi'],
  ['shiva', 'shiv', 'mahadev', 'rudra', 'mahamrityunjaya', 'rudrabhishek', 'mrityunjaya'],
  ['saraswati', 'sarasvati'],
  ['hanuman', 'bajrang', 'sundarkand', 'hanuman chalisa'],
  ['vishnu', 'narayana', 'narayan', 'satyanarayan', 'satyanarayana'],
  ['krishna', 'gopala', 'gopal', 'gita'],
  ['navagraha', 'navgraha', 'nine planets', 'graha', 'shani'],
  ['durga', 'lalita', 'parvati', 'devi'],
  ['rama', 'ram', 'ramcharitmanas', 'ramayan', 'ramayana'],
];

const MIN_ALIAS = 3;
/** Every word of `term` starts a word of `hay` (hay is " "-prefixed normalised text). */
const hasWords = (hay: string, term: string) => term.split(' ').every((w) => w && hay.includes(' ' + w));

function haystack(it: Item): string {
  const copy = EVENT_TYPE_COPY[it.eventType];
  return ' ' + norm([it.title, it.deity ?? '', copy.label, copy.noun, it.category ?? '',
    it.intention ? INTENTION_LABELS[it.intention] ?? '' : '', it.location ?? ''].join(' '));
}

function inFestivalWindow(it: Item, f: Festival): boolean {
  if (it.startsAt == null) return false;
  const DAY = 86_400_000;
  return it.startsAt >= festivalStartMs(f) - DAY && it.startsAt < festivalEndMs(f) + DAY;
}

function namesFestival(it: Item, f: Festival): boolean {
  const hay = ' ' + norm(`${it.title} ${it.deity ?? ''}`);
  return festivalTerms(f).some((t) => hasWords(hay, norm(t)));
}

/** Listings that belong to a festival: named in the title, or festival-intention inside its dates. */
function festivalMatch(it: Item, f: Festival): boolean {
  return namesFestival(it, f) || (it.intention === 'festival' && inFestivalWindow(it, f));
}

function matchesQuery(it: Item, qRaw: string, festivals: Festival[]): boolean {
  const q = norm(qRaw);
  if (!q) return true;
  const hay = haystack(it);
  if (hasWords(hay, q)) return true;
  const synonym = (list: string[]) => list.some((s) => s === q || (q.length >= MIN_ALIAS + 1 && s.startsWith(q)));
  for (const group of DEITY_ALIASES) {
    if (synonym(group) && group.some((a) => hasWords(hay, a))) return true;
  }
  for (const [type, list] of Object.entries(TYPE_SYNONYMS)) {
    if (synonym(list) && it.eventType === type) return true;
  }
  for (const [key, list] of Object.entries(INTENTION_SYNONYMS)) {
    if (synonym(list) && it.intention === key) return true;
  }
  for (const f of festivals) {
    if (festivalTerms(f).some((t) => norm(t) === q) && festivalMatch(it, f)) return true;
  }
  return false;
}

function matchesType(it: Item, type: string, festivals: Festival[]): boolean {
  if (!type) return true;
  if (type === 'festival') return it.intention === 'festival' || festivals.some((f) => namesFestival(it, f));
  if (type === 'gathering') return it.eventType === 'satsang' || it.eventType === 'sermon' || it.eventType === 'meditation';
  return it.eventType === type;
}

const IST_OFFSET = 330 * 60_000;
const DAY_MS = 86_400_000;
const istDay = (ms: number) => new Date(ms + IST_OFFSET).toISOString().slice(0, 10);
/** Midnight IST of the day containing `ms`. */
const istMidnight = (ms: number) => Math.floor((ms + IST_OFFSET) / DAY_MS) * DAY_MS - IST_OFFSET;

function matchesWhen(it: Item, when: string, now: number): boolean {
  if (!when) return true;
  if (it.liveNow) return true;
  const s = it.startsAt;
  if (s == null) return false;
  if (when === 'today') return istDay(s) === istDay(now);
  if (when === 'week') return s < now + 7 * DAY_MS;
  if (when === 'month') return istDay(s).slice(0, 7) === istDay(now).slice(0, 7);
  if (when === 'weekend') {
    const dow = new Date(now + IST_OFFSET).getUTCDay(); // 0 Sun … 6 Sat, IST
    const today0 = istMidnight(now);
    const satStart = dow === 0 ? today0 - DAY_MS : today0 + ((6 - dow) % 7) * DAY_MS;
    return s >= satStart && s < satStart + 2 * DAY_MS;
  }
  return true;
}

function matchesPrice(it: Item, price: string): boolean {
  if (!price) return true;
  const p = it.price;
  if (p == null) return false;
  if (price === 'free') return p === 0;
  if (price === 'under200') return p < 200;
  if (price === '200to1000') return p >= 200 && p <= 1000;
  return p > 1000;
}

const soonest = (a: Item, b: Item) => Number(b.isLiveStream) - Number(a.isLiveStream) || Number(b.liveNow) - Number(a.liveNow) || (a.startsAt ?? Infinity) - (b.startsAt ?? Infinity);
function sorter(sort: string): (a: Item, b: Item) => number {
  if (sort === 'booked') return (a, b) => b.booked - a.booked || soonest(a, b);
  if (sort === 'price') return (a, b) => (a.price ?? Infinity) - (b.price ?? Infinity) || soonest(a, b);
  if (sort === 'rating') return (a, b) => (b.ratingAvg ?? 0) - (a.ratingAvg ?? 0) || b.ratingCount - a.ratingCount || soonest(a, b);
  return soonest;
}

// ---------------------------------------------------------------- static copy
const TABS: { key: '' | TypeKey; label: string; sub: string; art: string; color: string }[] = [
  { key: '', label: 'Everything', sub: 'All upcoming', art: 'listing-puja', color: '#07545b' },
  { key: 'havan', label: 'Havans', sub: 'Shared fire rituals', art: 'category-puja', color: EVENT_TYPE_COPY.havan.color.bg },
  { key: 'puja', label: 'Pujas', sub: 'Personal & family', art: 'category-aarti', color: EVENT_TYPE_COPY.puja.color.bg },
  { key: 'satsang', label: 'Satsang', sub: 'Kirtan & discourse', art: 'category-bhajan', color: EVENT_TYPE_COPY.satsang.color.bg },
  { key: 'sermon', label: 'Sermons', sub: 'Katha & path', art: 'category-satsang', color: EVENT_TYPE_COPY.sermon.color.bg },
  { key: 'meditation', label: 'Meditation', sub: 'Guided mornings', art: 'category-yoga', color: EVENT_TYPE_COPY.meditation.color.bg },
  { key: 'festival', label: 'Festival specials', sub: 'Navratri · Diwali · Chhath', art: 'category-festival', color: '#a8741a' },
];
const CHIPS: { key: '' | TypeKey; label: string; color?: string }[] = [
  { key: '', label: 'All' },
  ...(['havan', 'puja', 'satsang', 'sermon', 'meditation'] as EventType[]).map((t) => ({ key: t, label: EVENT_TYPE_COPY[t].label, color: EVENT_TYPE_COPY[t].color.bg })),
  { key: 'festival', label: 'Festival', color: '#a8741a' },
];
const WHEN_LABELS: [string, string][] = [['', 'Any date'], ['today', 'Today'], ['week', 'This week'], ['weekend', 'Weekend'], ['month', 'This month']];
const PAGE = 12;

const PinIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z" /><circle cx="12" cy="9.5" r="2.5" /></svg>;

function relTime(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} days`;
}

const plural = (n: number, one: string, many = one + 's') => `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;

function prefersReducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

// ---------------------------------------------------------------- snapshot cache
// [MKT-SPEED-1 2026-09-27] The listing fetch took ~1.2 s median (p90 ~2 s) and the
// grid sat on "Loading events…" for all of it, on EVERY visit. The raw cards from
// the last successful load are now kept in localStorage, so a returning visitor
// sees the grid immediately while a fresh fetch replaces it in the background
// (stale-while-revalidate). These are PUBLIC listings — same bytes every guest
// gets — so there is nothing per-account to scope. Everything is re-derived
// through toItem() against the current clock, so an event that has ended since
// the snapshot is dropped exactly as a fresh fetch would drop it.
const SNAP_KEY = 'saathum_mkt_cards_v1';
const SNAP_MAX_AGE_MS = 30 * 60_000;
function readSnapshot(): Card[] | null {
  try {
    const raw = localStorage.getItem(SNAP_KEY);
    if (!raw) return null;
    const snap = JSON.parse(raw) as { at?: number; cards?: Card[] };
    if (!snap || !Array.isArray(snap.cards) || typeof snap.at !== 'number') return null;
    if (Date.now() - snap.at > SNAP_MAX_AGE_MS) return null;
    return snap.cards;
  } catch { return null; }
}
function writeSnapshot(cards: Card[]): void {
  try { localStorage.setItem(SNAP_KEY, JSON.stringify({ at: Date.now(), cards })); } catch { /* storage full or blocked */ }
}
function itemsFrom(cards: Card[], guides: GuideLink[]): Item[] {
  const out: Item[] = [];
  const seen = new Set<string>();
  const t = Date.now();
  for (const card of cards) {
    const it = toItem(card, guides, t);
    if (!it || seen.has(it.id)) continue;
    seen.add(it.id);
    out.push(it);
  }
  return out.sort(soonest);
}

// ---------------------------------------------------------------- component
type Status = 'loading' | 'ready' | 'error';

export default function MarketplaceV2({ guides, deities, intentions }: Props) {
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [items, setItems] = useState<Item[]>([]);
  const [status, setStatus] = useState<Status>('loading');
  const [shown, setShown] = useState(PAGE);
  const [now, setNow] = useState(() => Date.now());
  const [mounted, setMounted] = useState(false);
  const [reload, setReload] = useState(0);
  const allRef = useRef<HTMLElement | null>(null);
  const didInitialScroll = useRef(false);
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://saathum.com';

  // Seed from the URL once.
  useEffect(() => {
    setFilters(readFilters(window.location.search));
    setMounted(true);
  }, []);

  const festivals = useMemo(() => upcomingFestivals(now), [Math.floor(now / 3_600_000)]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load listings: /api/explore (≤ 3 × 30) + /api/explore/live-now.
  // [MKT-SPEED-1] Paint the last snapshot first (if any), then revalidate.
  useEffect(() => {
    const ctrl = new AbortController();
    const t0 = performance.now();
    const snap = readSnapshot();
    const fromSnap = snap ? itemsFrom(snap, guides) : null;
    if (fromSnap && fromSnap.length) {
      setItems(fromSnap);
      setStatus('ready');
      capture('cache_event', { store: 'marketplace_cards', result: 'hit', count: fromSnap.length, render_ms: Math.round(performance.now() - t0) });
    } else {
      setStatus('loading');
      capture('cache_event', { store: 'marketplace_cards', result: snap ? 'stale' : 'miss' });
    }
    (async () => {
      const liveP = getLiveNow(ctrl.signal).catch((err) => {
        if (!ctrl.signal.aborted) captureException(err, { surface: 'marketplace', endpoint: '/api/explore/live-now' });
        return { listings: [] as Card[] };
      });
      try {
        const cards: Card[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 3; page++) {
          const res = await getExplore({ limit: 30, cursor }, ctrl.signal);
          cards.push(...(res.listings ?? []));
          cursor = (res as { cursor?: string | null }).cursor ?? undefined;
          if (!cursor) break;
        }
        const live = await liveP;
        cards.push(...(live.listings ?? []));
        const collected = itemsFrom(cards, guides);
        setItems(collected);
        setStatus('ready');
        writeSnapshot(cards);
        const f = readFilters(window.location.search);
        capture('marketplace_loaded', {
          count: collected.length,
          live_count: collected.filter((i) => i.liveNow).length,
          ms: Math.round(performance.now() - t0),
          from_snapshot: !!(fromSnap && fromSnap.length),
          q: f.q || null,
          type: f.type || null,
        });
        if (f.q) capture('marketplace_search', { q: f.q, source: 'url' });
      } catch (err) {
        if (ctrl.signal.aborted) return;
        captureException(err, { surface: 'marketplace', endpoint: '/api/explore' });
        // A snapshot already on screen stays there — better than an error over real cards.
        if (!(fromSnap && fromSnap.length)) setStatus('error');
      }
    })();
    return () => ctrl.abort();
  }, [guides, reload]);

  // Countdown clock — only while something is counting down.
  const hasTimers = useMemo(() => items.some((i) => !i.liveNow && i.startsAt != null), [items]);
  useEffect(() => {
    if (!hasTimers) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [hasTimers]);

  // Keep the URL in step with the filters (shareable, back-button friendly).
  useEffect(() => {
    if (!mounted) return;
    const next = '/marketplace' + filtersQuery(filters) + window.location.hash;
    if (next !== window.location.pathname + window.location.search + window.location.hash) {
      try { window.history.replaceState(window.history.state, '', next); } catch (err) { captureException(err, { surface: 'marketplace', op: 'replaceState' }); }
    }
    // Mirror into the (static, Astro-rendered) hero search form.
    const form = document.querySelector<HTMLFormElement>('form.mk-search');
    if (form) {
      const q = form.elements.namedItem('q') as HTMLInputElement | null;
      const type = form.elements.namedItem('type') as HTMLSelectElement | null;
      const when = form.elements.namedItem('when') as HTMLSelectElement | null;
      if (q && q.value !== filters.q) q.value = filters.q;
      if (type) type.value = ['havan', 'puja', 'satsang', 'sermon', 'meditation', 'festival'].includes(filters.type) ? filters.type : '';
      if (when) when.value = filters.when;
    }
  }, [filters, mounted]);

  const scrollToAll = useCallback(() => {
    window.requestAnimationFrame(() => {
      allRef.current?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
    });
  }, []);

  // Arriving with a search in the URL → take the visitor to the results once they exist.
  useEffect(() => {
    if (status !== 'ready' || didInitialScroll.current || !isSearching(filters)) return;
    didInitialScroll.current = true;
    if (window.scrollY < 120) scrollToAll();
  }, [status, filters, scrollToAll]);

  // Progressive enhancement of the hero's plain GET form.
  useEffect(() => {
    const form = document.querySelector<HTMLFormElement>('form.mk-search');
    if (!form) return;
    const onSubmit = (e: SubmitEvent) => {
      e.preventDefault();
      const data = new FormData(form);
      const q = String(data.get('q') ?? '').trim().slice(0, 80);
      const type = oneOf(String(data.get('type') ?? ''), TYPE_KEYS);
      const when = oneOf(String(data.get('when') ?? ''), WHEN_KEYS);
      setFilters((f) => ({ ...EMPTY, sort: f.sort, q, type, when }));
      setShown(PAGE);
      capture('marketplace_search', { q, type: type || null, when: when || null, source: 'hero' });
      scrollToAll();
    };
    form.addEventListener('submit', onSubmit);
    return () => form.removeEventListener('submit', onSubmit);
  }, [scrollToAll]);

  const apply = useCallback((patch: Partial<Filters>, reset = false) => {
    setFilters((f) => ({ ...(reset ? { ...EMPTY, sort: f.sort } : f), ...patch }));
    setShown(PAGE);
  }, []);

  /** Props for an in-page filter link: a real href without JS, a client-side filter with it. */
  const filterLink = (patch: Partial<Filters>, onUse?: () => void) => ({
    href: hrefFor(patch) + '#all-events',
    onClick: (e: MouseEvent<HTMLAnchorElement>) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      onUse?.();
      apply(patch, true);
      scrollToAll();
    },
  });

  const setFilter = (key: keyof Filters, value: string | boolean) => {
    capture('marketplace_filter', { key, value });
    apply({ [key]: value } as Partial<Filters>);
  };

  // ------------------------------------------------------------ derived data
  const typeCounts = useMemo(() => {
    const out: Record<string, number> = { '': items.length };
    for (const k of TYPE_KEYS) out[k] = items.filter((it) => matchesType(it, k, festivals)).length;
    return out;
  }, [items, festivals]);

  // [MKT-V2-3] Tab sub-lines that depend on real listings (never a hardcoded price).
  const tabSub = useMemo(() => {
    const out: Record<string, string> = {};
    const havanPrices = items.filter((i) => i.eventType === 'havan' && i.price != null && i.price > 0).map((i) => i.price as number);
    if (havanPrices.length) out.havan = `Shared fire rituals · from ₹${Math.min(...havanPrices).toLocaleString('en-IN')}`;
    if (items.some((i) => i.eventType === 'puja' && (i.visibility === 'private' || i.mode === 'one_on_one'))) out.puja = 'Personal & family · 1:1 available';
    return out;
  }, [items]);

  const results = useMemo(() => {
    const list = items.filter((it) =>
      matchesType(it, filters.type, festivals)
      && matchesQuery(it, filters.q, festivals)
      && (!filters.intention || it.intention === filters.intention)
      && matchesWhen(it, filters.when, now)
      && matchesPrice(it, filters.price)
      && (!filters.prasad || (EVENT_TYPE_COPY[it.eventType].ritual && it.prasad))
      && (!filters.priv || it.visibility === 'private' || it.mode === 'one_on_one'));
    return list.sort(sorter(filters.sort));
    // `now` ticks every second; the day-level filters only need the minute.
  }, [items, filters, festivals, Math.floor(now / 60_000)]); // eslint-disable-line react-hooks/exhaustive-deps

  const live = useMemo(() => items.filter((i) => i.liveNow), [items]);
  const nextUp = useMemo(() => items.find((i) => !i.liveNow && i.startsAt != null && i.startsAt > now) ?? null, [items, now]);

  const stats = useMemo(() => {
    const towns = new Set(items.map((i) => norm(i.location ?? '')).filter(Boolean)).size;
    const devotees = items.reduce((n, i) => n + i.booked, 0);
    let w = 0; let sum = 0;
    for (const i of items) if (i.ratingAvg != null && i.ratingCount > 0) { sum += i.ratingAvg * i.ratingCount; w += i.ratingCount; }
    const upcoming = items.filter((i) => i.liveNow || (i.startsAt != null && i.startsAt < now + 30 * DAY_MS)).length;
    // Cities for the hero lead: most-listed first, up to three.
    const cityCount = new Map<string, { city: string; n: number }>();
    for (const i of items) {
      const city = (i.location ?? '').trim();
      if (!city) continue;
      const k = norm(city); const cur = cityCount.get(k);
      if (cur) cur.n++; else cityCount.set(k, { city, n: 1 });
    }
    const cities = [...cityCount.values()].sort((a, b) => b.n - a.n || a.city.localeCompare(b.city)).slice(0, 3).map((c) => c.city);
    return { towns, devotees, rating: w > 0 ? sum / w : null, upcoming, cities };
  }, [items, Math.floor(now / 60_000)]); // eslint-disable-line react-hooks/exhaustive-deps

  const temples = useMemo(() => {
    const m = new Map<string, { city: string; n: number }>();
    for (const i of items) {
      const city = (i.location ?? '').trim();
      if (!city) continue;
      const k = norm(city);
      const cur = m.get(k);
      if (cur) cur.n++; else m.set(k, { city, n: 1 });
    }
    return [...m.values()].sort((a, b) => b.n - a.n || a.city.localeCompare(b.city)).slice(0, 10);
  }, [items]);

  const deityCounts = useMemo(() => deities.map((d) => items.filter((i) => matchesQuery(i, d.name, [])).length), [deities, items]);
  const festivalCounts = useMemo(() => festivals.map((f) => items.filter((i) => festivalMatch(i, f)).length), [festivals, items]);

  const searching = isSearching(filters);
  const ready = status === 'ready';
  const visible = results.slice(0, shown);

  const cardAction = (it: Item, position: number, rail: string) => (action: string) =>
    capture('marketplace_card_click', { action, listing_id: it.id, position, rail });

  // ------------------------------------------------------------ hero portals
  // [MKT-V2-3] Stats card whenever something is listed; each stat hidden only when it is zero.
  const heroStats = mounted && ready && typeof document !== 'undefined' ? document.getElementById('mk-hero-stats') : null;
  const heroCount = mounted && ready && typeof document !== 'undefined' ? document.getElementById('mk-hero-count') : null;
  const heroCities = mounted && ready && typeof document !== 'undefined' ? document.getElementById('mk-hero-cities') : null;
  const statCells = [
    stats.towns > 0 && <div key="t"><b>{stats.towns.toLocaleString('en-IN')}</b><span>{stats.towns === 1 ? 'temple' : 'temples'}</span></div>,
    stats.devotees > 0 && <div key="d"><b>{stats.devotees.toLocaleString('en-IN')}</b><span>devotees joined</span></div>,
    stats.rating != null && <div key="r"><b>{stats.rating.toFixed(1)}★</b><span>average rating</span></div>,
  ].filter(Boolean);

  // ------------------------------------------------------------ empty state
  const emptyGuide = useMemo(() => {
    const q = norm(filters.q);
    if (!q) return null;
    return guideFor(filters.q, guides) ?? (q.length >= 3 ? guides.find((g) => hasWords(' ' + norm(g.title), q)) ?? null : null);
  }, [filters.q, guides]);

  const emptyState = (
    <div className="mk-empty" role="status">
      <img src={publicImage('/assets/saathum-bright/lotus.png', { width: 160, fit: 'scale-down' })} alt="" width={72} height={72} />
      {status === 'error'
        ? <h2 id="mk-empty-title">We couldn’t load events just now.</h2>
        : <h2 id="mk-empty-title">
          {filters.q
            ? <>No “{filters.q}” listed right now.</>
            : items.length === 0 ? 'No events are listed right now.' : 'Nothing matches these filters right now.'}
        </h2>}
      <p>{status === 'error'
        ? 'Please check your connection and try again.'
        : 'New havans and pujas are added every few days. Read about it in the guide, or ask us to schedule one.'}</p>
      <div className="mk-empty-actions">
        {status === 'error' && <button type="button" className="grand-button mk-retry" onClick={() => setReload((n) => n + 1)}>Try again</button>}
        <a className="grand-button" href={emptyGuide?.href ?? '/rituals/'}>
          {emptyGuide ? <>Read about {emptyGuide.title}</> : 'Read about it in the guide'} <span aria-hidden="true">→</span>
        </a>
        <a className="mk-empty-ask" href="/contact">Ask us to schedule one</a>
        {searching && <a className="grand-link" href="/marketplace#all-events" onClick={(e) => { e.preventDefault(); capture('marketplace_filter', { key: 'clear', value: true }); apply({}, true); }}>Clear filters <span aria-hidden="true">→</span></a>}
      </div>
    </div>
  );

  // ------------------------------------------------------------ render
  return (
    <>
      {heroStats && items.length > 0 && statCells.length > 0 && createPortal(<div className="mk-hero-stats">{statCells}</div>, heroStats)}
      {heroCount && items.length > 0 && createPortal(stats.upcoming > 0
        ? <> · {plural(stats.upcoming, 'EVENT', 'EVENTS')} THIS MONTH</>
        : <> · {plural(items.length, 'UPCOMING EVENT', 'UPCOMING EVENTS')}</>, heroCount)}
      {heroCities && stats.cities.length > 0 && createPortal(<> in {stats.cities.join(', ')} and more</>, heroCities)}

      {/* ② CATEGORY TABS */}
      <section className="mk-tabs" aria-label="Browse by category">
        <div className="mk-tabs-inner">
          {TABS.map((t) => {
            const n = typeCounts[t.key] ?? 0;
            return (
              <a key={t.key || 'all'} className={'mk-tab' + (filters.type === t.key ? ' is-on' : '')} style={{ '--tc': t.color } as CSSProperties}
                aria-current={filters.type === t.key ? 'true' : undefined}
                {...filterLink({ type: t.key }, () => capture('marketplace_tab', { type: t.key || 'all' }))}>
                <img src={publicImage(`/assets/saathum-booking/${t.art}.png`, { width: 240, fit: 'scale-down' })} alt="" width={120} height={120} loading="lazy" decoding="async" />
                <span className="mk-tab-copy"><b>{t.label}</b><small>{tabSub[t.key] ?? t.sub}</small></span>
                {ready && n > 0 && <span className="mk-tab-count" aria-label={plural(n, 'event')}>{n}</span>}
              </a>
            );
          })}
        </div>
      </section>

      {/* ③ HAPPENING NOW — only when something is live */}
      {live.length > 0 && (
        <section className="mk-live" aria-label="Happening now">
          <div className="mk-live-inner">
            <span className="bn-pill bn-pill--live"><i />Happening now</span>
            <p>
              <b>{live[0].title}</b>{live[0].location ? <> from {live[0].location}</> : null}
              {live[0].booked > 0 && <> · {plural(live[0].booked, 'devotee')} joined</>}
              {live.length > 1 && <> · {live.length - 1} more happening now</>}
              {nextUp && nextUp.startsAt != null && <> · <b>{nextUp.title}</b> starts in {relTime(nextUp.startsAt - now)}</>}
            </p>
            <a className="mk-live-btn" href={live[0].href} onClick={() => capture('marketplace_card_click', { action: 'join_live', listing_id: live[0].id, position: 0, rail: 'live' })}>View <span aria-hidden="true">→</span></a>
          </div>
        </section>
      )}

      {/* ④ UPCOMING EVENTS (+ empty state) — replaced the category rails, owner 2026-09-27 */}
      <section className="bn-section mk-all" id="all-events" ref={allRef} aria-labelledby="mk-all-title">
        <div className="bn-inner">
          <div className="bn-head"><h2 id="mk-all-title"><span aria-hidden="true">✽</span> {searching ? 'Your results' : 'Upcoming events'}</h2><p>Soonest first. Use the filters to narrow it down.</p></div>

          {status === 'loading' && <p className="mk-loading" role="status">Loading events…</p>}

          {ready && items.length > 0 && (
            <div className="mk-toolbar" role="region" aria-label="Filter events">
              <div className="mk-types" role="group" aria-label="Event type">
                {CHIPS.map((c) => (
                  <button key={c.key || 'all'} type="button" className={'mk-type' + (filters.type === c.key ? ' is-on' : '')}
                    style={c.color ? ({ '--tc': c.color } as CSSProperties) : undefined} aria-pressed={filters.type === c.key}
                    onClick={() => { capture('marketplace_tab', { type: c.key || 'all', source: 'toolbar' }); apply({ type: c.key }); }}>
                    {c.label} {typeCounts[c.key] > 0 && <small>{typeCounts[c.key]}</small>}
                  </button>
                ))}
              </div>
              <div className="mk-filters">
                {filters.q && (
                  <button type="button" className="mk-qchip" onClick={() => setFilter('q', '')} aria-label={`Remove search “${filters.q}”`}>
                    “{filters.q}” <span aria-hidden="true">×</span>
                  </button>
                )}
                <label className="mk-select"><span>Intention</span>
                  <select value={filters.intention} onChange={(e) => setFilter('intention', e.target.value)}>
                    <option value="">Any</option>
                    {Object.entries(INTENTION_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </label>
                <div className="mk-when" role="group" aria-label="When">
                  {WHEN_LABELS.map(([k, label]) => (
                    <button key={k || 'any'} type="button" className={filters.when === k ? 'is-on' : ''} aria-pressed={filters.when === k} onClick={() => setFilter('when', k)}>{label}</button>
                  ))}
                </div>
                <label className="mk-select"><span>Price</span>
                  <select value={filters.price} onChange={(e) => setFilter('price', e.target.value)}>
                    <option value="">Any</option><option value="free">Free</option><option value="under200">Under ₹200</option>
                    <option value="200to1000">₹200 – ₹1,000</option><option value="above1000">Above ₹1,000</option>
                  </select>
                </label>
                <label className="mk-select"><span>Sort</span>
                  <select value={filters.sort} onChange={(e) => setFilter('sort', e.target.value)}>
                    <option value="soonest">Soonest first</option><option value="booked">Most booked</option>
                    <option value="price">Price: low to high</option><option value="rating">Top rated</option>
                  </select>
                </label>
                <label className="mk-check"><input type="checkbox" checked={filters.prasad} onChange={(e) => setFilter('prasad', e.target.checked)} /> Prasad courier</label>
                <label className="mk-check"><input type="checkbox" checked={filters.priv} onChange={(e) => setFilter('priv', e.target.checked)} /> Private 1:1 only</label>
                <span className="mk-count" aria-live="polite">Showing {Math.min(shown, results.length)} of {results.length}</span>
              </div>
            </div>
          )}

          {ready && results.length > 0 && (
            <>
              <div className="bn-grid mk-grid">
                {visible.map((it, i) => <BookCard key={it.id} it={it} now={now} origin={origin} onAction={cardAction(it, i, 'grid')} />)}
              </div>
              {results.length > shown && (
                <div className="bn-more">
                  <button type="button" className="bn-more-btn" onClick={() => { capture('marketplace_filter', { key: 'show_more', value: shown + PAGE }); setShown((n) => n + PAGE); }}>
                    Show {Math.min(PAGE, results.length - shown)} more events <span aria-hidden="true">↓</span>
                  </button>
                </div>
              )}
            </>
          )}

          {(status === 'error' || (ready && results.length === 0)) && emptyState}
        </div>
      </section>

      {/* ⑤ BROWSE BY DEITY */}
      {deities.length > 0 && (
        <section className="mk-deities" aria-labelledby="mk-deity-title">
          <div className="mk-wrap">
            <div className="grand-section-heading"><h2 id="mk-deity-title"><span aria-hidden="true">✽</span> Browse by deity</h2><a className="mk-seeall mk-seeall--teal" href="/rituals/">All deities →</a></div>
            <div className="mk-deity-row">
              {deities.map((d, i) => (
                <a key={d.name} className="mk-deity" {...filterLink({ q: d.name }, () => capture('marketplace_search', { q: d.name, source: 'deity' }))}>
                  <span className="mk-deity-ring"><img src={publicImage(d.image, { width: 300, fit: 'scale-down' })} alt="" loading="lazy" decoding="async" /></span>
                  <b>{d.name}</b>
                  {ready && deityCounts[i] > 0 && <small>{plural(deityCounts[i], 'event')}</small>}
                </a>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ⑥ BY INTENTION — static, rendered by Astro */}
      {intentions}

      {/* ⑦ FESTIVAL CALENDAR + TEMPLES */}
      <section className="mk-two" aria-label="Festivals and temples">
        <div className={'mk-wrap mk-two-inner' + (festivals.length === 0 ? ' mk-two-inner--one' : '')}>
          {festivals.length > 0 && (
            <div className="mk-panel">
              <div className="grand-section-heading"><h2><span aria-hidden="true">✽</span> Festival calendar</h2><a className="mk-seeall mk-seeall--teal" {...filterLink({ type: 'festival' }, () => capture('marketplace_tab', { type: 'festival', source: 'festival_panel' }))}>All festivals →</a></div>
              <ol className="mk-fest">
                {festivals.map((f, i) => {
                  const d = new Date(festivalStartMs(f) + IST_OFFSET);
                  const n = festivalCounts[i];
                  return (
                    <li key={f.start + f.keyword}>
                      <a {...filterLink({ q: f.keyword }, () => capture('marketplace_search', { q: f.keyword, source: 'festival' }))}>
                        <span className="mk-fest-date"><b>{String(d.getUTCDate()).padStart(2, '0')}</b><small>{d.toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' })}</small></span>
                        <span className="mk-fest-copy"><b>{f.name}</b><span>{f.note}</span></span>
                        <span className="mk-fest-count">{ready && n > 0 ? <>{plural(n, 'event')} →</> : <span aria-label={'Find ' + f.keyword + ' events'}>→</span>}</span>
                      </a>
                    </li>
                  );
                })}
              </ol>
            </div>
          )}
          <div className="mk-panel">
            <div className="grand-section-heading"><h2><span aria-hidden="true">✽</span> {temples.length > 0 ? 'Live from these temples' : 'Performed live at the altar'}</h2></div>
            {temples.length > 0 && (
              <div className="mk-temples">
                {temples.map((t) => (
                  <a key={t.city} {...filterLink({ q: t.city }, () => capture('marketplace_search', { q: t.city, source: 'temple' }))}>
                    <PinIcon />{t.city}<small aria-label={plural(t.n, 'event')}>{t.n}</small>
                  </a>
                ))}
              </div>
            )}
            <p className="mk-panel-note">Every event names its temple and priest. Wherever you are, the sankalp is spoken at that altar.</p>
            <a className="grand-button mk-panel-btn" href="/how-it-works">How a live havan works <span aria-hidden="true">→</span></a>
          </div>
        </div>
      </section>

    </>
  );
}
