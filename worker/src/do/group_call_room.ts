// GroupCallRoom — the authenticated CF Realtime call authority + roster/
// active-speaker signalling for CF Realtime SFU group calls
// (Specs/CF-REALTIME-SFU-GROUP-AUDIO-BUILD.md,
//  Specs/CLOUDFLARE-ONLY-REALTIME-MEDIA-MIGRATION-PROPOSAL-2026-07-24.md Phase 1/2).
// One instance per group id. Unlike MeshRoom (which relays full WebRTC
// signalling for a P2P mesh), the SFU itself carries the media — this DO tracks
// the call authority (call_id/generation/state/media_kind), WHO is in the call,
// each member's SFU sessionId + published audio/video trackNames, per-client pull
// bookkeeping (bounded caps), and computes the ACTIVE-SPEAKER set so each client
// pulls only the few loudest talkers. The SFU session/track HTTP is proxied by
// routes/groupcall.ts (so the SFU app token never reaches the client).
//
// [CF-CALL-001] Authenticated authority + signed join tickets: the WS upgrade
// MUST present a short-lived CONF_TICKET_SECRET-signed ticket minted by
// routes/groupcall.ts's /join. The ticket is verified HERE, before the socket is
// accepted or any DO state is touched — the query-string `id`/`session` params
// are NEVER trusted directly (Non-negotiable migration rule #4). A ticket
// carrying a stale `call_id`/`generation` (i.e. from a call that has since
// ended) is rejected outright.
//
// HTTP authority surface (non-WS `fetch`, JSON in/out; called by groupcall.ts):
//   GET  /presence                 → {live, count, max, call_id, state}
//   POST /authority/start          {uid, media_kind, max_participants} → authority
//   POST /authority/join           {uid}                                → authority | 404/409
//   POST /authority/session_check  {uid, session_id}                    → {ok, generation, media_kind, call_id, max_participants} | 404/409
//   POST /authority/pull           {uid, session_id, remote_uid, kind, track_name, max_video?}
//   POST /authority/pull_close     {uid, session_id, kind, track_name}
//
// WS protocol (JSON), query string carries ONLY `ticket` (everything else is
// derived server-side from the verified ticket):
//   client→server: {t:"hello"}                       (sent once after connect)
//                  {t:"track", kind, trackName, enabled} (publish/clear a track;
//                                                          camera-off = kind:"video", trackName:null, enabled:false)
//                  {t:"level", v}                     (0..1 mic level, ~4×/sec)
//                  {t:"roster"}                       (request a fresh roster)
//   server→client: {t:"welcome", you, call_id, call_trace_id, generation, roster}
//                  {t:"roster", roster:[{uid,session,audio_track,video_track,video_enabled}]}
//                  {t:"speakers", uids:[...]}
//                  {t:"left", uid}
//                  {t:"full", reason}
import type { Env } from "../types";
import { verifyJoinTicket } from "../routes/groupcall";

export type MediaKind = "audio" | "video" | "audio_video";
export type CallState = "starting" | "live" | "ending" | "ended";

export interface Authority {
  call_id: string;
  call_trace_id: string;
  provider: "cloudflare_realtime";
  media_kind: MediaKind;
  started_by: string;
  generation: number;
  state: CallState;
  created_at: number;
  ended_at: number | null;
  max_participants: number;
}

// Legacy audio-only absolute backstop (groupAudioSfuEnabled path, unchanged).
const MAX_GROUP = 32;
// Phase 1/2 authenticated A/V cap — parity with the LiveKit conference cap
// (Specs …RULEBOOK.md, conference.ts MAX_PARTICIPANTS). Never raised past this.
const MAX_CONF_PARTICIPANTS = 25;
// Bounded per-client pull caps (Phase 2 "never pull every 25 video tracks at
// full quality on a mobile device"). Audio mirrors the existing active-speaker
// fan-out size; video defaults low and is hard-capped server-side regardless of
// what a client requests.
const MAX_AUDIO_PULLS = 6;
const DEFAULT_MAX_VIDEO_PULLS = 9;
const HARD_MAX_VIDEO_PULLS = 12;

