// Phase 2 commercial live events and 1:1 consultations on GetStream.
// Separate authority from Messenger and legacy Cloudflare media routes.

import type { Env } from "../types";
import { isFail, requireUser } from "../authz";
import { metaDb } from "../db/shard";
import { json } from "../util";
import { readConfig, type PlatformConfig } from "./config";
import {
  commercialJoinEnabled,
  commercialProviderIdentity,
  type CommercialSessionKind,
} from "../lib/commercial_stream_sessions";
import { commercialEvent } from "../lib/commercial_telemetry";
// [LIST-APPROVAL-AUTH-1] Read-only import of the system-actor listing transition
// landed in fa44bc21. This file only CALLS it from the provider-confirmed webhook
// path below — it does not own or edit listings.ts.
import { systemMarkListingLive } from "./listings";
import { hold, refund } from "../ledger";
import { notifyLiveAudience } from "../lib/commercial_notifications";
import { refreshCreatorStats } from "../lib/creator_stats"; // [LIST-STATS-1]
import {
  freeSessionPolicy, holdFreeSessionCap, settleFreeSession,
  countFreeWatching, trackFreeSessionJoinRefused, type FreeSessionKind,
} from "../lib/free_session"; // [LIST-FREE-1]

const USER_TOKEN_TTL_SECONDS = 15 * 60;

type ListingRow = {
  id: string;
  creator_id: string;
  kind: string;
  title: string;
  status: string;
  starts_at: number | null;
  duration_min: number | null;
  free_entry: number | null; // [LIST-FREE-1]
  attrs: string | null;
  capacity: number | null;
};

type BookingRow = {
  id: string;
  listing_id: string;
  creator_id: string;
  buyer_id: string;
  kind: string;
  status: string;
  starts_at: number;
  ends_at: number;
  order_id: string | null;
  title: string;
};

type ExtensionRow = {
  extension_id: string;
  commercial_session_id: string;
  booking_id: string;
  listing_id: string;
  base_order_id: string;
  extension_order_id: string;
  buyer_id: string;
  creator_id: string;
  base_ends_at: number;
  extension_ends_at: number;
  extension_minutes: number;
  rate_per_minute: number;
  amount: number;
  currency: string;
  policy_version: string;
  state: string;
  creator_consented_at: number | null;
  buyer_consented_at: number | null;
};

function b64url(value: Uint8Array | string): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function signJwt(secret: string, payload: Record<string, unknown>): Promise<string> {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC", key, new TextEncoder().encode(`${header}.${body}`),
  );
  return `${header}.${body}.${b64url(new Uint8Array(signature))}`;
}

function streamChatBindings(env: Env): { apiKey: string; apiSecret: string } | null {
  const apiKey = env.STREAM_CHAT_API_KEY ?? env.STREAM_VIDEO_API_KEY ?? "";
  const apiSecret = env.STREAM_CHAT_API_SECRET ?? env.STREAM_VIDEO_API_SECRET ?? "";
  return apiKey && apiSecret ? { apiKey, apiSecret } : null;
}

function streamVideoBindings(env: Env): { apiKey: string; apiSecret: string } | null {
  const apiKey = env.STREAM_VIDEO_API_KEY ?? "";
  const apiSecret = env.STREAM_VIDEO_API_SECRET ?? "";
  return apiKey && apiSecret ? { apiKey, apiSecret } : null;
}

function configured(env: Env): env is Env {
  return Boolean(streamVideoBindings(env) && streamChatBindings(env));
}

async function providerTokens(bindings: { apiSecret: string }, uid: string): Promise<{ server: string; user: string; expiresAt: number }> {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + USER_TOKEN_TTL_SECONDS;
  const [server, user] = await Promise.all([
    signJwt(bindings.apiSecret, { server: true, iat: now, exp: expiresAt }),
    signJwt(bindings.apiSecret, { user_id: uid, iat: now, exp: expiresAt }),
  ]);
  return { server, user, expiresAt };
}

async function chatToken(env: Env, uid: string, payload: Record<string, unknown>): Promise<string | null> {
  const bindings = streamChatBindings(env);
  if (!bindings) return null;
  const now = Math.floor(Date.now() / 1000);
  return await signJwt(bindings.apiSecret, { user_id: uid, iat: now, exp: now + USER_TOKEN_TTL_SECONDS, ...payload });
}

function providerUrl(env: Env, callType: string, callId: string, suffix = ""): string {
  return `https://video.stream-io-api.com/api/v2/video/call/${encodeURIComponent(callType)}/${encodeURIComponent(callId)}${suffix}?api_key=${encodeURIComponent(env.STREAM_VIDEO_API_KEY ?? "")}`;
}

function commercialChatChannel(args: {
  kind: CommercialSessionKind;
  listingId: string;
  bookingId?: string | null;
  sessionId: string;
  role: "host" | "viewer" | "creator" | "buyer";
}): { channel_type: string; channel_id: string; permissions: string[] } {
  const channelId = args.kind === "live_event"
    ? `commercial-live:${args.listingId}`
    : `commercial-consult:${args.bookingId}`;
  const moderator = args.role === "host" || args.role === "creator";
  return {
    channel_type: "livestream",
    channel_id: channelId,
    permissions: moderator
      ? ["read", "write", "react", "report", "mute", "block", "moderate", "ban", "delete_any"]
      : ["read", "write", "react", "report", "mute", "block"],
  };
}

async function upsertProviderUser(
  env: Env,
  serverToken: string,
  uid: string,
): Promise<boolean> {
  const response = await fetch(
    `https://video.stream-io-api.com/api/v2/users?api_key=${encodeURIComponent(env.STREAM_VIDEO_API_KEY ?? "")}`,
    {
      method: "POST",
      headers: { Authorization: serverToken, "Content-Type": "application/json", "stream-auth-type": "jwt" },
      body: JSON.stringify({ users: { [uid]: { id: uid, role: "user" } } }),
    },
  );
  return response.ok;
}

async function createProviderCall(args: {
  env: Env;
  serverToken: string;
  callType: string;
  callId: string;
  creatorId: string;
  kind: CommercialSessionKind;
  memberIds: string[];
  startsAt: number;
}): Promise<boolean> {
  const response = await fetch(providerUrl(args.env, args.callType, args.callId), {
    method: "POST",
    headers: { Authorization: args.serverToken, "Content-Type": "application/json", "stream-auth-type": "jwt" },
    body: JSON.stringify({
      data: {
        created_by_id: args.creatorId,
        starts_at: new Date(args.startsAt).toISOString(),
        members: args.memberIds.map((userId) => ({
          user_id: userId,
          ...(userId === args.creatorId ? { role: "host" } : {}),
        })),
        custom: { lane: "commercial", kind: args.kind, avatok_call_type: args.callType },
      },
    }),
  });
  return response.ok;
}

async function addProviderMember(args: {
  env: Env;
  serverToken: string;
  callType: string;
  callId: string;
  uid: string;
}): Promise<boolean> {
  const response = await fetch(providerUrl(args.env, args.callType, args.callId, "/members"), {
    method: "POST",
    headers: { Authorization: args.serverToken, "Content-Type": "application/json", "stream-auth-type": "jwt" },
    body: JSON.stringify({ update_members: [{ user_id: args.uid }] }),
  });
  return response.ok;
}

async function providerControl(args: {
  env: Env;
  callType: string;
  callId: string;
  action: "go_live" | "mark_ended";
  body?: Record<string, unknown>;
}): Promise<{ confirmed: boolean; uncertain: boolean; status: number | null }> {
  try {
    const bindings = streamVideoBindings(args.env);
    if (!bindings) return { confirmed: false, uncertain: true, status: null };
    const token = (await providerTokens(bindings, "server-control")).server;
    const response = await fetch(
      providerUrl(args.env, args.callType, args.callId, `/${args.action}`),
      {
        method: "POST",
        headers: {
          Authorization: token,
          "stream-auth-type": "jwt",
          ...(args.body ? { "Content-Type": "application/json" } : {}),
        },
        body: args.body ? JSON.stringify(args.body) : undefined,
      },
    );
    return {
      confirmed: response.ok,
      uncertain: response.status >= 500 || response.status === 429,
      status: response.status,
    };
  } catch {
    return { confirmed: false, uncertain: true, status: null };
  }
}

async function listing(env: Env, listingId: string): Promise<ListingRow | null> {
  return await metaDb(env).prepare(
    "SELECT id, creator_id, kind, title, status, starts_at, duration_min, free_entry, attrs, capacity FROM listings WHERE id=?1",
  ).bind(listingId).first<ListingRow>();
}

async function booking(env: Env, bookingId: string): Promise<BookingRow | null> {
  return await metaDb(env).prepare(
    `SELECT b.id, b.listing_id, b.creator_id, b.buyer_id, b.kind, b.status,
            b.starts_at, b.ends_at, b.order_id, COALESCE(l.title,'Consultation') title
       FROM bookings b LEFT JOIN listings l ON l.id=b.listing_id WHERE b.id=?1`,
  ).bind(bookingId).first<BookingRow>();
}

function idFrom(req: Request, kind: "live" | "consult"): string | null {
  const expression = kind === "live"
    ? /^\/api\/commercial\/live\/([A-Za-z0-9-]{1,64})\//
    : /^\/api\/commercial\/consult\/([A-Za-z0-9-]{1,64})\//;
  return new URL(req.url).pathname.match(expression)?.[1] ?? null;
}

function joinWindow(config: PlatformConfig, kind: CommercialSessionKind, startsAt: number, endsAt: number): {
  opensAt: number;
  closesAt: number;
} {
  return kind === "live_event"
    ? {
      opensAt: startsAt - config.commercialLiveBackstageEarlyMin * 60_000,
      closesAt: endsAt + config.commercialLiveStartGraceMin * 60_000,
    }
    : {
      opensAt: startsAt - config.commercialConsultJoinEarlyMin * 60_000,
      closesAt: endsAt + config.commercialConsultJoinLateMin * 60_000,
    };
}

/**
 * [COMM-CONSULT-ENT-1] `role` is REQUIRED, and it is a filter, not a post-check.
 *
 * This lookup used to be role-blind — `ORDER BY created_at DESC LIMIT 1` over every row
 * for the uid — and every caller then compared `grant.role` to the role it expected. That
 * was safe only while one account could hold at most one entitlement per booking. Since
 * checkout now also writes the creator's row, a creator who books their OWN consult holds
 * two rows for the same (kind, listing, booking, account) that differ only by role, both
 * stamped with the same `created_at`. The old query would return an arbitrary one of them
 * and the caller's own role check would then 409 the session, intermittently, with a
 * "authority mismatch" that describes nothing real.
 *
 * Filtering on role makes the query return the row the caller is asking about or nothing
 * at all, which is what every call site actually meant.
 */
async function entitlement(env: Env, args: {
  kind: CommercialSessionKind;
  listingId: string;
  bookingId?: string | null;
  uid: string;
  role: string;
}): Promise<{ entitlement_id: string; order_id: string | null; role: string } | null> {
  return await metaDb(env).prepare(
    `SELECT entitlement_id, order_id, role FROM commercial_entitlements
      WHERE kind=?1 AND listing_id=?2 AND COALESCE(booking_id,'')=COALESCE(?3,'')
        AND account_id=?4 AND role=?5 AND state IN ('reserved','held','active','consumed')
      ORDER BY created_at DESC LIMIT 1`,
  ).bind(args.kind, args.listingId, args.bookingId ?? null, args.uid, args.role)
    .first<{ entitlement_id: string; order_id: string | null; role: string }>();
}

