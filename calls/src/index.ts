/**
 * AvaTok calls backend — mints Cloudflare RealtimeKit participant tokens.
 *
 * POST /join  { room, name, role?, identifier? }
 *   role: "host" | "participant" | "guest"          → AvaTok group call
 *         "live_host" | "live_viewer"               → AvaLive
 *   → { meetingId, authToken, role, preset }
 *
 * A "room" maps to a stable RealtimeKit meeting (cached in KV); first joiner
 * creates the meeting, everyone else reuses it.
 */

export interface Env {
  ROOMS: KVNamespace;
  ACCOUNT_ID: string;
  APP_ID: string;
  CF_API_TOKEN: string; // secret
}

const PRESET: Record<string, string> = {
  host: "group_call_host",
  participant: "group_call_participant",
  guest: "group_call_guest",
  live_host: "livestream_host",
  live_viewer: "livestream_viewer",
};

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (url.pathname === "/health") return new Response("ok");

    // AvaLive — create (or reuse) a Cloudflare Stream live input for a room,
    // return WHIP (publish) + WHEP (play) URLs. Needs the CF token to have
    // Stream:Edit permission.
    if (url.pathname === "/live" && req.method === "POST") {
      let body: { room?: string };
      try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
      const room = (body.room || "").trim();
      if (!room) return json({ error: "room required" }, 400);
      const base = `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/stream`;
      const auth = { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" };

      let uid = await env.ROOMS.get(`live:${room}`);
      if (uid) {
        // Validate it still exists.
        const chk = await fetch(`${base}/live_inputs/${uid}`, { headers: auth });
        if (!chk.ok) uid = null;
      }
      if (!uid) {
        const res = await fetch(`${base}/live_inputs`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ meta: { name: `avalive:${room}` }, recording: { mode: "off" } }),
        });
        const data = (await res.json()) as { success?: boolean; result?: { uid?: string }; errors?: unknown };
        if (!data.success || !data.result?.uid) {
          return json({ error: "live input create failed", detail: data }, 502);
        }
        uid = data.result.uid;
        await env.ROOMS.put(`live:${room}`, uid, { expirationTtl: 86400 });
      }
      // Fetch full input to get WHIP/WHEP URLs.
      const got = await fetch(`${base}/live_inputs/${uid}`, { headers: auth });
      const full = (await got.json()) as { result?: any };
      const r = full.result || {};
      return json({
        inputUid: uid,
        whip: r.webRTC?.url ?? null,
        whep: r.webRTCPlayback?.url ?? null,
        hls: r.uid ? `https://customer-stream.cloudflarestream.com/${r.uid}/manifest/video.m3u8` : null,
      });
    }

    if (url.pathname !== "/join" || req.method !== "POST") {
      return json({ error: "not found" }, 404);
    }

    let body: { room?: string; name?: string; role?: string; identifier?: string };
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid json" }, 400);
    }
    const room = (body.room || "").trim();
    if (!room) return json({ error: "room required" }, 400);
    const role = body.role && PRESET[body.role] ? body.role : "participant";
    const preset = PRESET[role];
    const name = (body.name || "Guest").slice(0, 60);

    const base = `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/realtime/kit/${env.APP_ID}`;
    const auth = { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" };

    // Resolve (or create) the meeting for this room.
    let meetingId = await env.ROOMS.get(`room:${room}`);
    if (!meetingId) {
      const res = await fetch(`${base}/meetings`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ title: `avatok:${room}` }),
      });
      const data = (await res.json()) as { success?: boolean; data?: { id?: string } };
      if (!data.success || !data.data?.id) {
        return json({ error: "meeting create failed", detail: data }, 502);
      }
      meetingId = data.data.id;
      // Cache for 24h; calls rarely outlive that.
      await env.ROOMS.put(`room:${room}`, meetingId, { expirationTtl: 86400 });
    }

    // Add the participant → authToken.
    const pRes = await fetch(`${base}/meetings/${meetingId}/participants`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name,
        preset_name: preset,
        custom_participant_id: (body.identifier || crypto.randomUUID()).slice(0, 64),
      }),
    });
    const pData = (await pRes.json()) as { success?: boolean; data?: { token?: string } };
    if (!pData.success || !pData.data?.token) {
      return json({ error: "participant add failed", detail: pData }, 502);
    }

    return json({ meetingId, authToken: pData.data.token, role, preset });
  },
};
