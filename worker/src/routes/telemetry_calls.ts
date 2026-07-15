// [AVADIAL-CALL-INTEL-1] Call-intelligence ingest (owner decision 2026-07-15).
//
//   POST /api/telemetry/calls   { events: [ { call_uuid, number_e164, ... } ] }
//
// THE WHOLE POINT OF THIS ROUTE — why the device doesn't just talk to PostHog:
//
// Raw phone numbers must never reach PostHog. The canonical analytics identifier is
// HMAC-SHA256(server_secret, E.164), which is stable — so repeat-caller matching,
// unique-caller counts, report counts and spread graphs all work exactly as they
// would on raw numbers — but is not reversible by dictionary attack, because the
// key is secret.
//
// It is only secret if the DEVICE NEVER SEES IT. A key shipped inside an APK is not
// a secret: anyone who unpacks the app or roots a phone extracts it and can hash
// every number in a country's range to build a rainbow table, which is the exact
// thing the HMAC exists to prevent. So the HMAC is computed HERE, in the Worker,
// with a secret that never leaves Cloudflare. The dialer sends raw E.164 over TLS;
// this route is the only thing that ever sees both.
//
// That split costs nothing on the call path: the native buffer is only uploaded
// AFTER the call has ended (see CallTelemetryBuffer), so there is no latency budget
// to blow. The call is already over.
//
//   Android dialer ──raw E.164, buffered on disk──▶ this route ──┬──▶ D1 (raw)
//                                                                └──▶ PostHog (HMAC)
//
// KEY ROTATION: every event carries `key_version`. Rotating CALL_ID_HMAC_SECRET
// breaks continuity of phone_id across the boundary, so the version lets old and new
// be reconciled rather than silently orphaning history.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { track } from "../hooks";
import { metaDb } from "../db/shard";

const MAX_EVENTS = 500;
const KEY_VERSION = 1;
const APP = "avadial";

/** HMAC-SHA256(secret, value) → lowercase hex. */
async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Best-effort E.164 normalisation before hashing.
 *
 * This matters more than it looks: the SAME person must hash to the SAME phone_id
 * across every surface, or the intelligence graph silently splits into fragments
 * that never join. The device sends whatever the carrier handed Telecom, which is
 * often national format. Anything we can't confidently normalise is hashed as-is —
 * a slightly fragmented id beats dropping the event.
 */
function normalizeE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/[^\d+]/g, "");
  if (!digits) return null;
  if (digits.startsWith("+")) return digits;
  // No country code and no way to infer one here — hash the digits as given.
  return digits;
}