async function authorizeProviderJoin(args: {
  env: Env;
  config: PlatformConfig;
  uid: string;
  kind: CommercialSessionKind;
  listingId: string;
  bookingId?: string | null;
  creatorId: string;
  startsAt: number;
  endsAt: number;
  title: string;
  entitlementId: string;
  role: "host" | "viewer" | "creator" | "buyer";
  orderId?: string | null;
}): Promise<Response> {
  const refused = (reason: string, body: Record<string, unknown>, status: number): Response => {
    commercialEvent(args.env, "join", args.uid, { kind: args.kind, outcome: "refused", reason });
    return json(body, status);
  };
  if (!commercialJoinEnabled(args.kind, args.config)) return refused("join_disabled", { error: "commercial join disabled" }, 404);
  if (!configured(args.env)) return refused("provider_unavailable", { error: "commercial media unavailable" }, 503);
  const now = Date.now();
  const window = joinWindow(args.config, args.kind, args.startsAt, args.endsAt);
  if (now < window.opensAt) return refused("too_early", { error: "too early", opens_at: window.opensAt }, 425);
  if (now > window.closesAt) return refused("too_late", { error: "session unavailable" }, 410);

  const identity = commercialProviderIdentity({
    kind: args.kind,
    listingId: args.listingId,
    bookingId: args.bookingId,
    sessionVersion: 1,
  });
  const sessionId = args.kind === "live_event"
    ? `live_${args.listingId}_1`
    : `consult_${args.bookingId}`;
  const videoBindings = streamVideoBindings(args.env);
  if (!videoBindings) return refused("provider_unavailable", { error: "commercial media unavailable" }, 503);
  const tokens = await providerTokens(videoBindings, args.uid);
  if (!await upsertProviderUser(args.env, tokens.server, args.uid)) {
    return refused("provider_user_unavailable", { error: "provider user unavailable" }, 502);
  }

  const existing = await metaDb(args.env).prepare(
    `SELECT commercial_session_id,kind,listing_id,booking_id,creator_id,state
       FROM commercial_sessions WHERE provider=?1 AND provider_call_type=?2 AND provider_call_id=?3`,
  ).bind(identity.provider, identity.callType, identity.callId).first<{
    commercial_session_id: string;
    kind: string;
    listing_id: string;
    booking_id: string | null;
    creator_id: string;
    state: string;
  }>();
  if (existing && (
    existing.commercial_session_id !== sessionId
    || existing.kind !== args.kind
    || existing.listing_id !== args.listingId
    || (existing.booking_id ?? null) !== (args.bookingId ?? null)
    || existing.creator_id !== args.creatorId
  )) return refused("session_authority_mismatch", { error: "commercial session authority mismatch" }, 409);

  if (!existing) {
    const members = args.kind === "consult_1to1"
      ? [args.creatorId, args.uid]
      : [args.creatorId];
    for (const memberId of new Set(members)) {
      if (!await upsertProviderUser(args.env, tokens.server, memberId)) {
        return refused("provider_user_unavailable", { error: "provider user unavailable" }, 502);
      }
    }
    if (!await createProviderCall({
      env: args.env,
      serverToken: tokens.server,
      callType: identity.callType,
      callId: identity.callId,
      creatorId: args.creatorId,
      kind: args.kind,
      memberIds: [...new Set(members)],
      startsAt: args.startsAt,
    })) return refused("provider_call_unavailable", { error: "provider call unavailable" }, 502);

    const insertedAt = Date.now();
    await metaDb(args.env).prepare(
      `INSERT OR IGNORE INTO commercial_sessions
       (commercial_session_id,kind,listing_id,booking_id,order_id,creator_id,provider,
        provider_call_type,provider_call_id,session_version,scheduled_at,state,state_version,
        settlement_state,recording_state,replay_state,created_at,updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,1,?10,'scheduled',1,'not_ready',?11,?12,?13,?13)`,
    ).bind(
      // [COMM-LIVE-AUTH-1] consult_1to1 genuinely IS one order, so the session may carry
      // it. A live_event is one session over N tickets and must carry NULL — writing the
      // first joiner's order here is what locked every other ticket holder out.
      sessionId, args.kind, args.listingId, args.bookingId ?? null,
      args.kind === "consult_1to1" ? (args.orderId ?? null) : null,
      args.creatorId, identity.provider, identity.callType, identity.callId, args.startsAt,
      args.config.commercialRecordingEnabled ? "requested" : "disabled",
      args.config.commercialReplayEnabled ? "processing" : "disabled", insertedAt,
    ).run();
  }

  // INSERT OR IGNORE is only an idempotency primitive. Read the durable row
  // back before issuing provider credentials so a concurrent/colliding insert
  // can never authorize against a different commercial session authority.
  const persistedSession = await metaDb(args.env).prepare(
    `SELECT commercial_session_id,kind,listing_id,booking_id,order_id,creator_id,
       provider,provider_call_type,provider_call_id,scheduled_at,state
       FROM commercial_sessions WHERE commercial_session_id=?1`,
  ).bind(sessionId).first<{
    commercial_session_id: string;
    kind: string;
    listing_id: string;
    booking_id: string | null;
    order_id: string | null;
    creator_id: string;
    provider: string;
    provider_call_type: string;
    provider_call_id: string;
    scheduled_at: number;
    state: string;
  }>();
  // [COMM-LIVE-AUTH-1] order_id is NOT part of session authority — see the migration
  // 2026-08-29-commercial-member-order-id.sql for the full reasoning. Short version: a
  // live event has ONE session and N ticket purchases, so comparing the shared session's
  // order_id against the joiner's ticket refused every buyer after the first, and refused
  // ALL of them when the host (whose entitlement carries order_id NULL) joined first.
  // Every remaining field below derives from the listing, not from a buyer, so the
  // guarantee this check exists for — that a concurrent insert cannot authorize against a
  // different session — is intact.
  if (!persistedSession
    || persistedSession.commercial_session_id !== sessionId
    || persistedSession.kind !== args.kind
    || persistedSession.listing_id !== args.listingId
    || (persistedSession.booking_id ?? null) !== (args.bookingId ?? null)
    || persistedSession.creator_id !== args.creatorId
    || persistedSession.provider !== identity.provider
    || persistedSession.provider_call_type !== identity.callType
    || persistedSession.provider_call_id !== identity.callId
    || Number(persistedSession.scheduled_at) !== Number(args.startsAt)) {
    return refused("session_authority_mismatch", { error: "commercial session authority mismatch" }, 409);
  }
  if (["ended", "cancelled"].includes(persistedSession.state)) {
    return refused("session_terminal", { error: "session unavailable" }, 410);
  }

  if (args.kind === "live_event" && args.uid !== args.creatorId && !await addProviderMember({
    env: args.env,
    serverToken: tokens.server,
    callType: identity.callType,
    callId: identity.callId,
    uid: args.uid,
  })) return refused("provider_admission_unavailable", { error: "provider admission unavailable" }, 502);

  await metaDb(args.env).batch([
    metaDb(args.env).prepare(
      // [COMM-LIVE-AUTH-1] The per-ticket order lives HERE, one row per joiner, instead
      // of on the shared session row. This is the audit trail the session-row check was
      // reaching for, at a grain that does not constrain anyone else's admission.
      `INSERT OR IGNORE INTO commercial_session_members
       (commercial_session_id,account_id,entitlement_id,provider_user_id,role,order_id,added_at)
       VALUES (?1,?2,?3,?2,?4,?5,?6)`,
    ).bind(sessionId, args.uid, args.entitlementId, args.role, args.orderId ?? null, Date.now()),
    metaDb(args.env).prepare(
      "UPDATE commercial_entitlements SET state='active', updated_at=?2 WHERE entitlement_id=?1 AND state IN ('reserved','held')",
    ).bind(args.entitlementId, Date.now()),
  ]);
  const member = await metaDb(args.env).prepare(
    `SELECT entitlement_id,provider_user_id,role,order_id,removed_at
       FROM commercial_session_members WHERE commercial_session_id=?1 AND account_id=?2`,
  ).bind(sessionId, args.uid).first<{
    entitlement_id: string;
    provider_user_id: string;
    role: string;
    order_id: string | null;
    removed_at: number | null;
  }>();
  // [COMM-LIVE-AUTH-1] order_id is verified HERE, per member, which is the check the
  // session-row comparison was trying to be. Per member it is a real constraint (this
  // person was admitted on this ticket); on the shared row it was a lockout.
  if (!member
    || member.entitlement_id !== args.entitlementId
    || member.provider_user_id !== args.uid
    || member.role !== args.role
    || (member.order_id ?? null) !== (args.orderId ?? null)
    || member.removed_at !== null) {
    return refused("membership_authority_mismatch", { error: "commercial membership authority mismatch" }, 409);
  }

  const chat = commercialChatChannel({
    kind: args.kind,
    listingId: args.listingId,
    bookingId: args.bookingId ?? null,
    sessionId: sessionId,
    role: args.role,
  });
  const chatBindings = streamChatBindings(args.env);
  if (!chatBindings) return refused("provider_unavailable", { error: "commercial media unavailable" }, 503);
  const chatTokenValue = await chatToken(args.env, args.uid, {
    entitlement_id: args.entitlementId,
    session_id: sessionId,
    commercial_kind: args.kind,
    commercial_role: args.role,
    commercial_channel_id: chat.channel_id,
  });
  if (!chatTokenValue) return refused("provider_unavailable", { error: "commercial media unavailable" }, 503);
  commercialEvent(args.env, "join", args.uid, { kind: args.kind, outcome: "authorized", role: args.role });
  return json({
    ok: true,
    lane: "commercial",
    provider: "getstream",
    kind: args.kind,
    session_id: sessionId,
    api_key: args.env.STREAM_VIDEO_API_KEY,
    user_id: args.uid,
    token: tokens.user,
    token_expires_at: tokens.expiresAt,
    expires_at_ms: tokens.expiresAt * 1000,
    call_type: identity.callType,
    call_id: identity.callId,
    role: args.role,
    chat: {
      ...chat,
      api_key: chatBindings.apiKey,
      user_id: args.uid,
      token: chatTokenValue,
      token_expires_at: tokens.expiresAt,
      session_id: sessionId,
      entitlement_id: args.entitlementId,
      role: args.role,
    },
    opens_at: window.opensAt,
    closes_at: window.closesAt,
    title: args.title,
  });
}

async function commercialLiveJoinUnsafe(req: Request, env: Env): Promise<Response> {
  const listingId = idFrom(req, "live");
  if (!listingId) return json({ error: "bad listing id" }, 400);
  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);
  const config = await readConfig(env);
  if (config.commercialLiveJoinEnabled !== true) {
    return json({ error: "commercial join disabled" }, 404);
  }
  const row = await listing(env, listingId);
  if (!row || row.kind !== "live_event" || !["published", "live"].includes(row.status)) {
    return json({ error: "listing unavailable" }, 404);
  }
  const startsAt = Number(row.starts_at);
  const endsAt = startsAt + Number(row.duration_min ?? 60) * 60_000;
  const isHost = row.creator_id === auth.uid;
  if (isHost) {
    const now = Date.now();
    await metaDb(env).prepare(
      `INSERT OR IGNORE INTO commercial_entitlements
       (entitlement_id,kind,listing_id,booking_id,order_id,account_id,role,state,
        starts_at,ends_at,created_at,updated_at)
       VALUES (?1,'live_event',?2,NULL,NULL,?3,'host','active',?4,?5,?6,?6)`,
    ).bind(`host:${listingId}`, listingId, auth.uid, startsAt, endsAt, now).run();
    const hostGrant = await metaDb(env).prepare(
      `SELECT entitlement_id,kind,listing_id,booking_id,order_id,account_id,role,state,
         starts_at,ends_at FROM commercial_entitlements WHERE entitlement_id=?1`,
    ).bind(`host:${listingId}`).first<{
      entitlement_id: string;
      kind: string;
      listing_id: string;
      booking_id: string | null;
      order_id: string | null;
      account_id: string;
      role: string;
      state: string;
      starts_at: number | null;
      ends_at: number | null;
    }>();
    if (!hostGrant
      || hostGrant.entitlement_id !== `host:${listingId}`
      || hostGrant.kind !== "live_event"
      || hostGrant.listing_id !== listingId
      || hostGrant.booking_id !== null
      || hostGrant.order_id !== null
      || hostGrant.account_id !== auth.uid
      || hostGrant.role !== "host"
      || hostGrant.state !== "active"
      || Number(hostGrant.starts_at) !== startsAt
      || Number(hostGrant.ends_at) !== endsAt) {
      return json({ error: "commercial entitlement authority mismatch" }, 409);
    }
  }
  const grant = await entitlement(env, {
    kind: "live_event", listingId, uid: auth.uid, role: isHost ? "host" : "viewer",
  });
  if (!grant) return json({ error: "ticket required" }, 403);
  if (grant.role !== (isHost ? "host" : "viewer")) {
    commercialEvent(env, "join", auth.uid, { kind: "live_event", outcome: "refused", reason: "entitlement_role_mismatch" });
    return json({ error: "commercial entitlement authority mismatch" }, 409);
  }
  // [LIST-FREE-1] Free lane join gate — spec §E.5. The checkout-time gate
  // (commercial_checkout.ts) already caps total tickets issued; this is the SEPARATE
  // live-attendance gate, read off the same "watching" source the card uses
  // (listings.ts cardStatsFor), because a ticket holder who already left and rejoins
  // should not be double-refused by a ticket-count check. Host joins are never gated —
  // only viewers consume the creator's metered spend.
  if (!isHost && Number(row.free_entry) === 1) {
    const policy = await freeSessionPolicy(env, row);
    if (!policy.enabled) {
      commercialEvent(env, "join", auth.uid, { kind: "live_event", outcome: "refused", reason: "free_sessions_disabled" });
      return json({ error: "free_sessions_disabled" }, 403);
    }
    const watching = await countFreeWatching(env, listingId);
    if (watching >= policy.maxAttendees) {
      trackFreeSessionJoinRefused(env, { creatorId: row.creator_id, sessionId: `live_${listingId}_1`, maxAttendees: policy.maxAttendees, currentCount: watching });
      commercialEvent(env, "join", auth.uid, { kind: "live_event", outcome: "refused", reason: "free_session_full" });
      return json({ error: "free_session_full", message: "this free session is full" }, 409);
    }
  }
  return await authorizeProviderJoin({
    env, config, uid: auth.uid, kind: "live_event", listingId,
    creatorId: row.creator_id, startsAt, endsAt, title: row.title,
    entitlementId: grant.entitlement_id,
    role: isHost ? "host" : "viewer",
    orderId: grant.order_id,
  });
}

