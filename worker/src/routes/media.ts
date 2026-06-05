// Two upload paths + AvaLibrary + ICE. Reads are served by blossom.avatok.ai
// (public R2 bucket) — never through this Worker. Worker handles WRITES only.
import type { Env } from "../types";
import { json, sha256Hex, CORS } from "../util";
import { mediaSession, moderationSession } from "../db/shard";
import { authenticate, isErr } from "../auth";

// POST /upload/public — plaintext media (posts). sha256 → blocklist check →
// R2 PUT (status 'pending') → enqueue Workers-AI scan (Phase 4 consumer flips
// to 'live' or deletes). AI is async per Rulebook; blocklist is a cheap sync gate.
export async function uploadPublic(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const bytes = await req.arrayBuffer();
  if (!bytes.byteLength) return json({ error: "empty body" }, 400);
  const hash = await sha256Hex(bytes);                  // content id (moderation/blocklist/dedup)
  const r2Key = userKey(auth.npub, "public", hash);    // per-user storage path → clear ownership
  const url = `${env.BLOSSOM_BASE_URL}/${r2Key}`;
  const ct = req.headers.get("x-content-type") || req.headers.get("content-type") || "application/octet-stream";

  // Cheap synchronous blocklist gate (known-bad sha256 — content-level, cross-user).
  const blocked = await moderationSession(env)
    .prepare("SELECT 1 FROM blocked_media_hashes WHERE hash_value=?1 LIMIT 1").bind(hash).first();
  if (blocked) return json({ error: "rejected", reason: "blocked content" }, 403);

  const mdb = mediaSession(env);
  const existing = await mdb.prepare("SELECT id, moderation_status FROM user_media WHERE key=?1").bind(r2Key).first<any>();
  if (!existing) {
    await env.BLOBS.put(r2Key, bytes, { httpMetadata: { contentType: ct } });
    const id = crypto.randomUUID();
    await mdb.prepare(
      `INSERT INTO user_media (id, npub, media_type, storage, visibility, encrypted, key, display_url, mime_type, size_bytes, original_app, created_at, moderation_status)
       VALUES (?1,?2,?3,'blossom','public',0,?4,?5,?6,?7,?8,?9,'pending')`,
    ).bind(id, auth.npub, mediaType(ct), r2Key, url, ct, bytes.byteLength, "avatweet", Date.now()).run();
    // async moderation — content hash for scan/blocklist, r2_key for fetch/delete.
    ctx.waitUntil(env.Q_MODERATION.send({ type: "image", hash, npub: auth.npub, media_id: id, r2_key: r2Key }));
    // AvaBrain learns from public uploads (metadata only — no DM media here).
    ctx.waitUntil(env.Q_BRAIN.send({ npub: auth.npub, event_type: "upload_completed", source_app: "avatweet", payload: { hash, mime: ct, size: bytes.byteLength } }));
  }
  return json({ hash, key: r2Key, url, status: "pending" });
}

// POST /upload/private — client-side AES-GCM ciphertext (DM attachments).
// No scan (unscannable by design). Same public bucket — ciphertext is safe to
// serve; the AES key travels inside the encrypted DM.
export async function uploadPrivate(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const bytes = await req.arrayBuffer();
  if (!bytes.byteLength) return json({ error: "empty body" }, 400);
  const hash = await sha256Hex(bytes);
  const r2Key = userKey(auth.npub, "dm", hash);   // per-user path (ciphertext owned by sender)
  const url = `${env.BLOSSOM_BASE_URL}/${r2Key}`;
  const ct = "application/octet-stream"; // ciphertext

  const head = await env.BLOBS.head(r2Key);
  if (!head) await env.BLOBS.put(r2Key, bytes, { httpMetadata: { contentType: ct } });

  const mdb = mediaSession(env);
  const existing = await mdb.prepare("SELECT id FROM user_media WHERE key=?1").bind(r2Key).first();
  if (!existing) {
    await mdb.prepare(
      `INSERT INTO user_media (id, npub, media_type, storage, visibility, encrypted, key, display_url, mime_type, size_bytes, original_app, created_at, moderation_status)
       VALUES (?1,?2,'image','blossom','private',1,?3,?4,?5,?6,'avachat',?7,'skipped')`,
    ).bind(crypto.randomUUID(), auth.npub, r2Key, url, ct, bytes.byteLength, Date.now()).run();
  }
  return json({ hash, key: r2Key, url, status: "live" });
}

// Per-user storage prefix with a type subfolder → everything a user owns lives
// under `u/<npub>/…`, so an account delete is one prefix wipe and nothing of
// another user's can be touched. `npub` is bech32 (safe charset).
//   u/<npub>/public/<hash>   public posts
//   u/<npub>/dm/<hash>       DM ciphertext
//   u/<npub>/video/…         (future) Bunny is separate, but keep the convention
//   u/<npub>/backups/…       account exports
function userKey(npub: string, kind: "public" | "dm", hash: string): string {
  return `u/${npub}/${kind}/${hash}`;
}

// GET /media/:hash — back-compat shim. Old app fetched bytes here; now we 301 to
// the public bucket. Removed entirely at Phase 5 once the app reads blossom directly.
export function mediaRedirect(path: string, env: Env): Response {
  const hash = path.split("/").pop();
  return new Response(null, { status: 301, headers: { ...CORS, location: `${env.BLOSSOM_BASE_URL}/${hash}` } });
}

// GET /api/library?type=&cursor=  — paginated AvaLibrary for the authed user.
export async function getLibrary(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const sp = new URL(req.url).searchParams;
  const cursor = Number(sp.get("cursor") || Date.now());
  const type = sp.get("type");
  const sql = type
    ? `SELECT id, media_type, key, display_url, thumbnail_url, mime_type, visibility, created_at
       FROM user_media WHERE npub=?1 AND media_type=?2 AND created_at < ?3 ORDER BY created_at DESC LIMIT 20`
    : `SELECT id, media_type, key, display_url, thumbnail_url, mime_type, visibility, created_at
       FROM user_media WHERE npub=?1 AND created_at < ?2 ORDER BY created_at DESC LIMIT 20`;
  const mdb = mediaSession(env);
  const stmt = type
    ? mdb.prepare(sql).bind(auth.npub, type, cursor)
    : mdb.prepare(sql).bind(auth.npub, cursor);
  const rs = await stmt.all();
  const items = (rs.results ?? []) as any[];
  const next = items.length === 20 ? items[items.length - 1].created_at : null;
  return json({ items, cursor: next });
}

// GET /ice — short-lived STUN+TURN credentials from Cloudflare Calls.
export async function getIce(env: Env): Promise<Response> {
  const stunOnly = { iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] };
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return json(stunOnly);
  try {
    const r = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: 86400 }),
      },
    );
    if (!r.ok) return json(stunOnly);
    const data = (await r.json()) as any;
    return json(data.iceServers ? data : { iceServers: data });
  } catch {
    return json(stunOnly);
  }
}

function mediaType(ct: string): string {
  if (ct.startsWith("image/")) return "image";
  if (ct.startsWith("audio/")) return "audio";
  if (ct.startsWith("video/")) return "video";
  return "image";
}
