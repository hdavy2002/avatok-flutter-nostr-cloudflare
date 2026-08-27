// Phase 1 Messenger billing authorization foundation. This module remains
// unmounted until the provider integration review is complete, but its stateful
// contract is ready: D1 freezes authorization/pricing identity and WalletDO
// owns daily allowance, balance, and paid-time reservations.

import type { Env } from "../types";
import { json } from "../util";
import { isFail, requireUser } from "../authz";
import { track } from "../hooks";
import { readConfig, type PlatformConfig } from "./config";
import { messengerCallReservationStatus, messengerCallUsageStatus, releaseMessengerCallReservation, reserveMessengerCall } from "./wallet";
import { messengerCallBillingStub } from "../do/messenger_call_billing";
import {
  CENTITOKEN_SECONDS_PER_TOKEN,
  hourlyCallerFundedTokenEstimate,
  messengerProviderFor,
  messengerRateFor,
  utcDayKey,
  type MessengerMedia,
  type MessengerQualitySku,
  type MessengerVideoQuality,
} from "../lib/messenger_call_billing";

export interface MessengerCallAuthorizationRequest {
  callee_uid: string;
  media: MessengerMedia;
  quality: "audio" | MessengerVideoQuality;
  attempt_id: string;
  consent_id?: string | null;
}

export interface MessengerCallAuthorizationPreview {
  media: MessengerMedia;
  quality: "audio" | MessengerVideoQuality;
  provider: "cloudflare" | "stream";
  quality_sku: string;
  rate_centitokens_per_participant_minute: number;
  hourly_tokens_for_two_participants: number;
  price_version: number;
}

interface MessengerAuthorizationRow {
  authorization_id: string;
  call_id: string;
  attempt_id: string;
  payer_uid: string;
  callee_uid: string;
  media: MessengerMedia;
  quality_sku: MessengerQualitySku;
  provider: "cloudflare" | "stream";
  rate_centitokens_per_participant_minute: number;
  price_version: number;
  consent_id: string | null;
  allowance_day: string | null;
  status: string;
  reservation_ref: string | null;
  reservation_tokens: number;
  created_at: number;
  expires_at: number;
  connected_at: number | null;
  ended_at: number | null;
  terminal_reason: string | null;
}

export type MessengerCallAuthorizationRecord = MessengerAuthorizationRow;

function validUid(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128
    && /^[A-Za-z0-9_:@.-]+$/.test(value);
}

function validAttemptId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 8 && value.length <= 128
    && /^[A-Za-z0-9_-]+$/.test(value);
}

function parseRequest(value: unknown): MessengerCallAuthorizationRequest | { error: string } {
  const body = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const media = body.media === "audio" || body.media === "video" ? body.media : null;
  if (!validUid(body.callee_uid)) return { error: "invalid callee_uid" };
  if (!media) return { error: "media must be audio or video" };
  if (!validAttemptId(body.attempt_id)) return { error: "invalid attempt_id" };
  const calleeUid = body.callee_uid as string;
  const attemptId = body.attempt_id as string;
  if (body.consent_id !== undefined && body.consent_id !== null && !validAttemptId(body.consent_id)) {
    return { error: "invalid consent_id" };
  }
  if (media === "audio") {
    if (body.quality !== undefined && body.quality !== "audio") return { error: "audio quality must be audio" };
    return {
      callee_uid: calleeUid,
      media,
      quality: "audio",
      attempt_id: attemptId,
      consent_id: body.consent_id === null || body.consent_id === undefined ? null : body.consent_id,
    };
  }
  if (body.quality !== "sd" && body.quality !== "hd" && body.quality !== "2k" && body.quality !== "4k") {
    return { error: "video quality must be sd, hd, 2k, or 4k" };
  }
  return {
    callee_uid: calleeUid,
    media,
    quality: body.quality as MessengerVideoQuality,
    attempt_id: attemptId,
    consent_id: body.consent_id === null || body.consent_id === undefined ? null : body.consent_id,
  };
}