export async function commercialConsultPrejoin(req: Request, env: Env): Promise<Response> {
  const bookingId = idFrom(req, "consult");
  if (!bookingId) return json({ error: "bad booking id" }, 400);
  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);
  const config = await readConfig(env);
  if (config.commercialConsultJoinEnabled !== true) {
    return json({ error: "commercial join disabled" }, 404);
  }
  const row = await booking(env, bookingId);
  if (!row || row.kind !== "consult_1to1") return json({ error: "booking unavailable" }, 404);
  if (auth.uid !== row.creator_id && auth.uid !== row.buyer_id) return json({ error: "not your booking" }, 403);
  if (!["confirmed", "completed"].includes(row.status)) return json({ error: "booking unavailable" }, 409);
  const window = joinWindow(config, "consult_1to1", Number(row.starts_at), Number(row.ends_at));
  return json({
    ok: true, lane: "commercial", kind: "consult_1to1", booking_id: row.id,
    listing_id: row.listing_id, title: row.title, starts_at: Number(row.starts_at),
    ends_at: Number(row.ends_at), opens_at: window.opensAt, closes_at: window.closesAt,
    join_enabled: config.commercialConsultJoinEnabled === true,
    role: auth.uid === row.creator_id ? "creator" : "buyer",
  });
}

async function commercialConsultJoinUnsafe(req: Request, env: Env): Promise<Response> {
  const bookingId = idFrom(req, "consult");
  if (!bookingId) return json({ error: "bad booking id" }, 400);
  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);
  const config = await readConfig(env);
  if (config.commercialConsultJoinEnabled !== true) {
    return json({ error: "commercial join disabled" }, 404);
  }
  const row = await booking(env, bookingId);
  if (!row || row.kind !== "consult_1to1") return json({ error: "booking unavailable" }, 404);
  const isCreator = auth.uid === row.creator_id;
  if (!isCreator && auth.uid !== row.buyer_id) return json({ error: "not your booking" }, 403);
  if (row.status !== "confirmed") return json({ error: "booking unavailable" }, 409);
  const grant = await entitlement(env, {
    kind: "consult_1to1", listingId: row.listing_id, bookingId, uid: auth.uid,
    role: isCreator ? "creator" : "buyer",
  });
  if (!grant) return json({ error: "booking entitlement required" }, 403);
  if (grant.role !== (isCreator ? "creator" : "buyer")) {
    commercialEvent(env, "join", auth.uid, { kind: "consult_1to1", outcome: "refused", reason: "entitlement_role_mismatch" });
    return json({ error: "commercial entitlement authority mismatch" }, 409);
  }
  return await authorizeProviderJoin({
    env, config, uid: auth.uid, kind: "consult_1to1", listingId: row.listing_id,
    bookingId, creatorId: row.creator_id, startsAt: Number(row.starts_at),
    endsAt: Number(row.ends_at), title: row.title, entitlementId: grant.entitlement_id,
    role: isCreator ? "creator" : "buyer", orderId: row.order_id,
  });
}

function extensionConfig(config: PlatformConfig): { minutes: number; rate: number } | null {
  const minutes = Math.trunc(Number(config.commercialConsultExtensionMinutes));
  const rate = Math.trunc(Number(config.commercialConsultExtensionRate));
  return config.commercialConsultExtensionEnabled === true && minutes > 0 && rate > 0
    ? { minutes, rate }
    : null;
}

async function extensionBooking(env: Env, bookingId: string, uid: string): Promise<{
  booking: BookingRow;
  session: SessionAuthority;
  policy: Record<string, unknown> & { policy_snapshot_id: string; order_id: string; gross_amount: number; currency: string; creator_fee_pct: number; settlement_hold_hours: number; platform_fee_amount: number; creator_amount: number; cancellation_policy_json: string; policy_version: string };
} | Response> {
  const bookingRow = await booking(env, bookingId);
  if (!bookingRow || bookingRow.kind !== "consult_1to1") return json({ error: "booking unavailable" }, 404);
  if (uid !== bookingRow.creator_id && uid !== bookingRow.buyer_id) return json({ error: "not your booking" }, 403);
  if (bookingRow.status !== "confirmed") return json({ error: "session is not active" }, 409);
  const session = await sessionByBooking(env, bookingId);
  if (!session || session.kind !== "consult_1to1") return json({ error: "session unavailable" }, 409);
  if (session.state !== "live") return json({ error: "session is not live" }, 409);
  if (Date.now() >= Number(bookingRow.ends_at)) return json({ error: "session has ended" }, 409);
  const policy = await metaDb(env).prepare(
    `SELECT policy_snapshot_id,order_id,gross_amount,currency,creator_fee_pct,
       settlement_hold_hours,platform_fee_amount,creator_amount,
       cancellation_policy_json,policy_version
     FROM commercial_policy_snapshots WHERE order_id=?1 AND booking_id=?2 LIMIT 1`,
  ).bind(session.order_id, bookingId).first<any>();
  if (!policy) return json({ error: "immutable policy unavailable" }, 503);
  return { booking: bookingRow, session, policy };
}

function extensionResponse(row: ExtensionRow): Record<string, unknown> {
  return {
    ok: true,
    extension_id: row.extension_id,
    booking_id: row.booking_id,
    session_id: row.commercial_session_id,
    extension_minutes: Number(row.extension_minutes),
    amount: Number(row.amount),
    currency: row.currency,
    policy_version: row.policy_version,
    base_ends_at: Number(row.base_ends_at),
    extension_ends_at: Number(row.extension_ends_at),
    rate_per_minute: Number(row.rate_per_minute),
    state: row.state,
    creator_consented: row.creator_consented_at !== null,
    buyer_consented: row.buyer_consented_at !== null,
  };
}

async function extensionScheduleConflict(
  env: Env,
  row: Pick<ExtensionRow, "booking_id" | "creator_id" | "buyer_id" | "base_ends_at">,
  newEnd: number,
): Promise<boolean> {
  const calendarConflict = await metaDb(env).prepare(
    `SELECT 1 FROM calendar_blocks
     WHERE user_id IN (?1,?2) AND status='busy' AND starts_at < ?4 AND ends_at > ?3
       AND source_ref NOT IN (?5,?6) LIMIT 1`,
  ).bind(row.creator_id, row.buyer_id, row.base_ends_at, newEnd,
    `commercial:${row.booking_id}:creator`, `commercial:${row.booking_id}:buyer`).first();
  if (calendarConflict) return true;
  const bookingConflict = await metaDb(env).prepare(
    `SELECT 1 FROM bookings
     WHERE id<>?1 AND status IN ('confirmed','completed') AND starts_at < ?3 AND ends_at > ?2
       AND (creator_id=?4 OR buyer_id=?4 OR creator_id=?5 OR buyer_id=?5) LIMIT 1`,
  ).bind(row.booking_id, row.base_ends_at, newEnd, row.creator_id, row.buyer_id).first();
  return Boolean(bookingConflict);
}

export async function commercialConsultExtensionQuote(req: Request, env: Env): Promise<Response> {
  const bookingId = idFrom(req, "consult");
  if (!bookingId) return json({ error: "bad booking id" }, 400);
  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);
  const config = await readConfig(env);
  const pricing = extensionConfig(config);
  if (!pricing) return json({ error: "commercial extension unavailable" }, 404);
  const authority = await extensionBooking(env, bookingId, auth.uid);
  if (authority instanceof Response) return authority;
  const { booking: bk, session, policy } = authority;
  const extensionId = `commercial-extension:${bookingId}:${Number(bk.ends_at)}:${pricing.minutes}`;
  const extensionOrderId = `commercial-extension-order:${bookingId}:${Number(bk.ends_at)}:${pricing.minutes}`;
  const now = Date.now();
  try {
    await metaDb(env).prepare(
      `INSERT OR IGNORE INTO commercial_consult_extensions
       (extension_id,commercial_session_id,booking_id,listing_id,base_order_id,extension_order_id,
        buyer_id,creator_id,base_ends_at,extension_ends_at,extension_minutes,rate_per_minute,amount,currency,policy_version,state,created_at,updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,'proposed',?16,?16)`,
    ).bind(extensionId, session.commercial_session_id, bookingId, bk.listing_id, session.order_id,
      extensionOrderId, bk.buyer_id, bk.creator_id, Number(bk.ends_at),
      Number(bk.ends_at) + pricing.minutes * 60_000, pricing.minutes, pricing.rate,
      pricing.minutes * pricing.rate, String(policy.currency), `${policy.policy_version}:extension`, now).run();
    const row = await metaDb(env).prepare(
      `SELECT extension_id,commercial_session_id,booking_id,listing_id,base_order_id,extension_order_id,
       buyer_id,creator_id,base_ends_at,extension_ends_at,extension_minutes,rate_per_minute,amount,currency,policy_version,state,
       creator_consented_at,buyer_consented_at FROM commercial_consult_extensions WHERE extension_id=?1`,
    ).bind(extensionId).first<ExtensionRow>();
    if (!row) return json({ error: "extension quote unavailable" }, 503);
    if (row.extension_id !== extensionId || row.commercial_session_id !== session.commercial_session_id
      || row.booking_id !== bookingId || row.listing_id !== bk.listing_id || row.base_order_id !== session.order_id
      || row.extension_order_id !== extensionOrderId || row.buyer_id !== bk.buyer_id || row.creator_id !== bk.creator_id
      || Number(row.base_ends_at) !== Number(bk.ends_at)
      || Number(row.extension_ends_at) !== Number(bk.ends_at) + pricing.minutes * 60_000
      || Number(row.extension_minutes) !== pricing.minutes || Number(row.rate_per_minute) !== pricing.rate
      || Number(row.amount) !== pricing.minutes * pricing.rate || row.currency !== String(policy.currency)
      || row.policy_version !== `${policy.policy_version}:extension`) {
      return json({ error: "extension quote authority mismatch" }, 503);
    }
    return json(extensionResponse(row));
  } catch (_) {
    return json({ error: "commercial extension unavailable" }, 503);
  }
}

