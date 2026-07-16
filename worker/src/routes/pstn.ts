// worker/src/routes/pstn.ts — PSTN GATEWAY + VOICEMAIL execution mode
// (Canonical Architecture v1.0, Specs/PLAN-2026-07-16-ava-receptionist-
// guardian-FINAL.md — "Rollout inversion": V1 SHIPS VOICEMAIL FOR EVERYONE;
// the AI_AGENT execution mode is dark, no engine code exists in this repo).
//
// HARD RULE (plan §"Service boundaries" — "no import from voicemail code into
// engine code or vice versa"): this file imports NOTHING from any AI/
// receptionist engine module (reception_room.ts, reception_room_cf.ts,
// agent_voice_room.ts, …). Voicemail knows nothing about Gemini/Grok/prompts.
// Do NOT add such an import here.
//
// Every Vobiz-facing handler (answer/hangup/record-cb) is wrapped so a thrown
// error still returns a VALID XML/200 response — we never let our own bug
// drop a call (plan guardrail: "you never lose a call — worst case is
// voicemail, never busy").
//
// Vobiz sends application/x-www-form-urlencoded POSTs. Webhook auth is a long
// random secret as the trailing path segment (read from
// env.VOBIZ_WEBHOOK_SECRET when set; otherwise a fixed probe-grade constant —
// fine for the Phase-0 wiring probe, but production should set the real
// secret so the constant below is never relied on).
import type { Env } from "../types";
import { json, normalizePhone, sha256Hex } from "../util";
import { requireUser, isFail } from "../authz";
import { readConfig } from "./config";
import { matchAvatokPhones } from "./api";
import { verifyMissedcallDeviceToken } from "./missedcall";
import { metaDb } from "../db/shard";
import { CallState, ExecutionMode, PlatformEvent } from "../lib/platform_types";
import { contactFor } from "../lib/identity";
import { trackUserContact } from "../hooks";

// Probe-grade fallback — production deployments should `wrangler secret put
// VOBIZ_WEBHOOK_SECRET` and never rely on this constant being unknown.
const FALLBACK_WEBHOOK_SECRET = "vbz_p0_9f3e2c81aa774d54b6d0e51c7c2f4a68";
const STT_MODEL = "@cf/openai/whisper-large-v3-turbo";
const PROBE_TTL_SEC = 7 * 24 * 3600;      // 7 days
const SESSION_TTL_SEC = 3600;             // 1h — answer→record-cb correlation window
const EXPECT_TTL_SEC = 60;                // pre-registration window (AVA-RCPT-4 style)
const GREETING_KEY = "pstn/greetings/hi-en.mp3";
const PUBLIC_BASE = "https://api.avatok.ai";

function webhookSecret(env: Env): string {
  return env.VOBIZ_WEBHOOK_SECRET || FALLBACK_WEBHOOK_SECRET;
}