/** Build the frozen pricing/provider preview without touching any state. */
export function previewMessengerAuthorization(
  config: Pick<PlatformConfig,
    | "messengerAudioPaidCentitokensPerParticipantMinute"
    | "messengerVideoSdCentitokensPerParticipantMinute"
    | "messengerVideoHdCentitokensPerParticipantMinute"
    | "messengerVideo2kCentitokensPerParticipantMinute"
    | "messengerVideo4kCentitokensPerParticipantMinute"
    | "messengerCallPriceVersion"
  >,
  request: MessengerCallAuthorizationRequest,
  freeParticipantSecondsRemaining?: number,
): MessengerCallAuthorizationPreview | { code: "quality_unavailable" | "pricing_unavailable"; message: string } {
  const rate = messengerRateFor(config, request.media, request.quality);
  if (!rate) {
    const validVideoQuality = request.media === "video" && ["sd", "hd", "2k", "4k"].includes(request.quality as MessengerVideoQuality);
    return validVideoQuality
      ? { code: "pricing_unavailable", message: "Pricing for this call option is not configured." }
      : { code: "quality_unavailable", message: "The selected call quality is unavailable." };
  }
  if (request.media === "video" && rate.rateCentitokensPerParticipantMinute <= 0) {
    return { code: "pricing_unavailable", message: "Pricing for this call option is not configured." };
  }
  const freeAudio = request.media === "audio" && Number(freeParticipantSecondsRemaining ?? 0) > 0;
  if (request.media === "audio" && freeParticipantSecondsRemaining !== undefined && !freeAudio && rate.rateCentitokensPerParticipantMinute <= 0) {
    return { code: "pricing_unavailable", message: "Paid audio pricing is not configured." };
  }
  return {
    media: request.media,
    quality: request.quality === "audio" || request.media === "audio" ? "audio" : request.quality,
    provider: messengerProviderFor(request.media, freeAudio),
    quality_sku: rate.qualitySku,
    rate_centitokens_per_participant_minute: freeAudio ? 0 : rate.rateCentitokensPerParticipantMinute,
    hourly_tokens_for_two_participants: freeAudio ? 0 : hourlyCallerFundedTokenEstimate(rate.rateCentitokensPerParticipantMinute),
    price_version: config.messengerCallPriceVersion,
  };
}

function authView(row: MessengerAuthorizationRow, allowanceRemaining = 0): Record<string, unknown> {
  return {
    authorization_id: row.authorization_id,
    call_id: row.call_id,
    attempt_id: row.attempt_id,
    payer: "caller",
    payer_uid: row.payer_uid,
    callee_uid: row.callee_uid,
    media: row.media,
    quality: row.media === "audio" ? "audio" : row.quality_sku.replace("video_", ""),
    quality_sku: row.quality_sku,
    provider: row.provider,
    rate_centitokens_per_participant_minute: row.rate_centitokens_per_participant_minute,
    price_version: row.price_version,
    consent_id: row.consent_id,
    allowance_day: row.allowance_day,
    free_participant_seconds_remaining: allowanceRemaining,
    allowance_remaining_participant_seconds: allowanceRemaining,
    reservation_ref: row.reservation_ref,
    reservation_tokens: row.reservation_tokens,
    // Public wire alias consumed by the Flutter HUD. Keep the internal D1/DO
    // name above for reconciliation, but do not make clients know it.
    reserved_tokens: row.reservation_tokens,
    status: row.status,
    expires_at: row.expires_at,
  };
}

function pricingCatalog(config: PlatformConfig, freeRemaining = 0, spendableTokens?: number): Record<string, unknown> {
  const entries: Array<[MessengerQualitySku, number, boolean, string]> = [
    ["audio", config.messengerAudioPaidCentitokensPerParticipantMinute, true, "audio"],
    ["video_sd", config.messengerVideoSdCentitokensPerParticipantMinute, config.messengerVideoSdCentitokensPerParticipantMinute > 0, "sd"],
    ["video_hd", config.messengerVideoHdCentitokensPerParticipantMinute, config.messengerVideoHdCentitokensPerParticipantMinute > 0, "hd"],
    ["video_2k", config.messengerVideo2kCentitokensPerParticipantMinute, config.messengerVideo2kCentitokensPerParticipantMinute > 0, "2k"],
    ["video_4k", config.messengerVideo4kCentitokensPerParticipantMinute, config.messengerVideo4kCentitokensPerParticipantMinute > 0, "4k"],
  ];
  return {
    rates: Object.fromEntries(entries.map(([sku, rate, supported, cap]) => [sku, {
      centitokens_per_participant_minute: rate,
      rate_centitokens_per_participant_minute: rate,
      supported,
      public_cap: cap,
      hourly_tokens_for_two_participants: hourlyCallerFundedTokenEstimate(rate),
    }])),
    free_participant_seconds_remaining: Math.max(0, Math.trunc(freeRemaining)),
    ...(spendableTokens === undefined ? {} : { spendable_tokens: Math.max(0, Math.trunc(spendableTokens)) }),
    price_version: config.messengerCallPriceVersion,
  };
}

function flattenAuthorization(
  row: MessengerAuthorizationRow,
  allowanceRemaining = 0,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const authorization = authView(row, allowanceRemaining);
  // The Flutter decoder intentionally reads these fields at the top level.
  // Keep the nested object as a compatibility aid for non-Flutter clients.
  return { ...authorization, authorization_expires_at: row.expires_at, ...extra, authorization };
}

