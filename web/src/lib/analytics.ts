// [WEB-POSTHOG-1] The web PostHog core. THIS IS THE ONLY FILE THAT TOUCHES
// posthog-js. Every island/page/component that wants telemetry imports from
// here — never `import posthog from 'posthog-js'` anywhere else.
//
// Contract: Specs/SPEC-2026-09-02-TELEMETRY-CATALOG.md §1, §2.1, §2.2, §2.11.
// Mirrors app/lib/core/analytics.dart's naming and `_persistEmail` pattern so
// one dashboard can serve both surfaces.
//
// SSR-safe: every export is a no-op when `typeof window === 'undefined'`
// (Astro prerenders on the server, where there is no browser and nothing to
// instrument).

import posthog from 'posthog-js';
import type { Properties } from 'posthog-js';

const DEFAULT_KEY = 'phc_hmYMsHQEYjQU4bYXNdqA4VZVsfHEIkBQdQL0Kv7FIc5';
const DEFAULT_HOST = 'https://eu.i.posthog.com';

const isBrowser = typeof window !== 'undefined';

let initialized = false;
let currentUid: string | null = null;

// ── §1.5 scrubbing — never sent: passwords, tokens, secrets, otp, real phone
// numbers / long numeric ids. Mirrors analytics.dart's `_scrub` / worker's
// `scrubServer`. ──────────────────────────────────────────────────────────
const SENSITIVE_KEY_RE = /token|password|secret|authorization|otp/i;
// 7+ consecutive digits inside a string value (phone numbers, OTPs, long ids
// that slipped into a free-text prop) get redacted rather than dropped, so
// the surrounding message stays readable.
const LONG_DIGIT_RUN_RE = /\d{7,}/g;

function scrubValue(v: unknown): unknown {
  if (typeof v === 'string') return v.replace(LONG_DIGIT_RUN_RE, '[redacted]');
  return v;
}

function scrubProps(props: Properties | undefined | null): Properties | undefined | null {
  if (!props || typeof props !== 'object') return props;
  const out: Properties = {};
  for (const [k, v] of Object.entries(props)) {
    if (SENSITIVE_KEY_RE.test(k)) continue; // drop entirely
    out[k] = scrubValue(v);
  }
  return out;
}

// ── §2.1 `app` derivation from the URL path — matches the Worker's app_name. ─
function deriveApp(pathname: string): string {
  if (pathname.startsWith('/dashboard')) return 'avaexplore';
  if (pathname.startsWith('/admin')) return 'admin';
  if (
    pathname.startsWith('/l/') ||
    pathname.startsWith('/e/') ||
    pathname.startsWith('/live') ||
    pathname.startsWith('/marketplace')
  ) {
    return 'avaexplore';
  }
  return 'site';
}

function deviceClass(width: number): 'phone' | 'tablet' | 'desktop' {
  if (width < 768) return 'phone';
  if (width < 1024) return 'tablet';
  return 'desktop';
}

function registerResponsiveSuperProps(): void {
  if (!isBrowser) return;
  posthog.register({
    app: deriveApp(window.location.pathname),
    device_class: deviceClass(window.innerWidth),
    viewport: `${window.innerWidth}x${window.innerHeight}`,
  });
}

// ── §1.3 persisted email, mirrors analytics.dart `_persistEmail` — so errors
// after a lapsed session still carry the last-known email. ──────────────────
function emailKey(uid: string): string {
  return `ph_email_${uid}`;
}

function persistEmail(uid: string | null | undefined, email: string | null | undefined): void {
  if (!isBrowser || !uid || !email) return;
  try {
    window.localStorage.setItem(emailKey(uid), email);
  } catch {
    /* private mode / storage full — best-effort only */
  }
}

function loadEmail(uid: string): string | null {
  if (!isBrowser) return null;
  try {
    return window.localStorage.getItem(emailKey(uid));
  } catch {
    return null;
  }
}

/**
 * Idempotent — safe to call from every layout/page that loads. First caller
 * wins; later calls just re-register the responsive super props (cheap,
 * covers a client-side route change that Base.astro's script re-runs).
 */
