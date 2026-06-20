// Shared "consequential path" hooks (spec §27.4: every consequential code path
// emits a PostHog event via Q_ANALYTICS + an Analytics Engine point + a brain hook
// where the spec says so). Centralized so every phase wires observability the same
// way. All best-effort: a telemetry failure never breaks the user's request.
import type { Env } from "./types";

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
): void {
  try {
    void env.Q_ANALYTICS.send({
      event,
      uid,
      ts: Date.now(),
      props: {
        ...props,
        trace_id: trace_id ?? crypto.randomUUID(),
        app_name,
        app: String(props.app ?? app_name),
        app_version: String(props.app_version ?? "server"),
        service_name: SERVICE,
        // Envelope (ANALYTICS-OBSERVABILITY §1/§4): server-truth events are
        // distinguishable from client mirrors and join on the same account_id.
        worker: true,
        account_id: uid,
      },
    });
  } catch { /* best-effort */ }
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
): void {
  trackUserContact(env, uid, email, null, event, app_name, props, trace_id);
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
): void {
  const extra: Record<string, unknown> = {};
  const set: Record<string, unknown> = {};
  if (email) { extra.email = email; set.email = email; }
  if (phone) { extra.phone = phone; set.phone = phone; }
  if (!email && !phone) { track(env, uid, event, app_name, props, trace_id); return; }
  const prevSet = (props.$set as Record<string, unknown> | undefined) ?? {};
  track(env, uid, event, app_name, { ...props, ...extra, $set: { ...prevSet, ...set } }, trace_id);
}

/** Operational metric (Analytics Engine). */
export function metric(env: Env, name: string, doubles: number[], blobs: string[] = []): void {
  try { env.ANALYTICS?.writeDataPoint({ blobs: [name, ...blobs].slice(0, 20), doubles: doubles.slice(0, 20), indexes: [name.slice(0, 32)] }); } catch { /* best-effort */ }
}

/** Feed a derived fact to the brain (Q_BRAIN → consumer → DB_BRAIN). Public/
 *  platform facts only — never DM plaintext. Scope defaults to 'public'. */
export function brainFact(
  env: Env,
  uid: string,
  event_type: string,
  source_app: string,
  payload: Record<string, unknown>,
  scope: "public" | "private" | string = "public",
): void {
  try { void env.Q_BRAIN.send({ uid, event_type, source_app, scope, payload }); } catch { /* best-effort */ }
}
