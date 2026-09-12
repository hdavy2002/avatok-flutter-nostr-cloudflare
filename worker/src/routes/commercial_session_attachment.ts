// [APP-ONLY-TX-WORKER-RELAY-1] RULEBOOK-PAID-SESSIONS.md §7: "The browser is
// customer-only... may see and hear the creator, be seen and heard himself,
// chat, and upload a file into that chat." This is the upload half of that -
// the DO relay (do/stream_session.ts, sanitizeChatAttachment) is the other.
//
//   POST /api/commercial/session/:kind/:id/attachment
//     kind: "live" | "consult" -- matches the DO instance naming
//     (`live:<listingId>` | `consult:<bookingId>`); :id is that listing/booking id.
//     Body: raw file bytes. Headers: x-file-name, x-content-type (or
//     content-type). Response: {url, name, size, mime} -- the exact shape
//     `sanitizeChatAttachment` (do/stream_session.ts) accepts as a chat
//     `attachment`, so the client sends this response straight back on its
//     next `{type:'chat', ...}` socket message.
//
// Auth -- two lanes, because RULEBOOK §7 lets a paying customer into this
// session WITHOUT an avaTOK account:
//   1. A normal signed-in account (Clerk JWT via requireUser) -- the creator,
//      or a signed-in buyer.
//   2. The session's own room token (the same HMAC-signed `SessionTokenPayload`
//      that gates the DO WebSocket -- routes/live.ts `verifySessionToken`,
//      minted for this exact booking/listing by buildWaitingRoomGrant /
//      commercialConsultJoin / commercialLiveJoin). This IS the "guest,
//      no-account" credential today: nothing in this codebase yet mints a
//      separate email-code JWT for an accountless customer (grepped for
//      requireGuestAuth / `/j/:token` -- neither exists), and the room token is
//      already the one thing a browser customer holds after checkout+prejoin
//      that proves they belong in THIS session. Both lanes are then required to
//      hold a live row in `commercial_entitlements` for this booking/listing --
//      the same table (and the same kind/listing_id/booking_id/account_id/role
//      shape) `entitlement()` in commercial_stream_sessions.ts queries -- so a
//      forged or stale token still can't upload without a real entitlement.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { metaDb } from "../db/shard";
import { rateLimit } from "../money";
import { verifySessionToken } from "./live";
import { isCommercialId } from "../lib/commercial_ids";
import { commercialEvent } from "../lib/commercial_telemetry";
import { ATTACH_MAX_BYTES, ATTACH_MIME_OK } from "../do/stream_session";

const ATTACH_RL_MAX = 20;               // 20 uploads per session per user...
const ATTACH_RL_WINDOW_SEC = 6 * 3600;  // ...within a 6h window (covers any slot length with margin)

type Kind = "live" | "consult";

function safeFileName(raw: string | null): string {
  const base = (raw || "file").trim().slice(0, 120) || "file";
  // Strip path separators and anything not safe in an R2 key segment -- the
  // descriptor's `name` (shown to users) keeps the original, this is only for
  // the on-disk key.
  return base.replace(/[\/\\]/g, "_").replace(/[^A-Za-z0-9._-]/g, "_") || "file";
}

interface Grant { uid: string; role: string }

/** Lane 1: a normal signed-in account. */
async function authAccount(req: Request, env: Env): Promise<Grant | null> {
  const ctx = await requireUser(req, env);
  return isFail(ctx) ? null : { uid: ctx.uid, role: "" };
}

/** Lane 2: the session's own room token (see file header -- today's guest credential). */
async function authSessionToken(req: Request, id: string, env: Env): Promise<Grant | null> {
  const u = new URL(req.url);
  const raw = req.headers.get("x-session-token") || u.searchParams.get("token")
    || (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") || "";
  if (!raw) return null;
  const p = await verifySessionToken(env, raw);
  if (!p || p.sid !== id) return null;
  return { uid: p.uid, role: p.role };
}

// Same table/shape `entitlement()` (commercial_stream_sessions.ts) reads --
// not imported (that function is private to a file this route does not own),
// re-queried here so an entitlement, not just a token, gates the upload.
async function hasEntitlement(env: Env, args: { kind: Kind; id: string; uid: string }): Promise<boolean> {
  const entKind = args.kind === "consult" ? "consult_1to1" : "live_event";
  const row = args.kind === "consult"
    ? await metaDb(env).prepare(
        `SELECT 1 FROM commercial_entitlements
          WHERE kind=?1 AND booking_id=?2 AND account_id=?3
            AND state IN ('reserved','held','active','consumed') LIMIT 1`,
      ).bind(entKind, args.id, args.uid).first()
    : await metaDb(env).prepare(
        `SELECT 1 FROM commercial_entitlements
          WHERE kind=?1 AND listing_id=?2 AND account_id=?3
            AND state IN ('reserved','held','active','consumed') LIMIT 1`,
      ).bind(entKind, args.id, args.uid).first();
  return !!row;
}

export async function commercialSessionAttachmentUpload(req: Request, env: Env): Promise<Response> {
  const m = new URL(req.url).pathname.match(
    /^\/api\/commercial\/session\/(live|consult)\/([A-Za-z0-9][A-Za-z0-9-]{0,159})\/attachment$/,
  );
  if (!m) return json({ error: "not found" }, 404);
  const kind = m[1] as Kind;
  const id = m[2];
  if (!isCommercialId(id)) return json({ error: "bad session id" }, 400);

  const grant = (await authAccount(req, env)) ?? (await authSessionToken(req, id, env));
  if (!grant) return json({ error: "auth required" }, 401);
  if (!(await hasEntitlement(env, { kind, id, uid: grant.uid }))) {
    return json({ error: "session entitlement required" }, 403);
  }

  const rl = await rateLimit(env, `attach:${kind}:${id}:${grant.uid}`, ATTACH_RL_MAX, ATTACH_RL_WINDOW_SEC);
  if (rl) return rl;

  const mime = (req.headers.get("x-content-type") || req.headers.get("content-type") || "").trim().split(";")[0];
  if (!ATTACH_MIME_OK.test(mime)) return json({ error: "unsupported file type" }, 415);

  const declaredLen = Number(req.headers.get("content-length") || "0");
  if (declaredLen > ATTACH_MAX_BYTES) return json({ error: "file too large", max: ATTACH_MAX_BYTES }, 413);

  const bytes = await req.arrayBuffer();
  if (!bytes.byteLength) return json({ error: "empty body" }, 400);
  if (bytes.byteLength > ATTACH_MAX_BYTES) return json({ error: "file too large", max: ATTACH_MAX_BYTES }, 413);

  const name = safeFileName(req.headers.get("x-file-name"));
  const key = `sessions/${id}/${crypto.randomUUID()}-${name}`;
  await env.BLOBS.put(key, bytes, { httpMetadata: { contentType: mime } });
  const url = `${env.BLOSSOM_BASE_URL}/${key}`;

  commercialEvent(env, "chat_attachment", grant.uid, { kind, mime, bytes: bytes.byteLength });

  return json({ url, name: req.headers.get("x-file-name")?.slice(0, 120) || name, size: bytes.byteLength, mime });
}
