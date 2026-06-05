// Shared "consequential path" hooks (spec §27.4: every consequential code path
// emits a PostHog event via Q_ANALYTICS + an Analytics Engine point + a brain hook
// where the spec says so). Centralized so every phase wires observability the same
// way. All best-effort: a telemetry failure never breaks the user's request.
import type { Env } from "./types";

const SERVICE = "avatok-api";

/** PostHog product/analytics event (batched via Q_ANALYTICS → consumer /batch).
 *  Every event carries the 5 required fields (§27.11): trace_id, user_id (npub),
 *  app_name, app_version, service_name. */
export function track(
  env: Env,
  npub: string,
  event: string,
  app_name: string,
  props: Record<string, unknown> = {},
  trace_id?: string,
): void {
  try {
    void env.Q_ANALYTICS.send({
      event,
      npub,
      ts: Date.now(),
      props: {
        ...props,
        trace_id: trace_id ?? crypto.randomUUID(),
        app_name,
        app_version: String(props.app_version ?? "server"),
        service_name: SERVICE,
      },
    });
  } catch { /* best-effort */ }
}

/** Operational metric (Analytics Engine). */
export function metric(env: Env, name: string, doubles: number[], blobs: string[] = []): void {
  try { env.ANALYTICS?.writeDataPoint({ blobs: [name, ...blobs].slice(0, 20), doubles: doubles.slice(0, 20), indexes: [name.slice(0, 32)] }); } catch { /* best-effort */ }
}

/** Feed a derived fact to the brain (Q_BRAIN → consumer → DB_BRAIN). Public/
 *  platform facts only — never DM plaintext. Scope defaults to 'public'. */
export function brainFact(
  env: Env,
  npub: string,
  event_type: string,
  source_app: string,
  payload: Record<string, unknown>,
  scope: "public" | "private" | string = "public",
): void {
  try { void env.Q_BRAIN.send({ npub, event_type, source_app, scope, payload }); } catch { /* best-effort */ }
}