async function existingAuthorization(env: Env, payerUid: string, attemptId: string): Promise<MessengerAuthorizationRow | null> {
  return await env.DB_WALLET.prepare(
    "SELECT authorization_id, call_id, attempt_id, payer_uid, callee_uid, media, quality_sku, provider, " +
    "rate_centitokens_per_participant_minute, price_version, consent_id, allowance_day, status, reservation_ref, " +
    "reservation_tokens, created_at, expires_at, connected_at, ended_at, terminal_reason " +
    "FROM messenger_call_authorizations WHERE payer_uid=?1 AND attempt_id=?2 LIMIT 1",
  ).bind(payerUid, attemptId).first<MessengerAuthorizationRow>();
}

/** Resolve a server-issued pending consent challenge when the client starts a
 * fresh paid Stream attempt after free Cloudflare audio has ended. The
 * challenge is bound to the same caller, callee, media, and quality; a random
 * client consent id cannot authorize a new row. */
async function authorizationByConsent(
  env: Env,
  payerUid: string,
  calleeUid: string,
  consentId: string,
  media: MessengerMedia,
  qualitySku: MessengerQualitySku,
): Promise<MessengerAuthorizationRow | null> {
  return await env.DB_WALLET.prepare(
    "SELECT authorization_id, call_id, attempt_id, payer_uid, callee_uid, media, quality_sku, provider, " +
    "rate_centitokens_per_participant_minute, price_version, consent_id, allowance_day, status, reservation_ref, " +
    "reservation_tokens, created_at, expires_at, connected_at, ended_at, terminal_reason " +
    "FROM messenger_call_authorizations WHERE payer_uid=?1 AND callee_uid=?2 AND consent_id=?3 AND media=?4 AND quality_sku=?5 AND status='pending_consent' LIMIT 1",
  ).bind(payerUid, calleeUid, consentId, media, qualitySku).first<MessengerAuthorizationRow>();
}

/** Server-only lookup for the CallRoom admission lane. The caller supplies an
 * authorization id and attempt; all payer/provider/price terms come from D1. */
export async function loadMessengerCallAuthorization(
  env: Env,
  authorizationId: string,
  payerUid: string,
  attemptId: string,
): Promise<MessengerAuthorizationRow | null> {
  return await env.DB_WALLET.prepare(
    "SELECT authorization_id, call_id, attempt_id, payer_uid, callee_uid, media, quality_sku, provider, " +
    "rate_centitokens_per_participant_minute, price_version, consent_id, allowance_day, status, reservation_ref, " +
    "reservation_tokens, created_at, expires_at, connected_at, ended_at, terminal_reason " +
    "FROM messenger_call_authorizations WHERE authorization_id=?1 AND payer_uid=?2 AND attempt_id=?3 LIMIT 1",
  ).bind(authorizationId, payerUid, attemptId).first<MessengerAuthorizationRow>();
}

/** Server-only lookup for a provider join made by either authenticated seat.
 * The payer-scoped helper above remains the authority for /api/call; this
 * participant-scoped variant lets the callee join the already-authorized room
 * without ever becoming the payer or changing any frozen terms. */
export async function loadMessengerCallAuthorizationForParticipant(
  env: Env,
  authorizationId: string,
  uid: string,
  attemptId: string,
): Promise<MessengerAuthorizationRow | null> {
  return await env.DB_WALLET.prepare(
    "SELECT authorization_id, call_id, attempt_id, payer_uid, callee_uid, media, quality_sku, provider, " +
    "rate_centitokens_per_participant_minute, price_version, consent_id, allowance_day, status, reservation_ref, " +
    "reservation_tokens, created_at, expires_at, connected_at, ended_at, terminal_reason " +
    "FROM messenger_call_authorizations WHERE authorization_id=?1 AND attempt_id=?2 AND (payer_uid=?3 OR callee_uid=?3) LIMIT 1",
  ).bind(authorizationId, attemptId, uid).first<MessengerAuthorizationRow>();
}

async function insertAuthorization(env: Env, row: MessengerAuthorizationRow): Promise<void> {
  await env.DB_WALLET.prepare(
    "INSERT INTO messenger_call_authorizations (authorization_id, call_id, attempt_id, payer_uid, callee_uid, media, quality_sku, provider, " +
    "rate_centitokens_per_participant_minute, price_version, consent_id, allowance_day, status, reservation_ref, reservation_tokens, " +
    "created_at, expires_at, connected_at, ended_at, terminal_reason) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)",
  ).bind(
    row.authorization_id, row.call_id, row.attempt_id, row.payer_uid, row.callee_uid, row.media, row.quality_sku,
    row.provider, row.rate_centitokens_per_participant_minute, row.price_version, row.consent_id, row.allowance_day,
    row.status, row.reservation_ref, row.reservation_tokens, row.created_at, row.expires_at, row.connected_at,
    row.ended_at, row.terminal_reason,
  ).run();
}

