// Lightweight, SSR-safe telemetry facade. Rendering/auth never await the SDK.
// Commands (including identity changes) drain in order so queued events retain
// the account identity that was active when they occurred.
import type { Properties } from 'posthog-js';
type Core = typeof import('./analyticsCore');
type Command = (core: Core) => void;
let core: Core | undefined;
let loading: Promise<void> | undefined;
let scheduled = false;
let currentUid: string | null = null;
let trace: string | undefined;
const pending: { run: Command; event: boolean }[] = [];
const isBrowser = typeof window !== 'undefined';

function load(): void {
  if (!isBrowser || core || loading) return;
  loading = import('./analyticsCore').then((loaded) => {
    loaded.initAnalytics();
    core = loaded;
    setEarlyErrorCapture(false); // the SDK's exception autocapture owns it now
    reportPageSpeed();
    for (const command of pending.splice(0)) {
      try { command.run(loaded); } catch { /* telemetry is best-effort */ }
    }
  }).catch(() => {
    // A blocked SDK must not break UI. Retry on the next event; bound memory.
  }).finally(() => { loading = undefined; });
}

function enqueue(command: Command, event = false): void {
  if (!isBrowser) return;
  if (core) {
    try { command(core); } catch { /* telemetry must never break UI */ }
  } else {
    // Only events may be evicted. Never lose identify/reset/trace transitions:
    // replaying an event under the wrong account is worse than losing a sample.
    if (event && pending.filter((item) => item.event).length >= 500) {
      const oldestEvent = pending.findIndex((item) => item.event);
      pending.splice(oldestEvent, 1);
    }
    pending.push({ run: command, event });
    initAnalytics();
  }
}

// [WEB-PERF-1 2026-09-30] OWNER DECISION: everything non-critical loads LATER,
// in the background, on every public and signed-in page. PostHog (core + replay
// + surveys + dead-clicks, ~200 KB) used to start two animation frames after
// the script ran, i.e. while the page was still painting and hydrating. It now
// waits for the window `load` event and then an idle slot. Nothing is lost in
// the gap: calls queue in `pending` (above) and uncaught errors are buffered by
// the listeners below until the SDK's own exception autocapture takes over.
const MAX_WAIT_MS = 8000; // ceiling for a page that never goes idle
let earlyErrorsOn = false;
function onEarlyError(e: ErrorEvent): void {
  captureException(e.error ?? e.message, { source: 'early_window_error' });
}
function onEarlyRejection(e: PromiseRejectionEvent): void {
  captureException(e.reason, { source: 'early_unhandled_rejection' });
}
function setEarlyErrorCapture(on: boolean): void {
  if (!isBrowser || typeof window.addEventListener !== 'function' || on === earlyErrorsOn) return;
  earlyErrorsOn = on;
  const fn = on ? window.addEventListener : window.removeEventListener;
  fn.call(window, 'error', onEarlyError as EventListener);
  fn.call(window, 'unhandledrejection', onEarlyRejection as EventListener);
}

/**
 * [WEB-PERF-1] One `web_page_speed` event per page load, sent once the SDK is
 * up: first paint, largest paint, DOM-ready, load, and how long telemetry
 * itself was held back. This is how we prove the "load later" change made pages
 * faster for real visitors (catalog: SPEC-2026-09-02-TELEMETRY-CATALOG.md).
 */
function reportPageSpeed(): void {
  try {
    if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') return;
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime;
    const round = (n: number | undefined) => (typeof n === 'number' && n > 0 ? Math.round(n) : null);
    const send = (lcp: number | undefined) => capture('web_page_speed', {
      path: window.location.pathname,
      fcp_ms: round(fcp),
      lcp_ms: round(lcp),
      ttfb_ms: round(nav?.responseStart),
      dom_ready_ms: round(nav?.domContentLoadedEventEnd),
      load_ms: round(nav?.loadEventEnd),
      telemetry_start_ms: Math.round(performance.now()),
      transfer_kb: nav ? Math.round((nav.transferSize || 0) / 1024) : null,
      effective_type: (navigator as unknown as { connection?: { effectiveType?: string } }).connection?.effectiveType ?? null,
    });
    if (typeof PerformanceObserver === 'undefined') { send(undefined); return; }
    let sent = false;
    const po = new PerformanceObserver((list) => {
      if (sent) return;
      sent = true;
      po.disconnect();
      send(list.getEntries().at(-1)?.startTime);
    });
    po.observe({ type: 'largest-contentful-paint', buffered: true });
    window.setTimeout(() => { if (!sent) { sent = true; po.disconnect(); send(undefined); } }, 1000);
  } catch {
    /* telemetry must never break the page */
  }
}

export function initAnalytics(): void {
  if (!isBrowser || scheduled || core) return;
  scheduled = true;
  setEarlyErrorCapture(true);
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    clearTimeout(timer);
    scheduled = false;
    load();
  };
  const timer = window.setTimeout(start, MAX_WAIT_MS);
  const doc = typeof document !== 'undefined' ? document : undefined;
  if (!doc) {
    // Non-DOM contexts (and the CI contract sandbox): the old two-frame deferral.
    requestAnimationFrame(() => requestAnimationFrame(start));
    return;
  }
  const whenIdle = () => {
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (typeof ric === 'function') ric(start, { timeout: 3000 });
    else window.setTimeout(start, 1200); // Safari has no requestIdleCallback
  };
  if (doc.readyState === 'complete') whenIdle();
  else window.addEventListener('load', whenIdle, { once: true });
}

export function identify(uid: string, props?: { email?: string | null; phone?: string | null; handle?: string | null; [k: string]: unknown }): void {
  if (!isBrowser) return;
  currentUid = uid;
  const snapshot = props ? { ...props } : undefined;
  enqueue((sdk) => sdk.identify(uid, snapshot));
}
export function reset(): void {
  if (!isBrowser) return;
  currentUid = null;
  enqueue((sdk) => sdk.reset());
}
export function capture(event: string, props?: Properties): void {
  const snapshot = { ...props, ...(trace ? { trace_id: trace } : {}) };
  enqueue((sdk) => sdk.capture(event, snapshot), true);
}
export function captureException(err: unknown, props?: Properties): void {
  const snapshot = { ...props, ...(trace ? { trace_id: trace } : {}) };
  enqueue((sdk) => sdk.captureException(err, snapshot), true);
}
export function uiInteraction(name: string, ms: number, props?: Properties): void {
  capture('ui_interaction', { name, ms, ...props });
}
export function apiError(props: { endpoint: string; method: string; status: number; reason: string; ms: number; [k: string]: unknown }): void {
  capture('api_error', props);
}
export async function withTrace<T>(fn: (traceId: string) => Promise<T> | T): Promise<T> {
  if (!isBrowser) return fn('');
  const id = globalThis.crypto?.randomUUID?.() ?? `tr_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const previous = trace;
  trace = id;
  enqueue((sdk) => sdk.setTrace(id));
  try { return await fn(id); }
  finally {
    trace = previous;
    enqueue((sdk) => sdk.setTrace(previous));
  }
}
export function currentDistinctUid(): string | null { return currentUid; }
