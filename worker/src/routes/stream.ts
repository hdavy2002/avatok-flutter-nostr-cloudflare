// POST /webhooks/stream — Cloudflare Stream Live event sink (AvaLive).
// Verifies the Webhook-Signature (HMAC-SHA256 over "time.body") when
// STREAM_WEBHOOK_SECRET is set — gated like the rest of the secrets. On a
// connect/disconnect it records live status; when a recording is ready it
// dispatches the recording to Q_MODERATION for a post-stream content scan.
//
// NOTE: a NIP-53 kind:30311 "live event" is a SIGNED Nostr event, so its status
// can only be flipped by the broadcaster's key (the app republishes 30311 on
// state change). The server can't forge it, so we persist lifecycle to
// live_streams (DB_META) for discovery/cleanup and let the client update 30311.
import type { Env } from "../types";
import { json } from "../util";

export async function streamWebhook(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const raw = await req.text();

  // Signature check (gated). Header: "time=1700000000,sig1=<hexhmac>".
  if (env.STREAM_WEBHOOK_SECRET) {
    const ok = await verifySignature(env.STREAM_WEBHOOK_SECRET, req.headers.get("webhook-signature"), raw);
    if (!ok) return json({ error: "bad signature" }, 401);
  } else {
    console.warn("STREAM_WEBHOOK_SECRET unset — accepting Stream webhook unverified");
  }

  let body: any = {};
  try { body = JSON.parse(raw); } catch { return json({ error: "bad json" }, 400); }

  const uid: string = body.uid || body.data?.uid || "";              // Cloudflare Stream id
  const liveInput: string = body.liveInput || body.live_input || body.data?.live_input || "";
  const state: string = body.status?.state || body.status?.current?.state || body.state || "";
  const readyToStream: boolean = body.readyToStream === true || state === "ready";
  const creatorUid: string = body.meta?.creator || body.meta?.uid || ""; // owner (Clerk uid)

  // Persist lifecycle (best-effort; table is additive — see migrations/stream.sql).
  // live_streams.npub holds the creator's uid VALUE — the column keeps its name to
  // avoid colliding with Cloudflare Stream's own `uid` (= the stream id) column.
  try {
    await env.DB_META.prepare(
      `INSERT INTO live_streams (uid, live_input, npub, state, updated_at)
       VALUES (?1,?2,?3,?4,?5)
       ON CONFLICT(uid) DO UPDATE SET state=?4, updated_at=?5, live_input=COALESCE(?2,live_input), npub=COALESCE(NULLIF(?3,''),npub)`,
    ).bind(uid || liveInput || crypto.randomUUID(), liveInput, creatorUid, state || (readyToStream ? "ready" : "unknown"), Date.now()).run();
  } catch (e) {
    console.warn("live_streams write skipped (run migrations/stream.sql):", String(e));
  }

  // Recording ready → queue post-stream content scan.
  if (readyToStream && creatorUid) {
    ctx.waitUntil(env.Q_MODERATION.send({ type: "stream_recording", uid: creatorUid, media_id: uid, hash: "", r2_key: "" }));
  }

  return json({ ok: true });
}

async function verifySignature(secret: string, header: string | null, body: string): Promise<boolean> {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=").map((s) => s.trim())) as [string, string][]);
  const time = parts.time;
  const sig = parts.sig1;
  if (!time || !sig) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${time}.${body}`)));
  const want = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  // constant-time-ish compare
  if (want.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}
