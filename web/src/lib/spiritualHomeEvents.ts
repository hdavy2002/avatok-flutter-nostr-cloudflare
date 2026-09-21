/**
 * [SHV2-S2] Home page event data for the Saathum pivot (Part A §A4.2, §A7;
 * contracts.md §2).
 *
 * Pure controller: fetches `getLiveNow()` / `getExplore()`, filters to the
 * spiritual live-event category allowlist (§3), maps through `toCardView` /
 * `scheduleStateOf`, and exposes a subscribable `HomeEventsState` with a
 * fail-closed `joinable()` check. All I/O is dependency-injected so tests can
 * drive it with fake timers, a fake visibility source and canned fetchers —
 * see `spiritualHomeEvents.test.ts`.
 *
 * `CardView` (web/src/lib/types.ts) has no raw `joinable` boolean of its own —
 * `toCardView` folds `card.live || card.joinable || status==='live'` into one
 * `live` flag, so "server says live" and "joinable===true" cannot both be read
 * back off a `CardView`. Rather than edit `card.ts`/`types.ts` (out of
 * ownership, and the brief says stop and ask before doing that), this module
 * keeps the raw `joinable` bit from the live-now response in a private
 * id-keyed map alongside the mapped `CardView[]`, and `joinable()` consults
 * both. See the hand-back note for the question raised on this design.
 */
// [WEB-TESTS-1] Explicit `.ts` extensions here (unlike this codebase's usual
// extensionless style) so this file resolves as far as Node's ESM loader will
// take it under the repo's real `node --experimental-strip-types --test`
// convention — see the hand-back note: `card.ts`/`apiClient.ts` themselves
// still use extensionless relative imports internally, which is the deeper,
// out-of-ownership blocker for actually running the test file today.
import type { Card, CardPage, CardView } from './types.ts';
import { toCardView, scheduleStateOf } from './card.ts';
import { getLiveNow, getExplore } from './apiClient.ts';
import type { ExploreParams } from './apiClient.ts';

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
  live: CardView[];
  /** <= 6, future start asc, deduped, excludes live ids. */
  upcoming: CardView[];
  /** null until the 'newest' tab is first selected. */
  newest: CardView[] | null;
  newestStatus: NewestStatus;
  tab: HomeEventsTab;
  /** true after a failed refresh; Join now must be dropped while true. */
  stale: boolean;
  joinable(card: CardView, now?: number): boolean;
  retry(): void;
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

const REAL_SET_TIMEOUT = ((fn: () => void, ms: number) => setTimeout(fn, ms)) as HomeEventsDeps['setTimeout'];
const REAL_CLEAR_TIMEOUT = ((h: ReturnType<typeof setTimeout>) => clearTimeout(h)) as HomeEventsDeps['clearTimeout'];

function defaultIsVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

function defaultOnVisibilityChange(cb: () => void): () => void {
  if (typeof document === 'undefined') return () => {};
  document.addEventListener('visibilitychange', cb);
  return () => document.removeEventListener('visibilitychange', cb);
}

export function defaultHomeEventsDeps(): HomeEventsDeps {
  return {
    getLiveNow,
    getExplore,
    now: () => Date.now(),
    setTimeout: REAL_SET_TIMEOUT,
    clearTimeout: REAL_CLEAR_TIMEOUT,
    isVisible: defaultIsVisible,
    onVisibilityChange: defaultOnVisibilityChange,
    // Matches the existing LiveNowRail.tsx convention for getLiveNow().
    deadlineMs: 10_000,
    retryDelaysMs: [1_000, 3_000],
    refreshIntervalMs: 60_000,
  };
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
 *  inferred from the title — category id only. Exported for direct unit
 *  testing (see hand-back note re: node:test's reach into `card.ts`). */
export function isEligibleLiveEvent(card: Card): boolean {
  if (String(card.kind ?? '') === 'consult') return false;
  const category = card.category ?? null;
  return category != null && ALLOWLIST_SET.has(category);
}

function raceId(card: Card): string {
  return String(card.id);
}

interface LiveFetchResult {
  views: CardView[];
  joinableRaw: Map<string, boolean>;
  ids: Set<string>;
}

/** Confirmed-live, allowlisted, capped at 6, deduped. */
async function fetchLiveOnce(deps: HomeEventsDeps, signal: AbortSignal): Promise<LiveFetchResult> {
  const res = await withDeadlineDI((s) => deps.getLiveNow(s), deps.deadlineMs, deps, signal);
  const now = deps.now();
  const seen = new Set<string>();
  const joinableRaw = new Map<string, boolean>();
  const views: CardView[] = [];
  for (const card of res.listings ?? []) {
    if (!isEligibleLiveEvent(card)) continue;
    // "Confirmed live": trust the server's own live signal, not a title guess.
    const confirmedLive = Boolean(card.live) || scheduleStateOf(card, now) === 'live';
    if (!confirmedLive) continue;
    const id = raceId(card);
    if (seen.has(id)) continue;
    seen.add(id);
    joinableRaw.set(id, card.joinable === true);
    views.push(toCardView(card));
    if (views.length >= 6) break;
  }
  return { views, joinableRaw, ids: seen };
}

/** Future, allowlisted, ascending by start, deduped against `excludeIds`,
 *  capped at 6 — paging a 2nd/3rd page only while under 6 (hard cap 3 pages). */
async function fetchUpcomingOnce(deps: HomeEventsDeps, signal: AbortSignal, excludeIds: ReadonlySet<string>): Promise<CardView[]> {
  const now = deps.now();
  const seen = new Set<string>();
  const collected: CardView[] = [];
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
      const id = raceId(card);
      if (excludeIds.has(id) || seen.has(id)) continue;
      // scheduleStateOf's 'upcoming' already means: published, not cancelled,
      // not expired, and start time strictly in the future.
      if (scheduleStateOf(card, now) !== 'upcoming') continue;
      seen.add(id);
      collected.push(toCardView(card));
    }
    cursor = res.cursor ?? undefined;
    if (collected.length >= 6 || !cursor) break;
  }
  collected.sort((a, b) => (a.startsAt ?? Number.POSITIVE_INFINITY) - (b.startsAt ?? Number.POSITIVE_INFINITY));
  return collected.slice(0, 6);
}

