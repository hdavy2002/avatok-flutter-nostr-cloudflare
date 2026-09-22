/**
 * [SHV2-S2] Thin wrapper around `spiritualHomeEventsCore.ts` — the only place
 * this feature imports the REAL `scheduleStateOf` (card.ts) and
 * `getLiveNow`/`getExplore` (apiClient.ts), wiring them in as defaults so the
 * public API keeps the exact contracts.md §2 shape:
 * `createHomeEventsController(deps?: Partial<HomeEventsDeps>)`.
 *
 * Deliberately excluded from `web/test/spiritual_home_events.test.ts` — see
 * that file's header. card.ts/apiClient.ts (and their own transitive
 * `./types`/`./copy`/`./config`/`./requestDeadline`/`./analytics` imports) use
 * extensionless relative imports written for the Vite/Astro bundler, which
 * plain `node --experimental-strip-types --test` cannot resolve. Splitting the
 * pure logic into `spiritualHomeEventsCore.ts` (no runtime imports) means the
 * test suite exercises the real logic directly, with this wrapper — and the
 * resolution gap — never in its import graph at all.
 */
import { scheduleStateOf } from './card';
import { getLiveNow, getExplore } from './apiClient';
import {
  createHomeEventsController as createCoreController,
  type HomeEventsController,
  type HomeEventsDeps,
} from './spiritualHomeEventsCore';

export {
  LIVE_EVENT_CATEGORY_ALLOWLIST,
  isEligibleLiveEvent,
  computeStatus,
  computeJoinable,
} from './spiritualHomeEventsCore';
export type {
  HomeEventsStatus,
  HomeEventsTab,
  NewestStatus,
  HomeEventsState,
  HomeEventsController,
  HomeEventsDeps,
} from './spiritualHomeEventsCore';

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
    scheduleStateOf,
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

export function createHomeEventsController(overrides: Partial<HomeEventsDeps> = {}): HomeEventsController {
  return createCoreController({ ...defaultHomeEventsDeps(), ...overrides });
}