export async function commercialConsultExtensionConfirm(req: Request, env: Env): Promise<Response> {
  const bookingId = idFrom(req, "consult");
  if (!bookingId) return json({ error: "bad booking id" }, 400);
  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);
  const config = await readConfig(env);
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const extensionId = String(body.extension_id ?? "").trim();
  if (!extensionId) return json({ error: "extension_id required" }, 400);
  const accepts = body.accept === true;
  const row0 = await metaDb(env).prepare(
    `SELECT extension_id,commercial_session_id,booking_id,listing_id,base_order_id,extension_order_id,
     buyer_id,creator_id,base_ends_at,extension_ends_at,extension_minutes,rate_per_minute,amount,currency,policy_version,state,
     creator_consented_at,buyer_consented_at FROM commercial_consult_extensions
     WHERE extension_id=?1 AND booking_id=?2`,
  ).bind(extensionId, bookingId).first<ExtensionRow>();
  if (!row0) return json({ error: "extension quote unavailable" }, 404);
  if (auth.uid !== row0.creator_id && auth.uid !== row0.buyer_id) return json({ error: "not your session" }, 403);
  // A previously issued quote may be declined after the dark flag changes, but
  // a new consent/hold must re-check server pricing and the live booking.
  if (accepts && !extensionConfig(config)) return json({ error: "commercial extension unavailable" }, 404);
  if (!accepts) {
    await metaDb(env).prepare(
      "UPDATE commercial_consult_extensions SET state='declined',updated_at=?2 WHERE extension_id=?1 AND state IN ('proposed','consented')",
    ).bind(extensionId, Date.now()).run();
    return json({ ok: true, state: "declined", extension_id: extensionId });
  }
  const now = Date.now();
  await metaDb(env).prepare(
    `UPDATE commercial_consult_extensions SET
       creator_consented_at=CASE WHEN creator_id=?2 THEN COALESCE(creator_consented_at,?3) ELSE creator_consented_at END,
       buyer_consented_at=CASE WHEN buyer_id=?2 THEN COALESCE(buyer_consented_at,?3) ELSE buyer_consented_at END,
       state=CASE WHEN (creator_consented_at IS NOT NULL OR creator_id=?2)
                    AND (buyer_consented_at IS NOT NULL OR buyer_id=?2) THEN 'consented' ELSE state END,
       updated_at=?3 WHERE extension_id=?1 AND state IN ('proposed','consented','holding')`,
  ).bind(extensionId, auth.uid, now).run();
  let row = await metaDb(env).prepare(
    `SELECT extension_id,commercial_session_id,booking_id,listing_id,base_order_id,extension_order_id,
     buyer_id,creator_id,base_ends_at,extension_ends_at,extension_minutes,rate_per_minute,amount,currency,policy_version,state,
     creator_consented_at,buyer_consented_at FROM commercial_consult_extensions WHERE extension_id=?1`,
  ).bind(extensionId).first<ExtensionRow>();
  if (!row) return json({ error: "extension quote unavailable" }, 404);
  if (row.state === "applied" || row.state === "held") return json(extensionResponse(row));
  if (row.creator_consented_at === null || row.buyer_consented_at === null) return json(extensionResponse(row), 202);

  const authority = await extensionBooking(env, bookingId, auth.uid);
  if (authority instanceof Response) return authority;
  if (authority.session.commercial_session_id !== row.commercial_session_id
    || authority.session.order_id !== row.base_order_id
    || authority.booking.listing_id !== row.listing_id
    || authority.booking.creator_id !== row.creator_id
    || authority.booking.buyer_id !== row.buyer_id
    || Number(authority.booking.ends_at) !== Number(row.base_ends_at)) {
    return json({ error: "extension authority changed" }, 409);
  }

  const claimed = await metaDb(env).prepare(
    "UPDATE commercial_consult_extensions SET state='holding',updated_at=?2 WHERE extension_id=?1 AND state IN ('consented','holding')",
  ).bind(extensionId, now).run();
  if (!claimed.meta?.changes && row.state !== "holding") {
    row = await metaDb(env).prepare("SELECT * FROM commercial_consult_extensions WHERE extension_id=?1").bind(extensionId).first<ExtensionRow>() ?? row;
    return json(extensionResponse(row), 202);
  }
  const policy = await metaDb(env).prepare(
    `SELECT policy_snapshot_id,creator_fee_pct,settlement_hold_hours,platform_fee_amount,
      creator_amount,cancellation_policy_json,policy_version FROM commercial_policy_snapshots WHERE order_id=?1 LIMIT 1`,
  ).bind(row.base_order_id).first<any>();
  if (!policy) return json({ error: "immutable policy unavailable" }, 503);
  const orderNow = Date.now();
  const creatorAmount = Math.round(Number(row.amount) * Number(policy.creator_fee_pct) / 100);
  const platformAmount = Number(row.amount) - creatorAmount;
  await metaDb(env).prepare(
    `INSERT OR IGNORE INTO orders
      (id,listing_id,buyer_id,creator_id,amount,status,created_at,updated_at,kind,fee_pct,escrow_account,booking_id)
     VALUES (?1,?2,?3,?4,?5,'pending',?6,?6,'consult_1to1',?7,?8,?9)`,
  ).bind(row.extension_order_id, row.listing_id, row.buyer_id, row.creator_id, row.amount, orderNow,
    100 - Number(policy.creator_fee_pct), `escrow:${row.extension_order_id}`, row.booking_id).run();
  const persistedOrder = await metaDb(env).prepare(
    "SELECT id,listing_id,buyer_id,creator_id,amount,kind,fee_pct,escrow_account,booking_id FROM orders WHERE id=?1",
  ).bind(row.extension_order_id).first<any>();
  if (!persistedOrder || persistedOrder.id !== row.extension_order_id || persistedOrder.listing_id !== row.listing_id
    || persistedOrder.buyer_id !== row.buyer_id || persistedOrder.creator_id !== row.creator_id
    || Number(persistedOrder.amount) !== Number(row.amount) || persistedOrder.kind !== 'consult_1to1'
    || Number(persistedOrder.fee_pct) !== 100 - Number(policy.creator_fee_pct)
    || persistedOrder.escrow_account !== `escrow:${row.extension_order_id}` || persistedOrder.booking_id !== row.booking_id) {
    return json({ error: "extension order authority mismatch" }, 503);
  }
  await metaDb(env).prepare(
    `INSERT OR IGNORE INTO commercial_policy_snapshots
      (policy_snapshot_id,order_id,listing_id,booking_id,buyer_id,creator_id,kind,gross_amount,currency,
       creator_fee_pct,settlement_hold_hours,platform_fee_amount,creator_amount,cancellation_policy_json,
       conversion_snapshot_json,policy_version,created_at)
     VALUES (?1,?2,?3,?4,?5,?6,'consult_1to1',?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)`,
  ).bind(`commercial-extension-policy:${row.extension_id}`, row.extension_order_id, row.listing_id, row.booking_id,
    row.buyer_id, row.creator_id, row.amount, row.currency, Number(policy.creator_fee_pct),
    Number(policy.settlement_hold_hours), platformAmount, creatorAmount, policy.cancellation_policy_json,
    JSON.stringify({ base_order_id: row.base_order_id, extension_id: row.extension_id, base_ends_at: row.base_ends_at, extension_ends_at: row.extension_ends_at, rate_per_minute: row.rate_per_minute }),
    row.policy_version, orderNow).run();
  const persistedPolicy = await metaDb(env).prepare(
    `SELECT order_id,listing_id,booking_id,buyer_id,creator_id,kind,gross_amount,currency,
      creator_fee_pct,platform_fee_amount,creator_amount,policy_version
     FROM commercial_policy_snapshots WHERE order_id=?1`,
  ).bind(row.extension_order_id).first<any>();
  if (!persistedPolicy || persistedPolicy.order_id !== row.extension_order_id
    || persistedPolicy.listing_id !== row.listing_id || persistedPolicy.booking_id !== row.booking_id
    || persistedPolicy.buyer_id !== row.buyer_id || persistedPolicy.creator_id !== row.creator_id
    || persistedPolicy.kind !== 'consult_1to1' || Number(persistedPolicy.gross_amount) !== Number(row.amount)
    || persistedPolicy.currency !== row.currency || Number(persistedPolicy.creator_fee_pct) !== Number(policy.creator_fee_pct)
    || Number(persistedPolicy.platform_fee_amount) !== platformAmount || Number(persistedPolicy.creator_amount) !== creatorAmount
    || persistedPolicy.policy_version !== row.policy_version) {
    return json({ error: "extension policy authority mismatch" }, 503);
  }
  const newEnd = Number(row.extension_ends_at);
  if (await extensionScheduleConflict(env, row, newEnd)) {
    await metaDb(env).prepare("UPDATE commercial_consult_extensions SET state='consented',updated_at=?2 WHERE extension_id=?1 AND state='holding'").bind(row.extension_id, Date.now()).run();
    return json({ error: "extension schedule conflict", retryable: false }, 409);
  }
  const money = await hold(env, row.buyer_id, row.extension_order_id, row.amount, {
    opId: `commercial:extension:hold:${row.extension_id}`,
    title: "Consultation extension",
    app: "avaconsult",
  });
  if (!money.ok) {
    // Keep the exact quote and consent resumable after a top-up. The stable
    // hold op id makes a retry safe if the wallet response was ambiguous.
    await metaDb(env).prepare("UPDATE commercial_consult_extensions SET state='consented',updated_at=?2 WHERE extension_id=?1 AND state='holding'").bind(row.extension_id, Date.now()).run();
    return json({ error: money.status === 402 ? "insufficient_funds" : "extension payment failed", retryable: true }, money.status === 402 ? 402 : 502);
  }
  // Calendar and booking rows can change while the wallet hold is in flight.
  // Re-check before applying the extension, then refund the same escrow hold
  // if a race or expiry made the original schedule unsafe.
  if (Date.now() >= Number(row.base_ends_at) || await extensionScheduleConflict(env, row, newEnd)) {
    const reversed = await refund(env, row.extension_order_id, row.buyer_id, row.amount, {
      opId: `commercial:extension:refund:${row.extension_id}`,
      reason: "extension schedule changed before apply",
    });
    await metaDb(env).batch([
      metaDb(env).prepare("UPDATE orders SET status=?2,updated_at=?3 WHERE id=?1").bind(row.extension_order_id, reversed.ok ? 'refunded' : 'held', Date.now()),
      metaDb(env).prepare("UPDATE commercial_consult_extensions SET state='failed',updated_at=?2 WHERE extension_id=?1").bind(row.extension_id, Date.now()),
    ]);
    return json({ ok: false, state: reversed.ok ? 'refunded' : 'review_pending', reason: 'extension schedule changed before apply' }, 202);
  }
  await metaDb(env).batch([
    metaDb(env).prepare("UPDATE orders SET status='held',updated_at=?2 WHERE id=?1 AND status IN ('pending','held')").bind(row.extension_order_id, Date.now()),
    metaDb(env).prepare("UPDATE bookings SET ends_at=?2,updated_at=?3 WHERE id=?1 AND ends_at=?4 AND status='confirmed'").bind(row.booking_id, newEnd, Date.now(), row.base_ends_at),
    metaDb(env).prepare("UPDATE calendar_events SET end_at=?2 WHERE booking_id=?1 AND end_at=?3").bind(row.booking_id, newEnd, row.base_ends_at),
    metaDb(env).prepare("UPDATE calendar_blocks SET ends_at=?2 WHERE source_ref IN (?3,?4) AND ends_at=?5").bind(newEnd, `commercial:${row.booking_id}:creator`, `commercial:${row.booking_id}:buyer`, row.base_ends_at),
    metaDb(env).prepare("UPDATE commercial_entitlements SET ends_at=?2,updated_at=?3 WHERE booking_id=?1 AND state IN ('active','held','reserved')").bind(row.booking_id, newEnd, Date.now()),
    metaDb(env).prepare("UPDATE commercial_consult_extensions SET state='applied',held_at=COALESCE(held_at,?2),applied_at=COALESCE(applied_at,?2),updated_at=?2 WHERE extension_id=?1 AND state='holding'").bind(row.extension_id, Date.now()),
  ]);
  const booked = await metaDb(env).prepare("SELECT ends_at,status FROM bookings WHERE id=?1").bind(row.booking_id).first<any>();
  const blocks = await metaDb(env).prepare(
    "SELECT COUNT(*) count FROM calendar_blocks WHERE source_ref IN (?1,?2) AND ends_at=?3 AND status='busy'",
  ).bind(`commercial:${row.booking_id}:creator`, `commercial:${row.booking_id}:buyer`, newEnd).first<{ count: number }>();
  const entitlements = await metaDb(env).prepare(
    "SELECT COUNT(*) count FROM commercial_entitlements WHERE booking_id=?1 AND ends_at=?2 AND state IN ('active','held','reserved')",
  ).bind(row.booking_id, newEnd).first<{ count: number }>();
  if (!booked || Number(booked.ends_at) !== newEnd || booked.status !== 'confirmed'
    || Number(blocks?.count ?? 0) < 2 || Number(entitlements?.count ?? 0) < 2) {
    const reversed = await refund(env, row.extension_order_id, row.buyer_id, row.amount, {
      opId: `commercial:extension:refund:${row.extension_id}`,
      reason: "extension schedule update could not be verified",
    });
    await metaDb(env).batch([
      metaDb(env).prepare("UPDATE bookings SET ends_at=?2,updated_at=?3 WHERE id=?1 AND ends_at=?4").bind(row.booking_id, row.base_ends_at, Date.now(), newEnd),
      metaDb(env).prepare("UPDATE calendar_events SET end_at=?2 WHERE booking_id=?1 AND end_at=?3").bind(row.booking_id, row.base_ends_at, newEnd),
      metaDb(env).prepare("UPDATE calendar_blocks SET ends_at=?2 WHERE source_ref IN (?3,?4) AND ends_at=?5").bind(row.base_ends_at, `commercial:${row.booking_id}:creator`, `commercial:${row.booking_id}:buyer`, newEnd),
      metaDb(env).prepare("UPDATE commercial_entitlements SET ends_at=?2,updated_at=?3 WHERE booking_id=?1 AND ends_at=?4").bind(row.booking_id, row.base_ends_at, Date.now(), newEnd),
      metaDb(env).prepare("UPDATE orders SET status=?2,updated_at=?3 WHERE id=?1").bind(row.extension_order_id, reversed.ok ? 'refunded' : 'held', Date.now()),
      metaDb(env).prepare("UPDATE commercial_consult_extensions SET state='failed',updated_at=?2 WHERE extension_id=?1").bind(row.extension_id, Date.now()),
    ]);
    return json({ ok: false, state: reversed.ok ? 'refunded' : 'review_pending', reason: 'extension schedule verification failed' }, 202);
  }
  row = await metaDb(env).prepare("SELECT * FROM commercial_consult_extensions WHERE extension_id=?1").bind(extensionId).first<ExtensionRow>() ?? row;
  commercialEvent(env, "consult_extension", auth.uid, { outcome: "applied", booking_id: bookingId, extension_id: extensionId });
  return json(extensionResponse(row));
}

