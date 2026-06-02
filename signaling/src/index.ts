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
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(WEB_CLIENT_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
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
