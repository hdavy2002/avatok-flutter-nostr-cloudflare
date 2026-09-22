/**
 * [SHV2-S2] Pure home-event-shelf logic (Part A §A4.2, §A7; contracts.md §2,
 * REVISED after Wave 1 review).
 *
 * No runtime imports — only `import type` (erased at strip-time) — so
 * `web/test/spiritual_home_events.test.ts` can exercise this under plain
 * `node --experimental-strip-types --test` with no DOM and no bundler,
 * exactly like `web/src/lib/calendarCore.ts` does for the creator calendar.
 * Every real value this module needs (`getLiveNow`, `getExplore`,
 * `scheduleStateOf`, timers, a visibility source) comes in through
 * `HomeEventsDeps` — the thin wrapper `spiritualHomeEvents.ts` is the only
 * place that imports the real `card.ts`/`apiClient.ts` implementations and
 * wires them in as defaults.
 *
 * State exposes the RAW wire `Card`, not `CardView` — `ListingTile` and every
 * lane/price/pill helper in `card.ts` read raw `Card` fields (`billing_unit`,
 * `price_semantics`, `schedule_mode`, `slug`, …), and `Card.joinable` is
 * already the server's raw joinable bit, so there is no need for a private
 * side-map the way a `CardView`-shaped state would have required.
 */
import type { Card, CardPage, ScheduleState } from './types';
import type { ExploreParams } from './apiClient';

/** contracts.md §3 — live events only. Never infer from titles; never include consultation kinds. */
export const LIVE_EVENT_CATEGORY_ALLOWLIST = [
  'live_puja',
  'live_puja_ritual',
  'live_temple',
  'live_festival',
  'live_satsang',
] as const;

const ALLOWLIST_SET = new Set<string>(LIVE_EVENT_CATEGORY_ALLOWLIST);

export type HomeEventsStatus = 'loading' | 'full' | 'upcoming_only' | 'none' | 'error';
export type HomeEventsTab = 'upcoming' | 'newest';
export type NewestStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface HomeEventsState {
  status: HomeEventsStatus;
  /** <= 6, allowlisted, confirmed live. */
  live: Card[];
  /** <= 6, future start asc, deduped, excludes live ids. */
  upcoming: Card[];
  /** null until the 'newest' tab is first selected. */
  newest: Card[] | null;
  newestStatus: NewestStatus;
  tab: HomeEventsTab;
  /** true after a failed refresh; joinable() returns false while true. */
  stale: boolean;
  joinable(card: Card, now?: number): boolean;
  /** Re-runs the failed main load (or, if we already have data, an immediate refresh). */
  retry(): void;
  /** Selecting 'newest' when newestStatus is 'idle' OR 'error' (re)fetches it. */
  selectTab(tab: HomeEventsTab): void;
}

export interface HomeEventsController {
  getState(): HomeEventsState;
  subscribe(listener: (s: HomeEventsState) => void): () => void;
  /** First load + 60 s visibility-aware refresh. */
  start(): void;
  /** Aborts in-flight requests, clears timers, removes listeners. */
  dispose(): void;
}

