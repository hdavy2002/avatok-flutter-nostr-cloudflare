// [CALL-TRANSLATE-1] Paid 1:1 call translation control plane.
//
// This is deliberately separate from routes/translate.ts. That route serves
// marketplace/consult/live translation and has different prepaid semantics.
// Call translation is pay-as-you-go, one minute at a time, and is never made
// free by betaFreePremium or subscription entitlements.
import type { Env } from "../types";
import { requireUser, isFail } from "../authz";
import { readConfig } from "./config";
import { metaDb } from "../db/shard";
import { walletOp } from "./wallet";
import { acctUser, ACCT_PLATFORM_FEES } from "../ledger";
import { json } from "../util";
import { track } from "../hooks";
import { rateLimit } from "../money";

export const CALL_TRANSLATION_MODEL = "gemini-3.5-live-translate-preview";
export const CALL_TRANSLATION_RATE = 5;
export const CALL_TRANSLATION_MIN_START = 5;
// Android's host bridge attaches to flutter_webrtc's decoded-playback callback;
// it never opens a second microphone capture and never sends PCM via CallRoom.
export const CALL_TRANSLATION_SOURCE_BRIDGE_ENABLED = true;
const SOURCE_LEASE_MS = 90_000;
const APP = "avatok_call_translation";
// [CALL-TRANSLATE-2A-2] A row left in 'activating' beyond this is a crash-retry
// casualty, not a live activation: minute one's deterministic op id proves the
// money already moved, so the row is repaired forward instead of stranding a
// payer who was charged. Kept short — the whole activate path is sub-second.
const ACTIVATING_STUCK_MS = 15_000;

// Keep this list server-owned. The client mirrors it for the picker, but the
// Worker is authoritative and rejects unknown BCP-47 values.
export const CALL_TRANSLATION_LANGS = new Set([
  "af","ak","sq","am","ar","hy","az","eu","be","bn","bg","my","ca","zh-Hans","zh-Hant","hr","cs","da","nl","en","et","fil","fi","fr","gl","ka","de","el","gu","ha","he","hi","hu","is","id","it","ja","jv","kn","kk","km","rw","ko","lo","lv","lt","mk","ms","ml","mr","mn","ne","no","nb","fa","pl","pt-BR","pt-PT","pa","ro","ru","sr","sd","si","sk","sl","es","su","sw","sv","ta","te","th","tr","uk","ur","uz","vi","zu",
]);

type CallSession = {
  id: string; payer_uid: string; call_ref: string; target_lang: string;
  source_lease: string; status: string; started_at: number | null;
  last_billed_minute: number; billed_tokens: number; updated_at: number;
  // [CALL-TRANSLATE-2B-3] Device-scoped binding for provider tokens. NULL for
  // sessions created by clients from before the nonce shipped.
  device_nonce: string | null;
};

// [CALL-TRANSLATE-2B-3] Opaque client-generated value; the Worker only ever
// compares it, never interprets it. Bounded so it cannot be used as storage.
const DEVICE_NONCE_RE = /^[A-Za-z0-9_.:-]{8,128}$/;

function readNonce(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length ? s : null;
}

/**
 * [CALL-TRANSLATE-2B-3] Token issuance is bound to the session row AND to the
 * device that created it.
 *
 * The nonce is OPTIONAL for one release cycle: a request that omits it is
 * accepted (existing builds send nothing), and a session created without one
 * can never mismatch. It is enforced the moment BOTH sides carry a value — that
 * is what stops a token minted for one device being refreshed from another.
 * Tighten to mandatory once no pre-nonce build is in the field.
 */
function nonceRejected(s: CallSession, supplied: unknown): boolean {
  const got = readNonce(supplied);
  if (!got || !s.device_nonce) return false;
  return got !== s.device_nonce;
}

async function load(env: Env, id: string): Promise<CallSession | null> {
  return await metaDb(env).prepare("SELECT * FROM translation_call_sessions WHERE id=?1").bind(id).first<CallSession>();
}

