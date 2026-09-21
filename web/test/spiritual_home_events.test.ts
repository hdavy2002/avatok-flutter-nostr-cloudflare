// [SHV2-S2] Regression tests for web/src/lib/spiritualHomeEventsCore.ts.
//
// node:test based, matching this repo's web/test/ convention (see
// calendar_core.test.ts) — there is no vitest devDependency in web/package.json,
// and CI (verify.yml) runs exactly `cd web && node --experimental-strip-types
// --test test/*.test.ts` (contracts.md §6a).
//   node --experimental-strip-types --test test/spiritual_home_events.test.ts
//
// This suite imports ONLY `spiritualHomeEventsCore.ts`, which — like
// `calendarCore.ts` — has NO runtime imports (only `import type`, erased at
// strip-time), so it loads under plain `node --test` with no DOM and no
// bundler. The real `card.ts`/`apiClient.ts` value bindings (`scheduleStateOf`,
// `getLiveNow`, `getExplore`) live behind `HomeEventsDeps` and are injected
// here as simple fakes; the thin wrapper `spiritualHomeEvents.ts` (which does
// import the real `card.ts`/`apiClient.ts` — both of which use extensionless
// relative imports written for the Vite/Astro bundler and are therefore NOT
// loadable by plain node) is deliberately never imported by this file.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LIVE_EVENT_CATEGORY_ALLOWLIST,
  computeStatus,
  computeJoinable,
  isEligibleLiveEvent,
  createHomeEventsController,
} from '../src/lib/spiritualHomeEventsCore.ts';
import type { HomeEventsDeps, HomeEventsState } from '../src/lib/spiritualHomeEventsCore.ts';
import type { Card, CardPage, ScheduleState } from '../src/lib/types.ts';

// ── fixtures ────────────────────────────────────────────────────────────────

const HOUR = 3_600_000;

function card(overrides: Partial<Card> = {}): Card {
  return {
    id: 'listing-1',
    kind: 'live_event',
    title: 'Satsang with Guruji',
    category: 'live_satsang',
    status: 'published',
    starts_at: Date.now() + HOUR,
    duration_min: 60,
    created_at: Date.now(),
    ...overrides,
  };
}

/** A page of `Card`s, cursor-paginated like `/api/explore`. */
function page(listings: Card[], cursor: string | null = null): CardPage {
  return { listings, cursor };
}

const drain = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};

/**
 * Simple fake of card.ts's real `scheduleStateOf` — same semantics, reimplemented
 * here (rather than imported) so this test file has no runtime dependency on
 * card.ts. Mirrors worker/src/lib/listing_schedule.ts's scheduleState().
 */
function fakeScheduleStateOf(
  c: Pick<Card, 'schedule_state' | 'status' | 'kind' | 'starts_at' | 'duration_min' | 'expires_at'>,
  now = Date.now(),
): ScheduleState {
  if (c.schedule_state) return c.schedule_state;
  const status = String(c.status ?? '');
  if (status === 'cancelled') return 'cancelled';
  if (status === 'completed') return 'ended';
  if (status !== 'published' && status !== 'live' && status !== '') return 'unpublished';
  const expiresRaw = Number(c.expires_at ?? 0);
  const expires = expiresRaw > 0 ? (expiresRaw < 1e11 ? expiresRaw * 1000 : expiresRaw) : null;
  if (expires !== null && expires <= now) return 'expired';
  if (status === 'live') return 'live';
  if (c.kind !== 'live_event') return 'open';
  const raw = Number(c.starts_at ?? 0);
  if (!(raw > 0)) return 'open';
  const start = raw < 1e11 ? raw * 1000 : raw;
  const end = start + Math.max(1, Number(c.duration_min ?? 60) || 60) * 60_000;
  if (now < start) return 'upcoming';
  if (now < end) return 'starting';
  return 'ended';
}

/** Manual fake clock: `now()`/`setTimeout`/`clearTimeout` driven by `advance()`,
 *  draining microtasks between each fired timer so chained `.then()`s settle. */