export interface HomeEventsDeps {
  getLiveNow: (signal?: AbortSignal) => Promise<{ listings: Card[] }>;
  getExplore: (params: ExploreParams, signal?: AbortSignal) => Promise<CardPage>;
  /** [LISTING-EXPIRY-1] Injected rather than imported, so this file stays
   *  import-free: the SAME function card.ts uses (mirrors worker/src/lib/listing_schedule.ts). */
  scheduleStateOf: (card: Card, now?: number) => ScheduleState;
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
  /** Whether the tab is currently visible (foregrounded). */
  isVisible: () => boolean;
  /** Subscribe to visibility transitions; returns an unsubscribe fn. */
  onVisibilityChange: (cb: () => void) => () => void;
  /** withDeadline-style timeout for each fetch, ms. */
  deadlineMs: number;
  /** Delays (ms) between bounded retries of the INITIAL load. Empty = no retry. */
  retryDelaysMs: number[];
  /** Live-eligibility refresh cadence while visible, ms (A7: 60 s). */
  refreshIntervalMs: number;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/** Mirrors requestDeadline.ts's withDeadline, but with injectable timers so
 *  tests can drive it with fake clocks instead of real setTimeout. */
function withDeadlineDI<T>(
  read: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  deps: Pick<HomeEventsDeps, 'setTimeout' | 'clearTimeout'>,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<HomeEventsDeps['setTimeout']> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => {
      controller.abort();
      reject(new DOMException('Request cancelled', 'AbortError'));
    };
    if (parent?.aborted) {
      onAbort();
      return;
    }
    parent?.addEventListener('abort', onAbort, { once: true });
    timer = deps.setTimeout(() => {
      controller.abort();
      reject(new DOMException('Request timed out. Please try again.', 'TimeoutError'));
    }, timeoutMs);
  });
  return Promise.race([
    interrupted,
    controller.signal.aborted
      ? Promise.reject(new DOMException('Request cancelled', 'AbortError'))
      : read(controller.signal),
  ]).finally(() => {
    if (timer !== undefined) deps.clearTimeout(timer);
    if (onAbort) parent?.removeEventListener('abort', onAbort);
  });
}

/** contracts.md §3: allowlisted category AND never a consultation kind. Never
 *  inferred from the title — category id only. */
export function isEligibleLiveEvent(card: Card): boolean {
  if (String(card.kind ?? '') === 'consult') return false;
  const category = card.category ?? null;
  return category != null && ALLOWLIST_SET.has(category);
}

export function computeStatus(liveCount: number, upcomingCount: number): HomeEventsStatus {
  if (liveCount > 0) return 'full';
  if (upcomingCount > 0) return 'upcoming_only';
  return 'none';
}

/**
 * Standalone, pure form of the fail-closed `joinable` rule (A4.2 / contracts §2):
 * true only if not stale, the card's own `joinable===true` (the server's raw
 * bit — `Card.joinable`), the card itself says live (`Card.live` or a
 * server-confirmed 'live' schedule state), its scheduled window hasn't
 * expired/ended/cancelled, and it isn't sold out. Anything missing or
 * contradictory falls closed to `false`.
 */
export function computeJoinable(
  card: Card,
  opts: { stale: boolean; now: number; scheduleStateOf: HomeEventsDeps['scheduleStateOf'] },
): boolean {
  if (opts.stale) return false;
  if (card.joinable !== true) return false;
  const state = opts.scheduleStateOf(card, opts.now);
  if (!(card.live === true || state === 'live')) return false; // server must say live
  if (state === 'ended' || state === 'cancelled' || state === 'expired') return false; // window/non-bookable
  if (card.seats_left === 0) return false; // sold out
  return true;
}

function cardId(card: Card): string {
  return String(card.id);
}

interface LiveFetchResult {
  cards: Card[];
  ids: Set<string>;
}

/** Confirmed-live, allowlisted, capped at 6, deduped. */
async function fetchLiveOnce(deps: HomeEventsDeps, signal: AbortSignal): Promise<LiveFetchResult> {
  const res = await withDeadlineDI((s) => deps.getLiveNow(s), deps.deadlineMs, deps, signal);
  const now = deps.now();
  const seen = new Set<string>();
  const cards: Card[] = [];
  for (const card of res.listings ?? []) {
    if (!isEligibleLiveEvent(card)) continue;
    // "Confirmed live": trust the server's own live signal, not a title guess.
    const confirmedLive = Boolean(card.live) || deps.scheduleStateOf(card, now) === 'live';
    if (!confirmedLive) continue;
    const id = cardId(card);
    if (seen.has(id)) continue;
    seen.add(id);
    cards.push(card);
    if (cards.length >= 6) break;
  }
  return { cards, ids: seen };
}

/** Future, allowlisted, ascending by start, deduped against `excludeIds`,
 *  capped at 6 — paging a 2nd/3rd page only while under 6 (hard cap 3 pages). */
