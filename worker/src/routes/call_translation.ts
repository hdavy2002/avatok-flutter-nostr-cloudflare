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
/**
 * [CALL-TRANSLATE-APIVER-1] ONE place for the provider API version in this layer.
 *
 * The Android bridge holds the matching constant (`API_VERSION` in
 * CallTranslationAudioPlugin.java) and the two MUST move together: a token minted
 * under one version and presented to a socket on another is the exact failure this
 * constant exists to make impossible to reintroduce by a scattered literal.
 *
 * `v1alpha` matches the Live Translate guide ("you must use the v1alpha endpoint"
 * with ephemeral tokens) AND the two lanes in this repo that are already proven in
 * production — routes/translate.ts mints on v1alpha and
 * avachat/voice_call/live_voice_controller.dart connects on v1alpha. Probed live on
 * 2026-08-04: v1beta and v1alpha accept an identical mint body and behave identically
 * on the socket, so this is a consistency choice, not a functional one.
 */
export const CALL_TRANSLATION_API_VERSION = "v1alpha";
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

/**
 * [CALL-TRANSLATE-2D-3] OWNER DECISION 2026-08-04 — call translation is PAID-ONLY.
 *
 * `.balance` is the PAID wallet balance. It deliberately excludes `free` (the
 * daily AI grant) and `bonus` (the 100-token welcome grant), which is why a user
 * whose only tokens are the welcome grant is refused here. That is INTENDED, not
 * a bug: this is a metered third-party provider lane, not an in-house AI feature.
 *
 * Do NOT "fix" this by switching the gate to `.spendable` or by adding
 * `allow_free: true` to `chargeMinute` — the two must always agree, and the owner
 * has ruled that welcome-grant tokens are not spendable on call translation.
 * The CLAUDE-adjacent note "no premium gating, 100 free tokens at signup" is about
 * AI features generally; THIS feature is the documented exception.
 *
 * `spendable` is still read so the 402 can say WHY (see `insufficientTokens`).
 */
async function balance(env: Env, uid: string): Promise<{ paid: number; spendable: number }> {
  const r = await walletOp(env, uid, { op: "balance", uid });
  return {
    paid: Number(r.body?.balance ?? 0),
    spendable: Number(r.body?.spendable ?? r.body?.balance ?? 0),
  };
}