function noStoreJoinResponse(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Pragma', 'no-cache');
  return response;
}

/// Admission responses contain short-lived provider credentials. Keep the
/// transport POST-only and explicitly non-cacheable, including error replies.
export async function commercialLiveJoin(req: Request, env: Env): Promise<Response> {
  return noStoreJoinResponse(await commercialLiveJoinUnsafe(req, env));
}

export async function commercialConsultJoin(req: Request, env: Env): Promise<Response> {
  return noStoreJoinResponse(await commercialConsultJoinUnsafe(req, env));
}

type SessionAuthority = {
  commercial_session_id: string;
  kind: CommercialSessionKind;
  listing_id: string;
  booking_id: string | null;
  order_id: string | null;
  creator_id: string;
  provider_call_type: string;
  provider_call_id: string;
  state: string;
  settlement_state: string;
  scheduled_at: number;
  live_started_at: number | null;
  ended_at: number | null;
};

async function sessionByListing(env: Env, listingId: string): Promise<SessionAuthority | null> {
  return await metaDb(env).prepare(
    `SELECT commercial_session_id,kind,listing_id,booking_id,order_id,creator_id,
      provider_call_type,provider_call_id,state,settlement_state,scheduled_at,
      live_started_at,ended_at FROM commercial_sessions
      WHERE kind='live_event' AND listing_id=?1 ORDER BY session_version DESC LIMIT 1`,
  ).bind(listingId).first<SessionAuthority>();
}

async function sessionByBooking(env: Env, bookingId: string): Promise<SessionAuthority | null> {
  return await metaDb(env).prepare(
    `SELECT commercial_session_id,kind,listing_id,booking_id,order_id,creator_id,
      provider_call_type,provider_call_id,state,settlement_state,scheduled_at,
      live_started_at,ended_at FROM commercial_sessions
      WHERE kind='consult_1to1' AND booking_id=?1 ORDER BY session_version DESC LIMIT 1`,
  ).bind(bookingId).first<SessionAuthority>();
}

function idempotencyKey(req: Request): string | null {
  const value = (req.headers.get("idempotency-key") ?? "").trim();
  return /^[A-Za-z0-9_.:-]{8,128}$/.test(value) ? value : null;
}

async function runControl(args: {
  req: Request;
  env: Env;
  actorId: string;
  session: SessionAuthority;
  action: "go_live" | "end";
  recording?: boolean;
}): Promise<Response> {
  if (!configured(args.env)) {
    commercialEvent(args.env, "broadcast", args.actorId, { kind: args.session.kind, outcome: "refused", action: args.action, reason: "provider_unavailable" });
    return json({ error: "commercial media unavailable" }, 503);
  }
  const idem = idempotencyKey(args.req);
  if (!idem) {
    commercialEvent(args.env, "broadcast", args.actorId, { kind: args.session.kind, outcome: "refused", action: args.action, reason: "idempotency_required" });
    return json({ error: "valid Idempotency-Key required" }, 400);
  }
  const operationId = `${args.session.commercial_session_id}:${args.action}:${idem}`;
  const existing = await metaDb(args.env).prepare(
    "SELECT actor_id,action,state,provider_status FROM commercial_control_operations WHERE operation_id=?1",
  ).bind(operationId).first<{
    actor_id: string;
    action: string;
    state: string;
    provider_status: number | null;
  }>();
  if (existing) {
    if (existing.actor_id !== args.actorId || existing.action !== args.action) {
      return json({ error: "idempotency authority mismatch" }, 409);
    }
    if (existing.state === "confirmed") {
      commercialEvent(args.env, "broadcast", args.actorId, { kind: args.session.kind, outcome: "replay", action: args.action });
      return json({ ok: true, idempotent_replay: true, state: args.action === "go_live" ? "starting" : "ending" });
    }
    if (existing.state === "reconciliation_pending" || existing.state === "pending") {
      commercialEvent(args.env, "broadcast", args.actorId, { kind: args.session.kind, outcome: "reconciliation_pending", action: args.action });
      return json({ error: "commercial reconciliation pending" }, 503);
    }
    commercialEvent(args.env, "broadcast", args.actorId, { kind: args.session.kind, outcome: "refused", action: args.action, reason: "provider_rejected" });
    return json({ error: "provider rejected operation", provider_status: existing.provider_status }, 409);
  }
  const now = Date.now();
  await metaDb(args.env).prepare(
    `INSERT INTO commercial_control_operations
     (operation_id,commercial_session_id,actor_id,action,state,created_at,updated_at)
     VALUES (?1,?2,?3,?4,'pending',?5,?5)`,
  ).bind(operationId, args.session.commercial_session_id, args.actorId, args.action, now).run();

  const provider = await providerControl({
    env: args.env,
    callType: args.session.provider_call_type,
    callId: args.session.provider_call_id,
    action: args.action === "go_live" ? "go_live" : "mark_ended",
    body: args.action === "go_live"
      ? { start_hls: true, start_recording: args.recording === true }
      : undefined,
  });
  if (!provider.confirmed) {
    const operationState = provider.uncertain ? "reconciliation_pending" : "failed";
    await metaDb(args.env).batch([
      metaDb(args.env).prepare(
        "UPDATE commercial_control_operations SET state=?2,provider_status=?3,updated_at=?4 WHERE operation_id=?1",
      ).bind(operationId, operationState, provider.status, Date.now()),
      ...(provider.uncertain ? [metaDb(args.env).prepare(
        `UPDATE commercial_sessions SET state='reconciliation_pending',
          settlement_state=CASE WHEN settlement_state='not_ready' THEN 'review_pending' ELSE settlement_state END,
          state_version=state_version+1,updated_at=?2 WHERE commercial_session_id=?1`,
      ).bind(args.session.commercial_session_id, Date.now())] : []),
    ]);
    commercialEvent(args.env, "broadcast", args.actorId, {
      kind: args.session.kind, outcome: provider.uncertain ? "reconciliation_pending" : "refused",
      action: args.action, reason: provider.uncertain ? "provider_uncertain" : "provider_rejected",
    });
    return json({
      error: provider.uncertain ? "commercial reconciliation pending" : "provider rejected operation",
      provider_status: provider.status,
    }, provider.uncertain ? 503 : 409);
  }

  await metaDb(args.env).batch([
    metaDb(args.env).prepare(
      "UPDATE commercial_control_operations SET state='confirmed',provider_status=?2,updated_at=?3 WHERE operation_id=?1",
    ).bind(operationId, provider.status, Date.now()),
    metaDb(args.env).prepare(
      `UPDATE commercial_sessions SET state=?2,state_version=state_version+1,updated_at=?3
       WHERE commercial_session_id=?1 AND state NOT IN ('ended','cancelled','reconciliation_pending')`,
    ).bind(args.session.commercial_session_id, args.action === "go_live" ? "backstage" : "ending", Date.now()),
  ]);
  if (args.session.kind === "live_event") {
    await notifyLiveAudience(args.env, {
      type: args.action === "go_live" ? "commercial_broadcast_started" : "commercial_broadcast_ended",
      eventId: `${args.session.commercial_session_id}:${args.action}`,
      listingId: args.session.listing_id,
      sessionId: args.session.commercial_session_id,
      title: args.action === "go_live" ? "Live event started" : "Live event ended",
      body: args.action === "go_live" ? "The event is live now." : "The event has ended.",
    }, args.session.creator_id);
  }
  commercialEvent(args.env, "broadcast", args.actorId, { kind: args.session.kind, outcome: "authorized", action: args.action });
  return json({ ok: true, state: args.action === "go_live" ? "starting" : "ending" }, 202);
}

export async function commercialLivePrepareHost(req: Request, env: Env): Promise<Response> {
  const listingId = idFrom(req, "live");
  if (!listingId) return noStoreJoinResponse(json({ error: "bad listing id" }, 400));
  const auth = await requireUser(req, env);
  if (isFail(auth)) return noStoreJoinResponse(json({ error: auth.error }, auth.status));
  const row = await listing(env, listingId);
  if (!row || row.kind !== "live_event" || row.creator_id !== auth.uid) {
    return noStoreJoinResponse(json({ error: "not your live event" }, 403));
  }
  const response = await commercialLiveJoin(req, env);
  if (response.ok) {
    await metaDb(env).prepare(
      `UPDATE commercial_sessions SET state='backstage',backstage_opened_at=COALESCE(backstage_opened_at,?2),
        state_version=state_version+1,updated_at=?2
       WHERE kind='live_event' AND listing_id=?1 AND state='scheduled'`,
    ).bind(listingId, Date.now()).run();
  }
  return response;
}

export async function commercialLiveGoLive(req: Request, env: Env): Promise<Response> {
  const listingId = idFrom(req, "live");
  if (!listingId) return json({ error: "bad listing id" }, 400);
  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);
  const config = await readConfig(env);
  if (config.commercialLiveJoinEnabled !== true) return json({ error: "commercial join disabled" }, 404);
  const row = await listing(env, listingId);
  if (!row || row.creator_id !== auth.uid || row.kind !== "live_event") return json({ error: "not your live event" }, 403);
  const session = await sessionByListing(env, listingId);
  if (!session) return json({ error: "prepare host first" }, 409);
  if (!["scheduled", "backstage"].includes(session.state)) return json({ error: "session cannot go live", state: session.state }, 409);
  // [LIST-FREE-1] Free lane creator hold — spec §E.2. This runs BEFORE the broadcast
  // starts, i.e. before anyone can join and start consuming metered attendee-minutes.
  // Insufficient creator balance refuses the go-live outright (402, dual error codes) —
  // the show never starts unmetered and the creator's balance never goes negative.
  if (Number(row.free_entry) === 1) {
    const policy = await freeSessionPolicy(env, row);
    if (!policy.enabled) {
      commercialEvent(env, "broadcast", auth.uid, { kind: "live_event", outcome: "refused", action: "go_live", reason: "free_sessions_disabled" });
      return json({ error: "free_sessions_disabled" }, 403);
    }
    const held = await holdFreeSessionCap(env, {
      creatorId: row.creator_id, sessionId: session.commercial_session_id,
      capTokens: policy.capTokens, title: row.title,
    });
    if (!held.ok) {
      commercialEvent(env, "broadcast", auth.uid, { kind: "live_event", outcome: "refused", action: "go_live", reason: "insufficient_tokens" });
      return json({
        error: held.error, error_legacy: held.error_legacy,
        needed: held.needed, balance: held.balance,
      }, held.status);
    }
  }
  return await runControl({
    req, env, actorId: auth.uid, session, action: "go_live",
    recording: config.commercialRecordingEnabled,
  });
}

export async function commercialLiveEnd(req: Request, env: Env): Promise<Response> {
  const listingId = idFrom(req, "live");
  if (!listingId) return json({ error: "bad listing id" }, 400);
  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);
  const config = await readConfig(env);
  if (config.commercialLiveJoinEnabled !== true) return json({ error: "commercial join disabled" }, 404);
  const row = await listing(env, listingId);
  if (!row || row.creator_id !== auth.uid || row.kind !== "live_event") return json({ error: "not your live event" }, 403);
  const session = await sessionByListing(env, listingId);
  if (!session) return json({ error: "session unavailable" }, 404);
  if (session.state === "ended") return json({ ok: true, idempotent_replay: true, state: "ended" });
  return await runControl({ req, env, actorId: auth.uid, session, action: "end" });
}

export async function commercialConsultEnd(req: Request, env: Env): Promise<Response> {
  const bookingId = idFrom(req, "consult");
  if (!bookingId) return json({ error: "bad booking id" }, 400);
  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);
  const config = await readConfig(env);
  if (config.commercialConsultJoinEnabled !== true) return json({ error: "commercial join disabled" }, 404);
  const row = await booking(env, bookingId);
  if (!row || (row.creator_id !== auth.uid && row.buyer_id !== auth.uid)) return json({ error: "not your booking" }, 403);
  const session = await sessionByBooking(env, bookingId);
  if (!session) return json({ error: "session unavailable" }, 404);
  if (session.state === "ended") return json({ ok: true, idempotent_replay: true, state: "ended" });
  return await runControl({ req, env, actorId: auth.uid, session, action: "end" });
}

