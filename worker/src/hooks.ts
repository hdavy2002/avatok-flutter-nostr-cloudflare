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
