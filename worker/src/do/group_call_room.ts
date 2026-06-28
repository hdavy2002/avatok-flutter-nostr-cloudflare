// GroupCallRoom — roster + active-speaker signalling for CF Realtime SFU group
// AUDIO calls (Specs/CF-REALTIME-SFU-GROUP-AUDIO-BUILD.md). One instance per
// group id. Unlike MeshRoom (which relays full WebRTC signalling for a P2P mesh),
// the SFU itself carries the media — this DO only tracks WHO is in the call,
// each member's SFU sessionId + published audio trackName, and computes the
// ACTIVE-SPEAKER set so each client pulls only the few loudest talkers (the key
// to good 32-person audio on tiny bandwidth). It persists nothing durable beyond
// the live socket attachments; the SFU session/track HTTP is proxied by
// routes/groupcall.ts (so the SFU app token never reaches the client).
//
// WS protocol (JSON):
//   client→server: {t:"hello", session}           (sent once after connect)
//                  {t:"published", track}          (mic local track name on the SFU)
//                  {t:"level", v}                   (0..1 mic level, ~4×/sec)
//                  {t:"roster"}                     (request a fresh roster)
//   server→client: {t:"welcome", you, roster}
//                  {t:"roster", roster:[{uid,session,track}]}
//                  {t:"speakers", uids:[...]}       (current active speakers)
//                  {t:"left", uid}
//                  {t:"full", reason}               (then close — 33rd joiner)
import type { Env } from "../types";

const MAX_GROUP = 32;
// How many of the loudest talkers each client pulls. 32-person audio forwards
// at most this many streams to each device instead of 31.
const ACTIVE_SPEAKERS = 6;
// A member counts as "speaking" above this smoothed level (0..1).
const SPEAKING_FLOOR = 0.04;
// Zombie sweep: evict a socket with no level/heartbeat for this long.
const STALE_MS = 45_000;
const SWEEP_MS = 15_000;
// Absolute backstop so a wedged room can't live forever.
const MAX_ROOM_MS = 18 * 3600 * 1000;

interface Att {
  uid: string;
  session: string; // SFU sessionId
  track: string | null; // published mic track name
  level: number; // smoothed 0..1
  ts: number; // last activity
  born: number;
}