export async function commercialConsultState(req: Request, env: Env): Promise<Response> {
  const bookingId = idFrom(req, "consult");
  if (!bookingId) return json({ error: "bad booking id" }, 400);
  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);
  const row = await booking(env, bookingId);
  if (!row || row.kind !== "consult_1to1") return json({ error: "booking unavailable" }, 404);
  if (auth.uid !== row.creator_id && auth.uid !== row.buyer_id) return json({ error: "not your booking" }, 403);
  const session = await sessionByBooking(env, bookingId);
  if (!session) return json({ error: "session unavailable" }, 404);
  return json({ ok: true, ...safeSessionState(session), starts_at: Number(row.starts_at), ends_at: Number(row.ends_at) });
}

async function canViewSession(env: Env, session: SessionAuthority, uid: string): Promise<boolean> {
  if (session.creator_id === uid) return true;
  // [COMM-LIVE-AUTH-1] Scoped by listing+booking, NOT by session.order_id.
  //
  // This used to key off session.order_id, which is now NULL for every live_event (the
  // session is shared across N tickets — see the migration). Left as it was, a live-event
  // buyer whose ticket was refunded could no longer open their own refund receipt: their
  // entitlement is 'refunded' so the check below rejects them, and if they never got in
  // they have no member row either. commercial_refund_receipts carries listing_id and
  // booking_id itself, so scoping on those answers the same question without depending
  // on a field that legitimately has no single value here.
  const refundReceipt = await metaDb(env).prepare(
    `SELECT 1 ok FROM commercial_refund_receipts
       WHERE listing_id=?1 AND COALESCE(booking_id,'')=COALESCE(?2,'')
         AND (buyer_id=?3 OR creator_id=?3) LIMIT 1`,
  ).bind(session.listing_id, session.booking_id ?? null, uid).first<{ ok: number }>();
  if (refundReceipt) return true;
  const member = await metaDb(env).prepare(
    "SELECT 1 ok FROM commercial_session_members WHERE commercial_session_id=?1 AND account_id=?2 LIMIT 1",
  ).bind(session.commercial_session_id, uid).first<{ ok: number }>();
  if (member) return true;
  // [COMM-CONSULT-ENT-1] Deliberately role-BLIND, and therefore deliberately NOT
  // entitlement() — which now requires a role because admission is always "may this uid
  // enter AS this role". Visibility is a different question: "does this uid have any
  // stake in this session at all", answered yes for a viewer, a buyer or the creator
  // alike. Routing this through entitlement() would have meant guessing a role in order
  // to answer a question that does not have one.
  const anyGrant = await metaDb(env).prepare(
    `SELECT 1 ok FROM commercial_entitlements
      WHERE kind=?1 AND listing_id=?2 AND COALESCE(booking_id,'')=COALESCE(?3,'')
        AND account_id=?4 AND state IN ('reserved','held','active','consumed') LIMIT 1`,
  ).bind(session.kind, session.listing_id, session.booking_id ?? null, uid).first<{ ok: number }>();
  return Boolean(anyGrant);
}

async function consumeCommercialEntitlementsOnSessionEnd(env: Env, sessionId: string): Promise<void> {
  const session = await metaDb(env).prepare(
    `SELECT s.kind, s.listing_id, s.booking_id, p.cancellation_policy_json
       FROM commercial_sessions s
       JOIN commercial_policy_snapshots p ON p.order_id IN (
         SELECT order_id FROM commercial_settlement_jobs WHERE commercial_session_id=?1
       )
      WHERE s.commercial_session_id=?1
      ORDER BY p.created_at DESC LIMIT 1`,
  ).bind(sessionId).first<{ kind: CommercialSessionKind; listing_id: string; booking_id: string | null; cancellation_policy_json: string | null }>();
  if (!session) return;
  let policy: { min_connected_ms?: number } = {};
  try { policy = JSON.parse(String(session.cancellation_policy_json ?? "{}")) as { min_connected_ms?: number }; } catch { /* use safe default */ }
  const minimumMs = Number.isFinite(Number(policy.min_connected_ms))
    ? Math.max(0, Math.trunc(Number(policy.min_connected_ms)))
    : 60_000;
  const rows = await metaDb(env).prepare(
    `SELECT e.entitlement_id, e.account_id, e.role,
        COALESCE(SUM(i.connected_ms),0) connected_ms
       FROM commercial_entitlements e
       LEFT JOIN commercial_session_members m
         ON m.commercial_session_id=?1 AND m.entitlement_id=e.entitlement_id
       LEFT JOIN commercial_participant_intervals i
         ON i.commercial_session_id=?1 AND i.account_id=e.account_id
      WHERE m.commercial_session_id=?1
        AND e.state IN ('reserved','held','active')
      GROUP BY e.entitlement_id, e.account_id, e.role`,
  ).bind(sessionId).all<{
    entitlement_id: string;
    account_id: string;
    role: string;
    connected_ms: number;
  }>();
  const consumable = (rows.results ?? []).filter((row) => Number(row.connected_ms ?? 0) >= minimumMs);
  if (!consumable.length) return;
  const now = Date.now();
  await metaDb(env).batch(consumable.map((row) => metaDb(env).prepare(
    `UPDATE commercial_entitlements SET state='consumed',updated_at=?2
       WHERE entitlement_id=?1 AND state IN ('reserved','held','active')`,
  ).bind(row.entitlement_id, now)));
}

function safeSessionState(session: SessionAuthority): Record<string, unknown> {
  return {
    session_id: session.commercial_session_id,
    kind: session.kind,
    listing_id: session.listing_id,
    booking_id: session.booking_id,
    state: session.state,
    settlement_state: session.settlement_state,
    scheduled_at: Number(session.scheduled_at),
    live_started_at: session.live_started_at,
    ended_at: session.ended_at,
  };
}

export async function commercialLiveState(req: Request, env: Env): Promise<Response> {
  const listingId = idFrom(req, "live");
  if (!listingId) return json({ error: "bad listing id" }, 400);
  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);
  const session = await sessionByListing(env, listingId);
  if (!session) return json({ error: "session unavailable" }, 404);
  if (!await canViewSession(env, session, auth.uid)) return json({ error: "not entitled" }, 403);
  return json({ ok: true, ...safeSessionState(session) });
}

export async function commercialReceipt(req: Request, env: Env): Promise<Response> {
  const match = new URL(req.url).pathname.match(/^\/api\/commercial\/session\/([A-Za-z0-9_:-]{1,160})\/receipt$/);
  if (!match) return json({ error: "bad session id" }, 400);
  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);
  const session = await metaDb(env).prepare(
    `SELECT commercial_session_id,kind,listing_id,booking_id,order_id,creator_id,
      provider_call_type,provider_call_id,state,settlement_state,scheduled_at,
      live_started_at,ended_at FROM commercial_sessions WHERE commercial_session_id=?1`,
  ).bind(match[1]).first<SessionAuthority>();
  if (!session) return json({ error: "session unavailable" }, 404);
  if (!await canViewSession(env, session, auth.uid)) return json({ error: "not entitled" }, 403);
  const receipts = await metaDb(env).prepare(
    `SELECT receipt_id,commercial_session_id,order_id,listing_id,booking_id,buyer_id,
      creator_id,kind,gross_amount,platform_fee_amount,creator_amount,currency,
      settlement_state,connected_ms,policy_snapshot_id,issued_at
      FROM commercial_receipts WHERE commercial_session_id=?1
        AND (?2=creator_id OR buyer_id=?2) ORDER BY issued_at`,
  ).bind(session.commercial_session_id, auth.uid).all<Record<string, unknown>>();
  const visible = receipts.results ?? [];
  const refunds = await metaDb(env).prepare(
    `SELECT refund_receipt_id,order_id,commercial_session_id,listing_id,booking_id,buyer_id,
      creator_id,kind,gross_amount,refunded_amount,remaining_amount,platform_fee_amount,creator_amount,
      currency,settlement_state,reason,actor,policy_snapshot_id,issued_at
      FROM commercial_refund_receipts WHERE commercial_session_id=?1
        AND (?2=creator_id OR buyer_id=?2) ORDER BY issued_at`,
  ).bind(session.commercial_session_id, auth.uid).all<Record<string, unknown>>();
  const refundRows = refunds.results ?? [];
  if (visible.length === 0 && refundRows.length === 0) {
    return json({ ok: true, ready: false, settlement_state: session.settlement_state }, 202);
  }
  return session.creator_id === auth.uid
    ? json({ ok: true, ready: true, receipts: visible, refund_receipts: refundRows })
    : json({ ok: true, ready: true, receipt: visible[0] ?? null, refund_receipt: refundRows[0] ?? null });
}

/** Refund receipts for cancellations that happened before a provider session
 * existed (for example a live event cancelled before the first join). */
export async function commercialRefundReceipt(req: Request, env: Env): Promise<Response> {
  const match = new URL(req.url).pathname.match(/^\/api\/commercial\/refund-receipt\/([A-Za-z0-9_:-]{1,160})$/);
  if (!match) return json({ error: "bad refund receipt id" }, 400);
  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);
  const receipt = await metaDb(env).prepare(
    `SELECT refund_receipt_id,order_id,commercial_session_id,listing_id,booking_id,buyer_id,
      creator_id,kind,gross_amount,refunded_amount,remaining_amount,platform_fee_amount,creator_amount,
      currency,settlement_state,reason,actor,policy_snapshot_id,issued_at
      FROM commercial_refund_receipts WHERE refund_receipt_id=?1
        AND (buyer_id=?2 OR creator_id=?2)`,
  ).bind(match[1], auth.uid).first<Record<string, unknown>>();
  if (!receipt) return json({ error: "refund receipt unavailable" }, 404);
  return json({ ok: true, receipt });
}

/**
 * Customer-owned commercial sessions for My Sessions.
 *
 * This is a read-only projection over account-bound entitlements, bookings,
 * orders and provider-backed session state. It intentionally returns no join
 * credential; admission still goes through the dedicated join endpoints.
 */
export async function commercialSessionsMine(req: Request, env: Env): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);
  try {
    const config = await readConfig(env);
    const rows = await metaDb(env).prepare(
      `SELECT e.entitlement_id,e.kind,e.listing_id,e.booking_id,e.order_id,e.state entitlement_state,
          e.starts_at entitlement_starts_at,e.ends_at entitlement_ends_at,
          l.title,l.creator_id,l.price,l.currency_display,l.duration_min,
          b.starts_at booking_starts_at,b.ends_at booking_ends_at,b.status booking_status,
          o.status order_status,
          s.commercial_session_id,s.state session_state,s.settlement_state session_settlement_state,
          r.receipt_id,r.settlement_state receipt_settlement_state,r.issued_at receipt_issued_at,
          rr.refund_receipt_id,rr.settlement_state refund_settlement_state,
          rr.refunded_amount,rr.remaining_amount,rr.reason refund_reason,rr.issued_at refund_issued_at
       FROM commercial_entitlements e
       JOIN listings l ON l.id=e.listing_id
       LEFT JOIN bookings b ON b.id=e.booking_id
       LEFT JOIN orders o ON o.id=e.order_id
       LEFT JOIN commercial_sessions s ON s.commercial_session_id=(
         SELECT s2.commercial_session_id FROM commercial_sessions s2
          WHERE s2.kind=e.kind AND s2.listing_id=e.listing_id
            AND COALESCE(s2.booking_id,'')=COALESCE(e.booking_id,'')
          ORDER BY s2.session_version DESC,s2.updated_at DESC LIMIT 1
       )
       LEFT JOIN commercial_receipts r
         ON r.commercial_session_id=s.commercial_session_id AND r.order_id=e.order_id
       LEFT JOIN commercial_refund_receipts rr
         ON rr.order_id=e.order_id
       WHERE e.account_id=?1 AND e.role IN ('viewer','buyer')
         AND (e.state IN ('reserved','held','active','consumed') OR rr.refund_receipt_id IS NOT NULL)
       ORDER BY COALESCE(b.starts_at,e.starts_at) DESC LIMIT 200`,
    ).bind(auth.uid).all<Record<string, unknown>>();
    const now = Date.now();
    const sessions = (rows.results ?? []).map((row) => {
      const startsAt = Number(row.booking_starts_at ?? row.entitlement_starts_at ?? 0);
      const rawEndsAt = Number(row.booking_ends_at ?? row.entitlement_ends_at ?? 0);
      const endsAt = rawEndsAt || startsAt + Math.max(1, Number(row.duration_min ?? 60)) * 60_000;
      const window = joinWindow(
        config,
        row.kind === "live_event" ? "live_event" : "consult_1to1",
        startsAt,
        endsAt,
      );
      return { ...row, starts_at: startsAt, ends_at: endsAt, opens_at: window.opensAt, closes_at: window.closesAt };
    });
    return json({ ok: true, server_now: now, sessions });
  } catch (_) {
    // The additive Phase 2 schema may not be installed on an older environment.
    // An unavailable projection is safer than presenting invented bookings.
    return json({ error: "commercial sessions unavailable" }, 503);
  }
}