/** Newest tab: future-only, allowlisted, deduped against live ids, ordered by
 *  `created_at` desc, capped at 6. Single page — only fetched lazily. */
async function fetchNewestOnce(deps: HomeEventsDeps, signal: AbortSignal, excludeLiveIds: ReadonlySet<string>): Promise<CardView[]> {
  const now = deps.now();
  const res = await withDeadlineDI(
    (s) => deps.getExplore({ kind: 'live_event', section: 'live_streaming', limit: 50, sort: 'newest' }, s),
    deps.deadlineMs,
    deps,
    signal,
  );
  const seen = new Set<string>();
  const collected: CardView[] = [];
  for (const card of res.listings ?? []) {
    if (!isEligibleLiveEvent(card)) continue;
    const id = raceId(card);
    if (excludeLiveIds.has(id) || seen.has(id)) continue;
    if (scheduleStateOf(card, now) !== 'upcoming') continue;
    seen.add(id);
    collected.push(toCardView(card));
  }
  collected.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return collected.slice(0, 6);
}

const EMPTY_ID_SET: ReadonlySet<string> = new Set();

export function computeStatus(liveCount: number, upcomingCount: number): HomeEventsStatus {
  if (liveCount > 0) return 'full';
  if (upcomingCount > 0) return 'upcoming_only';
  return 'none';
}

/**
 * Standalone, pure form of the fail-closed `joinable` rule (A4.2 / contracts §2):
 * true only if not stale, the live-now response said `joinable===true` for this
 * id, the mapped card itself says live, its scheduled window (if any) hasn't
 * expired, and it isn't sold out / ended / cancelled / expired. Anything
 * missing or contradictory falls closed to `false`. Exported so it can be unit
 * tested directly against hand-built `CardView` fixtures without exercising
 * the fetch pipeline.
 */
export function computeJoinable(
  card: CardView,
  opts: { stale: boolean; joinableRaw: boolean | undefined; now: number },
): boolean {
  if (opts.stale) return false;
  if (opts.joinableRaw !== true) return false;
  if (!card.live) return false;
  if (card.startsAt != null && card.durationMin != null) {
    const end = card.startsAt + card.durationMin * 60_000;
    if (opts.now >= end) return false;
  }
  if (card.seatsLeft === 0) return false;
  if (card.scheduleState === 'ended' || card.scheduleState === 'cancelled' || card.scheduleState === 'expired') return false;
  return true;
}

export function createHomeEventsController(overrides: Partial<HomeEventsDeps> = {}): HomeEventsController {
  const deps: HomeEventsDeps = { ...defaultHomeEventsDeps(), ...overrides };

  let status: HomeEventsStatus = 'loading';
  let live: CardView[] = [];
  let upcoming: CardView[] = [];
  let newest: CardView[] | null = null;
  let newestStatus: NewestStatus = 'idle';
  let tab: HomeEventsTab = 'upcoming';
  let stale = false;
  let liveJoinableRaw = new Map<string, boolean>();

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
      live = liveResult.views;
      liveJoinableRaw = liveResult.joinableRaw;
      upcoming = upcomingRaw.filter((c) => !liveResult.ids.has(c.id));
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
      live = result.views;
      liveJoinableRaw = result.joinableRaw;
      // A listing may have transitioned from upcoming to live between refreshes.
      upcoming = upcoming.filter((c) => !result.ids.has(c.id));
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

  function joinable(card: CardView, now: number = deps.now()): boolean {
    return computeJoinable(card, { stale, joinableRaw: liveJoinableRaw.get(card.id), now });
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
      const excludeLiveIds = new Set(live.map((c) => c.id));
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
