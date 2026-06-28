// Ably realtime auth + server publish (Ably migration, 2026-06-27).
//
// The avatok-api Worker stays the AUTH authority and keeps messages
// server-readable: the app never holds an Ably API key. Instead it calls
// POST /api/ably/token with its Clerk session; we mint a SHORT-LIVED Ably JWT
// (HS256) that pins clientId = ctx.uid and grants tightly room-scoped
// capabilities. Durable messages are published to Ably server-side (ablyPublish,
// called from the existing /api/msg/send path) AFTER moderation/block/brain, so
// the "server can read & route" property we kept from the Cloudflare pivot is
// preserved while Ably handles the realtime fan-out.
//
// Config (secret): ABLY_API_KEY = "<keyName>:<keySecret>" (one Ably API key).
// Unset ⇒ 503 (flag-gated like every other integration).
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";

const enc = new TextEncoder();
const TOKEN_TTL_S = 60 * 60; // 1h — the client re-mints via authCallback on expiry.

function b64url(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export function ablyConfigured(env: Env): boolean {
  return typeof env.ABLY_API_KEY === "string" && env.ABLY_API_KEY.includes(":");
}

/** The user's room-scoped Ably capabilities. clientId is pinned in the JWT, so a
 *  user can only ever act as themselves. Channels mirror the app's helpers
 *  (config.dart): msg:/typing:/meta:/presence:. */
function capabilityFor(uid: string): Record<string, string[]> {
  return {
    "msg:*": ["subscribe", "history"],            // durable msgs (server publishes)
    "typing:*": ["publish", "subscribe"],          // ephemeral typing
    "meta:*": ["publish", "subscribe", "history"], // receipts + tombstones
    "react:*": ["publish", "subscribe", "history"],// Phase 4 — per-message reactions (live)
    "burst:*": ["publish", "subscribe"],           // Phase 4 — ephemeral floating-emoji bursts
    "room:*": ["subscribe", "presence"],           // Phase 4 — occupancy (presence members count)
    [`room:${uid}`]: ["publish", "subscribe", "presence"],
    "presence:*": ["subscribe"],                   // watch peers' online/last-seen
    [`presence:${uid}`]: ["publish", "subscribe", "presence"], // my own presence
  };
}

/** Mint an Ably JWT (HS256, kid = keyName). */
async function ablyJwt(env: Env, uid: string): Promise<string> {
  const [keyName, keySecret] = env.ABLY_API_KEY!.split(":");
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT", kid: keyName }));
  const payload = {
    "x-ably-capability": JSON.stringify(capabilityFor(uid)),
    "x-ably-clientId": uid,
    iat: now - 10,
    exp: now + TOKEN_TTL_S,
  };
  const body = b64url(JSON.stringify(payload));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(keySecret), enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

// ---- POST /api/ably/token ---------------------------------------------------
export async function ablyToken(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  if (!ablyConfigured(env)) return json({ error: "ably not configured" }, 503);
  try {
    const token = await ablyJwt(env, ctx.uid);
    return json({ token, clientId: ctx.uid, expires_in: TOKEN_TTL_S });
  } catch (e) {
    return json({ error: "mint failed", detail: String(e).slice(0, 200) }, 500);
  }
}

// ---- server-side publish (REST) ---------------------------------------------
// Basic-auth REST publish with the API key. Used by /api/msg/send to push the
// stored, moderated message onto Ably for instant live delivery. Best-effort —
// never blocks the send (offline recipients still get the FCM wake).
// `opts.id` sets Ably's idempotent message id. We pass our own canonical id
// (chronologically sortable — see canonicalMsgId) so the live message, the R2
// archive key, and the client dedupe key are all the SAME value. Re-publishing
// the same id is a no-op on Ably (safe retries).
export async function ablyPublish(
  env: Env, channel: string, name: string, data: unknown,
  opts?: { clientId?: string; id?: string },
): Promise<boolean> {
  if (!ablyConfigured(env)) return false;
  try {
    const auth = "Basic " + btoa(env.ABLY_API_KEY!);
    const res = await fetch(
      `https://rest.ably.io/channels/${encodeURIComponent(channel)}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: auth },
        body: JSON.stringify({
          name, data,
          ...(opts?.clientId ? { clientId: opts.clientId } : {}),
          ...(opts?.id ? { id: opts.id } : {}),
        }),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

/** Canonical, chronologically-sortable message id: 13-digit zero-padded epoch ms
 *  + a short random suffix → lexical sort == time order, collision-safe. Used as
 *  the Ably message id, the R2 archive key, and the client dedupe key. */
export function canonicalMsgId(createdMs: number): string {
  return `${String(createdMs).padStart(13, "0")}.${crypto.randomUUID().slice(0, 8)}`;
}