/** Prove the ref is the exact active 1:1 CallRoom, not an arbitrary string. */
async function participantInActiveCall(env: Env, callRef: string, uid: string): Promise<boolean> {
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(callRef)) return false;
  try {
    const stub = env.CALL_ROOMS.get(env.CALL_ROOMS.idFromName(callRef));
    const p = await stub.fetch(new Request("https://call-room/participants?callId=" + encodeURIComponent(callRef)));
    if (!p.ok) return false;
    const participants = await p.json() as { ok?: boolean; callerUid?: string; calleeUid?: string };
    if (!participants.ok || (participants.callerUid !== uid && participants.calleeUid !== uid)) return false;
    const s = await stub.fetch(new Request("https://call-room/session?callId=" + encodeURIComponent(callRef)));
    if (!s.ok) return false;
    const session = await s.json() as { session?: { session_state?: string; terminal?: boolean } };
    if (!session.session) return false;
    const state = String(session.session.session_state ?? "");
    return !session.session.terminal && state === "connected";
  } catch {
    return false;
  }
}

async function balance(env: Env, uid: string): Promise<number> {
  const r = await walletOp(env, uid, { op: "balance", uid });
  return Number(r.body?.balance ?? 0);
}

async function chargeMinute(env: Env, s: CallSession, minute: number): Promise<boolean> {
  const r = await walletOp(env, s.payer_uid, {
    op: "spend", uid: s.payer_uid, amount: CALL_TRANSLATION_RATE, type: "spend",
    app_name: APP, ref: s.id, op_id: `call-translation:${s.id}:minute:${minute}`,
    ledger: {
      debit: acctUser(s.payer_uid), credit: ACCT_PLATFORM_FEES,
      type: "translation_fee", ref: s.id,
      meta: JSON.stringify({ title: `Call translation (${s.target_lang})`, minute, rate_per_min: CALL_TRANSLATION_RATE, call_ref: s.call_ref }),
    },
  });
  return r.status === 200;
}

async function mintToken(env: Env, targetLang: string): Promise<{ token: string; expiresAt: number } | null> {
  if (!env.GEMINI_API_KEY) return null;
  const expiresAt = Date.now() + 30 * 60_000;
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/auth_tokens", {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({
      uses: 1, expireTime: new Date(expiresAt).toISOString(),
      liveConnectConstraints: {
        model: `models/${CALL_TRANSLATION_MODEL}`,
        config: {
          // [CALL-TRANSLATE-2A-1] Captions are deferred (owner). Transcription is
          // deliberately NOT requested here: the token constraints and the native
          // setup JSON must agree, and no transcript text may ever leave the
          // provider session for this feature.
          responseModalities: ["AUDIO"],
          translationConfig: { targetLanguageCode: targetLang, echoTargetLanguage: false },
          sessionResumption: {},
          contextWindowCompression: { slidingWindow: {} },
        },
      },
    }),
  });
  const body = await response.json().catch(() => ({})) as { name?: string };
  return response.ok && body.name ? { token: body.name, expiresAt } : null;
}

/** Awaited on purpose: workerd cancels un-awaited sends on early-return paths. */
async function nonceRejection(env: Env, s: CallSession, route: string): Promise<Response> {
  await track(env, s.payer_uid, "call_translation_nonce_mismatch", APP, {
    session_id: s.id, call_ref: s.call_ref, route,
  });
  return json({ error: "device_nonce_mismatch", billable: false }, 403);
}

/**
 * [CALL-TRANSLATE-2B-4] The out-of-funds wire contract for call translation.
 *
 * The canonical key is now `insufficient_tokens` (owner: the currency is Tokens,
 * not coins). `error_legacy` carries the previous spelling for ONE release cycle
 * so any build that string-matches `insufficient_avacoins` keeps working; the
 * HTTP status stays 402, which is what the current Dart client actually branches
 * on. Delete `error_legacy` once no pre-rename build is in the field.
 */
function insufficientTokens(extra: Record<string, unknown> = {}): Response {
  return json({
    error: "insufficient_tokens",
    error_legacy: "insufficient_avacoins",
    ...extra,
  }, 402);
}

function authError(ctx: unknown): Response {
  return json({ error: (ctx as { error: string }).error }, (ctx as { status: number }).status);
}

/**
 * [CALL-TRANSLATE-2A-2] Post-charge reconciliation for the activate race.
 *
 * `chargeMinute` is keyed on the deterministic op id `call-translation:<sid>:minute:1`,
 * so the debit can never be applied twice however many times activate is retried.
 * The only thing that can actually race is the row UPDATE. Once money has moved we
 * therefore never return an opaque 409 that the client reads as "charged, no
 * translation" — we converge the row and answer 200.
 */