async function authorizeExisting(env: Env, row: MessengerAuthorizationRow, consentId: string | null, config: PlatformConfig): Promise<Response> {
  if (row.expires_at > 0 && row.expires_at <= Date.now() && row.status !== "ended") {
    await env.DB_WALLET.prepare(
      "UPDATE messenger_call_authorizations SET status='expired', terminal_reason='authorization_expired', ended_at=?1 WHERE authorization_id=?2 AND status IN ('pending_consent','authorized')",
    ).bind(Date.now(), row.authorization_id).run();
    return json({ approved: false, code: "authorization_expired", authorization_id: row.authorization_id }, 409);
  }
  let allowanceRemaining = 0;
  if (row.allowance_day) {
    const usage = await messengerCallUsageStatus(env, row.payer_uid, {
      day: row.allowance_day,
      daily_audio_allowance_participant_seconds: config.messengerAudioFreeParticipantSecondsDaily,
    });
    if (usage.ok) allowanceRemaining = Math.max(0, Number(usage.body?.daily_audio_allowance_remaining ?? 0));
  }
  if (row.status === "pending_consent") {
    if (!consentId || consentId !== row.consent_id) {
      void track(env, row.payer_uid, "messenger_call_consent_shown", "avatok", {
        authorization_id: row.authorization_id, call_id: row.call_id, attempt_id: row.attempt_id, provider: row.provider,
        media: row.media, quality_sku: row.quality_sku, price_version: row.price_version,
        consent_kind: row.media === "video" ? "video" : "paid_audio",
      }).catch(() => undefined);
      return json({
        approved: false, code: "consent_required",
        consent_kind: row.media === "video" ? "video" : "paid_audio",
        ...pricingCatalog(config, allowanceRemaining),
        ...flattenAuthorization(row, allowanceRemaining),
      }, 409);
    }
    void track(env, row.payer_uid, "messenger_call_consent_result", "avatok", {
      authorization_id: row.authorization_id, call_id: row.call_id, attempt_id: row.attempt_id, provider: row.provider,
      media: row.media, quality_sku: row.quality_sku, price_version: row.price_version,
      accepted: true,
    }).catch(() => undefined);
    const reservationWallSeconds = Math.max(1, Math.trunc(config.messengerCallReservationWallSeconds));
    const reservationTokens = Math.max(1, Math.ceil(
      row.rate_centitokens_per_participant_minute * reservationWallSeconds * 2 / CENTITOKEN_SECONDS_PER_TOKEN,
    ));
    const reservationRef = `messenger-call:${row.authorization_id}`;
    const expiresAt = Math.max(row.expires_at, Date.now() + reservationWallSeconds * 1000);
    const reserved = await reserveMessengerCall(
      env, row.payer_uid, reservationTokens, reservationRef,
      `${reservationRef}:reserve`, expiresAt,
    );
    if (!reserved.ok) {
      void track(env, row.payer_uid, "messenger_call_reservation_result", "avatok", {
        authorization_id: row.authorization_id, call_id: row.call_id, attempt_id: row.attempt_id, provider: row.provider,
        media: row.media, quality_sku: row.quality_sku, price_version: row.price_version,
        reservation_action: "initial", ok: false, status: reserved.status,
      }).catch(() => undefined);
      await env.DB_WALLET.prepare(
        "UPDATE messenger_call_authorizations SET status='failed', terminal_reason=?1, ended_at=?2 WHERE authorization_id=?3 AND status='pending_consent'",
      ).bind("insufficient_balance", Date.now(), row.authorization_id).run();
      return json({ approved: false, code: "insufficient_balance", authorization_id: row.authorization_id }, 402);
    }
    void track(env, row.payer_uid, "messenger_call_reservation_result", "avatok", {
      authorization_id: row.authorization_id, call_id: row.call_id, attempt_id: row.attempt_id, provider: row.provider,
      media: row.media, quality_sku: row.quality_sku, price_version: row.price_version,
      reservation_action: "initial", ok: true, reservation_tokens: reservationTokens,
    }).catch(() => undefined);
    await env.DB_WALLET.prepare(
      "UPDATE messenger_call_authorizations SET status='authorized', reservation_ref=?1, reservation_tokens=?2, expires_at=?3 WHERE authorization_id=?4 AND status='pending_consent'",
    ).bind(reservationRef, reservationTokens, expiresAt, row.authorization_id).run();
    const updated = await existingAuthorization(env, row.payer_uid, row.attempt_id);
    if (!updated) return json({ approved: false, code: "authorization_unavailable" }, 503);
    return json({
      approved: true,
      ...pricingCatalog(config, allowanceRemaining),
      ...flattenAuthorization(updated, allowanceRemaining),
    });
  }
  if (row.status === "authorized") {
    return json({ approved: true, ...flattenAuthorization(row, allowanceRemaining) });
  }
  return json({ approved: false, code: row.status, ...flattenAuthorization(row, allowanceRemaining) }, 409);
}

