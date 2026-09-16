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

export function initAnalytics(): void {
  if (!isBrowser || scheduled || core) return;
  scheduled = true;
  // Give critical rendering/hydration a turn. A timeout covers hidden tabs.
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    clearTimeout(timer);
    scheduled = false;
    load();
  };
  const timer = window.setTimeout(start, 1500);
  requestAnimationFrame(() => requestAnimationFrame(start));
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