async function reconcileActivating(env: Env, id: string): Promise<Response> {
  const fresh = await load(env, id);
  if (!fresh) return json({ error: "not found" }, 404);
  if (fresh.status === "active") {
    return json({
      ok: true, billed_minute: Math.max(1, fresh.last_billed_minute),
      rate_per_min: CALL_TRANSLATION_RATE, reconciled: "already_active",
    });
  }
  if (fresh.status === "activating" && Date.now() - fresh.updated_at > ACTIVATING_STUCK_MS) {
    const now = Date.now();
    await metaDb(env).prepare(
      `UPDATE translation_call_sessions
          SET status='active', started_at=COALESCE(started_at,?2),
              last_billed_minute=MAX(last_billed_minute,1),
              billed_tokens=MAX(billed_tokens,?3), updated_at=?2
        WHERE id=?1 AND status='activating'`,
    ).bind(id, now, CALL_TRANSLATION_RATE).run();
    const repaired = await load(env, id);
    if (repaired && repaired.status === "active") {
      await track(env, repaired.payer_uid, "call_translation_activation_repaired", APP, {
        session_id: id, call_ref: repaired.call_ref, stuck_ms: now - fresh.updated_at,
      });
      return json({
        ok: true, billed_minute: Math.max(1, repaired.last_billed_minute),
        rate_per_min: CALL_TRANSLATION_RATE, reconciled: "repaired",
      });
    }
  }
  if (fresh.status === "stopped" || fresh.status === "funds-stopped" || fresh.status === "provider-stopped") {
    return json({ error: fresh.status, billable: true }, 409);
  }
  // Still genuinely in flight (another attempt is inside its own charge). The
  // client retries this exact call; it is idempotent by construction.
  return json({ error: "activation_in_progress", billable: true, retry_after_ms: 750 }, 409);
}

/** Create an unbilled pending session. The source-ready activation is the paid boundary. */
export async function callTranslationStart(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return authError(ctx);
  const cfg = await readConfig(env);
  if (!cfg.translationEnabled || !cfg.callTranslationEnabled) return json({ error: "call translation disabled" }, 503);
  const b = await req.json().catch(() => ({})) as Record<string, unknown>;
  const callRef = String(b.call_ref ?? "");
  const lang = String(b.target_lang ?? "");
  // This is a capability assertion, not a fallback. The native same-capture tap
  // must provide this exact capability before a provider token can be used.
  if (!CALL_TRANSLATION_SOURCE_BRIDGE_ENABLED || b.source_capability !== "webrtc_same_capture_pcm16_v1") return json({ error: "source_capture_unavailable", billable: false }, 412);
  if (!CALL_TRANSLATION_LANGS.has(lang)) return json({ error: "unsupported target_lang", lang }, 400);
  const deviceNonce = readNonce(b.device_nonce);
  if (deviceNonce && !DEVICE_NONCE_RE.test(deviceNonce)) return json({ error: "invalid_device_nonce", billable: false }, 400);
  if (!(await participantInActiveCall(env, callRef, ctx.uid))) return json({ error: "not an active 1:1 call" }, 403);
  const limited = await rateLimit(env, `call-trl:${ctx.uid}`, 10, 3600);
  if (limited) return limited;
  const existing = await metaDb(env).prepare("SELECT id FROM translation_call_sessions WHERE payer_uid=?1 AND call_ref=?2 AND status IN ('pending','activating','active') LIMIT 1").bind(ctx.uid, callRef).first<{ id: string }>();
  if (existing) return json({ error: "translation already active", session_id: existing.id }, 409);
  const bal = await balance(env, ctx.uid);
  if (bal < CALL_TRANSLATION_MIN_START) return insufficientTokens({ needed: CALL_TRANSLATION_MIN_START, balance: bal });
  const now = Date.now();
  const id = crypto.randomUUID();
  const lease = crypto.randomUUID();
  // Provision the constrained provider session before the paid boundary. The
  // Android bridge must receive setupComplete before it calls /activate.
  const token = await mintToken(env, lang);
  if (!token) return json({ error: "provider_unavailable", billable: false }, 502);
  try {
    await metaDb(env).prepare(
      `INSERT INTO translation_call_sessions (id,payer_uid,call_ref,target_lang,source_lease,status,started_at,last_billed_minute,billed_tokens,updated_at,device_nonce)
       VALUES (?1,?2,?3,?4,?5,'pending',NULL,0,0,?6,?7)`,
    ).bind(id, ctx.uid, callRef, lang, lease, now, deviceNonce).run();
  } catch {
    const winner = await metaDb(env).prepare("SELECT id FROM translation_call_sessions WHERE payer_uid=?1 AND call_ref=?2 AND status IN ('pending','activating','active') LIMIT 1").bind(ctx.uid, callRef).first<{ id: string }>();
    return json({ error: "translation already active", session_id: winner?.id }, 409);
  }
  track(env, ctx.uid, "call_translation_start_ready", APP, { call_ref: callRef, language: lang });
  return json({
    ok: true,
    session_id: id,
    source_lease: lease,
    token: token.token,
    token_expires_at: token.expiresAt,
    model: CALL_TRANSLATION_MODEL,
    rate_per_min: CALL_TRANSLATION_RATE,
    balance: bal,
    // Tells the client whether this session is nonce-bound, so it knows to send
    // the same value back on activate/renew/token/language.
    device_bound: deviceNonce !== null,
  });
}