// How many of the loudest talkers each client pulls via active-speaker fan-out.
const ACTIVE_SPEAKERS = 6;
// A member counts as "speaking" above this smoothed level (0..1).
const SPEAKING_FLOOR = 0.04;
// P3-A hysteresis: enter the active set after N consecutive reports above the
// floor, leave only after M below it — stops rapid swap of the lower slots.
const SPEAKER_ENTER_HITS = 2;
const SPEAKER_LEAVE_MISSES = 4;
// P3-A: coalesce active-speaker set changes in this window before broadcasting a
// new {t:'speakers'} frame, so level flapping can't thrash SDP renegotiation.
const SPEAKER_COALESCE_MS = 1500;
// Zombie sweep: evict a socket with no level/heartbeat for this long.
const STALE_MS = 45_000;
const SWEEP_MS = 15_000;
// Absolute backstop so a wedged room can't live forever.
const MAX_ROOM_MS = 18 * 3600 * 1000;

interface Att {
  uid: string;
  session: string;      // SFU sessionId, bound from the verified ticket
  generation: number;   // call generation this socket was admitted under
  audioTrack: string | null;
  videoTrack: string | null;
  videoEnabled: boolean;
  audioPulls: string[]; // remote trackNames this client currently pulls (audio)
  videoPulls: string[]; // remote trackNames this client currently pulls (video)
  level: number;        // smoothed 0..1
  ts: number;           // last activity
  born: number;
  hot?: number;
  cold?: number;
  speaking?: boolean;
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

export class GroupCallRoom {
  private state: DurableObjectState;
  private env: Env;
  private speakers: string[] = [];
  private pendingSince = 0;
  private lastSpeakerBroadcastAt = 0;
  private authorityCache: Authority | null | undefined; // undefined = not yet loaded

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.headers.get("Upgrade") !== "websocket") return this.handleHttp(url, req);
    return this.handleWsUpgrade(url, req);
  }

  // ---- HTTP authority surface --------------------------------------------------

  private async handleHttp(url: URL, req: Request): Promise<Response> {
    switch (url.pathname) {
      case "/presence": {
        const count = this.liveCount();
        const a = await this.loadAuthority();
        return json({ live: count > 0, count, max: a?.max_participants ?? MAX_GROUP, call_id: a?.call_id ?? null, state: a?.state ?? "ended" });
      }
      case "/authority/start": return this.authorityStart(req);
      case "/authority/join": return this.authorityJoin(req);
      case "/authority/session_check": return this.authoritySessionCheck(req);
      case "/authority/pull": return this.authorityPull(req);
      case "/authority/pull_close": return this.authorityPullClose(req);
      default: return json({ error: "not found" }, 404);
    }
  }

  private async authorityStart(req: Request): Promise<Response> {
    let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    const uid = String(b?.uid || "").slice(0, 128);
    if (!uid) return json({ error: "uid required" }, 400);
    const mediaKind: MediaKind = (["audio", "video", "audio_video"].includes(b?.media_kind) ? b.media_kind : "audio") as MediaKind;
    const requestedCap = Number(b?.max_participants) || MAX_CONF_PARTICIPANTS;
    const maxParticipants = Math.max(2, Math.min(requestedCap, MAX_CONF_PARTICIPANTS));

    let a = await this.loadAuthority();
    if (!a || a.state === "ended") {
      const now = Date.now();
      a = {
        call_id: crypto.randomUUID(),
        call_trace_id: crypto.randomUUID(),
        provider: "cloudflare_realtime",
        media_kind: mediaKind,
        started_by: uid,
        generation: (a?.generation ?? 0) + 1,
        state: "starting",
        created_at: now,
        ended_at: null,
        max_participants: maxParticipants,
      };
      await this.saveAuthority(a);
    } else if (this.liveCount() >= a.max_participants) {
      return json({ error: `call is full (${a.max_participants})`, cap: a.max_participants }, 409);
    }
    return json({
      call_id: a.call_id, call_trace_id: a.call_trace_id, generation: a.generation,
      state: a.state, media_kind: a.media_kind, max_participants: a.max_participants, started_by: a.started_by,
    });
  }

  private async authorityJoin(req: Request): Promise<Response> {
    let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    const uid = String(b?.uid || "").slice(0, 128);
    if (!uid) return json({ error: "uid required" }, 400);
    const a = await this.loadAuthority();
    if (!a || a.state === "ended") return json({ error: "no live call" }, 404);
    if (this.liveCount() >= a.max_participants && !this.hasLiveUid(uid)) {
      return json({ error: `call is full (${a.max_participants})`, cap: a.max_participants }, 409);
    }
    return json({
      call_id: a.call_id, call_trace_id: a.call_trace_id, generation: a.generation,
      state: a.state, media_kind: a.media_kind, max_participants: a.max_participants, started_by: a.started_by,
    });
  }

  private async authoritySessionCheck(req: Request): Promise<Response> {
    let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    const uid = String(b?.uid || "").slice(0, 128);
    const sessionId = String(b?.session_id || "").slice(0, 128);
    if (!uid || !sessionId) return json({ error: "uid + session_id required" }, 400);
    const a = await this.loadAuthority();
    if (!a || a.state === "ended") return json({ error: "no live call" }, 404);
    const att = this.findAtt(uid, sessionId);
    if (!att) return json({ error: "not connected" }, 409);
    if (att.generation !== a.generation) return json({ error: "stale generation" }, 409);
    return json({ ok: true, generation: a.generation, media_kind: a.media_kind, call_id: a.call_id, max_participants: a.max_participants });
  }

  private async authorityPull(req: Request): Promise<Response> {
    let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    const uid = String(b?.uid || "").slice(0, 128);
    const sessionId = String(b?.session_id || "").slice(0, 128);
    const remoteUid = String(b?.remote_uid || "").slice(0, 128);
    const kind = b?.kind === "video" ? "video" : "audio";
    const trackName = String(b?.track_name || "").slice(0, 128);
    if (!uid || !sessionId || !remoteUid || !trackName) return json({ error: "uid + session_id + remote_uid + track_name required" }, 400);

    const a = await this.loadAuthority();
    if (!a || a.state === "ended") return json({ error: "no live call" }, 404);
    const self = this.findAtt(uid, sessionId);
    if (!self) return json({ error: "not connected" }, 409);
    if (self.generation !== a.generation) return json({ error: "stale generation" }, 409);
    if (kind === "video" && a.media_kind === "audio") return json({ error: "video not enabled for this call" }, 400);

    const remoteWs = this.findWsByUid(remoteUid);
    const remote = remoteWs ? this.att(remoteWs) : null;
    if (!remote) return json({ error: "publisher not connected" }, 404);
    const publisherTrack = kind === "video" ? remote.videoTrack : remote.audioTrack;
    if (!publisherTrack || publisherTrack !== trackName) return json({ error: "publisher is not publishing that track" }, 403);

    const list = kind === "video" ? self.videoPulls : self.audioPulls;
    if (list.includes(trackName)) return json({ ok: true, already: true }); // idempotent

    if (kind === "audio") {
      if (list.length >= MAX_AUDIO_PULLS) return json({ error: `audio pull cap reached (${MAX_AUDIO_PULLS})` }, 429);
      self.audioPulls.push(trackName);
    } else {
      const requestedCap = Number(b?.max_video) || DEFAULT_MAX_VIDEO_PULLS;
      const cap = Math.max(1, Math.min(requestedCap, HARD_MAX_VIDEO_PULLS));
      if (list.length >= cap) return json({ error: `video pull cap reached (${cap})` }, 429);
      self.videoPulls.push(trackName);
    }
    this.persistAtt(uid, sessionId, self);
    return json({ ok: true });
  }

  private async authorityPullClose(req: Request): Promise<Response> {
    let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    const uid = String(b?.uid || "").slice(0, 128);
    const sessionId = String(b?.session_id || "").slice(0, 128);
    const kind = b?.kind === "video" ? "video" : "audio";
    const trackName = String(b?.track_name || "").slice(0, 128);
    if (!uid || !sessionId || !trackName) return json({ ok: true }); // idempotent no-op on bad input
    const self = this.findAtt(uid, sessionId);
    if (!self) return json({ ok: true }); // idempotent: already gone
    const list = kind === "video" ? self.videoPulls : self.audioPulls;
    const i = list.indexOf(trackName);
    if (i >= 0) list.splice(i, 1);
    this.persistAtt(uid, sessionId, self);
    return json({ ok: true });
  }

  // ---- WebSocket upgrade (ticket-authenticated) ---------------------------------

  private async handleWsUpgrade(url: URL, req: Request): Promise<Response> {
    const ticketStr = url.searchParams.get("ticket") || "";
    const ticket = await verifyJoinTicket(this.env, ticketStr);
    if (!ticket) return new Response("invalid or expired ticket", { status: 401 });

    const a = await this.loadAuthority();
    if (!a || a.state === "ended") return new Response("call not active", { status: 409 });
    if (ticket.call_id !== a.call_id || ticket.generation !== a.generation) {
      return new Response("stale generation", { status: 409 });
    }

    const cap = Math.min(a.max_participants, MAX_GROUP);
    if (this.liveCount() >= cap && !this.hasLiveUid(ticket.uid)) {
      const reject = new WebSocketPair();
      reject[1].accept();
      try {
        reject[1].send(JSON.stringify({ t: "full", reason: `call is full (${cap})` }));
        reject[1].close(1000, "room full");
      } catch { /* ignore */ }
      return new Response(null, { status: 101, webSocket: reject[0] });
    }

    // Duplicate uid+generation (reconnect flurry) → evict the stale socket so the
    // new (verified) one takes over; this is NOT a stale-generation ticket (those
    // are hard-rejected above), just the same user reconnecting.
    const existing = this.findWsByUid(ticket.uid);
    if (existing) { try { existing.close(1000, "superseded by reconnect"); } catch { /* ignore */ } }

    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    this.state.acceptWebSocket(server, [ticket.uid]);
    const now = Date.now();
    const att: Att = {
      uid: ticket.uid, session: ticket.session_id, generation: ticket.generation,
      audioTrack: null, videoTrack: null, videoEnabled: false,
      audioPulls: [], videoPulls: [], level: 0, ts: now, born: now,
    };
    (server as any).serializeAttachment(att);

    if (a.state === "starting") { a.state = "live"; await this.saveAuthority(a); }

    this.sendTo(server, {
      t: "welcome", you: ticket.uid, call_id: a.call_id, call_trace_id: a.call_trace_id,
      generation: a.generation, roster: this.roster(),
    });
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
        (ws as any).serializeAttachment(att);
        this.broadcastRoster();
        break;
      // Publish/clear ONE track kind. uid is never taken from the message — it is
      // fixed to this socket's ticket-verified attachment. Camera-off is
      // {kind:"video", trackName:null, enabled:false}: it clears/disables ONLY
      // the video track, never touches audioTrack, and never creates a new
      // session (Phase 2 requirement).
      case "track": {
        const kind = data.kind === "video" ? "video" : "audio";
        const trackName = typeof data.trackName === "string" && data.trackName ? data.trackName.slice(0, 128) : null;
        const enabled = data.enabled !== false;
        if (kind === "audio") {
          att.audioTrack = trackName;
        } else {
          att.videoTrack = enabled ? trackName : null;
          att.videoEnabled = enabled && !!trackName;
        }
        (ws as any).serializeAttachment(att);
        this.broadcastRoster();
        break;
      }
      // Legacy alias (pre-Phase-2 clients): audio-only publish.
      case "published":
        att.audioTrack = typeof data.track === "string" ? data.track.slice(0, 128) : null;
        (ws as any).serializeAttachment(att);
        this.broadcastRoster();
        break;
      case "level": {
        const v = typeof data.v === "number" && isFinite(data.v) ? Math.max(0, Math.min(1, data.v)) : 0;
        att.level = att.level * 0.6 + v * 0.4;
        if (att.level >= SPEAKING_FLOOR) {
          att.hot = (att.hot ?? 0) + 1; att.cold = 0;
          if ((att.hot ?? 0) >= SPEAKER_ENTER_HITS) att.speaking = true;
        } else {
          att.cold = (att.cold ?? 0) + 1; att.hot = 0;
          if ((att.cold ?? 0) >= SPEAKER_LEAVE_MISSES) att.speaking = false;
        }
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
    this.broadcastRoster(ws);
    this.recomputeSpeakers(ws);
    // Last participant leaving ends the call — a fresh /authority/start mints a
    // brand-new call_id + bumped generation next time (Phase 1 identity rule).
    if (this.liveCount(ws) === 0) void this.endAuthority();
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
    if (this.state.getWebSockets().length > 0) {
      try { await this.state.storage.setAlarm(now + SWEEP_MS); } catch { /* ignore */ }
    } else {
      void this.endAuthority();
    }
  }

  private async ensureSweep(): Promise<void> {
    try {
      const existing = await this.state.storage.getAlarm();
      if (existing == null) await this.state.storage.setAlarm(Date.now() + SWEEP_MS);
    } catch { /* ignore */ }
  }

  // ---- authority storage helpers -------------------------------------------------

  private async loadAuthority(): Promise<Authority | null> {
    if (this.authorityCache !== undefined) return this.authorityCache;
    const a = (await this.state.storage.get<Authority>("authority")) ?? null;
    this.authorityCache = a;
    return a;
  }

  private async saveAuthority(a: Authority): Promise<void> {
    this.authorityCache = a;
    await this.state.storage.put("authority", a);
  }

  private async endAuthority(): Promise<void> {
    const a = await this.loadAuthority();
    if (!a || a.state === "ended") return;
    a.state = "ended";
    a.ended_at = Date.now();
    await this.saveAuthority(a);
  }

  // ---- socket/roster helpers -----------------------------------------------------

  private att(ws: WebSocket): Att | null {
    try { return (ws as any).deserializeAttachment() as Att; } catch { return null; }
  }

  private liveCount(exclude?: WebSocket): number {
    let n = 0;
    for (const ws of this.state.getWebSockets()) { if (ws !== exclude) n++; }
    return n;
  }

  private hasLiveUid(uid: string): boolean {
    return !!this.findWsByUid(uid);
  }

  private findWsByUid(uid: string): WebSocket | null {
    for (const ws of this.state.getWebSockets()) {
      const a = this.att(ws);
      if (a && a.uid === uid) return ws;
    }
    return null;
  }

  private findAtt(uid: string, sessionId: string): Att | null {
    const ws = this.findWsByUid(uid);
    if (!ws) return null;
    const a = this.att(ws);
    return a && a.session === sessionId ? a : null;
  }

  private persistAtt(uid: string, sessionId: string, att: Att): void {
    const ws = this.findWsByUid(uid);
    if (ws && this.att(ws)?.session === sessionId) (ws as any).serializeAttachment(att);
  }

  private roster(): { uid: string; session: string; audio_track: string | null; video_track: string | null; video_enabled: boolean }[] {
    const out: { uid: string; session: string; audio_track: string | null; video_track: string | null; video_enabled: boolean }[] = [];
    for (const ws of this.state.getWebSockets()) {
      const a = this.att(ws);
      if (a) out.push({ uid: a.uid, session: a.session, audio_track: a.audioTrack, video_track: a.videoTrack, video_enabled: a.videoEnabled });
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

  // Compute the top-N debounced talkers and broadcast — COALESCED so a change that
  // reverts within SPEAKER_COALESCE_MS never hits the wire (prevents SDP
  // renegotiation thrash). Uses the hysteresis `speaking` flag, not the raw level.
  private recomputeSpeakers(exclude?: WebSocket): void {
    const live: { uid: string; level: number }[] = [];
    for (const ws of this.state.getWebSockets()) {
      if (ws === exclude) continue;
      const a = this.att(ws);
      if (a && a.speaking && a.level >= SPEAKING_FLOOR) live.push({ uid: a.uid, level: a.level });
    }
    live.sort((x, y) => y.level - x.level);
    const next = live.slice(0, ACTIVE_SPEAKERS).map((s) => s.uid).sort();
    const changed = next.length !== this.speakers.length ||
      next.some((u, i) => u !== this.speakers[i]);
    const now = Date.now();
    if (!changed) { this.pendingSince = 0; return; }
    if (this.pendingSince === 0) this.pendingSince = now;
    if (now - this.pendingSince < SPEAKER_COALESCE_MS) return;
    const churnMs = this.lastSpeakerBroadcastAt > 0 ? now - this.lastSpeakerBroadcastAt : 0;
    this.pendingSince = 0;
    this.lastSpeakerBroadcastAt = now;
    this.speakers = next;
    const msg = JSON.stringify({ t: "speakers", uids: next, size: next.length, churn_ms: churnMs });
    for (const ws of this.state.getWebSockets()) {
      if (ws === exclude) continue;
      try { ws.send(msg); } catch { /* gone */ }
    }
  }

  private sendTo(ws: WebSocket, obj: unknown): void {
    try { ws.send(JSON.stringify(obj)); } catch { /* gone */ }
  }
}