/**
 * [CALL-TRANSLATE-2D-3] PAID-ONLY — see `balance()` above (owner, 2026-08-04).
 *
 * `allow_free` is OMITTED on purpose, which the WalletDO reads as `false`:
 * headroom and drawdown come from the PAID `balance` only, never from
 * `free + bonus`. This must stay in lockstep with the `/start` gate, which
 * checks `.balance`. Adding `allow_free: true` here without changing that gate
 * (or vice versa) creates a user who passes /start and fails /activate — charged
 * expectations, no translation.
 */
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
  const response = await fetch(`https://generativelanguage.googleapis.com/${CALL_TRANSLATION_API_VERSION}/auth_tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    /**
     * [CALL-TRANSLATE-APIVER-1] `bidiGenerateContentSetup` is the REAL wire field.
     *
     * `liveConnectConstraints` — which this used to send, and which the published
     * REST curl on ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens still
     * shows — is an SDK-LEVEL name only. The genai SDKs rewrite it to
     * `bidiGenerateContentSetup` before it reaches the wire
     * (`createAuthTokenConfigToMldev` -> `liveConnectConstraintsToMldev` in
     * @google/genai). Posted raw it is rejected outright:
     *
     *   400 Invalid JSON payload received. Unknown name "liveConnectConstraints"
     *       at 'auth_token': Cannot find field.
     *
     * Probed against the live endpoint 2026-08-04 on BOTH v1beta and v1alpha —
     * body validation runs before key validation, so this needs no key to
     * reproduce. Every mint therefore returned null and every /start, /language
     * and /token answered 502 provider_unavailable: the feature could not have
     * worked once. routes/translate.ts has had the correct shape since
     * 2026-06-11; this route diverged from it.
     *
     * Note the nesting, which is NOT the SDK's: `responseModalities` and
     * `translationConfig` live under `generationConfig`, while `sessionResumption`
     * and `contextWindowCompression` are siblings of it — this object is a
     * BidiGenerateContentSetup, not a LiveConnectConfig.
     */
    body: JSON.stringify({
      uses: 1, expireTime: new Date(expiresAt).toISOString(),
      bidiGenerateContentSetup: {
        model: `models/${CALL_TRANSLATION_MODEL}`,
        generationConfig: {
          // [CALL-TRANSLATE-2A-1] Captions are deferred (owner). Transcription is
          // deliberately NOT requested here: the token constraints and the native
          // setup JSON must agree, and no transcript text may ever leave the
          // provider session for this feature.
          responseModalities: ["AUDIO"],
          translationConfig: { targetLanguageCode: targetLang, echoTargetLanguage: false },
        },
        sessionResumption: {},
        contextWindowCompression: { slidingWindow: {} },
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
 *
 * [CALL-TRANSLATE-2D-3] `paid_only: true` is always present so the client can
 * write accurate copy. It means: this refusal is about PAID balance, and free /
 * bonus (welcome-grant) tokens can never satisfy it (owner decision — see
 * `balance()`). When `spendable > balance` the user genuinely holds tokens that
 * simply do not apply here, and the copy must say "top up" rather than
 * "you have no tokens", which would be visibly wrong next to their wallet.
 */
function insufficientTokens(extra: Record<string, unknown> = {}): Response {
  return json({
    error: "insufficient_tokens",
    error_legacy: "insufficient_avacoins",
    paid_only: true,
    rate_per_min: CALL_TRANSLATION_RATE,
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
      billed_tokens: fresh.billed_tokens, call_ref: fresh.call_ref,
      rate_per_min: CALL_TRANSLATION_RATE, reconciled: "already_active",
    });
  }
  // [CALL-TRANSLATE-2D-3] There is deliberately NO `status === 'activating'`
  // repair branch here. The version that used to sit at this spot compared
  // `updated_at` against ACTIVATING_STUCK_MS — but this same request refreshed
  // `updated_at` when it claimed the row (see the claim UPDATE in
  // `callTranslationActivate`), so the age test could never pass. It was dead
  // code advertising a self-heal that could not fire. Worse, reaching here at
  // all requires `UPDATE ... WHERE status='activating'` to have matched zero
  // rows, which by definition means the status is no longer 'activating'.
  //
  // The genuine stuck-row case — an attempt that charged minute one and then
  // died before writing the row — is now repaired at its real entry point, in
  // `callTranslationActivate`'s stuck-claim path, where the age is measured
  // against the claim that is actually stale. See A2 there.
  if (fresh.status === "stopped" || fresh.status === "funds-stopped" || fresh.status === "provider-stopped") {
    return json({ error: fresh.status, billable: true, call_ref: fresh.call_ref }, 409);
  }
  // Still genuinely in flight (another attempt is inside its own charge). The
  // client retries this exact call; it is idempotent by construction.
  return json({ error: "activation_in_progress", billable: true, retry_after_ms: 750, call_ref: fresh.call_ref }, 409);
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
  // Check for an existing session BEFORE spending rate-limit budget: a duplicate
  // /start is the client converging, not abuse, and burning quota on the 409 was
  // part of how a legitimate payer got locked out.
  const existing = await metaDb(env).prepare("SELECT id FROM translation_call_sessions WHERE payer_uid=?1 AND call_ref=?2 AND status IN ('pending','activating','active') LIMIT 1").bind(ctx.uid, callRef).first<{ id: string }>();
  if (existing) return json({ error: "translation already active", session_id: existing.id, call_ref: callRef }, 409);
  /**
   * [CALL-TRANSLATE-2D-3] Rate limiting: two buckets, both tunable from KV.
   *
   * The old single 10/hour ceiling predated Phase C's speculative warm-up. A
   * warm-up creates a REAL session row via this route when the language sheet
   * opens, and `start()` creates another when that warm session is not adopted —
   * so ~5 sheet opens per hour locked the payer out with a 429 rendered as
   * "Live translation could not start." That is a paying user being told the
   * product is broken because they browsed the language list.
   *
   * Warm-ups are therefore counted in their OWN bucket, with a higher ceiling,
   * because they are cheap: `/start` never moves money (the paid boundary is
   * `/activate`), so a discarded warm-up costs one provider token mint and one
   * D1 row. A caller who lies and always sends `warm_up:true` gets the warm-up
   * ceiling instead of the start ceiling — same order of magnitude, still
   * bounded, and still unable to spend a single token. That is the trade.
   */
  const warmUp = b.warm_up === true;
  const rlMax = Math.max(1, Math.trunc(
    warmUp ? cfg.callTranslationWarmupsPerHour : cfg.callTranslationStartsPerHour,
  ));
  const limited = await rateLimit(env, `call-trl${warmUp ? "-warm" : ""}:${ctx.uid}`, rlMax, 3600);
  if (limited) {
    await track(env, ctx.uid, "call_translation_start_rate_limited", APP, {
      call_ref: callRef, warm_up: warmUp, ceiling_per_hour: rlMax,
    });
    return limited;
  }
  const bal = await balance(env, ctx.uid);
  if (bal.paid < CALL_TRANSLATION_MIN_START) {
    return insufficientTokens({
      needed: CALL_TRANSLATION_MIN_START,
      balance: bal.paid,
      // Non-paid tokens the user DOES hold. > balance means "you have tokens,
      // but not the kind this feature spends" — see the paid-only note above.
      spendable: bal.spendable,
      call_ref: callRef,
    });
  }
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
    return json({ error: "translation already active", session_id: winner?.id, call_ref: callRef }, 409);
  }
  await track(env, ctx.uid, "call_translation_start_ready", APP, {
    session_id: id, call_ref: callRef, language: lang, warm_up: warmUp,
  });
  return json({
    ok: true,
    session_id: id,
    // [CALL-TRANSLATE-2D-3] Echoed so the client can stamp the SAME identifier the
    // Worker stamps on its own PostHog events. Without it the two timelines for
    // one call cannot be joined: Dart events carried session_id only.
    call_ref: callRef,
    // Echoed so the client knows the server agreed this row is speculative.
    warm_up: warmUp,
    source_lease: lease,
    token: token.token,
    token_expires_at: token.expiresAt,
    model: CALL_TRANSLATION_MODEL,
    rate_per_min: CALL_TRANSLATION_RATE,
    balance: bal.paid,
    spendable: bal.spendable,
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
  if (s.status === "active") {
    return json({
      ok: true, billed_minute: s.last_billed_minute, billed_tokens: s.billed_tokens,
      call_ref: s.call_ref, rate_per_min: CALL_TRANSLATION_RATE,
    });
  }
  if (s.status !== "pending" && s.status !== "activating") return json({ error: s.status, call_ref: s.call_ref }, 409);
  const b = await req.json().catch(() => ({})) as Record<string, unknown>;
  if (nonceRejected(s, b.device_nonce)) return await nonceRejection(env, s, "activate");
  /**
   * [CALL-TRANSLATE-2D-3 / A2] Stuck-claim repair — the REACHABLE version.
   *
   * For an 'activating' row, `updated_at` is the moment this row was CLAIMED,
   * not the moment the source became ready. Measuring source-lease freshness
   * against it is the actual bug: an attempt that claimed the row, charged
   * minute one under the deterministic op id, then died before writing the row
   * leaves it 'activating' forever. Every later retry is then rejected with a
   * 412 `source_not_ready` once the claim passes SOURCE_LEASE_MS — a payer whose
   * charge succeeded, permanently unable to get translation. That is exactly the
   * A2 guarantee failing.
   *
   * So past ACTIVATING_STUCK_MS we treat the row as a crashed prior attempt and
   * skip ONLY the staleness test. Ownership, nonce, lease identity,
   * `source_ready` and live-participant checks all still apply, and the repair
   * runs `chargeMinute(s, 1)` rather than assuming the money moved: that call is
   * idempotent on `call-translation:<sid>:minute:1`, so it is a no-op returning
   * success if minute one was already debited, and a real charge if the crash
   * happened before the debit. Correct in both directions, never double-billed.
   */
  const stuckClaim = s.status === "activating" && Date.now() - s.updated_at > ACTIVATING_STUCK_MS;
  if (b.source_lease !== s.source_lease || b.source_ready !== true || (!stuckClaim && Date.now() - s.updated_at > SOURCE_LEASE_MS)) return json({ error: "source_not_ready", billable: false, call_ref: s.call_ref }, 412);
  if (!(await participantInActiveCall(env, s.call_ref, ctx.uid))) return json({ error: "call_ended_or_source_invalid", billable: false, call_ref: s.call_ref }, 409);
  if (stuckClaim) {
    await track(env, ctx.uid, "call_translation_activation_repaired", APP, {
      session_id: id, call_ref: s.call_ref, stuck_ms: Date.now() - s.updated_at,
    });
  }
  if (s.status === "pending") {
    const claimed = await metaDb(env).prepare("UPDATE translation_call_sessions SET status='activating',updated_at=?2 WHERE id=?1 AND status='pending'").bind(id, Date.now()).run();
    if (claimed.meta.changes !== 1) {
      // Pre-charge race: a concurrent retry claimed it. If that retry already
      // finished, this attempt is an idempotent success rather than a failure.
      const fresh = await load(env, id);
      if (fresh && fresh.status === "active") {
        return json({
          ok: true, billed_minute: Math.max(1, fresh.last_billed_minute),
          billed_tokens: fresh.billed_tokens, call_ref: fresh.call_ref,
          rate_per_min: CALL_TRANSLATION_RATE, reconciled: "already_active",
        });
      }
      return json({ error: "activation_in_progress", billable: false, retry_after_ms: 750, call_ref: s.call_ref }, 409);
    }
  }
  if (!(await chargeMinute(env, s, 1))) {
    await metaDb(env).prepare("UPDATE translation_call_sessions SET status='pending',updated_at=?2 WHERE id=?1 AND status='activating'").bind(id, Date.now()).run();
    // PAID-ONLY refusal (owner 2026-08-04). `spendable` is included so the client
    // can distinguish "no tokens at all" from "tokens, but not paid ones".
    const bal = await balance(env, ctx.uid);
    return insufficientTokens({
      reason: "paid_balance_required", needed: CALL_TRANSLATION_MIN_START, billable: false,
      balance: bal.paid, spendable: bal.spendable, call_ref: s.call_ref,
    });
  }
  const now = Date.now();
  const activated = await metaDb(env).prepare("UPDATE translation_call_sessions SET status='active',started_at=?2,last_billed_minute=1,billed_tokens=?3,updated_at=?2 WHERE id=?1 AND status='activating'").bind(id, now, CALL_TRANSLATION_RATE).run();
  // The charge landed. Never surface an opaque 409 from here — reconcile instead.
  if (activated.meta.changes !== 1) return await reconcileActivating(env, id);
  // [CALL-TRANSLATE-2D-3 / L-2] `billed_tokens` is returned here for parity with
  // renew; the client used to fall back to a hardcoded 5. This is authoritative:
  // the UPDATE above just wrote exactly this value under `status='activating'`.
  return json({
    ok: true, billed_minute: 1, billed_tokens: CALL_TRANSLATION_RATE,
    call_ref: s.call_ref, rate_per_min: CALL_TRANSLATION_RATE,
  });
}

/** Idempotent one-minute renewal. Call state is never changed by billing failure. */
export async function callTranslationRenew(req: Request, env: Env, id: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return authError(ctx);
  const s = await load(env, id);
  if (!s || s.payer_uid !== ctx.uid) return json({ error: "not found" }, 404);
  if (s.status !== "active") return json({ error: s.status, call_ref: s.call_ref }, 409);
  const rb = await req.json().catch(() => ({})) as Record<string, unknown>;
  if (nonceRejected(s, rb.device_nonce)) return await nonceRejection(env, s, "renew");
  if (!(await participantInActiveCall(env, s.call_ref, ctx.uid))) return json({ error: "call_ended", call_ref: s.call_ref }, 409);
  const elapsed = Math.max(1, Math.ceil((Date.now() - Number(s.started_at)) / 60_000));
  if (elapsed <= s.last_billed_minute) return json({ ok: true, billed_minute: s.last_billed_minute, billed_tokens: s.billed_tokens, call_ref: s.call_ref });
  const minute = s.last_billed_minute + 1;
  if (!(await chargeMinute(env, s, minute))) {
    await metaDb(env).prepare("UPDATE translation_call_sessions SET status='funds-stopped',updated_at=?2 WHERE id=?1 AND status='active'").bind(id, Date.now()).run();
    await track(env, ctx.uid, "call_translation_funds_stopped", APP, { session_id: id, call_ref: s.call_ref, minute });
    // PAID-ONLY (owner 2026-08-04): the wallet refused against paid `balance`.
    // `spendable` lets the client say "your remaining tokens are free/bonus
    // tokens, which translation cannot spend" instead of a misleading "empty".
    const bal = await balance(env, ctx.uid);
    return insufficientTokens({
      reason: "balance_exhausted", billable: true,
      balance: bal.paid, spendable: bal.spendable,
      billed_minute: s.last_billed_minute, billed_tokens: s.billed_tokens, call_ref: s.call_ref,
    });
  }
  // [CALL-TRANSLATE-2D-3 / L-3] Derived from the guarded minute counter, not from
  // the possibly-stale `s.billed_tokens` we read before the charge. Every minute
  // costs exactly CALL_TRANSLATION_RATE and activate seeds minute 1 with that
  // same rate, so `billed_tokens === last_billed_minute * RATE` is an invariant
  // of the row. `MAX(...)` below therefore only ever guards against a regression.
  const billed = minute * CALL_TRANSLATION_RATE;
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
        billed_tokens: fresh.billed_tokens, call_ref: fresh.call_ref, reconciled: "already_billed",
      });
    }
  }
  // Re-read rather than echoing the value we computed: `MAX()` means the stored
  // figure is the authority, and a concurrent writer may legitimately have set a
  // higher one. Falling back to `billed` only if the row vanished mid-flight.
  const settled = await load(env, id);
  return json({
    ok: true,
    billed_minute: settled?.last_billed_minute ?? minute,
    billed_tokens: settled?.billed_tokens ?? billed,
    call_ref: s.call_ref,
  });
}

export async function callTranslationStop(req: Request, env: Env, id: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return authError(ctx);
  const s = await load(env, id);
  if (!s || s.payer_uid !== ctx.uid) return json({ error: "not found" }, 404);
  await metaDb(env).prepare("UPDATE translation_call_sessions SET status='stopped',updated_at=?2 WHERE id=?1 AND status NOT IN ('stopped','funds-stopped','provider-stopped')").bind(id, Date.now()).run();
  await track(env, ctx.uid, "call_translation_stopped", APP, {
    session_id: id, call_ref: s.call_ref, billed_minute: s.last_billed_minute,
  });
  return json({ ok: true, billed_tokens: s.billed_tokens, billed_minute: s.last_billed_minute, call_ref: s.call_ref });
}

/**
 * [CALL-TRANSLATE-2C-1] Mid-call language switch.
 *
 * Updates `target_lang` on the EXISTING session row and mints a token bound to
 * the updated row. Deliberately NOT a new session: the user changed language,
 * not product, so the same billing session continues — `started_at`,
 * `last_billed_minute` and `billed_tokens` are untouched and no minute-1 charge
 * is taken. A switch is therefore free; the running per-minute clock keeps
 * ticking through it.
 *
 * The client does make-before-break: it keeps the old provider socket alive
 * until the new one reports setupComplete, so this route must be safe to call
 * while a session is actively translating.
 */
export async function callTranslationLanguage(req: Request, env: Env, id: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return authError(ctx);
  const cfg = await readConfig(env);
  const s = await load(env, id);
  if (!s || s.payer_uid !== ctx.uid) return json({ error: "not found" }, 404);
  if (s.status !== "active") return json({ error: s.status, billable: false, call_ref: s.call_ref }, 409);
  const b = await req.json().catch(() => ({})) as Record<string, unknown>;
  if (nonceRejected(s, b.device_nonce)) return await nonceRejection(env, s, "language");
  const lang = String(b.target_lang ?? "");
  if (!CALL_TRANSLATION_LANGS.has(lang)) return json({ error: "unsupported target_lang", lang, billable: false, call_ref: s.call_ref }, 400);
  if (!(await participantInActiveCall(env, s.call_ref, ctx.uid))) return json({ error: "call_ended", billable: false, call_ref: s.call_ref }, 409);
  /**
   * [CALL-TRANSLATE-2D-3] Abuse ceiling, not a product limit — a user changing
   * their mind must never be told "slow down".
   *
   * The previous 40/hour was written as if one switch were one request. Phase C
   * consumes this route 2–3 times per switch (speculative pre-mint, restoring
   * the speculative row, then the real switch), so 40 meant ~13 switches an hour
   * before a 429. Now KV-tunable and sized for the client's actual behaviour.
   * A switch is free — it does not touch the wallet or the minute clock — so
   * what this bounds is provider token mints, not spend.
   */
  const langMax = Math.max(1, Math.trunc(cfg.callTranslationSwitchesPerHour));
  const limited = await rateLimit(env, `call-trl-lang:${ctx.uid}`, langMax, 3600);
  if (limited) {
    await track(env, ctx.uid, "call_translation_language_rate_limited", APP, {
      session_id: id, call_ref: s.call_ref, ceiling_per_hour: langMax,
    });
    return limited;
  }
  const updated = await metaDb(env).prepare(
    "UPDATE translation_call_sessions SET target_lang=?2,updated_at=?3 WHERE id=?1 AND status='active'",
  ).bind(id, lang, Date.now()).run();
  if (updated.meta.changes !== 1) return json({ error: "switch_conflict", billable: false, call_ref: s.call_ref }, 409);
  // Mint against the RE-READ row, never against the request: if a concurrent
  // switch won, the token must carry the language that is actually recorded.
  const fresh = await load(env, id);
  if (!fresh || fresh.status !== "active") return json({ error: fresh?.status ?? "not found", billable: false, call_ref: s.call_ref }, 409);
  const wantToken = b.mint !== false;
  const token = wantToken ? await mintToken(env, fresh.target_lang) : null;
  if (wantToken && !token) {
    // The row already carries the new language; the client stays on the old
    // socket and may retry the mint via /token. Never leave the caller guessing.
    await track(env, ctx.uid, "call_translation_language_switch_failed", APP, {
      session_id: id, call_ref: s.call_ref, from_language: s.target_lang, to_language: lang, reason: "provider_unavailable",
    });
    return json({ error: "provider_unavailable", target_lang: fresh.target_lang, previous_target_lang: s.target_lang, billable: false, call_ref: s.call_ref }, 502);
  }
  await track(env, ctx.uid, "call_translation_language_switched", APP, {
    session_id: id, call_ref: s.call_ref, from_language: s.target_lang, to_language: fresh.target_lang,
    billed_minute: fresh.last_billed_minute,
  });
  return json({
    ok: true,
    session_id: id,
    call_ref: fresh.call_ref,
    target_lang: fresh.target_lang,
    previous_target_lang: s.target_lang,
    token: token?.token,
    token_expires_at: token?.expiresAt,
    model: CALL_TRANSLATION_MODEL,
    rate_per_min: CALL_TRANSLATION_RATE,
    billed_minute: fresh.last_billed_minute,
    billed_tokens: fresh.billed_tokens,
  });
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
  if (!(await participantInActiveCall(env, s.call_ref, ctx.uid))) return json({ error: "call_ended", call_ref: s.call_ref }, 409);
  const limited = await rateLimit(env, `call-trl-token:${ctx.uid}`, 24, 3600);
  if (limited) {
    await track(env, ctx.uid, "call_translation_token_rate_limited", APP, {
      session_id: s.id, call_ref: s.call_ref, ceiling_per_hour: 24,
    });
    return limited;
  }
  const token = await mintToken(env, s.target_lang);
  return token
    ? json({ ok: true, session_id: s.id, call_ref: s.call_ref, token: token.token, token_expires_at: token.expiresAt, target_lang: s.target_lang, model: CALL_TRANSLATION_MODEL })
    : json({ error: "provider_unavailable", call_ref: s.call_ref }, 502);
}