type CommercialWebhookInput = {
  webhookId: string;
  eventType: string;
  callType: string;
  callId: string;
  actorId: string | null;
  providerSessionId: string | null;
  occurredAt: number;
  rawJson: string;
};

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Called only after the shared GetStream receiver verifies the raw signature. */
export async function recordCommercialStreamEvent(
  env: Env,
  input: CommercialWebhookInput,
): Promise<{ handled: boolean; duplicate?: boolean; reviewPending?: boolean }> {
  if (input.callType !== "avatok_livestream" && input.callType !== "avatok_consult_1to1") {
    return { handled: false };
  }
  const payloadHash = await sha256Hex(input.rawJson);
  const session = await metaDb(env).prepare(
    `SELECT commercial_session_id,state,ended_at,listing_id,kind FROM commercial_sessions
      WHERE provider='getstream' AND provider_call_type=?1 AND provider_call_id=?2`,
  ).bind(input.callType, input.callId).first<{
    commercial_session_id: string;
    state: string;
    ended_at: number | null;
    listing_id: string;
    kind: string;
  }>();
  const inserted = await metaDb(env).prepare(
    `INSERT OR IGNORE INTO commercial_provider_events
     (provider_event_id,provider,provider_call_type,provider_call_id,commercial_session_id,
      event_type,provider_user_id,provider_occurred_at,received_at,payload_sha256,payload_json,
      processing_state)
     VALUES (?1,'getstream',?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`,
  ).bind(
    input.webhookId, input.callType, input.callId, session?.commercial_session_id ?? null,
    input.eventType, input.actorId, input.occurredAt, Date.now(), payloadHash, input.rawJson,
    session ? "received" : "review_pending",
  ).run();
  const persistedEvent = await metaDb(env).prepare(
    `SELECT provider,provider_call_type,provider_call_id,commercial_session_id,event_type,
       provider_user_id,provider_occurred_at,payload_sha256,payload_json
       FROM commercial_provider_events WHERE provider_event_id=?1`,
  ).bind(input.webhookId).first<{
    provider: string;
    provider_call_type: string | null;
    provider_call_id: string | null;
    commercial_session_id: string | null;
    event_type: string;
    provider_user_id: string | null;
    provider_occurred_at: number | null;
    payload_sha256: string;
    payload_json: string;
  }>();
  if (!persistedEvent
    || persistedEvent.provider !== "getstream"
    || persistedEvent.provider_call_type !== input.callType
    || persistedEvent.provider_call_id !== input.callId
    || (persistedEvent.commercial_session_id !== null
      && persistedEvent.commercial_session_id !== (session?.commercial_session_id ?? null))
    || persistedEvent.event_type !== input.eventType
    || (persistedEvent.provider_user_id ?? null) !== (input.actorId ?? null)
    || Number(persistedEvent.provider_occurred_at) !== Number(input.occurredAt)
    || persistedEvent.payload_sha256 !== payloadHash
    || persistedEvent.payload_json !== input.rawJson) {
    commercialEvent(env, "provider_event", null, {
      kind: input.callType === "avatok_livestream" ? "live_event" : "consult_1to1",
      outcome: "replay_mismatch", event_class: "authority_row",
    });
    throw new Error("commercial provider event authority mismatch");
  }
  if ((inserted.meta?.changes ?? 0) === 0) {
    const prior = await metaDb(env).prepare(
      "SELECT payload_sha256,processing_state FROM commercial_provider_events WHERE provider_event_id=?1",
    ).bind(input.webhookId).first<{ payload_sha256: string; processing_state: string }>();
    if (!prior || prior.payload_sha256 !== payloadHash) {
      commercialEvent(env, "provider_event", null, {
        kind: input.callType === "avatok_livestream" ? "live_event" : "consult_1to1",
        outcome: "replay_mismatch", event_class: "duplicate_identity",
      });
      throw new Error("commercial provider event replay mismatch");
    }
    if (!session || prior.processing_state !== "review_pending") {
      commercialEvent(env, "provider_event", null, {
        kind: input.callType === "avatok_livestream" ? "live_event" : "consult_1to1",
        outcome: "duplicate", event_class: "replayed",
      });
      return { handled: true, duplicate: true };
    }
    await metaDb(env).prepare(
      `UPDATE commercial_provider_events SET commercial_session_id=?2,
        processing_state='received',processing_error=NULL WHERE provider_event_id=?1`,
    ).bind(input.webhookId, session.commercial_session_id).run();
  }
  if (!session) {
    commercialEvent(env, "provider_event", null, {
      kind: input.callType === "avatok_livestream" ? "live_event" : "consult_1to1",
      outcome: "review_pending", event_class: "unbound",
    });
    return { handled: true, reviewPending: true };
  }
  const terminal = session.state === "ended" || session.state === "cancelled";
  const eventLower = input.eventType.toLowerCase();
  const terminalEvent = eventLower.includes("session_ended")
    || eventLower.includes("call.ended")
    || eventLower.includes("live_stopped");
  if (terminal && !terminalEvent) {
    await metaDb(env).prepare(
      `UPDATE commercial_provider_events SET processing_state='review_pending',
        processing_error='late event after terminal state',processed_at=?2
       WHERE provider_event_id=?1`,
    ).bind(input.webhookId, Date.now()).run();
    commercialEvent(env, "provider_event", null, {
      kind: input.callType === "avatok_livestream" ? "live_event" : "consult_1to1",
      outcome: "review_pending", event_class: "out_of_order",
    });
    return { handled: true, reviewPending: true };
  }

  const member = input.actorId ? await metaDb(env).prepare(
    `SELECT account_id FROM commercial_session_members
      WHERE commercial_session_id=?1 AND provider_user_id=?2 AND removed_at IS NULL`,
  ).bind(session.commercial_session_id, input.actorId).first<{ account_id: string }>() : null;
  const joined = eventLower.includes("participant_joined") || eventLower.includes("participant.joined");
  const left = eventLower.includes("participant_left") || eventLower.includes("participant.left");
  if ((joined || left) && !member) {
    await metaDb(env).prepare(
      `UPDATE commercial_provider_events SET processing_state='review_pending',
        processing_error='unknown commercial member', processed_at=?2 WHERE provider_event_id=?1`,
    ).bind(input.webhookId, Date.now()).run();
    commercialEvent(env, "provider_event", null, {
      kind: input.callType === "avatok_livestream" ? "live_event" : "consult_1to1",
      outcome: "review_pending", event_class: "unknown_member",
    });
    return { handled: true, reviewPending: true };
  }

  if (joined && member && input.actorId) {
    const providerSessionId = input.providerSessionId ?? "default";
    const intervalId = `${session.commercial_session_id}:${input.actorId}:${providerSessionId}:${input.webhookId}`;
    await metaDb(env).prepare(
      `INSERT OR IGNORE INTO commercial_participant_intervals
       (interval_id,commercial_session_id,account_id,provider_user_id,provider_session_id,
        joined_event_id,joined_at,reconciliation_state,created_at,updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,'open',?8,?8)`,
    ).bind(
      intervalId,
      session.commercial_session_id, member.account_id, input.actorId, providerSessionId,
      input.webhookId, input.occurredAt, Date.now(),
    ).run();
    const persistedInterval = await metaDb(env).prepare(
      `SELECT interval_id,commercial_session_id,account_id,provider_user_id,provider_session_id,
         joined_event_id,joined_at,reconciliation_state
         FROM commercial_participant_intervals WHERE interval_id=?1`,
    ).bind(intervalId).first<{
      interval_id: string;
      commercial_session_id: string;
      account_id: string;
      provider_user_id: string;
      provider_session_id: string;
      joined_event_id: string;
      joined_at: number;
      reconciliation_state: string;
    }>();
    if (!persistedInterval
      || persistedInterval.interval_id !== intervalId
      || persistedInterval.commercial_session_id !== session.commercial_session_id
      || persistedInterval.account_id !== member.account_id
      || persistedInterval.provider_user_id !== input.actorId
      || persistedInterval.provider_session_id !== providerSessionId
      || persistedInterval.joined_event_id !== input.webhookId
      || Number(persistedInterval.joined_at) !== Number(input.occurredAt)
      || persistedInterval.reconciliation_state !== "open") {
      await metaDb(env).prepare(
        `UPDATE commercial_provider_events SET processing_state='review_pending',
           processing_error='participant interval authority mismatch',processed_at=?2
           WHERE provider_event_id=?1`,
      ).bind(input.webhookId, Date.now()).run();
      commercialEvent(env, "provider_event", null, {
        kind: input.callType === "avatok_livestream" ? "live_event" : "consult_1to1",
        outcome: "review_pending", event_class: "interval_authority",
      });
      return { handled: true, reviewPending: true };
    }
  } else if (left && member && input.actorId) {
    const open = await metaDb(env).prepare(
      `SELECT interval_id,joined_at FROM commercial_participant_intervals
       WHERE commercial_session_id=?1 AND provider_user_id=?2
         AND reconciliation_state='open' AND joined_at<=?3
       ORDER BY joined_at DESC LIMIT 1`,
    ).bind(session.commercial_session_id, input.actorId, input.occurredAt)
      .first<{ interval_id: string; joined_at: number }>();
    if (open) {
      await metaDb(env).prepare(
        `UPDATE commercial_participant_intervals
         SET left_event_id=?2,left_at=?3,connected_ms=?4,reconciliation_state='closed',updated_at=?5
         WHERE interval_id=?1 AND reconciliation_state='open'`,
      ).bind(
        open.interval_id, input.webhookId, input.occurredAt,
        Math.max(0, input.occurredAt - Number(open.joined_at)), Date.now(),
      ).run();
    }
  }

  if (eventLower.includes("session_started") || eventLower.includes("live_started")) {
    commercialEvent(env, "provider_lifecycle", null, {
      kind: input.callType === "avatok_livestream" ? "live_event" : "consult_1to1",
      outcome: "started",
    });
    // [LIST-APPROVAL-AUTH-1] Capture the PRE-update state before the UPDATE below can
    // ever move it to 'live'. The UPDATE's WHERE clause matches state IN
    // ('scheduled','backstage','live') — it matches (and bumps state_version) even when
    // the session is ALREADY live, so `.meta.changes` alone cannot tell a genuine
    // scheduled/backstage -> live transition apart from a replayed/duplicate
    // "session_started"/"live_started" lifecycle event on an already-live session. Only
    // `wasLive` (read before the mutation) can.
    const wasLive = session.state === "live";
    await metaDb(env).prepare(
      `UPDATE commercial_sessions SET state='live',
        live_started_at=COALESCE(live_started_at,?2),state_version=state_version+1,updated_at=?3
       WHERE commercial_session_id=?1 AND state IN ('scheduled','backstage','live')`,
    ).bind(session.commercial_session_id, input.occurredAt, Date.now()).run();
    // [LIST-APPROVAL-AUTH-1] Wires `systemMarkListingLive` (worker/src/routes/listings.ts),
    // which fa44bc21 introduced to close the creator-bypass in setListingStatus but never
    // called from anywhere — so today no listing ever reaches 'live' and the "is LIVE now"
    // follower fanout never fires. This is the correct call site, NOT commercialLiveGoLive
    // (~line 1157): that function only *requests* go-live from the creator and moves the
    // SESSION to 'backstage', not 'live' — it has no provider confirmation that the
    // broadcast is actually up. This branch, by contrast, only runs inside
    // recordCommercialStreamEvent, which per that function's own doc comment is "Called
    // only after the shared GetStream receiver verifies the raw signature" — i.e. the
    // provider itself has confirmed the stream is live. Do not move this call back to
    // commercialLiveGoLive.
    //
    // Guarded so it can never fail the session event (the session row is the source of
    // truth; the listing's `status` column is a downstream projection of it) and so a
    // duplicate/replayed webhook for an already-live session is a no-op (see `wasLive`
    // above) rather than a repeated fanout or a wasted write.
    if (input.callType === "avatok_livestream" && !wasLive) {
      try {
        const projected = await systemMarkListingLive(env, session.listing_id);
        commercialEvent(env, "listing_projection", null, {
          kind: "live_event", outcome: projected.ok ? "live" : "not_applied",
          reason: projected.reason ?? "",
        });
      } catch (err) {
        commercialEvent(env, "listing_projection", null, {
          kind: "live_event", outcome: "error", reason: String((err as Error)?.message ?? err).slice(0, 160),
        });
      }
    }
  } else if (eventLower.includes("session_ended") || eventLower.includes("call.ended") || eventLower.includes("live_stopped")) {
    commercialEvent(env, "provider_lifecycle", null, {
      kind: input.callType === "avatok_livestream" ? "live_event" : "consult_1to1",
      outcome: "ended",
    });
    await metaDb(env).batch([
      metaDb(env).prepare(
        `UPDATE commercial_sessions SET state='ended',ended_at=COALESCE(ended_at,?2),
          settlement_state=CASE WHEN settlement_state='not_ready' THEN 'pending' ELSE settlement_state END,
          state_version=state_version+1,updated_at=?3
         WHERE commercial_session_id=?1 AND state NOT IN ('ended','cancelled')`,
      ).bind(session.commercial_session_id, input.occurredAt, Date.now()),
      metaDb(env).prepare(
        `UPDATE commercial_participant_intervals
         SET left_at=?2,connected_ms=MAX(0,?2-joined_at),reconciliation_state='closed',updated_at=?3
         WHERE commercial_session_id=?1 AND reconciliation_state='open'`,
      ).bind(session.commercial_session_id, input.occurredAt, Date.now()),
      metaDb(env).prepare(
        `INSERT OR IGNORE INTO commercial_settlement_jobs
         (settlement_job_id,commercial_session_id,order_id,state,terminal_event_id,
          attempts,created_at,updated_at)
         SELECT 'settlement:' || ?1 || ':' || p.order_id,?1,p.order_id,'pending',?2,0,?3,?3
         FROM commercial_policy_snapshots p
         WHERE p.listing_id=(SELECT listing_id FROM commercial_sessions WHERE commercial_session_id=?1)
           AND COALESCE(p.booking_id,'')=COALESCE(
             (SELECT booking_id FROM commercial_sessions WHERE commercial_session_id=?1),''
           )`,
      ).bind(session.commercial_session_id, input.webhookId, Date.now()),
    ]);
    await consumeCommercialEntitlementsOnSessionEnd(env, session.commercial_session_id);
    const jobs = await metaDb(env).prepare(
      `SELECT settlement_job_id,commercial_session_id,order_id,state,terminal_event_id
         FROM commercial_settlement_jobs WHERE commercial_session_id=?1`,
    ).bind(session.commercial_session_id).all<{
      settlement_job_id: string;
      commercial_session_id: string;
      order_id: string;
      state: string;
      terminal_event_id: string;
    }>();
    const invalidJob = (jobs.results ?? []).find((job) =>
      job.settlement_job_id !== `settlement:${session.commercial_session_id}:${job.order_id}`
      || job.commercial_session_id !== session.commercial_session_id
      || job.terminal_event_id !== input.webhookId
      || !["pending", "processing", "review_pending", "settled", "refunded"].includes(job.state));
    if (invalidJob) {
      await metaDb(env).batch([
        metaDb(env).prepare(
          `UPDATE commercial_provider_events SET processing_state='review_pending',
             processing_error='settlement job authority mismatch',processed_at=?2
             WHERE provider_event_id=?1`,
        ).bind(input.webhookId, Date.now()),
        metaDb(env).prepare(
          `UPDATE commercial_sessions SET settlement_state='review_pending',updated_at=?2
             WHERE commercial_session_id=?1 AND settlement_state NOT IN ('settled','refunded')`,
        ).bind(session.commercial_session_id, Date.now()),
      ]);
      commercialEvent(env, "provider_event", null, {
        kind: input.callType === "avatok_livestream" ? "live_event" : "consult_1to1",
        outcome: "review_pending", event_class: "settlement_authority",
      });
      return { handled: true, reviewPending: true };
    }
    if ((jobs.results ?? []).length === 0) {
      await metaDb(env).prepare(
        `UPDATE commercial_sessions SET settlement_state='review_pending',updated_at=?2
         WHERE commercial_session_id=?1`,
      ).bind(session.commercial_session_id, Date.now()).run();
    }
    // [LIST-STATS-1] The session just landed in a terminal 'ended' state above
    // — refresh this creator's cached trust-ladder row (creator_stats) off
    // the hot path. Fire-and-forget on purpose: a stale stats row for a few
    // minutes is cosmetic, and this webhook must never fail (or slow down)
    // because of it. session here only carries commercial_session_id/state,
    // so the creator_id is looked up fresh.
    void metaDb(env).prepare(
      "SELECT creator_id FROM commercial_sessions WHERE commercial_session_id=?1",
    ).bind(session.commercial_session_id).first<{ creator_id: string }>()
      .then((row) => { if (row?.creator_id) return refreshCreatorStats(env, row.creator_id); })
      .catch((e) => console.warn("creator_stats refresh hook skipped:", String(e)));

    // [LIST-FREE-1] Free-lane settlement — spec §E.4. Same fire-and-forget posture as the
    // creator_stats refresh just above: this webhook must never fail or slow down because
    // of it, and `session` here only carries commercial_session_id/state, so the listing's
    // free_entry/attrs/capacity and the session's kind/creator_id are looked up fresh.
    void metaDb(env).prepare(
      `SELECT s.commercial_session_id, s.kind, s.creator_id,
              l.free_entry, l.attrs, l.capacity, l.duration_min
         FROM commercial_sessions s JOIN listings l ON l.id = s.listing_id
        WHERE s.commercial_session_id = ?1`,
    ).bind(session.commercial_session_id).first<{
      commercial_session_id: string; kind: FreeSessionKind; creator_id: string;
      free_entry: number | null; attrs: string | null; capacity: number | null; duration_min: number | null;
    }>()
      .then(async (freeRow) => {
        if (!freeRow || Number(freeRow.free_entry) !== 1) return;
        const policy = await freeSessionPolicy(env, freeRow);
        await settleFreeSession(env, {
          sessionId: freeRow.commercial_session_id, creatorId: freeRow.creator_id, kind: freeRow.kind,
          capTokens: policy.capTokens, ratePerAttendeeMinute: policy.ratePerAttendeeMinute,
        });
      })
      .catch((e) => console.warn("free session settlement skipped:", String(e)));
  }
  await metaDb(env).prepare(
    "UPDATE commercial_provider_events SET processing_state='applied',processed_at=?2 WHERE provider_event_id=?1",
  ).bind(input.webhookId, Date.now()).run();
  commercialEvent(env, "provider_event", null, {
    kind: input.callType === "avatok_livestream" ? "live_event" : "consult_1to1",
    outcome: "applied", event_class: input.eventType.toLowerCase().includes("participant") ? "participant" : "state",
  });
  return { handled: true };
}

