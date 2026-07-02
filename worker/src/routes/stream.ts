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
  const liveInput: string = body.liveInput || body.live_input || body.data?.live_input || body.data?.input_id || "";
  const state: string = body.status?.state || body.status?.current?.state || body.state || "";
  const eventType: string = body.eventType || body.event_type || body.name || state || "";
  const readyToStream: boolean = body.readyToStream === true || state === "ready";
  const creatorUid: string = body.meta?.creator || body.meta?.uid || ""; // owner (Clerk uid)
  const listingId: string = body.meta?.listing || "";

  // ---- Phase 7: live event lifecycle + R7 downtime evidence -----------------
  // connected/disconnected gaps feed refund rule R7 ("platform failure" fires
  // only after ≥5 CONTIGUOUS minutes of downtime, not transient blips — A4).
  // downtime_ms stores the LONGEST contiguous gap seen.
  const connected = /(^|\.)connected$|live_input\.connected/i.test(eventType) || state === "connected" || state === "live";
  const disconnected = /disconnected/i.test(eventType) || state === "disconnected";
  if (connected || disconnected) {
    try {
      const sess = listingId
        ? await env.DB_META.prepare("SELECT listing_id, downtime_ms, last_disconnect_at, state FROM live_sessions WHERE listing_id=?1").bind(listingId).first<any>()
        : await env.DB_META.prepare("SELECT listing_id, downtime_ms, last_disconnect_at, state FROM live_sessions WHERE live_input=?1").bind(liveInput || uid).first<any>();
      if (sess) {
        const now = Date.now();
        if (disconnected) {
          await env.DB_META.prepare(
            "UPDATE live_sessions SET last_disconnect_at=COALESCE(last_disconnect_at,?2), updated_at=?2 WHERE listing_id=?1",
          ).bind(sess.listing_id, now).run();
        } else if (sess.last_disconnect_at) {
          const gap = now - Number(sess.last_disconnect_at);
          await env.DB_META.prepare(
            "UPDATE live_sessions SET downtime_ms=MAX(downtime_ms,?2), last_disconnect_at=NULL, started_at=COALESCE(started_at,?3), updated_at=?3 WHERE listing_id=?1",
          ).bind(sess.listing_id, gap, now).run();
        } else {
          await env.DB_META.prepare(
            "UPDATE live_sessions SET started_at=COALESCE(started_at,?2), state=CASE WHEN state='scheduled' THEN 'live' ELSE state END, updated_at=?2 WHERE listing_id=?1",
          ).bind(sess.listing_id, now).run();
        }
        // Viewer overlay: "Creator reconnecting…" / auto-resume (A4).
        const stub = env.STREAM_SESSION_DO.get(env.STREAM_SESSION_DO.idFromName(`live:${sess.listing_id}`));
        ctx.waitUntil(stub.fetch("https://session/op", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ op: "host-live", live: connected }),
        }).then(() => undefined).catch(() => undefined));
      }
    } catch (e) {
      console.warn("live_sessions lifecycle write skipped:", String(e));
    }
  }

  // Persist lifecycle (best-effort; table is additive — see migrations/stream.sql).
  // live_streams.broadcaster_uid holds the creator's Clerk uid; the PK `uid` is
  // Cloudflare Stream's own id (the stream id) — a different value.
  try {
    await env.DB_META.prepare(
      `INSERT INTO live_streams (uid, live_input, broadcaster_uid, state, updated_at)
       VALUES (?1,?2,?3,?4,?5)
       ON CONFLICT(uid) DO UPDATE SET state=?4, updated_at=?5, live_input=COALESCE(?2,live_input), broadcaster_uid=COALESCE(NULLIF(?3,''),broadcaster_uid)`,
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
