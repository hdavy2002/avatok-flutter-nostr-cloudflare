/**
 * AvaTok call signaling — Cloudflare Worker + Durable Object.
 *
 * - GET  /                      → browser test client (join a room from a laptop)
 * - GET  /health                → "ok"
 * - WS   /room/:roomId?id=peer  → WebSocket signaling, one Durable Object per room
 *
 * The DO relays JSON signaling messages between peers in a room:
 *   {type:"welcome", id, peers:[...]}   (sent to a newcomer)
 *   {type:"peer-joined", id}            (broadcast to existing peers)
 *   {type:"peer-left", id}
 *   {type:"offer"|"answer"|"candidate"|"bye", to, from, ...payload}
 *
 * Role rule (avoids glare for 1:1): the NEWCOMER initiates the offer to each
 * existing peer. Works the same for the Flutter app and the web client.
 */

export interface Env {
  ROOMS: DurableObjectNamespace;
  PUSH: KVNamespace;
  MEDIA: R2Bucket;             // encrypted, content-addressed chat media
  FCM_PROJECT: string;
  TURN_KEY_ID?: string;        // secret
  TURN_KEY_API_TOKEN?: string; // secret
  FCM_CLIENT_EMAIL?: string;   // secret (service account)
  FCM_PRIVATE_KEY?: string;    // secret (service account)
  CALLS_APP_ID?: string;       // secret — Cloudflare Realtime (Calls) SFU app
  CALLS_APP_SECRET?: string;   // secret
  RESEND_API_KEY?: string;     // secret — optional, emails backup download links
  RELAY_SVC: Fetcher;          // service binding → avatok-relay (for /export)
}

// ---- FCM HTTP v1 (wake-on-call) ----

function b64url(input: ArrayBuffer | string): string {
  const bytes = typeof input === "string"
    ? new TextEncoder().encode(input)
    : new Uint8Array(input);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    der.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function fcmAccessToken(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: env.FCM_CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const input = `${header}.${claim}`;
  const key = await importPrivateKey(env.FCM_PRIVATE_KEY!);
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
  const jwt = `${input}.${b64url(sig)}`;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const data = (await r.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("no access token");
  return data.access_token;
}

async function sendCallPush(
  env: Env, token: string, data: Record<string, string>,
): Promise<number> {
  const at = await fcmAccessToken(env);
  const r = await fetch(
    `https://fcm.googleapis.com/v1/projects/${env.FCM_PROJECT}/messages:send`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: { token, data, android: { priority: "high" } },
      }),
    },
  );
  return r.status;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