/** Bounded cron reconciliation for provider-control outcomes that were
 * uncertain. Authenticated GET evidence can restore control state, but an
 * unsigned reconciliation response never auto-releases escrow. */
export async function reconcileCommercialSessions(
  env: Env,
  limit = 10,
): Promise<{ scanned: number; restored: number; reviewPending: number }> {
  if (!configured(env)) return { scanned: 0, restored: 0, reviewPending: 0 };
  const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
  const rows = await metaDb(env).prepare(
    `SELECT commercial_session_id,provider_call_type,provider_call_id
     FROM commercial_sessions WHERE state='reconciliation_pending'
     ORDER BY updated_at LIMIT ?1`,
  ).bind(safeLimit).all<{
    commercial_session_id: string;
    provider_call_type: string;
    provider_call_id: string;
  }>();
  let restored = 0;
  let reviewPending = 0;
  for (const row of rows.results ?? []) {
    const bindings = streamVideoBindings(env);
    if (!bindings) continue;
    const tokens = await providerTokens(bindings, "server-reconciliation");
    let response: Response;
    try {
      response = await fetch(providerUrl(env, row.provider_call_type, row.provider_call_id), {
        method: "GET",
        headers: { Authorization: tokens.server, "stream-auth-type": "jwt" },
      });
    } catch {
      commercialEvent(env, "reconciliation", null, { outcome: "provider_unavailable" });
      continue;
    }
    if (!response.ok && response.status !== 404) {
      commercialEvent(env, "reconciliation", null, { outcome: "provider_rejected" });
      continue;
    }
    const raw = response.status === 404 ? JSON.stringify({ status: 404 }) : await response.text();
    const hash = await sha256Hex(raw);
    const eventId = `reconcile:${row.commercial_session_id}:${hash.slice(0, 24)}`;
    await metaDb(env).prepare(
      `INSERT OR IGNORE INTO commercial_provider_events
       (provider_event_id,provider,provider_call_type,provider_call_id,commercial_session_id,
        event_type,provider_occurred_at,received_at,payload_sha256,payload_json,
        evidence_source,processing_state,processed_at)
       VALUES (?1,'getstream',?2,?3,?4,'reconciliation.call_state',?5,?5,?6,?7,
        'authenticated_reconciliation','applied',?5)`,
    ).bind(
      eventId, row.provider_call_type, row.provider_call_id,
      row.commercial_session_id, Date.now(), hash, raw,
    ).run();
    const persistedEvent = await metaDb(env).prepare(
      `SELECT provider,provider_call_type,provider_call_id,commercial_session_id,event_type,
         evidence_source,payload_sha256,payload_json
         FROM commercial_provider_events WHERE provider_event_id=?1`,
    ).bind(eventId).first<{
      provider: string;
      provider_call_type: string | null;
      provider_call_id: string | null;
      commercial_session_id: string | null;
      event_type: string;
      evidence_source: string;
      payload_sha256: string;
      payload_json: string;
    }>();
    if (!persistedEvent
      || persistedEvent.provider !== "getstream"
      || persistedEvent.provider_call_type !== row.provider_call_type
      || persistedEvent.provider_call_id !== row.provider_call_id
      || persistedEvent.commercial_session_id !== row.commercial_session_id
      || persistedEvent.event_type !== "reconciliation.call_state"
      || persistedEvent.evidence_source !== "authenticated_reconciliation"
      || persistedEvent.payload_sha256 !== hash
      || persistedEvent.payload_json !== raw) {
      commercialEvent(env, "reconciliation", null, { outcome: "review_pending", reason: "event_authority_mismatch" });
      continue;
    }

    let payload: Record<string, any> = {};
    try { payload = JSON.parse(raw) as Record<string, any>; } catch { /* review below */ }
    const call = payload.call ?? payload.data?.call ?? {};
    const session = payload.session ?? payload.data?.session ?? call.session ?? {};
    const ended = response.status === 404 || Boolean(call.ended_at ?? session.ended_at);
    const backstage = call.backstage === true;
    const live = call.backstage === false || Boolean(call.live_started_at ?? session.started_at);
    const now = Date.now();
    if (ended) {
      await metaDb(env).batch([
        metaDb(env).prepare(
          `UPDATE commercial_sessions SET state='ended',ended_at=COALESCE(ended_at,?2),
            settlement_state='review_pending',state_version=state_version+1,updated_at=?2
           WHERE commercial_session_id=?1 AND state='reconciliation_pending'`,
        ).bind(row.commercial_session_id, now),
        metaDb(env).prepare(
          `UPDATE commercial_control_operations SET state='reconciliation_pending',
            updated_at=?2 WHERE commercial_session_id=?1 AND state IN ('pending','reconciliation_pending')`,
        ).bind(row.commercial_session_id, now),
        metaDb(env).prepare(
          `INSERT OR IGNORE INTO commercial_settlement_jobs
           (settlement_job_id,commercial_session_id,order_id,state,terminal_event_id,
            attempts,last_error,created_at,updated_at)
           SELECT 'settlement:' || ?1 || ':' || p.order_id,?1,p.order_id,
             'review_pending',?2,0,'terminal state recovered without signed attendance evidence',?3,?3
           FROM commercial_policy_snapshots p
           WHERE p.listing_id=(SELECT listing_id FROM commercial_sessions WHERE commercial_session_id=?1)
             AND COALESCE(p.booking_id,'')=COALESCE(
               (SELECT booking_id FROM commercial_sessions WHERE commercial_session_id=?1),''
             )`,
        ).bind(row.commercial_session_id, eventId, now),
      ]);
      commercialEvent(env, "reconciliation", null, { outcome: "review_pending", reason: "terminal_without_signed_attendance" });
      reviewPending++;
    } else if (backstage || live) {
      await metaDb(env).batch([
        metaDb(env).prepare(
          `UPDATE commercial_sessions SET state=?2,
            state_version=state_version+1,updated_at=?3
           WHERE commercial_session_id=?1 AND state='reconciliation_pending'`,
        ).bind(row.commercial_session_id, live && !backstage ? "live" : "backstage", now),
        metaDb(env).prepare(
          `UPDATE commercial_control_operations SET state='failed',updated_at=?2
           WHERE commercial_session_id=?1 AND state='reconciliation_pending'`,
        ).bind(row.commercial_session_id, now),
      ]);
      commercialEvent(env, "reconciliation", null, { outcome: "restored" });
      restored++;
    }
  }
  return { scanned: (rows.results ?? []).length, restored, reviewPending };
}