export async function messengerCallAuthorize(req: Request, env: Env): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);
  void track(env, auth.uid, "messenger_call_authorization_requested", "avatok", {
    role: "caller", route: "authorize",
  }).catch(() => undefined);
  const body = await req.json().catch(() => null);
  const parsed = parseRequest(body);
  if ("error" in parsed) return json({ approved: false, code: "invalid_request", error: parsed.error }, 400);
  if (parsed.callee_uid === auth.uid) return json({ approved: false, code: "invalid_request", error: "cannot call yourself" }, 400);

  const config = await readConfig(env).catch(() => null);
  if (!config) return json({ approved: false, code: "pricing_unavailable" }, 503);
  if (config.messengerCallBillingEnabled !== true) {
    return json({ approved: false, code: "billing_disabled" }, 409);
  }

  const preview = previewMessengerAuthorization(config, parsed);
  if ("code" in preview) return json({ approved: false, ...preview }, 409);

  // Retry identity is payer + attempt. The server never accepts a client call
  // id, provider, rate, price version, or UTC day. A pending row owns the
  // consent challenge and can only be promoted with that exact challenge.
  let existing: MessengerAuthorizationRow | null;
  try { existing = await existingAuthorization(env, auth.uid, parsed.attempt_id); }
  catch { return json({ approved: false, code: "billing_storage_unavailable" }, 503); }
  if (existing) {
    if (existing.callee_uid !== parsed.callee_uid || existing.media !== parsed.media ||
      existing.quality_sku !== preview.quality_sku) {
      return json({ approved: false, code: "attempt_contract_mismatch" }, 409);
    }
    return authorizeExisting(env, existing, parsed.consent_id ?? null, config);
  }

  const day = utcDayKey();
  const usage = await messengerCallUsageStatus(env, auth.uid, {
    day,
    daily_audio_allowance_participant_seconds: config.messengerAudioFreeParticipantSecondsDaily,
  });
  if (!usage.ok) return json({ approved: false, code: "allowance_unavailable" }, usage.status >= 500 ? 503 : 409);
  const allowanceRemaining = Math.max(0, Number(usage.body?.daily_audio_allowance_remaining ?? 0));
  const selectedPreview = previewMessengerAuthorization(config, parsed, allowanceRemaining);
  if ("code" in selectedPreview) {
    return json({ approved: false, ...selectedPreview, day }, 409);
  }
  const consentCandidate = parsed.consent_id
    ? await authorizationByConsent(env, auth.uid, parsed.callee_uid, parsed.consent_id, parsed.media, selectedPreview.quality_sku as MessengerQualitySku).catch(() => null)
    : null;
  const consentNow = Date.now();
  const consentSource = consentCandidate &&
    consentCandidate.status === "pending_consent" &&
    (consentCandidate.expires_at <= 0 || consentCandidate.expires_at > consentNow) &&
    consentCandidate.provider === selectedPreview.provider &&
    consentCandidate.rate_centitokens_per_participant_minute === selectedPreview.rate_centitokens_per_participant_minute &&
    consentCandidate.price_version === selectedPreview.price_version &&
    selectedPreview.provider === "stream" && selectedPreview.rate_centitokens_per_participant_minute > 0
    ? consentCandidate : null;

  const authorizationId = crypto.randomUUID();
  const callId = crypto.randomUUID();
  const now = Date.now();
  const needsConsent = !consentSource && (parsed.media === "video" ||
    (parsed.media === "audio" && allowanceRemaining <= 0 && selectedPreview.rate_centitokens_per_participant_minute > 0));
  const consentChallenge = needsConsent ? crypto.randomUUID() : (consentSource ? parsed.consent_id : null);
  const row: MessengerAuthorizationRow = {
    authorization_id: authorizationId,
    call_id: callId,
    attempt_id: parsed.attempt_id,
    payer_uid: auth.uid,
    callee_uid: parsed.callee_uid,
    media: parsed.media,
    quality_sku: selectedPreview.quality_sku as MessengerQualitySku,
    provider: selectedPreview.provider,
    rate_centitokens_per_participant_minute: selectedPreview.rate_centitokens_per_participant_minute,
    price_version: selectedPreview.price_version,
    consent_id: consentChallenge ?? null, // [WORKER-TSC-GREEN-1] the field is `string | null`; undefined was leaking in
    allowance_day: day,
    status: needsConsent ? "pending_consent" : "authorized",
    reservation_ref: null,
    reservation_tokens: 0,
    created_at: now,
    expires_at: now + 10 * 60 * 1000,
    connected_at: null,
    ended_at: null,
    terminal_reason: null,
  };
  try {
    await insertAuthorization(env, row);
  } catch {
    // A concurrent retry may have won the unique payer/attempt insert. Return
    // the durable winner rather than minting a second call or reservation.
    const winner = await existingAuthorization(env, auth.uid, parsed.attempt_id).catch(() => null);
    if (winner) return authorizeExisting(env, winner, parsed.consent_id ?? null, config);
    return json({ approved: false, code: "billing_storage_unavailable" }, 503);
  }
  if (consentSource) {
    await env.DB_WALLET.prepare(
      "UPDATE messenger_call_authorizations SET status='cancelled', terminal_reason='superseded_by_fresh_paid_attempt', ended_at=?1 WHERE authorization_id=?2 AND status='pending_consent'",
    ).bind(now, consentSource.authorization_id).run().catch(() => undefined);
  }
  if (needsConsent) {
    void track(env, auth.uid, "messenger_call_consent_shown", "avatok", {
      authorization_id: authorizationId, call_id: callId, attempt_id: parsed.attempt_id, provider: selectedPreview.provider,
      media: parsed.media, quality_sku: selectedPreview.quality_sku, price_version: selectedPreview.price_version,
      consent_kind: parsed.media === "video" ? "video" : "paid_audio",
    }).catch(() => undefined);
    return json({
      approved: false,
      code: "consent_required",
      consent_kind: parsed.media === "video" ? "video" : "paid_audio",
      // This server-issued consent_id is the only value accepted on the
      // retry. Any client-generated/pre-generated value is ignored.
      ...pricingCatalog(config, allowanceRemaining),
      ...flattenAuthorization(row, allowanceRemaining, {
        media: parsed.media,
        quality_sku: selectedPreview.quality_sku,
        provider: selectedPreview.provider,
        rate_centitokens_per_participant_minute: selectedPreview.rate_centitokens_per_participant_minute,
        price_version: selectedPreview.price_version,
      }),
    }, 409);
  }
  void track(env, auth.uid, "messenger_call_authorization_result", "avatok", {
    authorization_id: authorizationId, call_id: callId, attempt_id: parsed.attempt_id, provider: selectedPreview.provider,
    media: parsed.media, quality_sku: selectedPreview.quality_sku, price_version: selectedPreview.price_version,
    approved: true,
  }).catch(() => undefined);
  return json({
    approved: true,
    ...pricingCatalog(config, allowanceRemaining),
    ...flattenAuthorization(row, allowanceRemaining),
  });
}