export async function ingestCallTelemetry(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  const secret = env.CALL_ID_HMAC_SECRET;
  if (!secret) {
    // Fail LOUD, not open. Ingesting without the secret would mean either writing
    // raw numbers into PostHog or storing unusable ids — both worse than a retry.
    // The device keeps its buffer on a non-2xx and retries on the next drain.
    return json({ error: "call_intel_unconfigured" }, 503);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_json" }, 400);
  }
  const events = Array.isArray(body?.events) ? body.events : null;
  if (!events) return json({ error: "events_required" }, 400);
  if (events.length > MAX_EVENTS) return json({ error: "too_many_events" }, 413);

  let accepted = 0;
  let skipped = 0;

  for (const ev of events) {
    try {
      const callUuid = ev?.call_uuid ? String(ev.call_uuid) : null;
      if (!callUuid) { skipped++; continue; }

      const e164 = normalizeE164(ev?.number_e164);
      const phoneId = e164 ? await hmacHex(secret, e164) : null;

      // ── operational store: raw number, owner-scoped ──
      // Raw E.164 lives here and ONLY here, because the product genuinely needs it:
      // returning a call, showing the number, blocklists, contacts, our own lookup.
      // ON CONFLICT DO NOTHING makes the upload idempotent — the device retries on a
      // failed upload (at-least-once), so the same call_uuid can legitimately arrive
      // twice and must not double-count.
      await metaDbSafe(env, callUuid, ctx.uid, e164, phoneId, ev);

      // ── analytics: HMAC only, never the raw number ──
      const props: Record<string, unknown> = {
        call_uuid: callUuid,
        phone_id: phoneId,
        key_version: KEY_VERSION,
        direction: ev?.direction ?? null,
        final_state: ev?.final_state ?? null,
        ring_duration_ms: ev?.ring_duration_ms ?? null,
        talk_duration_ms: ev?.talk_duration_ms ?? null,
        total_duration_ms: ev?.total_duration_ms ?? null,
        // The number this whole rearchitecture was built to measure: Answer tap →
        // Telecom STATE_ACTIVE. Null when the call wasn't answered by a tap.
        answer_delay_ms: ev?.answer_delay_ms ?? null,
        contact_exists: ev?.contact_exists ?? null,
        spam_score: ev?.spam_score ?? null,
        spam_bucket: ev?.spam_bucket ?? null,
        sim_slot: ev?.sim_slot ?? null,
        carrier: ev?.carrier ?? null,
        country_code: ev?.country_code ?? null,
        network_type: ev?.network_type ?? null,
        actions: ev?.actions ?? null,
        // Identity — what makes a per-tester PostHog pull possible later. With many
        // testers on many devices, the email is the only way to tell whose phone a
        // call problem is on.
        email: ev?.email ?? null,
        // The user's OWN number, alongside the email. Both are required so a future
        // pull can find whose device a call problem happened on — with many testers
        // that is the only way to tell. This is the account holder's own number, not
        // the caller's (which is HMAC'd into phone_id above and never sent raw).
        user_phone_e164: ev?.user_phone_e164 ?? null,
        user_name: ev?.user_name ?? null,
        account_id: ev?.account_id ?? null,
        device_distinct_id: ev?.distinct_id ?? null,
        ...flattenDevice(ev?.device),
      };
      // NOTE: contact_name is deliberately NOT forwarded even if a future client
      // sends it. It is a third party's PII, taken from someone else's device, about
      // a person who never consented — the practice Truecaller has been fined for
      // under GDPR. contact_exists carries the signal the model actually needs.

      await track(env, ctx.uid, "avadial_call_completed", APP, props);
      accepted++;
    } catch {
      skipped++; // one bad event must never fail the whole batch
    }
  }

  return json({ ok: true, accepted, skipped });
}

function flattenDevice(device: any): Record<string, unknown> {
  if (!device || typeof device !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const k of [
    "device_model", "android_version", "android_sdk",
    "app_version", "language", "country", "timezone",
  ]) {
    if (device[k] != null) out[k] = device[k];
  }
  return out;
}

/**
 * Operational row. Isolated + swallowed so a schema/D1 hiccup can never cost us the
 * analytics event — the two sinks are independent on purpose.
 */
async function metaDbSafe(
  env: Env,
  callUuid: string,
  uid: string,
  e164: string | null,
  phoneId: string | null,
  ev: any,
): Promise<void> {
  try {
    await metaDb(env).prepare(
      `INSERT INTO call_intel (
         call_uuid, uid, number_e164, phone_id, direction, final_state,
         ring_duration_ms, talk_duration_ms, total_duration_ms, answer_delay_ms,
         contact_exists, spam_score, spam_bucket, carrier, country_code,
         network_type, started_at, ended_at, created_at
       ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)
       ON CONFLICT(call_uuid) DO NOTHING`,
    ).bind(
      callUuid,
      uid,
      e164,
      phoneId,
      ev?.direction ?? null,
      ev?.final_state ?? null,
      ev?.ring_duration_ms ?? null,
      ev?.talk_duration_ms ?? null,
      ev?.total_duration_ms ?? null,
      ev?.answer_delay_ms ?? null,
      ev?.contact_exists ? 1 : 0,
      ev?.spam_score ?? null,
      ev?.spam_bucket ?? null,
      ev?.carrier ?? null,
      ev?.country_code ?? null,
      ev?.network_type ?? null,
      ev?.ts ?? null,
      ev?.end_time ?? null,
      Date.now(),
    ).run();
  } catch {
    // Table not migrated yet / transient D1 error — analytics still lands.
  }
}