/** Activate and debit minute one only after the peer/source lane is ready. */
export async function callTranslationActivate(req: Request, env: Env, id: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return authError(ctx);
  const s = await load(env, id);
  if (!s || s.payer_uid !== ctx.uid) return json({ error: "not found" }, 404);
  if (s.status === "active") return json({ ok: true, billed_minute: s.last_billed_minute, rate_per_min: CALL_TRANSLATION_RATE });
  if (s.status !== "pending" && s.status !== "activating") return json({ error: s.status }, 409);
  const b = await req.json().catch(() => ({})) as Record<string, unknown>;
  if (nonceRejected(s, b.device_nonce)) return await nonceRejection(env, s, "activate");
  if (b.source_lease !== s.source_lease || b.source_ready !== true || Date.now() - s.updated_at > SOURCE_LEASE_MS) return json({ error: "source_not_ready", billable: false }, 412);
  if (!(await participantInActiveCall(env, s.call_ref, ctx.uid))) return json({ error: "call_ended_or_source_invalid", billable: false }, 409);
  if (s.status === "pending") {
    const claimed = await metaDb(env).prepare("UPDATE translation_call_sessions SET status='activating',updated_at=?2 WHERE id=?1 AND status='pending'").bind(id, Date.now()).run();
    if (claimed.meta.changes !== 1) {
      // Pre-charge race: a concurrent retry claimed it. If that retry already
      // finished, this attempt is an idempotent success rather than a failure.
      const fresh = await load(env, id);
      if (fresh && fresh.status === "active") {
        return json({
          ok: true, billed_minute: Math.max(1, fresh.last_billed_minute),
          rate_per_min: CALL_TRANSLATION_RATE, reconciled: "already_active",
        });
      }
      return json({ error: "activation_in_progress", billable: false, retry_after_ms: 750 }, 409);
    }
  }
  if (!(await chargeMinute(env, s, 1))) {
    await metaDb(env).prepare("UPDATE translation_call_sessions SET status='pending',updated_at=?2 WHERE id=?1 AND status='activating'").bind(id, Date.now()).run();
    return insufficientTokens({ needed: CALL_TRANSLATION_MIN_START, billable: false });
  }
  const now = Date.now();
  const activated = await metaDb(env).prepare("UPDATE translation_call_sessions SET status='active',started_at=?2,last_billed_minute=1,billed_tokens=?3,updated_at=?2 WHERE id=?1 AND status='activating'").bind(id, now, CALL_TRANSLATION_RATE).run();
  // The charge landed. Never surface an opaque 409 from here — reconcile instead.
  if (activated.meta.changes !== 1) return await reconcileActivating(env, id);
  return json({ ok: true, billed_minute: 1, rate_per_min: CALL_TRANSLATION_RATE });
}