/** GET pricing for the Messenger UI. It is a read-only remote-config view. */
export async function messengerCallPricing(req: Request, env: Env): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);
  const config = await readConfig(env).catch(() => null);
  if (!config) return json({ code: "pricing_unavailable" }, 503);
  if (config.messengerCallBillingEnabled !== true) return json({ code: "billing_disabled" }, 409);
  const query = new URL(req.url).searchParams;
  const day = utcDayKey();
  const usage = await messengerCallUsageStatus(env, auth.uid, {
    day,
    daily_audio_allowance_participant_seconds: config.messengerAudioFreeParticipantSecondsDaily,
  });
  if (!usage.ok) return json({ code: "allowance_unavailable" }, usage.status >= 500 ? 503 : 409);
  const freeRemaining = Math.max(0, Number(usage.body?.daily_audio_allowance_remaining ?? 0));
  const spendableTokens = Number(usage.body?.spendable_tokens ?? 0);
  const catalog = pricingCatalog(config, freeRemaining, spendableTokens);
  if (!query.has("media") && !query.has("quality")) return json(catalog);
  const media: MessengerMedia = query.get("media") === "video" ? "video" : "audio";
  const quality = media === "audio" ? "audio" : query.get("quality");
  if (media === "video" && quality !== "sd" && quality !== "hd" && quality !== "2k" && quality !== "4k") {
    return json({ code: "invalid_quality" }, 400);
  }
  const preview = previewMessengerAuthorization(config, {
    callee_uid: auth.uid, media, quality: quality as "audio" | MessengerVideoQuality,
    attempt_id: "pricing-preview", consent_id: null,
  }, freeRemaining);
  if ("code" in preview) return json({ ...preview }, 409);
  return json({ ...catalog, ...preview });
}