async function fetchUpcomingOnce(deps: HomeEventsDeps, signal: AbortSignal, excludeIds: ReadonlySet<string>): Promise<Card[]> {
  const now = deps.now();
  const seen = new Set<string>();
  const collected: Card[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 3; page++) {
    const res = await withDeadlineDI(
      (s) => deps.getExplore({ kind: 'live_event', section: 'live_streaming', limit: 50, cursor }, s),
      deps.deadlineMs,
      deps,
      signal,
    );
    for (const card of res.listings ?? []) {
      if (!isEligibleLiveEvent(card)) continue;
      const id = cardId(card);
      if (excludeIds.has(id) || seen.has(id)) continue;
      // scheduleStateOf's 'upcoming' already means: published, not cancelled,
      // not expired, and start time strictly in the future.
      if (deps.scheduleStateOf(card, now) !== 'upcoming') continue;
      seen.add(id);
      collected.push(card);
    }
    cursor = res.cursor ?? undefined;
    if (collected.length >= 6 || !cursor) break;
  }
  collected.sort((a, b) => (a.starts_at ?? Number.POSITIVE_INFINITY) - (b.starts_at ?? Number.POSITIVE_INFINITY));
  return collected.slice(0, 6);
}

/** Newest tab: future-only, allowlisted, deduped against live ids, ordered by
 *  `created_at` desc, capped at 6. Single page — only fetched lazily. */
async function fetchNewestOnce(deps: HomeEventsDeps, signal: AbortSignal, excludeLiveIds: ReadonlySet<string>): Promise<Card[]> {
  const now = deps.now();
  const res = await withDeadlineDI(
    (s) => deps.getExplore({ kind: 'live_event', section: 'live_streaming', limit: 50, sort: 'newest' }, s),
    deps.deadlineMs,
    deps,
    signal,
  );
  const seen = new Set<string>();
  const collected: Card[] = [];
  for (const card of res.listings ?? []) {
    if (!isEligibleLiveEvent(card)) continue;
    const id = cardId(card);
    if (excludeLiveIds.has(id) || seen.has(id)) continue;
    if (deps.scheduleStateOf(card, now) !== 'upcoming') continue;
    seen.add(id);
    collected.push(card);
  }
  collected.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
  return collected.slice(0, 6);
}

const EMPTY_ID_SET: ReadonlySet<string> = new Set();

/** The engine. Takes a FULLY resolved `HomeEventsDeps` — no defaults, no
 *  `Partial` — the thin wrapper (`spiritualHomeEvents.ts`) is what supplies
 *  real-world defaults and exposes the `Partial<HomeEventsDeps>` public API. */