function xml(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/xml" } });
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Always-safe XML the caller hears if anything upstream throws — never dead
 *  air, never a dropped call, matches the plan's resilience guardrail even
 *  though the full record flow didn't run for this attempt. */
function safetyNetXml(): Response {
  return xml(
    `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    `<Speak>We're sorry, we're unable to take your call right now. Please try again later.</Speak>` +
    `<Hangup/></Response>`,
  );
}

async function parseForm(req: Request): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const text = await req.text();
    const params = new URLSearchParams(text);
    for (const [k, v] of params.entries()) out[k] = v;
  } catch { /* best-effort — empty fields, never throw */ }
  return out;
}

/** Best-effort probe capture — NEVER let a capture failure break the webhook
 *  (AVA-RCPT-0a). Stores the full payload (fields + headers) under
 *  `pstn_probe:<ISO ts>:<kind>:<CallUUID>`, TTL 7 days. */
async function captureProbe(env: Env, kind: string, callUuid: string, req: Request, fields: Record<string, string>): Promise<void> {
  try {
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => { headers[k] = v; });
    const key = `pstn_probe:${new Date().toISOString()}:${kind}:${callUuid || "unknown"}`;
    await env.TOKENS.put(key, JSON.stringify({ fields, headers }), { expirationTtl: PROBE_TTL_SEC });
  } catch { /* never break the webhook over a capture failure */ }
}

interface PstnSession {
  owner_uid: string | null;
  is_orphan: boolean;
  caller: string | null;
  trace_id: string;
  call_id: string;
  ts: number;
}

function sanitizeKey(s: string): string {
  return s.replace(/[^A-Za-z0-9_+.-]/g, "_");
}

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Resolve owner_uid from ForwardedFrom (primary — phone_hash lookup, reusing
 *  api.ts's matchAvatokPhones core, api.ts:1076) or a pending /expect
 *  pre-registration (secondary, matched by the CALLER's own number hash).
 *  Returns null when neither resolves — the caller falls to ORPHAN mode. */
async function resolveOwner(env: Env, forwardedFrom: string, callerFrom: string): Promise<{ owner_uid: string | null; owner_name: string | null }> {
  if (forwardedFrom) {
    try {
      const matches = await matchAvatokPhones(env, { numbers: [forwardedFrom] });
      if (matches.length > 0) return { owner_uid: matches[0].uid, owner_name: matches[0].name };
    } catch { /* fall through to expectation match */ }
  }
  if (callerFrom) {
    try {
      const hash = await sha256Hex(normalizePhone(callerFrom));
      const pending = await env.TOKENS.get(`pstn_expect:${hash}`, "json") as { owner_uid?: string } | null;
      if (pending?.owner_uid) return { owner_uid: pending.owner_uid, owner_name: null };
    } catch { /* fall through to ORPHAN */ }
  }
  // DIRECT-DIAL SELF-MAILBOX (2026-07-16, from live debugging): a call that
  // reaches the DID with NO ForwardedFrom and NO expectation is usually
  // someone dialing the voicemail line directly. If the CALLER's own number
  // maps to an AvaTOK account, deliver to THEIR inbox — i.e. "call your own
  // voicemail number" behaves like every carrier voicemail line, and owner
  // testing works without carrier forwarding. (Owner's 09:55 test call landed
  // ORPHAN for exactly this reason: direct call → no ForwardedFrom → nobody
  // to deliver to.)
  if (callerFrom) {
    try {
      const matches = await matchAvatokPhones(env, { numbers: [callerFrom] });
      if (matches.length > 0) return { owner_uid: matches[0].uid, owner_name: matches[0].name };
    } catch { /* fall through to ORPHAN */ }
  }
  // NOTE: hidden/withheld-caller anonymous expectation matching
  // (`pstn_expect:anon:<owner_uid>`) needs the owner already known to check —
  // which is circular for a truly anonymous incoming leg without
  // ForwardedFrom. Left as a documented v1 gap (plan §5c "Hidden/withheld
  // caller ID" — carrier ForwardedFrom is expected to still be present even
  // when the ORIGINAL caller's id is hidden, since it's a carrier-forwarding
  // header, not the caller's own CLI). Real-carrier verification is Phase 0.
  return { owner_uid: null, owner_name: null };
}

// ---------------------------------------------------------------------------
// POST /api/pstn/answer/<secret>
// ---------------------------------------------------------------------------
async function handleAnswer(req: Request, env: Env, secret: string): Promise<Response> {
  if (secret !== webhookSecret(env)) return xml(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`, 403);
  const fields = await parseForm(req);
  const callUuid = fields.CallUUID || "";
  await captureProbe(env, "answer", callUuid, req, fields);

  try {
    const cfg = await readConfig(env);
    const forwardedFrom = fields.ForwardedFrom || "";
    const callerFrom = fields.From || "";

    const resolved = cfg.pstnVoicemail === true
      ? await resolveOwner(env, forwardedFrom, callerFrom)
      : { owner_uid: null, owner_name: null }; // pure-probe mode: force ORPHAN regardless of resolution (safe dark)
    const isOrphan = !resolved.owner_uid;

    const callId = crypto.randomUUID();
    const traceId = crypto.randomUUID();
    const recordSec = Math.max(5, Math.round(Number(cfg.pstnVoicemailRecordSec) || 25));

    const session: PstnSession = {
      owner_uid: isOrphan ? null : resolved.owner_uid,
      is_orphan: isOrphan,
      caller: callerFrom || null,
      trace_id: traceId,
      call_id: callId,
      ts: Date.now(),
    };
    if (callUuid) {
      try { await env.TOKENS.put(`pstn_session:${callUuid}`, JSON.stringify(session), { expirationTtl: SESSION_TTL_SEC }); } catch { /* best-effort */ }
    }

    // Vobiz (Plivo-lineage) caches <Play> media BY URL STRING indefinitely —
    // re-uploading the same R2 key changes nothing for callers (learned
    // 2026-07-16: a re-mastered louder greeting kept playing as the original
    // quiet take). Version the URL with the R2 object's etag so every new
    // upload is a brand-new URL to Vobiz, while an unchanged file stays fully
    // cacheable on their side.
    let hasGreeting = false;
    let greetingVersion = "";
    try {
      const head = await env.BLOBS.head(GREETING_KEY);
      hasGreeting = !!head;
      greetingVersion = head?.httpEtag ? head.httpEtag.replace(/[^A-Za-z0-9]/g, "").slice(0, 16) : "";
    } catch { /* fall back to Speak */ }

    const greetingUrl = `${PUBLIC_BASE}/api/pstn/greeting/hi-en${greetingVersion ? `?v=${greetingVersion}` : ""}`;
    const recordCbUrl = `${PUBLIC_BASE}/api/pstn/record-cb/${encodeURIComponent(secret)}`;

    const introBlock = hasGreeting
      ? `<Play>${esc(greetingUrl)}</Play>`
      : `<Speak>${esc(
          resolved.owner_name
            ? `${resolved.owner_name} is not available. Please leave a message after the beep. You have ${recordSec} seconds.`
            : `The person you are calling is not available. Please leave a message after the beep. You have ${recordSec} seconds.`,
        )}</Speak>`;

    // [AVAVM-TRANSCRIPT-1, investigated 2026-07-16] Deliberately NOT setting
    // `transcriptionType`/`transcriptionUrl` here. Vobiz docs (xml/record
    // attributes) are explicit: "Transcription is available at an additional
    // cost" — it is a separately METERED add-on (see xml/record/start-
    // recording's transcription_charge/transcription_rate callback fields and
    // the dashboard Cost Analysis "Transcription" line item), not something
    // bundled free into the recording. The owner's ask was "if we're getting
    // it free from Vobiz, stop re-transcribing" — we are NOT getting it free,
    // so switching would trade one metered cost (Workers AI Whisper) for
    // another metered cost (Vobiz ASR) with no established rate comparison,
    // and would NOT satisfy the stated condition. We are also not currently
    // double-paying for the SAME transcript today: Vobiz is never asked to
    // transcribe, so only Whisper (below) ever runs. Keep Whisper as the sole
    // transcription source unless the owner explicitly signs off on a Vobiz
    // transcription cost comparison.
    const responseXml =
      `<?xml version="1.0" encoding="UTF-8"?><Response>${introBlock}` +
      `<Record maxLength="${recordSec}" timeout="3" playBeep="true" fileFormat="wav" ` +
      `callbackUrl="${esc(recordCbUrl)}" callbackMethod="POST"/>` +
      `<Speak>Thank you. Goodbye.</Speak><Hangup/></Response>`;

    return xml(responseXml);
  } catch {
    // Never drop the call over our own bug — safety-net voicemail-less hangup.
    return safetyNetXml();
  }
}

// ---------------------------------------------------------------------------
// POST /api/pstn/hangup/<secret>
// ---------------------------------------------------------------------------
async function handleHangup(req: Request, env: Env, secret: string): Promise<Response> {
  if (secret !== webhookSecret(env)) return xml(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`, 403);
  const fields = await parseForm(req);
  const callUuid = fields.CallUUID || "";
  await captureProbe(env, "hangup", callUuid, req, fields);

  try {
    if (callUuid) {
      const session = await env.TOKENS.get(`pstn_session:${callUuid}`, "json") as PstnSession | null;
      const billDuration = Number(fields.BillDuration ?? fields.Duration ?? 0) || 0;
      const cost = Number(fields.Cost ?? fields.TotalCost ?? 0) || null;
      try {
        await metaDb(env)
          .prepare(
            `INSERT INTO pstn_call_costs (call_uuid, owner_uid, trace_id, bill_duration, vobiz_cost, execution_mode, degraded, created_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7)
             ON CONFLICT(call_uuid) DO UPDATE SET bill_duration=excluded.bill_duration, vobiz_cost=excluded.vobiz_cost`,
          )
          .bind(
            callUuid,
            session?.owner_uid ?? null,
            session?.trace_id ?? null,
            billDuration,
            cost,
            ExecutionMode.VOICEMAIL,
            Date.now(),
          )
          .run();
      } catch { /* best-effort — cost accounting never blocks the webhook */ }

      // [Owner spec 2026-07-16] MISSED-CALL FALLBACK: caller hung up without a
      // recording landing (bailed during the greeting, or the 3s silence
      // cutoff closed an empty Record). The owner is STILL informed with a
      // text-only card. Vobiz sends record-cb BEFORE hangup when a recording
      // exists (observed live), but we wait 4s and re-check the delivered
      // marker anyway to close the race. client_id differs from the recording
      // card's (`pstn-missed:` vs `pstn:`) so a late recording card can never
      // be swallowed by idempotency — worst case (very slow record-cb) the
      // owner gets both cards, which is honest.
      const session2 = session;
      if (session2 && !session2.is_orphan && session2.owner_uid) {
        await new Promise((r) => setTimeout(r, 4000));
        const delivered = await env.TOKENS.get(`pstn_delivered:${callUuid}`).catch(() => null);
        if (!delivered) {
          try {
            const ownerUid = session2.owner_uid;
            const callerLabel = session2.caller || "Unknown caller";
            const callerKey = sanitizeKey(session2.caller || "unknown");
            const conv = `voicemail_${ownerUid}__${callerKey}`;
            const envelope = JSON.stringify({
              t: "voicemail",
              text: `📞 Missed call from ${callerLabel} — no voicemail recorded.`,
              session_id: session2.call_id, caller_uid: null, caller_name: null,
              caller_phone: session2.caller, call_id: session2.call_id,
              duration_s: null, transcript: "", has_recording: false, media_ref: null,
            });
            const stub = env.INBOX.get(env.INBOX.idFromName(ownerUid));
            await stub.fetch("https://inbox/append", {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({
                conv, sender: "ava_pstn", kind: "voicemail", body: envelope,
                media_ref: null, scope: `to:${ownerUid}`, created_at: Date.now(),
                owner: ownerUid, client_id: `pstn-missed:${callUuid}`,
              }),
            });
            try {
              await env.Q_PUSH.send({
                kind: "notify", to: ownerUid, fromName: callerLabel, title: "Missed call",
                body: `${callerLabel} called — no voicemail left`,
                data: { type: "voicemail", conv, caller_uid: null },
              });
            } catch { /* best-effort */ }
          } catch { /* best-effort — never fail the webhook */ }
        }
      }
    }
  } catch { /* best-effort */ }

  return xml(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
}

// ---------------------------------------------------------------------------
// POST /api/pstn/record-cb/<secret>
// ---------------------------------------------------------------------------
async function handleRecordCb(req: Request, env: Env, secret: string): Promise<Response> {
  if (secret !== webhookSecret(env)) return xml(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`, 403);
  const fields = await parseForm(req);
  const callUuid = fields.CallUUID || "";
  await captureProbe(env, "record-cb", callUuid, req, fields);

  try {
    const recordUrl = fields.RecordUrl || fields.RecordFile || "";
    const session = callUuid ? (await env.TOKENS.get(`pstn_session:${callUuid}`, "json") as PstnSession | null) : null;
    const isOrphan = !session || session.is_orphan || !session.owner_uid;

    if (!recordUrl) return xml(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);

    // [AVAVM-TRANSCRIPT-1] Idempotency guard — Vobiz callbacks can be retried.
    // `pstn_delivered:<CallUUID>` is set below once a voicemail card has been
    // posted for this call (the SAME marker the hangup handler already reads
    // for its missed-call fallback). Without this check, a retried record-cb
    // would re-fetch the WAV from Vobiz's media host AND re-run Whisper on the
    // identical recording — the InboxDO append is idempotent on client_id so no
    // duplicate CARD would appear, but we'd still pay for a second Whisper
    // transcription for nothing. Bail out before either the fetch or the STT
    // call.
    if (!isOrphan && callUuid) {
      const already = await env.TOKENS.get(`pstn_delivered:${callUuid}`).catch(() => null);
      if (already) {
        try {
          await env.Q_ANALYTICS.send({
            event: "pstn_voicemail_recordcb_dup_skipped", uid: session?.owner_uid ?? "unattributed", ts: Date.now(),
            props: { call_uuid: callUuid, trace_id: session?.trace_id ?? null },
          });
        } catch { /* best-effort */ }
        return xml(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
      }
    }

    // Vobiz's media host REQUIRES the account's X-Auth headers — an
    // unauthenticated fetch 401s (verified live 2026-07-16: the owner's first
    // delivered voicemail card had no audio AND no transcript because this
    // fetch silently failed). Secrets: `wrangler secret put VOBIZ_AUTH_ID /
    // VOBIZ_AUTH_TOKEN`.
    let wavBytes: Uint8Array | null = null;
    try {
      const headers: Record<string, string> = {};
      if (env.VOBIZ_AUTH_ID && env.VOBIZ_AUTH_TOKEN) {
        headers["X-Auth-ID"] = env.VOBIZ_AUTH_ID;
        headers["X-Auth-Token"] = env.VOBIZ_AUTH_TOKEN;
      }
      const r = await fetch(recordUrl, { headers });
      if (r.ok) wavBytes = new Uint8Array(await r.arrayBuffer());
    } catch { /* best-effort fetch — degraded delivery below */ }

    if (isOrphan) {
      // Orphan/probe path: store under pstn_orphan/, no owner, no inbox delivery.
      if (wavBytes) {
        try {
          await env.BLOBS.put(`pstn_orphan/${sanitizeKey(callUuid || crypto.randomUUID())}.wav`, wavBytes, {
            httpMetadata: { contentType: "audio/wav" },
          });
        } catch { /* best-effort */ }
      }
      // Orphans must be VISIBLE in telemetry (2026-07-16 debugging: an owner
      // test call vanished silently because only successful deliveries emitted
      // an event — PostHog had nothing to investigate with).
      try {
        const callerHash = session?.caller ? await sha256Hex(normalizePhone(session.caller)) : null;
        await env.Q_ANALYTICS.send({
          event: "pstn_orphan", uid: "unattributed", ts: Date.now(),
          props: { call_uuid: callUuid, caller_hash: callerHash, trace_id: session?.trace_id ?? null, state: CallState.ORPHAN },
        });
      } catch { /* best-effort */ }
      return xml(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
    }

    const ownerUid = session!.owner_uid as string;
    const callerKey = sanitizeKey(session!.caller || "unknown");
    const callId = session!.call_id || crypto.randomUUID();
    const traceId = session!.trace_id || crypto.randomUUID();

    let recordingKey: string | null = null;
    if (wavBytes) {
      try {
        recordingKey = `voicemail/${ownerUid}/${callerKey}/${callId}.wav`;
        await env.BLOBS.put(recordingKey, wavBytes, { httpMetadata: { contentType: "audio/wav" } });
      } catch { recordingKey = null; }
    }

    let transcript = "";
    if (wavBytes) {
      try {
        const out: unknown = await env.AI.run(STT_MODEL, { audio: b64encode(wavBytes) } as unknown as Record<string, unknown>);
        const o = out as { text?: string; transcription?: string } | null;
        transcript = String(o?.text ?? o?.transcription ?? "").trim();
      } catch { /* best-effort — envelope still lands without a transcript */ }
    }

    // InboxDO append — REUSES do/voicemail_room.ts's postVoicemail() envelope
    // shape exactly (kind:"voicemail", media_ref embedded in body too per
    // GAP-3, client_id idempotency, Q_PUSH notify shape) so the EXISTING
    // client VoicemailCard renders this without any client-side change.
    try {
      const callerLabel = session!.caller || "Unknown caller";
      const conv = `voicemail_${ownerUid}__${callerKey}`;
      // [AVAVM-TRANSCRIPT-1] SUMMARY LINE ONLY — mirrors do/voicemail_room.ts's
      // postVoicemail() fix. The raw transcript lives ONLY in envelope.transcript
      // below; `text` used to embed the full transcript too, which the client
      // rendered a second time as the expandable transcript block (the reported
      // double-transcript bug). See inbox_api.dart's InboxCard.fromRow for the
      // client-side defensive strip covering already-delivered envelopes.
      const bodyText = transcript
        ? `📞 Voicemail from ${callerLabel}`
        : `📞 Voicemail from ${callerLabel} (no transcript available)`;
      const envelope = JSON.stringify({
        t: "voicemail", text: bodyText, session_id: callId,
        caller_uid: null, caller_name: null, caller_phone: session!.caller,
        call_id: callId, duration_s: null, transcript, has_recording: !!recordingKey,
        media_ref: recordingKey,
      });
      const stub = env.INBOX.get(env.INBOX.idFromName(ownerUid));
      await stub.fetch("https://inbox/append", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conv, sender: "ava_pstn", kind: "voicemail", body: envelope,
          media_ref: recordingKey, scope: `to:${ownerUid}`, created_at: Date.now(),
          owner: ownerUid, client_id: `pstn:${callUuid}`,
        }),
      });

      // Mark the call delivered so the hangup handler's missed-call fallback
      // (below) knows a real voicemail card already landed for this CallUUID.
      try { await env.TOKENS.put(`pstn_delivered:${callUuid}`, "1", { expirationTtl: SESSION_TTL_SEC }); } catch { /* best-effort */ }

      try {
        await env.Q_PUSH.send({
          kind: "notify", to: ownerUid, fromName: callerLabel, title: "New voicemail",
          body: transcript ? transcript.slice(0, 140) : `${callerLabel} left you a voicemail`,
          data: { type: "voicemail", conv, caller_uid: null },
        });
      } catch { /* best-effort — push is an accelerator, InboxDO append is the record of truth */ }

      // [AVAVM-TRANSCRIPT-1] Cost-saving telemetry — proves whether Whisper ran
      // and what it cost us. transcript_source is always 'whisper'|'none' today
      // (Vobiz's native ASR is a paid add-on we deliberately don't request —
      // see the comment on the <Record> XML in handleAnswer); whisper_skipped
      // is always false on this path since the ONLY way to reach here is
      // having just run Whisper above. Tagged with the owner's email/phone
      // (via contactFor) so this is pullable from PostHog by contact, same as
      // voicemail_room.ts's telemetry.
      try {
        const contact = await contactFor(env, ownerUid).catch(() => ({ email: null, phone: null }));
        await trackUserContact(env, ownerUid, contact.email, contact.phone, "pstn_voicemail_transcribed", "pstn", {
          transcript_source: transcript ? "whisper" : "none",
          whisper_skipped: false,
          transcript_length: transcript.length,
          has_recording: !!recordingKey,
          call_id: callId,
          trace_id: traceId,
        }, traceId);
      } catch { /* best-effort */ }

      try {
        const callerHash = session!.caller ? await sha256Hex(normalizePhone(session!.caller)) : null;
        await env.Q_ANALYTICS.send({
          event: PlatformEvent.GuardianQueued, uid: ownerUid, ts: Date.now(),
          props: { pstn: true, trace_id: traceId, call_id: callId, caller_hash: callerHash, duration: null, state: CallState.GUARDIAN_QUEUED },
        });
      } catch { /* best-effort */ }
    } catch { /* InboxDO append is the source of truth — a failure here means the voicemail is lost for this call, but the webhook must still 200 to Vobiz */ }
  } catch { /* fully best-effort handler — never surface a 5xx to Vobiz */ }

  return xml(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
}

// ---------------------------------------------------------------------------
// GET /api/pstn/carrier-codes — public, no auth (dialing codes only, no
// secrets). Server-driven per-carrier MMI code table for the voicemail
// call-forwarding enable engine (app/lib/features/avadial/
// pstn_forwarding_setup.dart). ADDITIVE — the GSM-standard codes the client
// hardcodes today are the DEFAULTS below, so this endpoint's absence/failure
// changes nothing (the client falls back to those same literals byte-for-
// byte). Overrides live in KV TOKENS key `pstn_carrier_codes`, edited
// directly by ops via `scripts/cf.sh`-style deliberate KV writes — never a
// worker deploy — and matched by LONGEST mccmnc PREFIX so a broad entry
// ("405" — all of a country's operators on that MCC) and a narrow one
// ("405861" — one specific operator) can coexist; the narrower one wins.
// Missing/corrupt KV → pure defaults, never a thrown error (matches this
// file's "never break the caller" posture elsewhere).
// ---------------------------------------------------------------------------
interface PstnCarrierCodeSet {
  cfb_enable: string;
  cfnry_enable: string;
  cfnrc_enable: string;
  cfb_disable: string;
  cfnry_disable: string;
  cfnrc_disable: string;
  cfb_status: string;
  cfnry_status: string;
  cfnrc_status: string;
}

// GSM-standard call-forwarding MMI codes — EXACTLY what
// pstn_forwarding_setup.dart hardcodes today (PstnForwardKindX.enableCode/
// disableCode): *67*/*61*/*62* to enable (busy/no-reply/not-reachable),
// ##67#/##61#/##62# to disable. `{did}` is substituted with
// kPstnVoicemailDid client-side. *_status codes are the standard "check
// current forwarding number" USSD queries (not yet dialed by the client, but
// published for the settings screen's future status-check use).
const DEFAULT_CARRIER_CODES: PstnCarrierCodeSet = {
  cfb_enable: "*67*{did}#",
  cfnry_enable: "*61*{did}#",
  cfnrc_enable: "*62*{did}#",
  cfb_disable: "##67#",
  cfnry_disable: "##61#",
  cfnrc_disable: "##62#",
  cfb_status: "*#67#",
  cfnry_status: "*#61#",
  cfnrc_status: "*#62#",
};

const CARRIER_CODES_KV_KEY = "pstn_carrier_codes";
const CARRIER_CODES_TABLE_VERSION = 1;

async function handleCarrierCodes(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const mccmnc = (url.searchParams.get("mccmnc") || "").replace(/[^0-9]/g, "").slice(0, 15);
  const carrier = (url.searchParams.get("carrier") || "").slice(0, 100);

  let codes: PstnCarrierCodeSet = { ...DEFAULT_CARRIER_CODES };
  let source: "default" | "override" = "default";

  if (mccmnc) {
    try {
      const table = (await env.TOKENS.get(CARRIER_CODES_KV_KEY, "json")) as Record<
        string,
        Partial<PstnCarrierCodeSet>
      > | null;
      if (table && typeof table === "object") {
        // Longest-prefix match — a specific operator entry (e.g. "40586")
        // wins over a broader country/MCC entry (e.g. "405").
        let bestPrefix = "";
        for (const prefix of Object.keys(table)) {
          if (prefix && mccmnc.startsWith(prefix) && prefix.length > bestPrefix.length) {
            bestPrefix = prefix;
          }
        }
        if (bestPrefix) {
          const override = table[bestPrefix];
          if (override && typeof override === "object") {
            codes = { ...codes, ...override };
            source = "override";
          }
        }
      }
    } catch { /* corrupt/missing KV → pure defaults, never an error */ }
  }

  try {
    await env.Q_ANALYTICS.send({
      event: "pstn_carrier_codes_served",
      uid: "unattributed",
      ts: Date.now(),
      props: { mccmnc: mccmnc || null, carrier: carrier || null, source },
    });
  } catch { /* best-effort — telemetry never blocks the response */ }

  return json(
    { v: CARRIER_CODES_TABLE_VERSION, source, codes },
    200,
    { "cache-control": "public, max-age=300" },
  );
}

// ---------------------------------------------------------------------------
// GET /api/pstn/greeting/<lang> — public, no auth (just an audio file)
// ---------------------------------------------------------------------------
async function handleGreeting(env: Env, lang: string): Promise<Response> {
  const safeLang = lang.replace(/[^a-zA-Z0-9_-]/g, "");
  const key = `pstn/greetings/${safeLang}.mp3`;
  try {
    const obj = await env.BLOBS.get(key);
    if (!obj) return new Response("not found", { status: 404 });
    return new Response(obj.body, {
      headers: { "content-type": "audio/mpeg", "cache-control": "public, max-age=86400" },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

// ---------------------------------------------------------------------------
// POST /api/pstn/expect — app-side pre-registration (Flutter session auth).
// A native HMAC-token path (missedcall.ts pattern) is planned so this also
// works with the Flutter engine dead (cold-start reject); v1 uses the app's
// own Clerk session, matching the plan's documented v1 scope.
// ---------------------------------------------------------------------------
/** Shared by handleExpect (Clerk-session auth) and handleExpectNative
 *  (device-token auth) — writes the identical KV pre-registration record so
 *  both paths are indistinguishable to resolveOwner() at answer time. */
async function putExpectation(env: Env, uid: string, caller: string | undefined, anonymous: boolean | undefined): Promise<{ ok: true; mode: "anonymous" | "caller" } | { error: string; status: number }> {
  const ts = Date.now();
  if (anonymous === true) {
    await env.TOKENS.put(`pstn_expect:anon:${uid}`, JSON.stringify({ owner_uid: uid, ts }), { expirationTtl: EXPECT_TTL_SEC });
    return { ok: true, mode: "anonymous" };
  }
  const c = String(caller || "");
  if (!c) return { error: "caller_e164 or anonymous required", status: 400 };
  const hash = await sha256Hex(normalizePhone(c));
  await env.TOKENS.put(`pstn_expect:${hash}`, JSON.stringify({ owner_uid: uid, ts }), { expirationTtl: EXPECT_TTL_SEC });
  return { ok: true, mode: "caller" };
}

async function handleExpect(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const cfg = await readConfig(env);
  if (cfg.pstnVoicemail !== true) return json({ error: "disabled", flag: "pstnVoicemail" }, 503);

  const b = (await req.json().catch(() => ({}))) as { caller_e164?: string; anonymous?: boolean };
  const res = await putExpectation(env, ctx.uid, b.caller_e164, b.anonymous);
  if ("error" in res) return json({ error: res.error }, res.status);
  return json({ ok: true, mode: res.mode });
}

// ---------------------------------------------------------------------------
// POST /api/pstn/expect-native — device-token pre-registration (Kotlin lane).
// Fire-and-forget from the native side while the Flutter engine is dead (no
// Clerk session available), so auth here is the SAME long-lived HMAC device
// token minted by missedcall.ts's POST /api/missedcall/token, verified via
// verifyMissedcallDeviceToken (missedcall.ts's module-private verifyToken).
//
// SECURITY: an unauthenticated expectation write would let an attacker poison
// the caller→owner mapping (`pstn_expect:<hash>` / `pstn_expect:anon:<uid>`)
// and receive someone else's voicemails — so this endpoint is strictly
// token-or-nothing: no device_token, no write, 401. The worker's own
// ForwardedFrom-based resolution in resolveOwner() remains the fallback path
// when no pre-registration (native or app-side) exists at answer time.
// ---------------------------------------------------------------------------
async function handleExpectNative(req: Request, env: Env): Promise<Response> {
  const cfg = await readConfig(env);
  if (cfg.pstnVoicemail !== true) return json({ error: "disabled", flag: "pstnVoicemail" }, 503);

  const b = (await req.json().catch(() => ({}))) as { caller?: string | null; anonymous?: boolean; device_token?: string };
  const uid = await verifyMissedcallDeviceToken(env, b.device_token || "");
  if (!uid) return json({ error: "bad token" }, 401);

  const res = await putExpectation(env, uid, b.caller || undefined, b.anonymous);
  if ("error" in res) return json({ error: res.error }, res.status);
  return json({ ok: true, mode: res.mode });
}

// ---------------------------------------------------------------------------
// GET /api/pstn/dump/<secret> — engineering readback of recent probe capture.
// ---------------------------------------------------------------------------
async function handleDump(env: Env, secret: string): Promise<Response> {
  if (secret !== webhookSecret(env)) return json({ error: "forbidden" }, 403);
  try {
    const list = await env.TOKENS.list({ prefix: "pstn_probe:", limit: 100 });
    const entries: Array<{ key: string; value: unknown }> = [];
    for (const k of list.keys) {
      let value: unknown = null;
      try { value = await env.TOKENS.get(k.name, "json"); } catch { /* skip unparsable */ }
      entries.push({ key: k.name, value });
    }
    return json({ ok: true, count: entries.length, entries });
  } catch (e) {
    return json({ error: "dump failed", detail: String(e).slice(0, 200) }, 500);
  }
}

// ---------------------------------------------------------------------------
// Dispatcher — index.ts calls this for every path under /api/pstn/.
// ---------------------------------------------------------------------------
export async function pstnRoute(req: Request, env: Env, path: string): Promise<Response> {
  try {
    const rest = path.slice("/api/pstn/".length); // e.g. "answer/<secret>"
    const parts = rest.split("/").filter(Boolean);
    const kind = parts[0] || "";

    if (kind === "answer" && req.method === "POST") return await handleAnswer(req, env, decodeURIComponent(parts[1] || ""));
    if (kind === "hangup" && req.method === "POST") return await handleHangup(req, env, decodeURIComponent(parts[1] || ""));
    if (kind === "record-cb" && req.method === "POST") return await handleRecordCb(req, env, decodeURIComponent(parts[1] || ""));
    if (kind === "greeting" && req.method === "GET") return await handleGreeting(env, decodeURIComponent(parts[1] || ""));
    if (kind === "carrier-codes" && req.method === "GET") return await handleCarrierCodes(req, env);
    if (kind === "expect" && req.method === "POST") return await handleExpect(req, env);
    if (kind === "expect-native" && req.method === "POST") return await handleExpectNative(req, env);
    if (kind === "dump" && req.method === "GET") return await handleDump(env, decodeURIComponent(parts[1] || ""));

    return json({ error: "not found" }, 404);
  } catch {
    // Absolute last resort — a thrown error anywhere in dispatch must never
    // surface as a raw 5xx to Vobiz on a webhook path.
    if (path.startsWith("/api/pstn/answer/") || path.startsWith("/api/pstn/hangup/") || path.startsWith("/api/pstn/record-cb/")) {
      return safetyNetXml();
    }
    return json({ error: "internal error" }, 500);
  }
}