function createFakeClock(startMs = 1_000_000) {
  let now = startMs;
  let seq = 0;
  const timers = new Map<number, { at: number; seq: number; fn: () => void }>();
  const setTimeoutFn: HomeEventsDeps['setTimeout'] = (fn, ms) => {
    const id = ++seq;
    timers.set(id, { at: now + ms, seq: id, fn });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  const clearTimeoutFn: HomeEventsDeps['clearTimeout'] = (id) => {
    timers.delete(id as unknown as number);
  };
  async function advance(ms: number): Promise<void> {
    const target = now + ms;
    for (;;) {
      let nextId: number | null = null;
      let next: { at: number; seq: number; fn: () => void } | null = null;
      for (const [id, t] of timers) {
        if (t.at > target) continue;
        if (!next || t.at < next.at || (t.at === next.at && t.seq < next.seq)) {
          next = t;
          nextId = id;
        }
      }
      if (!next || nextId === null) break;
      timers.delete(nextId);
      now = next.at;
      next.fn();
      await drain();
    }
    now = target;
  }
  return { now: () => now, setTimeout: setTimeoutFn, clearTimeout: clearTimeoutFn, advance, pendingCount: () => timers.size };
}

function createFakeVisibility(initiallyVisible = true) {
  let visible = initiallyVisible;
  const callbacks = new Set<() => void>();
  return {
    isVisible: () => visible,
    onVisibilityChange: (cb: () => void) => {
      callbacks.add(cb);
      return () => callbacks.delete(cb);
    },
    setVisible: (v: boolean) => {
      visible = v;
      for (const cb of callbacks) cb();
    },
  };
}

function baseDeps(overrides: Partial<HomeEventsDeps> = {}): { deps: HomeEventsDeps; clock: ReturnType<typeof createFakeClock>; vis: ReturnType<typeof createFakeVisibility> } {
  const clock = createFakeClock();
  const vis = createFakeVisibility(true);
  const deps: HomeEventsDeps = {
    getLiveNow: async () => ({ listings: [] }),
    getExplore: async () => page([]),
    scheduleStateOf: fakeScheduleStateOf,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    isVisible: vis.isVisible,
    onVisibilityChange: vis.onVisibilityChange,
    deadlineMs: 5_000,
    retryDelaysMs: [1_000, 2_000],
    refreshIntervalMs: 60_000,
    ...overrides,
  };
  return { deps, clock, vis };
}

// ── pure helpers ─────────────────────────────────────────────────────────────

test('allowlist matches contracts.md §3 exactly', () => {
  assert.deepEqual(
    [...LIVE_EVENT_CATEGORY_ALLOWLIST].sort(),
    ['live_festival', 'live_puja', 'live_puja_ritual', 'live_satsang', 'live_temple'].sort(),
  );
});

test('isEligibleLiveEvent: allowlisted category passes, everything else fails closed', () => {
  assert.equal(isEligibleLiveEvent(card({ category: 'live_puja' })), true);
  assert.equal(isEligibleLiveEvent(card({ category: 'live_puja_ritual' })), true);
  assert.equal(isEligibleLiveEvent(card({ category: 'live_temple' })), true);
  assert.equal(isEligibleLiveEvent(card({ category: 'live_festival' })), true);
  assert.equal(isEligibleLiveEvent(card({ category: 'live_satsang' })), true);
  assert.equal(isEligibleLiveEvent(card({ category: 'meditation' })), false, 'no live yoga/meditation/bhajan/katha category exists');
  assert.equal(isEligibleLiveEvent(card({ category: null })), false);
  assert.equal(isEligibleLiveEvent(card({ category: undefined })), false);
});

test('isEligibleLiveEvent: never a consultation kind, even if the category matches', () => {
  assert.equal(isEligibleLiveEvent(card({ category: 'live_satsang', kind: 'consult' })), false);
});

test('computeStatus: full / upcoming_only / none per A4.2', () => {
  assert.equal(computeStatus(1, 0), 'full');
  assert.equal(computeStatus(2, 5), 'full');
  assert.equal(computeStatus(0, 1), 'upcoming_only');
  assert.equal(computeStatus(0, 0), 'none');
});

test('computeJoinable: true only when every condition holds', () => {
  const now = 1_000_000;
  const c = card({ status: 'live', live: true, joinable: true, starts_at: now - 1000, duration_min: 60 });
  assert.equal(computeJoinable(c, { stale: false, now, scheduleStateOf: fakeScheduleStateOf }), true);
});

test('computeJoinable: fails closed when joinable is missing (undefined)', () => {
  const now = 1_000_000;
  const c = card({ status: 'live', live: true, starts_at: now - 1000, duration_min: 60 });
  assert.equal(c.joinable, undefined);
  assert.equal(computeJoinable(c, { stale: false, now, scheduleStateOf: fakeScheduleStateOf }), false);
});

test('computeJoinable: fails closed when joinable is explicitly false', () => {
  const now = 1_000_000;
  const c = card({ status: 'live', live: true, joinable: false, starts_at: now - 1000, duration_min: 60 });
  assert.equal(computeJoinable(c, { stale: false, now, scheduleStateOf: fakeScheduleStateOf }), false);
});

test('computeJoinable: fails closed when the server never confirmed live', () => {
  const now = 1_000_000;
  const c = card({ status: 'published', live: false, joinable: true, starts_at: now + HOUR });
  assert.equal(computeJoinable(c, { stale: false, now, scheduleStateOf: fakeScheduleStateOf }), false);
});

test('computeJoinable: fails closed once the scheduled window has expired', () => {
  const now = 1_000_000;
  const c = card({ status: 'live', live: true, joinable: true, starts_at: now - 2 * HOUR, duration_min: 60 }); // ended an hour ago
  // status:'live' alone would normally short-circuit to 'live' in scheduleStateOf,
  // so use schedule_state directly to express "server confirms this window is over".
  const withState = { ...c, schedule_state: 'ended' as const };
  assert.equal(computeJoinable(withState, { stale: false, now, scheduleStateOf: fakeScheduleStateOf }), false);
});

test('computeJoinable: fails closed when sold out', () => {
  const now = 1_000_000;
  const c = card({ status: 'live', live: true, joinable: true, starts_at: now - 1000, duration_min: 60, seats_left: 0 });
  assert.equal(computeJoinable(c, { stale: false, now, scheduleStateOf: fakeScheduleStateOf }), false);
});

test('computeJoinable: fails closed while stale, even if everything else says joinable', () => {
  const now = 1_000_000;
  const c = card({ status: 'live', live: true, joinable: true, starts_at: now - 1000, duration_min: 60 });
  assert.equal(computeJoinable(c, { stale: true, now, scheduleStateOf: fakeScheduleStateOf }), false);
});

test('computeJoinable: fails closed on a non-bookable schedule state (ended/cancelled/expired)', () => {
  const now = 1_000_000;
  for (const scheduleState of ['ended', 'cancelled', 'expired'] as const) {
    const c = { ...card({ live: true, joinable: true }), schedule_state: scheduleState };
    assert.equal(computeJoinable(c, { stale: false, now, scheduleStateOf: fakeScheduleStateOf }), false, scheduleState);
  }
});

// ── controller: states ───────────────────────────────────────────────────────

function firstReadyState(states: HomeEventsState[]): HomeEventsState | undefined {
  return states.find((s) => s.status !== 'loading');
}

test('controller: FULL when at least one eligible live event exists', async () => {
  const { deps } = baseDeps({
    getLiveNow: async () => ({ listings: [card({ id: 'live-1', status: 'live', live: true, joinable: true })] }),
    getExplore: async () => page([]),
  });
  const controller = createHomeEventsController(deps);
  const states: HomeEventsState[] = [];
  controller.subscribe((s) => states.push(s));
  controller.start();
  await drain();
  const s = firstReadyState(states)!;
  assert.equal(s.status, 'full');
  assert.equal(s.live.length, 1);
  assert.equal(s.live[0].id, 'live-1');
  controller.dispose();
});

test('controller: UPCOMING_ONLY when nothing is live but upcoming exists', async () => {
  const { deps, clock } = baseDeps();
  deps.getLiveNow = async () => ({ listings: [] });
  deps.getExplore = async () => page([card({ id: 'up-1', starts_at: clock.now() + HOUR })]);
  const controller = createHomeEventsController(deps);
  const states: HomeEventsState[] = [];
  controller.subscribe((s) => states.push(s));
  controller.start();
  await drain();
  const s = firstReadyState(states)!;
  assert.equal(s.status, 'upcoming_only');
  assert.equal(s.upcoming.length, 1);
  controller.dispose();
});

test('controller: NONE when there is no live and no upcoming inventory', async () => {
  const { deps } = baseDeps();
  const controller = createHomeEventsController(deps);
  const states: HomeEventsState[] = [];
  controller.subscribe((s) => states.push(s));
  controller.start();
  await drain();
  const s = firstReadyState(states)!;
  assert.equal(s.status, 'none');
  assert.equal(s.live.length, 0);
  assert.equal(s.upcoming.length, 0);
  controller.dispose();
});

test('controller: starts in loading before the first response resolves', () => {
  const { deps } = baseDeps({
    getLiveNow: () => new Promise(() => {}),
    getExplore: () => new Promise(() => {}),
  });
  const controller = createHomeEventsController(deps);
  controller.start();
  assert.equal(controller.getState().status, 'loading');
  controller.dispose();
});

test('controller: ERROR after bounded retries are exhausted, and error is never reported as none', async () => {
  const { deps, clock } = baseDeps({
    retryDelaysMs: [1_000, 2_000],
    getLiveNow: async () => {
      throw new Error('network down');
    },
    getExplore: async () => page([]),
  });
  const controller = createHomeEventsController(deps);
  const states: HomeEventsState[] = [];
  controller.subscribe((s) => states.push(s));
  controller.start();
  await drain();
  assert.equal(controller.getState().status, 'loading'); // still retrying
  await clock.advance(1_000);
  await clock.advance(2_000);
  assert.equal(controller.getState().status, 'error');
  assert.notEqual(controller.getState().status, 'none');
  controller.dispose();
});

test('controller: retry() re-attempts the load from an error state', async () => {
  let fail = true;
  const { deps } = baseDeps({
    retryDelaysMs: [],
    getLiveNow: async () => {
      if (fail) throw new Error('boom');
      return { listings: [card({ id: 'live-1', status: 'live', live: true, joinable: true })] };
    },
  });
  const controller = createHomeEventsController(deps);
  controller.start();
  await drain();
  assert.equal(controller.getState().status, 'error');
  fail = false;
  controller.getState().retry();
  await drain();
  assert.equal(controller.getState().status, 'full');
  controller.dispose();
});

// ── controller: paging cap, dedupe, live-exclusion ──────────────────────────

test('controller: upcoming pages while under six qualify, but never past a hard cap of three pages', async () => {
  const now = 2_000_000;
  // Each page yields exactly ONE new qualifying card, so after three pages
  // only 3 have qualified — still under six. If the cap were count-driven
  // only, a 4th page would be fetched; it must not be.
  const pageOf = (idx: number, cursor: string | null) => page([card({ id: `up-${idx}`, starts_at: now + (idx + 1) * HOUR })], cursor);
  let calls = 0;
  const { deps } = baseDeps({
    now: () => now,
    getExplore: async () => {
      calls += 1;
      if (calls === 1) return pageOf(0, 'cursor-2');
      if (calls === 2) return pageOf(1, 'cursor-3');
      if (calls === 3) return pageOf(2, 'cursor-4'); // still has a cursor — a 4th page must never be requested
      throw new Error('a 4th page was requested despite the hard cap');
    },
  });
  const controller = createHomeEventsController(deps);
  controller.start();
  await drain();
  assert.equal(calls, 3, 'hard cap of three pages, even though still under six');
  assert.equal(controller.getState().upcoming.length, 3);
  controller.dispose();
});

test('controller: upcoming stops paging once six qualify', async () => {
  const now = 2_000_000;
  let calls = 0;
  const { deps } = baseDeps({
    now: () => now,
    getExplore: async () => {
      calls += 1;
      return page(
        Array.from({ length: 6 }, (_, i) => card({ id: `up-${i}`, starts_at: now + (i + 1) * HOUR })),
        'cursor-2',
      );
    },
  });
  const controller = createHomeEventsController(deps);
  controller.start();
  await drain();
  assert.equal(calls, 1, 'six qualified on page one, no second page fetched');
  assert.equal(controller.getState().upcoming.length, 6);
  controller.dispose();
});

test('controller: dedupes repeated ids within a page', async () => {
  const now = 2_000_000;
  const { deps } = baseDeps({
    now: () => now,
    getExplore: async () =>
      page([card({ id: 'dup-1', starts_at: now + HOUR }), card({ id: 'dup-1', starts_at: now + HOUR })]),
  });
  const controller = createHomeEventsController(deps);
  controller.start();
  await drain();
  assert.equal(controller.getState().upcoming.length, 1);
  controller.dispose();
});

test('controller: a live id never appears in upcoming', async () => {
  const now = 2_000_000;
  const { deps } = baseDeps({
    now: () => now,
    getLiveNow: async () => ({ listings: [card({ id: 'shared-id', status: 'live', live: true, joinable: true })] }),
    getExplore: async () => page([card({ id: 'shared-id', starts_at: now + HOUR }), card({ id: 'other', starts_at: now + HOUR })]),
  });
  const controller = createHomeEventsController(deps);
  controller.start();
  await drain();
  const s = controller.getState();
  assert.equal(s.live.some((c) => c.id === 'shared-id'), true);
  assert.equal(s.upcoming.some((c) => c.id === 'shared-id'), false);
  assert.equal(s.upcoming.some((c) => c.id === 'other'), true);
  controller.dispose();
});

// ── controller: newest tab lazy fetch ───────────────────────────────────────

test('controller: newest is not fetched until selectTab("newest") is called', async () => {
  let exploreCalls = 0;
  const { deps } = baseDeps({
    getExplore: async (params) => {
      exploreCalls += 1;
      void params;
      return page([]);
    },
  });
  const controller = createHomeEventsController(deps);
  controller.start();
  await drain();
  assert.equal(controller.getState().newest, null);
  const callsBeforeTab = exploreCalls;
  controller.getState().selectTab('newest');
  await drain();
  assert.ok(exploreCalls > callsBeforeTab, 'selecting the newest tab triggers its own fetch');
  assert.notEqual(controller.getState().newest, null);
  assert.equal(controller.getState().newestStatus, 'ready');
  controller.dispose();
});

test('controller: selecting newest twice does not re-fetch once ready', async () => {
  let exploreCalls = 0;
  const { deps } = baseDeps({
    getExplore: async () => {
      exploreCalls += 1;
      return page([]);
    },
  });
  const controller = createHomeEventsController(deps);
  controller.start();
  await drain();
  controller.getState().selectTab('newest');
  await drain();
  const afterFirst = exploreCalls;
  controller.getState().selectTab('newest');
  await drain();
  assert.equal(exploreCalls, afterFirst, 'already-ready newest tab is not re-fetched');
  controller.dispose();
});

test('controller: selecting newest again after an error re-fetches it', async () => {
  let shouldFail = true;
  let exploreCalls = 0;
  const { deps } = baseDeps({
    getExplore: async () => {
      exploreCalls += 1;
      if (shouldFail) throw new Error('down');
      return page([]);
    },
  });
  const controller = createHomeEventsController(deps);
  controller.start();
  await drain();
  controller.getState().selectTab('newest');
  await drain();
  assert.equal(controller.getState().newestStatus, 'error');
  const callsAtError = exploreCalls;
  shouldFail = false;
  controller.getState().selectTab('upcoming');
  controller.getState().selectTab('newest');
  await drain();
  assert.ok(exploreCalls > callsAtError, 'reselecting newest after an error re-fetches it');
  assert.equal(controller.getState().newestStatus, 'ready');
  controller.dispose();
});

// ── controller: refresh pause/resume, stale ─────────────────────────────────

test('controller: a failed refresh marks stale=true, keeps last-known cards, drops joinability', async () => {
  const { deps, clock } = baseDeps();
  let shouldFail = false;
  deps.getLiveNow = async () => {
    if (shouldFail) throw new Error('refresh failed');
    return { listings: [card({ id: 'live-1', status: 'live', live: true, joinable: true })] };
  };
  const controller = createHomeEventsController(deps);
  controller.start();
  await drain();
  const before = controller.getState();
  assert.equal(before.stale, false);
  assert.equal(before.joinable(before.live[0]), true);

  shouldFail = true;
  await clock.advance(60_000); // 60 s refresh tick
  const after = controller.getState();
  assert.equal(after.stale, true);
  assert.equal(after.live.length, 1, 'last-known cards are kept');
  assert.equal(after.joinable(after.live[0]), false, 'joinability dropped while stale');
  controller.dispose();
});

test('controller: refresh is paused while hidden and resumes on visibility', async () => {
  const { deps, clock, vis } = baseDeps();
  let liveCalls = 0;
  deps.getLiveNow = async () => {
    liveCalls += 1;
    return { listings: [] };
  };
  const controller = createHomeEventsController(deps);
  controller.start();
  await drain();
  const initialCalls = liveCalls;

  vis.setVisible(false);
  await clock.advance(120_000); // two refresh cycles' worth of time, while hidden
  assert.equal(liveCalls, initialCalls, 'no refresh while hidden');

  vis.setVisible(true);
  await drain();
  await clock.advance(60_000);
  assert.ok(liveCalls > initialCalls, 'refresh resumes once visible again');
  controller.dispose();
});

test('controller: becoming visible while stale triggers an immediate refresh, not a 60 s wait', async () => {
  // `stale` is only ever set by a REFRESH failure (after a successful initial
  // load) — an initial-load failure produces `status: 'error'` with
  // `stale` still false, a different case (see the ERROR test above). So this
  // test first gets a real success, then a real refresh failure, before
  // exercising the visibility-triggered immediate-refresh path.
  const { deps, clock, vis } = baseDeps();
  let shouldFail = false;
  let liveCalls = 0;
  deps.getLiveNow = async () => {
    liveCalls += 1;
    if (shouldFail) throw new Error('down');
    return { listings: [] };
  };
  const controller = createHomeEventsController(deps);
  controller.start();
  await drain();
  assert.equal(controller.getState().status, 'none');
  assert.equal(controller.getState().stale, false);

  shouldFail = true;
  await clock.advance(60_000); // the periodic refresh tick fails
  assert.equal(controller.getState().stale, true);
  const callsWhileStale = liveCalls;

  shouldFail = false;
  vis.setVisible(false);
  vis.setVisible(true);
  await drain();
  assert.ok(liveCalls > callsWhileStale, 'visibility handler drove a fresh attempt without waiting for the next 60 s tick');
  assert.equal(controller.getState().stale, false, 'the immediate refresh succeeded and cleared staleness');
  controller.dispose();
});

// ── controller: dispose ─────────────────────────────────────────────────────

test('controller: dispose aborts in-flight requests and stops further state updates', async () => {
  let signalSeen: AbortSignal | undefined;
  const { deps } = baseDeps({
    getLiveNow: (signal) => {
      signalSeen = signal;
      return new Promise(() => {}); // never resolves on its own
    },
  });
  const controller = createHomeEventsController(deps);
  const states: HomeEventsState[] = [];
  controller.subscribe((s) => states.push(s));
  controller.start();
  await drain();
  const countBeforeDispose = states.length;
  controller.dispose();
  assert.equal(signalSeen?.aborted, true);
  await drain();
  assert.equal(states.length, countBeforeDispose, 'no notifications fire after dispose');
});

test('controller: dispose clears the refresh timer so it never fires again', async () => {
  const { deps, clock } = baseDeps();
  let liveCalls = 0;
  deps.getLiveNow = async () => {
    liveCalls += 1;
    return { listings: [] };
  };
  const controller = createHomeEventsController(deps);
  controller.start();
  await drain();
  const callsAtDispose = liveCalls;
  controller.dispose();
  await clock.advance(600_000);
  assert.equal(liveCalls, callsAtDispose, 'no further refresh after dispose');
});