export function createHomeEventsController(deps: HomeEventsDeps): HomeEventsController {
  let status: HomeEventsStatus = 'loading';
  let live: Card[] = [];
  let upcoming: Card[] = [];
  let newest: Card[] | null = null;
  let newestStatus: NewestStatus = 'idle';
  let tab: HomeEventsTab = 'upcoming';
  let stale = false;

  let disposed = false;
  const listeners = new Set<(s: HomeEventsState) => void>();

  let liveController: AbortController | null = null;
  let upcomingController: AbortController | null = null;
  let newestController: AbortController | null = null;
  let refreshTimer: ReturnType<HomeEventsDeps['setTimeout']> | undefined;
  let retryTimer: ReturnType<HomeEventsDeps['setTimeout']> | undefined;
  let unsubscribeVisibility: (() => void) | undefined;

  // Bumped on every fresh initial load / retry so a slow, superseded attempt
  // that resolves after a newer one has already started never clobbers state.
  let loadEpoch = 0;

  function notify(): void {
    if (disposed) return;
    const snapshot = getState();
    for (const l of listeners) l(snapshot);
  }

  function abortLive(): AbortController {
    liveController?.abort();
    liveController = new AbortController();
    return liveController;
  }

  function abortUpcoming(): AbortController {
    upcomingController?.abort();
    upcomingController = new AbortController();
    return upcomingController;
  }

  function abortNewest(): AbortController {
    newestController?.abort();
    newestController = new AbortController();
    return newestController;
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      retryTimer = deps.setTimeout(() => {
        retryTimer = undefined;
        resolve();
      }, ms);
    });
  }

  async function loadInitial(epoch: number, attempt = 0): Promise<void> {
    if (disposed || epoch !== loadEpoch) return;
    try {
      // Fetched in parallel — upcoming doesn't know the live ids yet, so live
      // ids are filtered out of the upcoming result afterwards instead of
      // threading a dependency between the two network calls.
      const [liveResult, upcomingRaw] = await Promise.all([
        fetchLiveOnce(deps, abortLive().signal),
        fetchUpcomingOnce(deps, abortUpcoming().signal, EMPTY_ID_SET),
      ]);
      if (disposed || epoch !== loadEpoch) return;
      live = liveResult.cards;
      upcoming = upcomingRaw.filter((c) => !liveResult.ids.has(cardId(c)));
      status = computeStatus(live.length, upcoming.length);
      stale = false;
      notify();
      scheduleNextRefresh();
    } catch (err) {
      if (isAbortError(err) || disposed || epoch !== loadEpoch) return;
      if (attempt < deps.retryDelaysMs.length) {
        await delay(deps.retryDelaysMs[attempt]);
        if (disposed || epoch !== loadEpoch) return;
        return loadInitial(epoch, attempt + 1);
      }
      status = 'error';
      notify();
    }
  }

  async function refreshLive(): Promise<void> {
    if (disposed) return;
    try {
      const result = await fetchLiveOnce(deps, abortLive().signal);
      if (disposed) return;
      live = result.cards;
      // A listing may have transitioned from upcoming to live between refreshes.
      upcoming = upcoming.filter((c) => !result.ids.has(cardId(c)));
      status = computeStatus(live.length, upcoming.length);
      stale = false;
      notify();
    } catch (err) {
      if (isAbortError(err) || disposed) return;
      // Keep the last-known cards; drop joinability until a refresh succeeds.
      stale = true;
      notify();
    }
  }

  function scheduleNextRefresh(): void {
    if (disposed) return;
    if (refreshTimer !== undefined) return;
    if (!deps.isVisible()) return; // paused while hidden
    refreshTimer = deps.setTimeout(async () => {
      refreshTimer = undefined;
      await refreshLive();
      scheduleNextRefresh();
    }, deps.refreshIntervalMs);
  }

  function pauseRefresh(): void {
    if (refreshTimer !== undefined) {
      deps.clearTimeout(refreshTimer);
      refreshTimer = undefined;
    }
  }

  function onVisibility(): void {
    if (disposed) return;
    if (deps.isVisible()) {
      if (stale) {
        void refreshLive().then(() => scheduleNextRefresh());
      } else {
        scheduleNextRefresh();
      }
    } else {
      pauseRefresh();
    }
  }

  function joinable(card: Card, now: number = deps.now()): boolean {
    return computeJoinable(card, { stale, now, scheduleStateOf: deps.scheduleStateOf });
  }

  function retry(): void {
    if (disposed) return;
    if (status === 'error') {
      status = 'loading';
      notify();
      loadEpoch += 1;
      void loadInitial(loadEpoch);
    } else {
      void refreshLive();
    }
  }

  function selectTab(next: HomeEventsTab): void {
    if (disposed) return;
    tab = next;
    if (next === 'newest' && (newestStatus === 'idle' || newestStatus === 'error')) {
      newestStatus = 'loading';
      notify();
      const excludeLiveIds = new Set(live.map(cardId));
      void fetchNewestOnce(deps, abortNewest().signal, excludeLiveIds)
        .then((result) => {
          if (disposed) return;
          newest = result;
          newestStatus = 'ready';
          notify();
        })
        .catch((err) => {
          if (isAbortError(err) || disposed) return;
          newestStatus = 'error';
          notify();
        });
    } else {
      notify();
    }
  }

  function getState(): HomeEventsState {
    return { status, live, upcoming, newest, newestStatus, tab, stale, joinable, retry, selectTab };
  }

  function subscribe(listener: (s: HomeEventsState) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function start(): void {
    if (disposed) return;
    unsubscribeVisibility = deps.onVisibilityChange(onVisibility);
    loadEpoch += 1;
    void loadInitial(loadEpoch);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    liveController?.abort();
    upcomingController?.abort();
    newestController?.abort();
    pauseRefresh();
    if (retryTimer !== undefined) {
      deps.clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    unsubscribeVisibility?.();
    listeners.clear();
  }

  return { getState, subscribe, start, dispose };
}