/** Idempotent one-minute renewal. Call state is never changed by billing failure. */
export async function callTranslationRenew(req: Request, env: Env, id: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return authError(ctx);
  const s = await load(env, id);
  if (!s || s.payer_uid !== ctx.uid) return json({ error: "not found" }, 404);
  if (s.status !== "active") return json({ error: s.status }, 409);
  const rb = await req.json().catch(() => ({})) as Record<string, unknown>;
  if (nonceRejected(s, rb.device_nonce)) return await nonceRejection(env, s, "renew");
  if (!(await participantInActiveCall(env, s.call_ref, ctx.uid))) return json({ error: "call_ended" }, 409);
  const elapsed = Math.max(1, Math.ceil((Date.now() - Number(s.started_at)) / 60_000));
  if (elapsed <= s.last_billed_minute) return json({ ok: true, billed_minute: s.last_billed_minute, billed_tokens: s.billed_tokens });
  const minute = s.last_billed_minute + 1;
  if (!(await chargeMinute(env, s, minute))) {
    await metaDb(env).prepare("UPDATE translation_call_sessions SET status='funds-stopped',updated_at=?2 WHERE id=?1 AND status='active'").bind(id, Date.now()).run();
    await track(env, ctx.uid, "call_translation_funds_stopped", APP, { session_id: id, call_ref: s.call_ref, minute });
    return insufficientTokens({ reason: "balance_exhausted", billable: true });
  }
  const billed = s.billed_tokens + CALL_TRANSLATION_RATE;
  // [CALL-TRANSLATE-2A-2] Guard on the minute counter, not on status. The money
  // for `minute` has already moved under a deterministic op id, so the row must
  // record it even if a concurrent stop/funds-stop changed status underneath us —
  // and `last_billed_minute<?2` makes a replay a no-op rather than a double count.
  const applied = await metaDb(env).prepare(
    "UPDATE translation_call_sessions SET last_billed_minute=?2,billed_tokens=MAX(billed_tokens,?3),updated_at=?4 WHERE id=?1 AND last_billed_minute<?2",
  ).bind(id, minute, billed, Date.now()).run();
  if (applied.meta.changes !== 1) {
    const fresh = await load(env, id);
    if (fresh) {
      await track(env, ctx.uid, "call_translation_renew_reconciled", APP, {
        session_id: id, call_ref: s.call_ref, minute, status: fresh.status,
      });
      return json({
        ok: true, billed_minute: fresh.last_billed_minute,
        billed_tokens: fresh.billed_tokens, reconciled: "already_billed",
      });
    }
  }
  return json({ ok: true, billed_minute: minute, billed_tokens: billed });
}

export async function callTranslationStop(req: Request, env: Env, id: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return authError(ctx);
  const s = await load(env, id);
  if (!s || s.payer_uid !== ctx.uid) return json({ error: "not found" }, 404);
  await metaDb(env).prepare("UPDATE translation_call_sessions SET status='stopped',updated_at=?2 WHERE id=?1 AND status NOT IN ('stopped','funds-stopped','provider-stopped')").bind(id, Date.now()).run();
  track(env, ctx.uid, "call_translation_stopped", APP, { call_ref: s.call_ref });
  return json({ ok: true, billed_tokens: s.billed_tokens });
}

/**
 * Mint a replacement single-use provider token for an existing live session.
 *
 * [CALL-TRANSLATE-2B-3] Issuance is bound to three things, all checked here:
 * the session row (must exist, be owned by the caller, and be `active`), the
 * call (the payer must still be a participant in that exact connected CallRoom),
 * and the device nonce recorded at session create. `uses: 1` keeps the minted
 * token single-use provider-side. The target language always comes from the row,
 * never from the request — so a switch (see /language) is the only way to change it.
 */
export async function callTranslationToken(req: Request, env: Env, id: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return authError(ctx);
  const s = await load(env, id);
  if (!s || s.payer_uid !== ctx.uid || s.status !== "active") return json({ error: "not found" }, 404);
  const b = await req.json().catch(() => ({})) as Record<string, unknown>;
  if (nonceRejected(s, b.device_nonce)) return await nonceRejection(env, s, "token");
  if (!(await participantInActiveCall(env, s.call_ref, ctx.uid))) return json({ error: "call_ended" }, 409);
  const limited = await rateLimit(env, `call-trl-token:${ctx.uid}`, 24, 3600);
  if (limited) return limited;
  const token = await mintToken(env, s.target_lang);
  return token
    ? json({ ok: true, session_id: s.id, token: token.token, token_expires_at: token.expiresAt, target_lang: s.target_lang, model: CALL_TRANSLATION_MODEL })
    : json({ error: "provider_unavailable" }, 502);
}