/// Hash an npub so push-token KV keys don't store raw identities at rest.
async function npubKey(npub: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(npub));
  return "tok:" + [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }

    // ICE servers for 1:1 P2P calls — Cloudflare STUN + short-lived TURN.
    if (url.pathname === "/ice") {
      if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
      const stunOnly = {
        iceServers: [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }],
      };
      if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
        return new Response(JSON.stringify(stunOnly), {
          headers: { "content-type": "application/json", ...CORS },
        });
      }
      try {
        const r = await fetch(
          `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ ttl: 86400 }),
          },
        );
        const data = (await r.json()) as { iceServers?: unknown[] };
        // Drop alternate port 53 URLs (can time out in some clients).
        const servers = (data.iceServers || []).map((s: any) => ({
          ...s,
          urls: Array.isArray(s.urls)
            ? s.urls.filter((u: string) => !u.includes(":53"))
            : s.urls,
        }));
        return new Response(JSON.stringify({ iceServers: servers.length ? servers : stunOnly.iceServers }), {
          headers: { "content-type": "application/json", ...CORS },
        });
      } catch {
        return new Response(JSON.stringify(stunOnly), {
          headers: { "content-type": "application/json", ...CORS },
        });
      }
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(WEB_CLIENT_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    // Register a device's FCM token against an npub.
    if (url.pathname === "/register" && req.method === "POST") {
      if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
      const body = (await req.json().catch(() => ({}))) as { npub?: string; token?: string };
      if (!body.npub || !body.token) {
        return new Response(JSON.stringify({ error: "npub and token required" }),
          { status: 400, headers: { "content-type": "application/json", ...CORS } });
      }
      const key = await npubKey(body.npub);
      const existing = new Set<string>(JSON.parse((await env.PUSH.get(key)) || "[]"));
      existing.add(body.token);
      await env.PUSH.put(key, JSON.stringify([...existing]), { expirationTtl: 60 * 60 * 24 * 60 });
      return new Response(JSON.stringify({ ok: true, devices: existing.size }),
        { headers: { "content-type": "application/json", ...CORS } });
    }

    // Ring a callee: send a high-priority FCM data message to wake their phone.
    if (url.pathname === "/call" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as
        { to?: string; from?: string; callId?: string; kind?: string; fromName?: string };
      if (!body.to || !body.callId) {
        return new Response(JSON.stringify({ error: "to and callId required" }),
          { status: 400, headers: { "content-type": "application/json", ...CORS } });
      }
      if (!env.FCM_CLIENT_EMAIL || !env.FCM_PRIVATE_KEY) {
        return new Response(JSON.stringify({ error: "FCM not configured" }),
          { status: 503, headers: { "content-type": "application/json", ...CORS } });
      }
      const tokens: string[] = JSON.parse((await env.PUSH.get(await npubKey(body.to))) || "[]");
      if (tokens.length === 0) {
        return new Response(JSON.stringify({ error: "callee has no registered devices" }),
          { status: 404, headers: { "content-type": "application/json", ...CORS } });
      }
      const data = {
        type: "call",
        callId: body.callId,
        from: body.from ?? "",
        fromName: body.fromName ?? "AvaTOK",
        kind: body.kind ?? "audio",
      };
      const results: number[] = [];
      for (const t of tokens) {
        try { results.push(await sendCallPush(env, t, data)); } catch { results.push(0); }
      }
      return new Response(JSON.stringify({ sent: results.filter((s) => s === 200).length, results }),
        { headers: { "content-type": "application/json", ...CORS } });
    }

    // Relay a call status (declined / busy / ended) to the caller via FCM, so
    // it arrives even if the callee's app couldn't hold the signaling socket.
    if (url.pathname === "/call-status" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as { to?: string; callId?: string; status?: string };
      if (!b.to || !b.callId || !b.status) return json({ error: "to, callId, status required" }, 400);
      if (!env.FCM_CLIENT_EMAIL || !env.FCM_PRIVATE_KEY) return json({ error: "FCM not configured" }, 503);
      const tokens: string[] = JSON.parse((await env.PUSH.get(await npubKey(b.to))) || "[]");
      const data = { type: "call-status", callId: b.callId, status: b.status };
      const results: number[] = [];
      for (const t of tokens) {
        try { results.push(await sendCallPush(env, t, data)); } catch { results.push(0); }
      }
      return json({ sent: results.filter((s) => s === 200).length });
    }

    // ---- AvaTok public directory (NIP-05-style) ----
    if (req.method === "OPTIONS" &&
        ["/profile", "/resolve", "/search"].includes(url.pathname)) {
      return new Response(null, { headers: CORS });
    }

    // Upsert a profile so others can find you by @handle / name.
    if (url.pathname === "/profile" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as
        { npub?: string; handle?: string; name?: string };
      if (!b.npub) return json({ error: "npub required" }, 400);
      const handle = (b.handle || "").trim().toLowerCase().replace(/^@/, "");
      const prof = { npub: b.npub, handle, name: (b.name || "").trim() };
      await env.PUSH.put(`prof:${b.npub}`, JSON.stringify(prof));
      if (handle) await env.PUSH.put(`handle:${handle}`, b.npub);
      // Maintain a small searchable index (cap 5000).
      const idx: any[] = JSON.parse((await env.PUSH.get("dir:all")) || "[]");
      const at = idx.findIndex((p) => p.npub === b.npub);
      if (at >= 0) idx[at] = prof; else idx.unshift(prof);
      await env.PUSH.put("dir:all", JSON.stringify(idx.slice(0, 5000)));
      return json({ ok: true, profile: prof });
    }

    // Resolve a single identifier (@handle, handle, or npub) → profile.
    if (url.pathname === "/resolve") {
      const q = (url.searchParams.get("q") || "").trim();
      if (!q) return json({ error: "q required" }, 400);
      if (q.startsWith("npub1")) {
        const p = JSON.parse((await env.PUSH.get(`prof:${q}`)) || "null");
        return json({ npub: q, profile: p });
      }
      const handle = q.toLowerCase().replace(/^@/, "");
      const npub = await env.PUSH.get(`handle:${handle}`);
      if (!npub) return json({ npub: null }, 404);
      const p = JSON.parse((await env.PUSH.get(`prof:${npub}`)) || "null");
      return json({ npub, profile: p });
    }

    // Substring search over handle + name for the "Search site" tab.
    if (url.pathname === "/search") {
      const q = (url.searchParams.get("q") || "").trim().toLowerCase();
      if (q.length < 2) return json({ results: [] });
      const idx: any[] = JSON.parse((await env.PUSH.get("dir:all")) || "[]");
      const results = idx
        .filter((p) => p.handle?.includes(q) || p.name?.toLowerCase().includes(q))
        .slice(0, 20);
      return json({ results });
    }

    // ---- Encrypted, content-addressed chat media (Blossom-style on R2) ----
    if (url.pathname === "/media" && req.method === "OPTIONS") {
      return new Response(null, { headers: { ...CORS, "access-control-allow-headers": "content-type, x-content-type" } });
    }
    if (url.pathname === "/media" && req.method === "POST") {
      const buf = await req.arrayBuffer();
      if (buf.byteLength === 0) return json({ error: "empty body" }, 400);
      if (buf.byteLength > 25 * 1024 * 1024) return json({ error: "max 25 MB" }, 413);
      const digest = await crypto.subtle.digest("SHA-256", buf);
      const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      const ct = req.headers.get("x-content-type") || "application/octet-stream";
      // De-dupe: only write if absent.
      const head = await env.MEDIA.head(hash);
      if (!head) await env.MEDIA.put(hash, buf, { httpMetadata: { contentType: ct } });
      return json({ id: hash, size: buf.byteLength, url: `/media/${hash}` });
    }
    const mm = url.pathname.match(/^\/media\/([a-f0-9]{64})$/);
    if (mm && req.method === "GET") {
      const obj = await env.MEDIA.get(mm[1]);
      if (!obj) return new Response("not found", { status: 404, headers: CORS });
      const h = new Headers(CORS);
      h.set("content-type", obj.httpMetadata?.contentType || "application/octet-stream");
      h.set("cache-control", "public, max-age=31536000, immutable");
      return new Response(obj.body, { headers: h });
    }

    // ---- Account backup: export relay data → R2 → download link (+ optional email) ----
    if (url.pathname === "/backup" && req.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }
    if (url.pathname === "/backup" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as { pubkey?: string; email?: string };
      if (!b.pubkey || !/^[0-9a-f]{64}$/.test(b.pubkey)) {
        return json({ error: "valid pubkey required" }, 400);
      }
      const exp = await env.RELAY_SVC.fetch(`https://relay/export?pubkey=${b.pubkey}`);
      if (!exp.ok) return json({ error: "export failed", status: exp.status }, 502);
      const data = await exp.text();
      const key = `backups/${b.pubkey}-${Date.now()}.json`;
      await env.MEDIA.put(key, data, { httpMetadata: { contentType: "application/json" } });
      const link = `${url.origin}/${key}`;
      let emailed = false;
      if (env.RESEND_API_KEY && b.email) {
        try {
          const r = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: "AvaTOK <backup@avatok.ai>", to: [b.email],
              subject: "Your AvaTOK backup is ready",
              html: `<p>Your account export is ready.</p><p><a href="${link}">Download backup</a> — media files are not included.</p>`,
            }),
          });
          emailed = r.ok;
        } catch {/* ignore */}
      }
      return json({ url: link, emailed, size: data.length });
    }
    const bm = url.pathname.match(/^\/(backups\/[0-9a-f]{64}-\d+\.json)$/);
    if (bm && req.method === "GET") {
      const obj = await env.MEDIA.get(bm[1]);
      if (!obj) return new Response("not found", { status: 404, headers: CORS });
      return new Response(obj.body, {
        headers: { ...CORS, "content-type": "application/json",
          "content-disposition": 'attachment; filename="avatok-backup.json"' },
      });
    }

    // ---- Group calls: proxy to Cloudflare Realtime (Calls) SFU ----
    // Client calls POST /sfu/sessions/new, /sfu/sessions/:id/tracks/new,
    // PUT /sfu/sessions/:id/renegotiate — we inject the app credentials.
    if (url.pathname.startsWith("/sfu/")) {
      if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
      if (!env.CALLS_APP_ID || !env.CALLS_APP_SECRET) {
        return json({ error: "SFU not configured",
          hint: "set CALLS_APP_ID and CALLS_APP_SECRET (one-time Realtime app)" }, 503);
      }
      const base = `https://rtc.live.cloudflare.com/v1/apps/${env.CALLS_APP_ID}`;
      const sub = url.pathname.slice("/sfu".length); // keep leading slash
      const r = await fetch(base + sub + url.search, {
        method: req.method,
        headers: {
          Authorization: `Bearer ${env.CALLS_APP_SECRET}`,
          "Content-Type": "application/json",
        },
        body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.text(),
      });
      const body = await r.text();
      return new Response(body, {
        status: r.status,
        headers: { "content-type": "application/json", ...CORS },
      });
    }

    const m = url.pathname.match(/^\/room\/([A-Za-z0-9_-]{1,64})$/);
    if (m) {
      const id = env.ROOMS.idFromName(m[1]);
      return env.ROOMS.get(id).fetch(req);
    }
    return new Response("not found", { status: 404 });
  },
};