/**
 * Read-only runtime state for either authenticated seat in a Messenger call.
 *
 * The DO is the live connected-time authority, but its status operation is an
 * internal server contract. This route deliberately projects only fields the
 * Flutter call HUD needs; in particular it never forwards participant rows,
 * event generations, nonces, or reservation references.
 */
export async function messengerCallBillingStatus(req: Request, env: Env): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);
  const config = await readConfig(env).catch(() => null);
  if (!config) return json({ code: "billing_unavailable" }, 503);
  if (config.messengerCallBillingEnabled !== true) return json({ code: "billing_disabled" }, 409);

  const authorizationId = new URL(req.url).searchParams.get("authorization_id") || "";
  if (!validAttemptId(authorizationId)) return json({ code: "invalid_authorization_id" }, 400);
  const row = await env.DB_WALLET.prepare(
    "SELECT authorization_id, call_id, attempt_id, payer_uid, callee_uid, media, quality_sku, provider, " +
    "rate_centitokens_per_participant_minute, price_version, allowance_day, status, reservation_ref, " +
    "reservation_tokens, expires_at, terminal_reason FROM messenger_call_authorizations " +
    "WHERE authorization_id=?1 AND (payer_uid=?2 OR callee_uid=?2) LIMIT 1",
  ).bind(authorizationId, auth.uid).first<MessengerAuthorizationRow>();
  if (!row) return json({ code: "authorization_not_found" }, 404);

  let runtime: Record<string, unknown> = {};
  try {
    const response = await messengerCallBillingStub(env, row.authorization_id).fetch(
      "https://messenger-billing/status",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "status" }) },
    );
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (response.ok && body?.ok === true && body.state && typeof body.state === "object") {
      runtime = body.state as Record<string, unknown>;
    }
  } catch {
    // A missing/unavailable DO must not expose internal errors or turn a
    // read-only HUD poll into a state mutation. D1 remains the safe fallback.
  }

  const allowanceDay = row.allowance_day || utcDayKey();
  let freeRemaining = 0;
  if (row.media === "audio") {
    const usage = await messengerCallUsageStatus(env, row.payer_uid, {
      day: allowanceDay,
      daily_audio_allowance_participant_seconds: config.messengerAudioFreeParticipantSecondsDaily,
    }).catch(() => null);
    if (usage?.ok) freeRemaining = Math.max(0, Math.trunc(Number(usage.body?.daily_audio_allowance_remaining ?? 0)));
  }

  let reservedTokens = Math.max(0, Math.trunc(Number(runtime.reserved_tokens ?? row.reservation_tokens ?? 0)));
  if (row.reservation_ref) {
    const reservation = await messengerCallReservationStatus(env, row.payer_uid, row.reservation_ref).catch(() => null);
    if (reservation?.ok) {
      reservedTokens = Math.max(0, Math.trunc(Number(reservation.body?.reserved_tokens ?? reservedTokens)));
    }
  }
  const rate = Math.max(0, Math.trunc(Number(runtime.rate_centitokens_per_participant_minute ?? row.rate_centitokens_per_participant_minute)));
  const paidRunwayWallSeconds = row.provider === "stream" && rate > 0
    ? Math.max(0, Math.floor(reservedTokens * CENTITOKEN_SECONDS_PER_TOKEN / (rate * 2)))
    : 0;
  const runtimeStatus = typeof runtime.status === "string" ? runtime.status : row.status;
  const endingReason = typeof runtime.ending_reason === "string" && runtime.ending_reason
    ? runtime.ending_reason : (row.terminal_reason || null);
  const renewalFailed = typeof endingReason === "string" && endingReason.startsWith("renewal_");
  const receipt = await env.DB_WALLET.prepare(
    "SELECT 1 AS present FROM messenger_call_receipts WHERE authorization_id=?1 LIMIT 1",
  ).bind(row.authorization_id).first<{ present: number }>();

  return json({
    authorization_id: row.authorization_id,
    call_id: row.call_id,
    media: row.media,
    quality_sku: row.quality_sku,
    provider: row.provider,
    price_version: row.price_version,
    status: runtimeStatus,
    authorization_expires_at: row.expires_at,
    free_participant_seconds_remaining: freeRemaining,
    reserved_tokens: reservedTokens,
    paid_runway_wall_seconds: paidRunwayWallSeconds,
    // Compatibility aliases consumed by the Stream call HUD decoder.
    paid_remaining_wall_seconds: paidRunwayWallSeconds,
    low_balance: runtime.low_balance_notified === 1 || runtimeStatus === "funds_exhausted" || renewalFailed,
    renewal_failed: renewalFailed,
    exhausted: runtimeStatus === "funds_exhausted" || endingReason === "free_allowance_exhausted" || endingReason === "insufficient_balance",
    funds_exhausted: runtimeStatus === "funds_exhausted" || endingReason === "free_allowance_exhausted" || endingReason === "insufficient_balance",
    exhaustion_reason: endingReason === "free_allowance_exhausted" || endingReason === "insufficient_balance" ? endingReason : null,
    end_reason: endingReason,
    ending_reason: endingReason,
    receipt_available: !!receipt,
  });
}

