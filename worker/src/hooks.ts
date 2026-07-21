// Shared "consequential path" hooks (spec §27.4: every consequential code path
// emits a PostHog event via Q_ANALYTICS + an Analytics Engine point + a brain hook
// where the spec says so). Centralized so every phase wires observability the same
// way. All best-effort: a telemetry failure never breaks the user's request.
import type { Env } from "./types";
import { brainIngest } from "./lib/brain_ingest";
import { isBrainDomain, type BrainDomain } from "./lib/brain_domains";

const SERVICE = "avatok-api";

/** PostHog product/analytics event (batched via Q_ANALYTICS → consumer /batch).
 *  Every event carries the 5 required fields (§27.11): trace_id, user_id (uid),
 *  app_name, app_version, service_name. */
export function track(
  env: Env,
  uid: string,
  event: string,
  app_name: string,
  props: Record<string, unknown> = {},
  trace_id?: string,
): Promise<void> {
  try {
    // Return the send promise so callers can `ctx.waitUntil(...)` it. Without
    // that, an un-awaited send is cancelled when the response returns — which is
    // why server analytics (incl. signup_server) reached PostHog only sporadically.
    return env.Q_ANALYTICS.send({
      event,
      uid,
      ts: Date.now(),
      props: {
        ...props,
        trace_id: trace_id ?? crypto.randomUUID(),
        app_name,
        app: String(props.app ?? app_name),
        app_version: String(props.app_version ?? "server"),
        // Git commit SHA of the deployed Worker (set via `wrangler deploy --var
        // WORKER_RELEASE:<sha>`), 'dev' when unset → ties server errors/metrics to
        // the exact deploy, matching the client's `release` property.
        release: String(props.release ?? (env as any).WORKER_RELEASE ?? "dev"),
        service_name: SERVICE,
        // Envelope (ANALYTICS-OBSERVABILITY §1/§4): server-truth events are
        // distinguishable from client mirrors and join on the same account_id.
        worker: true,
        account_id: uid,
      },
    });
  } catch { /* best-effort */ }
  return Promise.resolve();
}

/**
 * Like [track], but stamps the user's raw [email] onto the event so support can
 * filter/pull events (especially errors) by email in PostHog. Email is added
 * both as a plain event property (`email`) AND as a `$set` person property, so
 * the PostHog person profile for this uid is populated server-side even if the
 * client never identified. Pass `email = null` to fall back to plain [track].
 */
export function trackUser(
  env: Env,
  uid: string,
  email: string | null | undefined,
  event: string,
  app_name: string,
  props: Record<string, unknown> = {},
  trace_id?: string,
): Promise<void> {
  return trackUserContact(env, uid, email, null, event, app_name, props, trace_id);
}

/**
 * Like [trackUser], but ALSO stamps the user's raw [phone] (E.164, when known)
 * onto the event so support can pull errors/telemetry by BOTH email AND phone in
 * PostHog. Each contact field is added as a plain event property (`email` /
 * `phone`) AND as a `$set` person property so the PostHog person profile for this
 * uid is populated server-side even if the client never identified. Pass `null`
 * for either field to omit it. Best-effort — never blocks the user's request.
 */
export function trackUserContact(
  env: Env,
  uid: string,
  email: string | null | undefined,
  phone: string | null | undefined,
  event: string,
  app_name: string,
  props: Record<string, unknown> = {},
  trace_id?: string,
): Promise<void> {
  const extra: Record<string, unknown> = {};
  const set: Record<string, unknown> = {};
  if (email) { extra.email = email; set.email = email; }
  if (phone) { extra.phone = phone; set.phone = phone; }
  if (!email && !phone) { return track(env, uid, event, app_name, props, trace_id); }
  const prevSet = (props.$set as Record<string, unknown> | undefined) ?? {};
  return track(env, uid, event, app_name, { ...props, ...extra, $set: { ...prevSet, ...set } }, trace_id);
}

/** Operational metric (Analytics Engine). */
export function metric(env: Env, name: string, doubles: number[], blobs: string[] = []): void {
  try { env.ANALYTICS?.writeDataPoint({ blobs: [name, ...blobs].slice(0, 20), doubles: doubles.slice(0, 20), indexes: [name.slice(0, 32)] }); } catch { /* best-effort */ }
}