export class Room {
  state: DurableObjectState;
  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const url = new URL(req.url);
    const peerId = (url.searchParams.get("id") || crypto.randomUUID()).slice(0, 64);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Hibernatable WebSocket; tag carries the peer id.
    this.state.acceptWebSocket(server, [peerId]);

    const others = this.state.getWebSockets().filter((ws) => ws !== server);
    const otherIds = others
      .map((ws) => this.state.getTags(ws)[0])
      .filter((x) => x && x !== peerId);

    server.send(JSON.stringify({ type: "welcome", id: peerId, peers: otherIds }));
    for (const ws of others) {
      try { ws.send(JSON.stringify({ type: "peer-joined", id: peerId })); } catch {}
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    if (typeof msg !== "string") return;
    let data: any;
    try { data = JSON.parse(msg); } catch { return; }

    const from = this.state.getTags(ws)[0];
    data.from = from;

    const all = this.state.getWebSockets();
    if (data.to) {
      for (const w of all) {
        if (this.state.getTags(w)[0] === data.to) {
          try { w.send(JSON.stringify(data)); } catch {}
        }
      }
    } else {
      for (const w of all) {
        if (w !== ws) { try { w.send(JSON.stringify(data)); } catch {} }
      }
    }
  }

  async webSocketClose(ws: WebSocket) {
    const from = this.state.getTags(ws)[0];
    for (const w of this.state.getWebSockets()) {
      if (w !== ws) { try { w.send(JSON.stringify({ type: "peer-left", id: from })); } catch {} }
    }
  }