export function initAnalytics(): void {
  if (!isBrowser) return;
  if (initialized) {
    registerResponsiveSuperProps();
    return;
  }
  initialized = true;

  const key = (import.meta.env.PUBLIC_POSTHOG_KEY as string | undefined) || DEFAULT_KEY;
  const host = (import.meta.env.PUBLIC_POSTHOG_HOST as string | undefined) || DEFAULT_HOST;
  const release = (import.meta.env.PUBLIC_RELEASE_SHA as string | undefined) || 'dev';

  posthog.init(key, {
    api_host: host,
    capture_pageview: 'history_change',
    capture_pageleave: true,
    autocapture: true,
    rageclick: true,
    capture_dead_clicks: true,
    capture_exceptions: true,
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: '*',
      blockClass: 'ph-no-capture',
    },
    // Replay is enabled here; the 20% sampling from the catalog (§1.2) is set
    // in the PostHog project settings (Session replay > sampling), same as
    // the app's server-controlled rollout — no client-side dice roll needed.
    persistence: 'localStorage+cookie',
    cross_subdomain_cookie: false,
    loaded: () => registerResponsiveSuperProps(),
    before_send: (event) => {
      if (!event) return event;
      if (event.properties) {
        event.properties = scrubProps(event.properties) ?? {};
      }
      return event;
    },
  });

  posthog.register({
    platform: 'web',
    service_name: 'avatok-web',
    release,
  });
  registerResponsiveSuperProps();

  // §1.3 — re-register the last-known email for the current distinct_id, if
  // any, so an error fired before identify() (or after a lapsed session)
  // still carries it. distinct_id is anonymous pre-login, but harmless to try.
  try {
    const uid = posthog.get_distinct_id?.();
    if (uid) {
      const saved = loadEmail(uid);
      if (saved) posthog.register({ email: saved });
    }
  } catch {
    /* best-effort */
  }

  if (isBrowser) {
    window.addEventListener('popstate', registerResponsiveSuperProps);
    window.addEventListener('resize', registerResponsiveSuperProps);
  }
}

/** §1.3 person identity. Call at sign-in with whatever is known. */
export function identify(
  uid: string,
  props?: { email?: string | null; phone?: string | null; handle?: string | null; [k: string]: unknown },
): void {
  if (!isBrowser) return;
  currentUid = uid;
  const personProps: Properties = { ...props };
  if (props?.email) {
    persistEmail(uid, props.email);
    posthog.register({ email: props.email });
  }
  try {
    posthog.identify(uid, scrubProps(personProps) ?? undefined);
  } catch {
    /* best-effort */
  }
}

/** §1.3 — call at sign-out. Clears the PostHog distinct_id/session. */
export function reset(): void {
  if (!isBrowser) return;
  currentUid = null;
  try {
    posthog.reset();
  } catch {
    /* best-effort */
  }
}

/** Generic capture — every named event in the catalog goes through this. */
export function capture(event: string, props?: Properties): void {
  if (!isBrowser) return;
  try {
    posthog.capture(event, scrubProps(props) ?? undefined);
  } catch {
    /* telemetry must never break the page */
  }
}

/** §1.2 error tracking — manual capture for a caught exception. */
export function captureException(err: unknown, props?: Properties): void {
  if (!isBrowser) return;
  try {
    posthog.captureException(err, scrubProps(props) ?? undefined);
  } catch {
    /* best-effort */
  }
}

/**
 * §2.11 `ui_interaction` — the ONE event for fetch-then-render / interaction
 * latency. Never invent a bespoke `*_ms` event; use this with a `name`.
 */
export function uiInteraction(name: string, ms: number, props?: Properties): void {
  capture('ui_interaction', { name, ms, ...props });
}

/** §2.11 `api_error` — the shared apiClient `request()` hook emits this. */
export function apiError(props: {
  endpoint: string;
  method: string;
  status: number;
  reason: string;
  ms: number;
  [k: string]: unknown;
}): void {
  capture('api_error', props);
}

/**
 * Correlates a client action across client/server/logs (§1 `trace_id`).
 * Generates a trace id, registers it as a super property for the duration of
 * `fn`, and unregisters it afterwards (even on throw). Nested calls restore
 * the outer trace id rather than clobbering it, so a trace inside a trace
 * doesn't leak into unrelated later events.
 */
export async function withTrace<T>(fn: (traceId: string) => Promise<T> | T): Promise<T> {
  if (!isBrowser) return fn('');
  const traceId =
    globalThis.crypto?.randomUUID?.() ?? `tr_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  let previous: string | undefined;
  try {
    previous = posthog.persistence?.props?.['trace_id'] as string | undefined;
  } catch {
    previous = undefined;
  }
  posthog.register({ trace_id: traceId });
  try {
    return await fn(traceId);
  } finally {
    if (previous) posthog.register({ trace_id: previous });
    else posthog.unregister('trace_id');
  }
}

/** Exposed for callers that need the active uid (e.g. per-uid localStorage keys). */
export function currentDistinctUid(): string | null {
  return currentUid;
}