// -- Secret scrub for server-side error text (SRV-ERR-TRACK-1) --------------
// Mirror the client's [Analytics._scrub]: strip anything that looks like a
// token/secret out of an exception message or stack BEFORE it leaves for
// PostHog, so a crashed request never leaks a bearer token, nsec, API key, or
// signed URL. Also caps length so one giant stack can't blow the event budget.
const _SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/nsec1[0-9a-z]+/gi, "[redacted]"],                                    // nostr private key
  [/(bearer\s+)[A-Za-z0-9._-]{10,}/gi, "$1[redacted]"],                  // Authorization: Bearer <jwt>
  [/\b(?:sk|rk|pk)_[A-Za-z0-9]{10,}/g, "[redacted]"],                    // stripe-style keys
  [/\bphc_[A-Za-z0-9]{20,}/g, "[redacted]"],                             // posthog project key
  [/eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+/g, "[redacted]"], // JWT
  [/([?&](?:token|key|sig|signature|secret|password|apikey)=)[^&\s"']+/gi, "$1[redacted]"],
];
function scrubServer(input: string): string {
  let s = input;
  for (const [re, rep] of _SECRET_PATTERNS) s = s.replace(re, rep);
  return s.length > 4000 ? `${s.slice(0, 4000)}...[truncated]` : s;
}

/**
 * [SRV-ERR-TRACK-1] Emit a server-side `$exception` so an uncaught Worker or
 * queue-consumer error becomes a grouped PostHog Error-Tracking Issue instead of
 * a silent Cloudflare 500. Payload mirrors the client schema (analytics.dart
 * `captureException`): the standard `$exception_list` PostHog fingerprints +
 * groups on, plus the flat `$exception_type`/`$exception_message` keys existing
 * HogQL queries already use. Best-effort; never throws.
 *
 * Returns the send promise so `fetch` callers can `ctx.waitUntil(...)` it -- an
 * un-awaited send is cancelled when the response returns (the same footgun the
 * `track` comment above calls out).
 */
export function trackException(
  env: Env,
  err: unknown,
  ctx: {
    uid?: string;
    route?: string;
    method?: string;
    trace_id?: string;
    handled?: boolean;   // false (default) = uncaught crash -> level:fatal; true = caught
    app_name?: string;
    extra?: Record<string, unknown>;
  } = {},
): Promise<void> {
  try {
    const e = err as { name?: string; message?: string; stack?: string } | null;
    const type =
      (e && e.name ? String(e.name) : undefined) ??
      (err as { constructor?: { name?: string } })?.constructor?.name ??
      "Error";
    const message = scrubServer(e && e.message != null ? String(e.message) : String(err));
    const stack = e && e.stack ? scrubServer(String(e.stack)) : undefined;
    const handled = ctx.handled ?? false;
    return track(
      env,
      ctx.uid && ctx.uid.length ? ctx.uid : "server",
      "$exception",
      ctx.app_name ?? "avatok",
      {
        // Standard PostHog error-tracking schema -> fingerprinted + grouped into an Issue.
        $exception_list: [
          {
            type,
            value: message,
            mechanism: { handled, synthetic: false },
            ...(stack
              ? { stacktrace: { type: "raw", frames: [{ platform: "node", raw: stack }] } }
              : {}),
          },
        ],
        $exception_level: handled ? "error" : "fatal",
        // Flat mirrors (kept for existing HogQL queries, matching the client).
        $exception_message: message,
        $exception_type: type,
        ...(stack ? { stack } : {}),
        ...(ctx.route ? { route: ctx.route } : {}),
        ...(ctx.method ? { method: ctx.method } : {}),
        is_fatal: !handled,
        ...(ctx.extra ?? {}),
      },
      ctx.trace_id,
    );
  } catch {
    /* best-effort: telemetry must never mask the original error */
  }
  return Promise.resolve();
}

/**
 * DEPRECATED shim — feed a derived fact to the brain. Kept so the remaining
 * legacy call sites keep compiling, but every event now flows through the ONE
 * ingestion contract (`brainIngest`): registry-resolved consent key + scope, a
 * consent check that FAILS CLOSED, and device_private rejection.
 *
 * The `domain` argument MUST be a registry domain (`BrainDomain`) — that is the
 * whole point: the old `source_app` fallback (which turned any string into an
 * unblockable pseudo-capability with no Settings toggle) is GONE. A call passing
 * a string that is not a registered domain is dropped at runtime (with telemetry)
 * rather than ingested under a toggle the user can never see.
 *
 * @deprecated Call `brainIngest(env, {...})` directly for new producers.
 */
export function brainFact(
  env: Env,
  uid: string,
  kind: string,
  domain: BrainDomain,
  payload?: Record<string, unknown>,
  sourceId?: string,
): void;
/**
 * @deprecated Legacy overload for call sites that still pass a non-registry app
 * string (e.g. 'avaid', 'avacalendar'). These are DROPPED at runtime — they were
 * only ever ingestible via the removed unblockable fallback. Migrate them to a
 * registry domain or delete the call.
 */
export function brainFact(
  env: Env,
  uid: string,
  kind: string,
  domain: string,
  payload?: Record<string, unknown>,
  sourceId?: string,
): void;
export function brainFact(
  env: Env,
  uid: string,
  kind: string,
  domain: string,
  payload: Record<string, unknown> = {},
  sourceId?: string,
): void {
  if (!isBrainDomain(domain)) {
    // The deleted fallback used to ingest this under an unblockable capability.
    try {
      metric(env, "brain_ingest_unknown_domain", [1], [String(domain), kind]);
      void track(env, uid, "ingest_dropped_unknown_domain", "avabrain", { domain, kind });
    } catch { /* best-effort */ }
    return;
  }
  void brainIngest(env, { uid, domain, kind, meta: payload, sourceId });
}