  async webSocketError() { /* noop */ }
}

const WEB_CLIENT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AvaTok Call Test</title>
<style>
  :root { --brand:#08C4C4; --ink:#0F1115; --soft:#F4F5F7; }
  * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:#E7E9EE; color:var(--ink); }
  .wrap { max-width:760px; margin:0 auto; padding:18px; }
  h1 { font-size:22px; margin:8px 0 2px; }
  .sub { color:#737A86; font-size:13px; margin-bottom:14px; }
  .row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:12px; }
  input { padding:12px 14px; border:1px solid #d7dbe0; border-radius:12px; font-size:16px; flex:1; min-width:160px; }
  button { padding:12px 18px; border:none; border-radius:12px; background:var(--brand); color:#fff; font-size:15px; font-weight:600; cursor:pointer; }
  button.sec { background:#fff; color:var(--ink); border:1px solid #d7dbe0; }
  button:disabled { opacity:.5; cursor:default; }
  .videos { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:10px; }
  video { width:100%; background:#11131A; border-radius:14px; aspect-ratio:3/4; object-fit:cover; }
  .tag { font-size:11px; color:#737A86; margin:4px 2px 0; }
  #log { white-space:pre-wrap; font-family:ui-monospace,Menlo,monospace; font-size:11px; background:#11131A; color:#9fe7e7; padding:10px; border-radius:12px; margin-top:14px; max-height:160px; overflow:auto; }
  @media (max-width:520px){ .videos{ grid-template-columns:1fr; } }
</style>
</head>
<body>
<div class="wrap">
  <h1>AvaTok Call Test <span style="color:var(--brand)">●</span></h1>
  <div class="sub">Enter the same room code on your phone and here. P2P WebRTC, audio + video.</div>
  <div class="row">
    <input id="room" placeholder="room code (e.g. test123)" value="test123" />
    <button id="join">Join call</button>
    <button id="hang" class="sec" disabled>Hang up</button>
  </div>
  <div class="videos">
    <div><video id="local" autoplay playsinline muted></video><div class="tag">You (browser)</div></div>
    <div><video id="remote" autoplay playsinline></video><div class="tag">Remote (phone)</div></div>
  </div>
  <div id="log"></div>
</div>
<script>
const ICE = [
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.l.google.com:19302" }
];
const $ = (id) => document.getElementById(id);
const log = (m) => { const l=$("log"); l.textContent += m + "\\n"; l.scrollTop=l.scrollHeight; };
let ws, pc, localStream, myId = "web-" + Math.random().toString(36).slice(2,8), remoteId = null;

async function start() {
  const room = $("room").value.trim() || "test123";
  $("join").disabled = true;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio:true, video:{ facingMode:"user" } });
    $("local").srcObject = localStream;
  } catch (e) { log("camera/mic error: " + e); $("join").disabled=false; return; }

  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(proto + "://" + location.host + "/room/" + encodeURIComponent(room) + "?id=" + myId);
  ws.onopen = () => log("signaling connected as " + myId);
  ws.onclose = () => log("signaling closed");
  ws.onerror = () => log("signaling error");
  ws.onmessage = onSignal;
  $("hang").disabled = false;
}

function newPC() {
  pc = new RTCPeerConnection({ iceServers: ICE });
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  pc.onicecandidate = (e) => { if (e.candidate && remoteId) send({ type:"candidate", to:remoteId, candidate:e.candidate }); };
  pc.ontrack = (e) => { $("remote").srcObject = e.streams[0]; log("remote track received"); };
  pc.onconnectionstatechange = () => log("pc: " + pc.connectionState);
  return pc;
}

function send(o) { ws.send(JSON.stringify(o)); }

async function onSignal(ev) {
  const d = JSON.parse(ev.data);
  if (d.type === "welcome") {
    log("in room. peers: " + JSON.stringify(d.peers));
    if (d.peers && d.peers.length) { remoteId = d.peers[0]; newPC(); const off = await pc.createOffer(); await pc.setLocalDescription(off); send({ type:"offer", to:remoteId, sdp:off }); log("sent offer to " + remoteId); }
  } else if (d.type === "peer-joined") {
    log("peer joined: " + d.id);
  } else if (d.type === "offer") {
    remoteId = d.from; if (!pc) newPC();
    await pc.setRemoteDescription(new RTCSessionDescription(d.sdp));
    const ans = await pc.createAnswer(); await pc.setLocalDescription(ans);
    send({ type:"answer", to:remoteId, sdp:ans }); log("answered " + remoteId);
  } else if (d.type === "answer") {
    await pc.setRemoteDescription(new RTCSessionDescription(d.sdp)); log("got answer");
  } else if (d.type === "candidate") {
    try { await pc.addIceCandidate(new RTCIceCandidate(d.candidate)); } catch(e){ log("ice err "+e); }
  } else if (d.type === "peer-left" || d.type === "bye") {
    log("peer left"); if ($("remote").srcObject){ $("remote").srcObject=null; }
  }
}

function hang() {
  if (remoteId) send({ type:"bye", to:remoteId });
  if (pc) pc.close(); pc=null;
  if (ws) ws.close();
  if (localStream) localStream.getTracks().forEach(t=>t.stop());
  $("local").srcObject=null; $("remote").srcObject=null;
  $("join").disabled=false; $("hang").disabled=true; remoteId=null;
  log("hung up");
}
$("join").onclick = start;
$("hang").onclick = hang;
</script>
</body>
</html>`;