export class GroupCallRoom {
  private state: DurableObjectState;
  private speakers: string[] = [];

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
  }

  async fetch(req: Request): Promise<Response> {
    // Presence probe (non-WS) — powers the in-chat "Ongoing call · N" banner.
    if (req.headers.get("Upgrade") !== "websocket") {
      const count = this.state.getWebSockets().length;
      return new Response(
        JSON.stringify({ live: count > 0, count, max: MAX_GROUP }),
        { headers: { "content-type": "application/json" } },
      );
    }

    const url = new URL(req.url);
    const uid = (url.searchParams.get("id") || crypto.randomUUID()).slice(0, 64);
    const session = (url.searchParams.get("session") || "").slice(0, 128);

    // Hard cap — the 33rd joiner is refused (clients also grey the control, and
    // routes/groupcall.ts soft-checks presence before minting an SFU session).
    if (this.state.getWebSockets().length >= MAX_GROUP) {
      const reject = new WebSocketPair();
      reject[1].accept();
      try {
        reject[1].send(JSON.stringify({ t: "full", reason: `call is full (${MAX_GROUP})` }));
        reject[1].close(1000, "room full (≤32)");
      } catch { /* ignore */ }
      return new Response(null, { status: 101, webSocket: reject[0] });
    }

    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    this.state.acceptWebSocket(server, [uid]);
    const now = Date.now();
    // serialize/deserializeAttachment are the hibernation-safe per-socket store
    // (cast to any so this compiles regardless of the workers-types version).
    (server as any).serializeAttachment({ uid, session, track: null, level: 0, ts: now, born: now } as Att);

    this.sendTo(server, { t: "welcome", you: uid, roster: this.roster() });
    this.broadcastRoster(server);
    void this.ensureSweep();
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string") return;
    let data: Record<string, unknown>;
    try { data = JSON.parse(message); } catch { return; }
    const att = this.att(ws);
    if (!att) return;
    att.ts = Date.now();

    switch (data.t) {
      case "hello":
        if (typeof data.session === "string" && data.session) att.session = data.session.slice(0, 128);
        (ws as any).serializeAttachment(att);
        this.broadcastRoster();
        break;
      case "published":
        att.track = typeof data.track === "string" ? data.track.slice(0, 128) : null;
        (ws as any).serializeAttachment(att);
        this.broadcastRoster();
        break;
      case "level": {
        const v = typeof data.v === "number" && isFinite(data.v) ? Math.max(0, Math.min(1, data.v)) : 0;
        // Exponential smoothing so a single spike doesn't flap the speaker set.
        att.level = att.level * 0.6 + v * 0.4;
        (ws as any).serializeAttachment(att);
        this.recomputeSpeakers();
        break;
      }
      case "roster":
        this.sendTo(ws, { t: "roster", roster: this.roster() });
        break;
      default:
        break;
    }
  }

  webSocketClose(ws: WebSocket, code: number): void {
    const att = this.att(ws);
    if (att) for (const w of this.state.getWebSockets()) {
      if (w !== ws) this.sendTo(w, { t: "left", uid: att.uid });
    }
    try { ws.close(code <= 1000 || code >= 3000 ? code : 1000); } catch { /* already closed */ }
    // Roster/speaker refresh for the remaining members.
    this.broadcastRoster(ws);
    this.recomputeSpeakers(ws);
  }

  webSocketError(ws: WebSocket): void {
    try { ws.close(1011); } catch { /* ignore */ }
  }

  // Zombie/idle/max-duration sweep. Hibernation-safe: scheduled via the DO alarm.
  async alarm(): Promise<void> {
    const now = Date.now();
    const all = this.state.getWebSockets();
    for (const ws of all) {
      const a = this.att(ws);
      if (!a) continue;
      if (now - a.ts > STALE_MS || now - a.born > MAX_ROOM_MS) {
        try { ws.close(1000, "evicted (idle/zombie)"); } catch { /* ignore */ }
      }
    }
    // Reschedule while anyone is still connected; otherwise let the room sleep.
    if (this.state.getWebSockets().length > 0) {
      try { await this.state.storage.setAlarm(now + SWEEP_MS); } catch { /* ignore */ }
    }
  }

  // ---- helpers ----------------------------------------------------------------

  private async ensureSweep(): Promise<void> {
    try {
      const existing = await this.state.storage.getAlarm();
      if (existing == null) await this.state.storage.setAlarm(Date.now() + SWEEP_MS);
    } catch { /* ignore */ }
  }

  private att(ws: WebSocket): Att | null {
    try { return (ws as any).deserializeAttachment() as Att; } catch { return null; }
  }

  private roster(): { uid: string; session: string; track: string | null }[] {
    const out: { uid: string; session: string; track: string | null }[] = [];
    for (const ws of this.state.getWebSockets()) {
      const a = this.att(ws);
      if (a) out.push({ uid: a.uid, session: a.session, track: a.track });
    }
    return out;
  }

  private broadcastRoster(exclude?: WebSocket): void {
    const msg = JSON.stringify({ t: "roster", roster: this.roster() });
    for (const ws of this.state.getWebSockets()) {
      if (ws === exclude) continue;
      try { ws.send(msg); } catch { /* gone */ }
    }
  }

  // Compute the top-N loudest and broadcast only when the set changes.
  private recomputeSpeakers(exclude?: WebSocket): void {
    const live: { uid: string; level: number }[] = [];
    for (const ws of this.state.getWebSockets()) {
      if (ws === exclude) continue;
      const a = this.att(ws);
      if (a && a.level >= SPEAKING_FLOOR) live.push({ uid: a.uid, level: a.level });
    }
    live.sort((x, y) => y.level - x.level);
    const next = live.slice(0, ACTIVE_SPEAKERS).map((s) => s.uid).sort();
    const changed = next.length !== this.speakers.length ||
      next.some((u, i) => u !== this.speakers[i]);
    if (!changed) return;
    this.speakers = next;
    const msg = JSON.stringify({ t: "speakers", uids: next });
    for (const ws of this.state.getWebSockets()) {
      if (ws === exclude) continue;
      try { ws.send(msg); } catch { /* gone */ }
    }
  }

  private sendTo(ws: WebSocket, obj: unknown): void {
    try { ws.send(JSON.stringify(obj)); } catch { /* gone */ }
  }
}
