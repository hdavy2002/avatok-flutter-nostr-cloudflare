// presence.ts — [CALL-PRESENCE-1 2026-08-07]
//
// POST /api/presence/beat — the device says "I'm here".
//
// This is the cheapest authenticated endpoint in the Worker and it must stay
// that way: it runs every `presenceHeartbeatSec` (25 s) on every connected
// device. NO D1. NO Durable Object. One Upstash SET, and nothing else on the
// response path — the identity resolution that stamps email/phone onto the
// telemetry (per CLAUDE.md) is deliberately pushed into `waitUntil` so a beat
// never costs a D1 read.
//
// Why a heartbeat needs its own endpoint at all: the client already pings the
// InboxDO socket every 25 s, but [WS-AUTORESP-1] has the runtime answer that ping
// WITHOUT waking the DO (~3,456 avoided wakes/day/user). That is the right
// design and we are not undoing it — so the ping proves liveness to the socket
// and to nobody else. This endpoint is where "I'm here" becomes a fact the call
// path can read in one lookup.

import type { Env } from "../types";
import { json } from "../util";
import { isFail, requireUser } from "../authz";
import { readConfig } from "./config";
import { writePresence, type PresenceRecord } from "../lib/presence";
import { trackUserContact } from "../hooks";
import { emailFor, phoneFor } from "../lib/identity";

/** Beat sources the client is expected to send. Anything else is kept but capped. */
const MAX_FIELD = 32;

function clean(v: unknown, fallback: string): string {
  const s = String(v ?? "").trim().slice(0, MAX_FIELD);
  return s || fallback;
}

export async function presenceBeat(req: Request, env: Env, execCtx?: ExecutionContext): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as {
    source?: string; app_state?: string; device_id?: string; ms_since_last?: number;
  };

  const cfg = await readConfig(env).catch(() => null);
  const freshSec = Number((cfg as { presenceFreshSec?: number } | null)?.presenceFreshSec ?? 90);
  const heartbeatSec = Number((cfg as { presenceHeartbeatSec?: number } | null)?.presenceHeartbeatSec ?? 25);

  const rec: PresenceRecord = {
    // SERVER-stamped. A device clock that is wrong by hours would otherwise be
    // able to declare itself permanently fresh (or permanently offline).
    lastSeenMs: Date.now(),
    source: clean(b.source, "ping"),
    appState: clean(b.app_state, "unknown"),
    deviceId: String(b.device_id ?? "").trim().slice(0, 128),
  };
  // The ONE await on the response path.
  await writePresence(env, ctx.uid, rec, freshSec);

  // Identity-stamped telemetry, entirely off the response path. `ms_since_last`
  // comes from the device (it is the only party that knows when IT last beat) —
  // a gap far larger than presenceHeartbeatSec is the signal that the phone is
  // being dozed, which is exactly the population `/api/call` will later see as
  // `presence:'stale'` with a live FCM token.
  const beatTelemetry = (async () => {
    try {
      const [email, phone] = await Promise.all([
        emailFor(env, ctx.uid).catch(() => null),
        phoneFor(env, ctx.uid).catch(() => null),
      ]);
      await trackUserContact(env, ctx.uid, email, phone, "presence_beat", "avatok", {
        source: rec.source,
        app_state: rec.appState,
        ms_since_last: Number.isFinite(Number(b.ms_since_last)) ? Number(b.ms_since_last) : null,
        device_id: rec.deviceId || null,
        fresh_sec: freshSec,
        heartbeat_sec: heartbeatSec,
        app_name: "avatok", service_name: "avatok-api", worker: true,
      });
    } catch { /* a beat must never fail because telemetry did */ }
  })();
  // workerd DROPS an unawaited promise once the response is returned. Without one
  // of these two branches `presence_beat` would silently never arrive — the exact
  // failure recorded in the worker-error-path-telemetry note in CLAUDE.md.
  if (execCtx) execCtx.waitUntil(beatTelemetry); else await beatTelemetry;

  // Echo the cadence so the device can retune without waiting for its own
  // RemoteConfig poll (~15 min) after a KV flip.
  return json({ ok: true, heartbeat_sec: heartbeatSec, fresh_sec: freshSec });
}