/** GET one immutable final receipt, scoped to the caller/payer. */
export async function messengerCallReceipt(req: Request, env: Env, authorizationId?: string): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);
  const id = authorizationId || new URL(req.url).searchParams.get("authorization_id") || "";
  if (!validAttemptId(id)) return json({ code: "invalid_authorization_id" }, 400);
  const row = await env.DB_WALLET.prepare(
    "SELECT authorization_id, call_id, payer_uid, media, quality_sku, provider, connected_wall_seconds, participant_seconds, " +
    "free_participant_seconds, paid_participant_seconds, rate_centitokens_per_participant_minute, price_version, tokens_charged, ending_reason, created_at " +
    "FROM messenger_call_receipts WHERE authorization_id=?1 AND payer_uid=?2 LIMIT 1",
  ).bind(id, auth.uid).first<Record<string, unknown>>();
  if (!row) return json({ code: "receipt_not_ready" }, 404);
  const participantSeconds = Math.max(0, Number(row.participant_seconds ?? 0));
  const freeParticipantSeconds = Math.max(0, Number(row.free_participant_seconds ?? 0));
  const paidParticipantSeconds = Math.max(0, Number(row.paid_participant_seconds ?? 0));
  const createdRaw = row.created_at;
  const createdNumeric = typeof createdRaw === "number" ? createdRaw : Number(createdRaw);
  const createdAtMs = Number.isFinite(createdNumeric)
    ? Math.max(0, createdNumeric)
    : Math.max(0, Date.parse(String(createdRaw ?? "")) || 0);
  const publicReceipt = {
    ...row,
    participant_count: 2,
    participant_minutes: participantSeconds / 60,
    free_participant_minutes: freeParticipantSeconds / 60,
    paid_participant_minutes: paidParticipantSeconds / 60,
    ended_reason: row.ending_reason ?? "",
    settlement_status: "settled",
    created_at: new Date(createdAtMs).toISOString(),
    created_at_ms: createdAtMs,
  };
  return json({ ...publicReceipt, receipt: publicReceipt });
}

/**
 * Cancel a caller-owned authorization. When the provider outcome is uncertain,
 * keep the reservation and move the row to reconciliation_pending; releasing
 * in that state could leave a provider call live and unmetered. A webhook or
 * reaper must later call this again with providerConfirmed=true.
 */
export async function cancelMessengerCallAuthorization(
  env: Env,
  payerUid: string,
  authorizationId: string,
  reason: string,
  providerConfirmed = true,
): Promise<boolean> {
  const row = await env.DB_WALLET.prepare(
    "SELECT authorization_id, payer_uid, reservation_ref, status FROM messenger_call_authorizations WHERE authorization_id=?1 AND payer_uid=?2 LIMIT 1",
  ).bind(authorizationId, payerUid).first<Pick<MessengerAuthorizationRow, "authorization_id" | "payer_uid" | "reservation_ref" | "status">>();
  if (!row) return false;
  const nextStatus = providerConfirmed ? "cancelled" : "reconciliation_pending";
  const eligibleStatuses = providerConfirmed
    ? "'pending_consent','authorized','connected','reconciliation_pending'"
    : "'pending_consent','authorized','connected'";
  await env.DB_WALLET.prepare(
    `UPDATE messenger_call_authorizations SET status=CASE WHEN status IN (${eligibleStatuses}) THEN ?1 ELSE status END, terminal_reason=?2, ended_at=CASE WHEN ?1='reconciliation_pending' THEN ended_at ELSE COALESCE(ended_at,?3) END WHERE authorization_id=?4 AND payer_uid=?5`,
  ).bind(nextStatus, reason.slice(0, 128), Date.now(), authorizationId, payerUid).run();
  if (providerConfirmed && row.reservation_ref) {
    await releaseMessengerCallReservation(
      env, payerUid, row.reservation_ref, `${row.reservation_ref}:release:${reason.slice(0, 64)}`,
    ).catch(() => undefined);
  }
  return true;
}

/** Mark a provider operation as uncertain without releasing caller funds. */
export async function markMessengerCallReconciliationPending(
  env: Env,
  payerUid: string,
  authorizationId: string,
  reason: string,
): Promise<boolean> {
  return cancelMessengerCallAuthorization(env, payerUid, authorizationId, reason, false);
}
