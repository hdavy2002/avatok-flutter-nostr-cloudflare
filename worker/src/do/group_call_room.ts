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
//   POST /authority/ring_add       {uids[], gid?}                       → authority + {added, already, present, capped} | 404/409
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
//                  {t:"recording", on}                ([ADDCALL-4-SRV] I am/am not recording)
//   server→client: {t:"welcome", you, call_id, call_trace_id, generation, roster, recording}
//                  {t:"roster", roster:[{uid,session,audio_track,video_track,video_enabled,muted,recording}]}
//                  {t:"speakers", uids:[...]}
//                  {t:"recording", on, uids:[...], count} ([ADDCALL-4-SRV] room recording state)
//                  {t:"left", uid}
//                  {t:"full", reason}
import type { Env } from "../types";
import { verifyJoinTicket } from "../routes/groupcall";
import { contactFor } from "../lib/identity";
import { trackUserContact, trackException } from "../hooks";

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
// [GCALL-W1-SWEEP] Grace window for a call that has an authority but no socket
// yet. The sweep is now armed at /authority/start (not only on a successful WS
// upgrade), so a join whose WS never opens is reaped instead of wedging the
// room forever. Without this grace the alarm would end a HEALTHY call whose
// starter is still completing the upgrade on a slow network. Must exceed the
// 60 s ticket TTL so a legitimately-slow first joiner is never killed.
const STARTING_GRACE_MS = 90_000;
// Absolute backstop so a wedged room can't live forever.
const MAX_ROOM_MS = 18 * 3600 * 1000;
const TICKET_NONCE_PREFIX = "ticket_nonce:";
// [GRP-W3-EVICT] A uid removed from the group while a call is running is barred
// for this long. It only has to outlive an already-minted ticket (TTL 60 s):
// after that the Worker's own membership guard refuses to issue them a new one,
// so this window is the entire hole. Deliberately NOT implemented by bumping the
// call generation — that would invalidate every OTHER participant's attachment
// and force the whole room to reconnect to remove one person.
const EVICT_PREFIX = "evicted:";
const EVICT_BLOCK_MS = 120_000;

// [ADDCALL-3-SRV] Hard ceiling on the stored `ring_targets` list. Was an inline
// `.slice(0, 64)` in authorityStart and is now shared with /authority/ring_add,
// which APPENDS to the same list — a late invitee must be counted against the
// same bound, or a long-running call could grow the list without limit and
// eventually blow the storage value.
const RING_TARGETS_MAX = 64;

// [GCALL-W4-ATTCAP] Hibernation attachments are capped (~2 KB). `Att` carries two
// client-supplied track names plus two pull lists, so unbounded 128-char names
// could be used to overflow the attachment and make serializeAttachment throw
// INSIDE authorityPull — breaking the call for everyone, not just the sender.
// Track names are ours by construction (`audio-<sessionId>`), so a much tighter
// budget costs nothing and removes the overflow entirely.
const MAX_TRACK_NAME = 64;
// Wire-protocol version, echoed on `welcome`. There was no version field
// anywhere, and CfJoinResult defaults every missing key, so a future shape
// change would have degraded silently into the generic failure rather than
// saying "this build is too old".
const WIRE_VERSION = 1;

interface Att {
  uid: string;
  session: string;      // SFU sessionId, bound from the verified ticket
  generation: number;   // call generation this socket was admitted under
  audioTrack: string | null;
  videoTrack: string | null;
  videoEnabled: boolean;
  /// [GCALL-W4-MUTE] Server-known mute state. Mute used to be purely local: no
  /// frame, no roster field, so the mic-slash other people saw was derived from
  /// `audioTrack == null`, which is only ever true BEFORE the first publish.
  /// Everyone therefore appeared unmuted no matter what they did.
  muted: boolean;
  /// [ADDCALL-4-SRV] Server-known call-recording state for THIS socket.
  /// Spec: Specs/SPEC-ADD-TO-CALL-2026-08-06.md §7 — "the indicator must show on
  /// the conference screen for every participant whenever any participant is
  /// recording, which means the `callrec` state frame has to be relayed through
  /// GroupCallRoom rather than the 1:1 CallRoom relay."
  ///
  /// In a 1:1 the ToS clause plus an on-screen indicator means both parties are
  /// informed. In a 10-way call the clause is doing all the work for nine people
  /// unless this field exists and is fanned out.
  ///
  /// OPTIONAL on purpose: attachments written by a build that predates this field
  /// deserialize with it `undefined`, so every read is `=== true`.
  recording?: boolean;
  audioPulls: string[]; // remote trackNames this client currently pulls (audio)
  videoPulls: string[]; // remote trackNames this client currently pulls (video)
  level: number;        // smoothed 0..1
  ts: number;           // last activity
  born: number;
  hot?: number;
  cold?: number;
  speaking?: boolean;
}

interface RosterRow {
  uid: string;
  session: string;
  audio_track: string | null;
  video_track: string | null;
  video_enabled: boolean;
  muted: boolean;
  /** [ADDCALL-4-SRV] True when this participant has told the room it is recording. */
  recording: boolean;
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
        // [GCALL-W1-KIND] media_kind is exposed here so routes/groupcall.ts can
        // put it on /status: without it the in-thread banner cannot know whether
        // the live call is audio or video and hardcodes a video join, which the
        // publish path then rejects outright for an audio call.
        return json({
          live: count > 0, count, max: a?.max_participants ?? MAX_GROUP,
          call_id: a?.call_id ?? null, state: a?.state ?? "ended",
          media_kind: a?.media_kind ?? null,
        });
      }
      case "/authority/start": return this.authorityStart(req);
      case "/authority/join": return this.authorityJoin(req);
      case "/authority/ring_add": return this.authorityRingAdd(req);
      case "/authority/session_check": return this.authoritySessionCheck(req);
      case "/authority/pull": return this.authorityPull(req);
      case "/authority/pull_close": return this.authorityPullClose(req);
      case "/authority/evict": return this.authorityEvict(req);
      default: return json({ error: "not found" }, 404);
    }
  }

  private async authorityStart(req: Request): Promise<Response> {
    let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    const uid = String(b?.uid || "").slice(0, 128);
    if (!uid) return json({ error: "uid required" }, 400);
    const mediaKind: MediaKind = (["audio", "video", "audio_video"].includes(b?.media_kind) ? b.media_kind : "audio") as MediaKind;
    // [GCALL-W4-RING] Who to un-ring when this call ends. The DO is the only
    // component that knows the call is over (the last leave, the sweep, an
    // eviction), but it has no view of group membership — so the caller hands it
    // the roster to cancel against, once, at start.
    const ringTargets: string[] = Array.isArray(b?.ring_targets)
      ? b.ring_targets.map((u: unknown) => String(u).slice(0, 128)).filter(Boolean).slice(0, RING_TARGETS_MAX)
      : [];
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
      if (ringTargets.length) {
        // The DO is addressed by idFromName(groupId) and so cannot recover the
        // group id from its own identity — the caller supplies it, purely so the
        // cancel frame can tell the client WHICH group stopped ringing.
        try {
          await this.state.storage.put("ring_targets", ringTargets);
          await this.state.storage.put("ring_gid", String(b?.gid ?? "").slice(0, 128));
        } catch { /* best-effort */ }
      }
      // [GCALL-W1-SWEEP] Arm the sweep the moment the authority exists. Before
      // this, the alarm was only armed on a successful WS upgrade — so a join
      // that failed after /authority/start (the publish-before-WS ordering
      // defect, a permission denial, a dead network) left the authority stuck
      // in state:"starting" with no sockets and NO alarm, wedging the room and
      // freezing its media_kind forever. `alarm()` applies STARTING_GRACE_MS so
      // this never reaps a call that is merely still connecting.
      void this.ensureSweep();
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

  /**
   * [ADDCALL-3-SRV] Append late invitees to the ring-cancel list of a call that
   * is ALREADY RUNNING. Spec: Specs/SPEC-ADD-TO-CALL-2026-08-06.md §5.
   *
   * ── WHY THIS ENDPOINT HAS TO EXIST ──────────────────────────────────────────
   * `ring_targets` was written exactly ONCE, in `authorityStart`, because until
   * now the only ring was the broadcast at the start of the call. `cancelRing`
   * (below) reads that same key when the call ends and un-rings everyone on it.
   *
   * So a person rung LATER — by `POST /api/groupcall/:id/invite` — would not be
   * on the list, would never receive `group_call_ring_cancel`, and **their phone
   * would keep ringing after everyone else had hung up**, with an "answer" that
   * drops them into a call that no longer exists. That is the single worst
   * failure mode in this phase, and this endpoint is the whole fix: the invite
   * route appends here BEFORE it rings anybody, so the cancel can never be
   * missed even if the ring itself half-fails.
   *
   * Internal only — reached through `roomFetch` from routes/groupcall.ts, which
   * has already run `guard()` (flags + membership + caps). This object is never
   * addressable from the internet except via the ticket-authenticated WS upgrade,
   * so it follows the same idiom as its sibling `/authority/*` handlers and does
   * not re-authenticate.
   *
   * Idempotent: inviting the same person twice appends nothing the second time
   * (they come back under `already`), so the list cannot be corrupted or a cancel
   * frame duplicated by a client that retries.
   *
   * Also returns the live authority, so the caller rings with the EXISTING
   * call_id/generation instead of reading them in a separate round trip that
   * could race a call ending in between.
   */
  private async authorityRingAdd(req: Request): Promise<Response> {
    let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    const uids: string[] = Array.isArray(b?.uids)
      ? b.uids.map((u: unknown) => String(u ?? "").slice(0, 128)).filter(Boolean)
      : [];

    const a = await this.loadAuthority();
    if (!a || a.state === "ended") return json({ error: "no live call" }, 404);

    // Capacity is checked against the authoritative live-socket count, exactly
    // as authorityStart/authorityJoin do. Refuse the WHOLE invite rather than
    // ringing people into a room that will bounce them at the door.
    const count = this.liveCount();
    if (count >= a.max_participants) {
      return json({ error: `call is full (${a.max_participants})`, cap: a.max_participants, count }, 409);
    }

    let targets: string[] = [];
    try { targets = (await this.state.storage.get<string[]>("ring_targets")) ?? []; } catch { /* treat as empty */ }

    const known = new Set(targets);
    const added: string[] = [];
    const already: string[] = [];
    const present: string[] = [];
    const capped: string[] = [];
    for (const u of uids) {
      // Someone who is already IN the call is not ringing and must not be added:
      // `ring_targets` means "phones that are ringing for this call", and a
      // cancel frame to a live participant is noise at best.
      if (this.hasLiveUid(u)) { present.push(u); continue; }
      if (known.has(u)) { already.push(u); continue; }
      if (targets.length + added.length >= RING_TARGETS_MAX) { capped.push(u); continue; }
      known.add(u);
      added.push(u);
    }

    if (added.length) {
      try {
        await this.state.storage.put("ring_targets", [...targets, ...added]);
        // The DO is addressed by idFromName(groupId) and cannot recover the group
        // id from its own identity. authorityStart stores it only when it rang
        // somebody, so a call that started alone has none — fill it in here, and
        // never overwrite one that is already set.
        const gid = String(b?.gid ?? "").slice(0, 128);
        if (gid) {
          const cur = await this.state.storage.get<string>("ring_gid");
          if (!cur) await this.state.storage.put("ring_gid", gid);
        }
      } catch {
        // A failed persist means the cancel would not reach these people, which
        // is precisely the bug this endpoint exists to prevent — so fail the
        // invite rather than ring someone we can never un-ring.
        return json({ error: "could not record ring targets" }, 500);
      }
    }

    return json({
      ok: true,
      call_id: a.call_id, call_trace_id: a.call_trace_id, generation: a.generation,
      state: a.state, media_kind: a.media_kind, max_participants: a.max_participants,
      started_by: a.started_by, count,
      added, already, present, capped,
      ring_target_count: targets.length + added.length,
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

  /** [GRP-W3-EVICT] Remove a uid from the live call immediately.
   *
   *  Called by routes/messaging.ts when someone is removed from (or leaves) the
   *  group. Membership was purely a D1 concept: this DO never re-checked it, and
   *  SFU media flows peer→SFU→peer with no per-packet Worker check, so a removed
   *  member carried on sending and receiving audio/video for as long as they
   *  kept the socket open. Closing the socket stops their publish and their
   *  pulls; the bar below stops them walking straight back in with a ticket
   *  minted seconds before the removal. */
  private async authorityEvict(req: Request): Promise<Response> {
    let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    const uid = String(b?.uid || "").slice(0, 128);
    if (!uid) return json({ error: "uid required" }, 400);

    await this.state.storage.put(`${EVICT_PREFIX}${uid}`, Date.now() + EVICT_BLOCK_MS);

    const ws = this.findWsByUid(uid);
    if (!ws) return json({ ok: true, evicted: false });
    const gone = new Set<WebSocket>([ws]);
    try { ws.close(1008, "removed from group"); } catch { /* already gone */ }
    // A server-initiated close does NOT re-enter webSocketClose for hibernatable
    // WebSockets, so nothing would otherwise tell the survivors — same trap the
    // sweep had. Announce the departure explicitly.
    for (const other of this.state.getWebSockets()) {
      if (gone.has(other)) continue;
      this.sendTo(other, { t: "left", uid });
    }
    this.broadcastRoster(gone);
    // [ADDCALL-4-SRV] An evicted member's recording flag leaves with them.
    this.broadcastRecording(gone);
    this.recomputeSpeakers(gone);
    if (this.state.getWebSockets().filter((w) => !gone.has(w)).length === 0) {
      await this.endAuthority();
    }
    return json({ ok: true, evicted: true });
  }

  // ---- WebSocket upgrade (ticket-authenticated) ---------------------------------

  private async handleWsUpgrade(url: URL, req: Request): Promise<Response> {
    const ticketStr = url.searchParams.get("ticket") || "";
    const ticket = await verifyJoinTicket(this.env, ticketStr);
    if (!ticket) return new Response("invalid or expired ticket", { status: 401 });

    // A signed ticket is a one-time capability, not a bearer token: a replay
    // within its 60-second window must not be able to displace the legitimate
    // participant. The REPLAY CHECK happens here (cheap, before any work), but
    // the nonce is only CONSUMED further down, immediately before the socket is
    // accepted — [GCALL-W1-NONCE]. Consuming it up here burned the ticket on
    // every rejectable outcome (stale generation, full room), so a user turned
    // away from a full call could not retry with the ticket they were just
    // issued: the retry died as "ticket already used" instead of "call is full".
    const nonceKey = `${TICKET_NONCE_PREFIX}${ticket.nonce}`;
    const nonceExp = await this.state.storage.get<number>(nonceKey);
    if (nonceExp != null && nonceExp >= Date.now()) {
      return new Response("ticket already used", { status: 401 });
    }

    // [GRP-W3-EVICT] A ticket minted moments before this user was removed from
    // the group is still cryptographically valid for its 60 s TTL. Refuse it.
    const evictedUntil = await this.state.storage.get<number>(`${EVICT_PREFIX}${ticket.uid}`);
    if (evictedUntil != null && evictedUntil >= Date.now()) {
      return new Response("no longer a member of this group", { status: 403 });
    }

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
    // [GCALL-W4-DUPE] The superseded socket is closed server-side, which (as
    // everywhere else in this DO) does NOT re-enter webSocketClose — so nothing
    // announced it, `liveCount` transiently double-counted the same person
    // against the cap, and `findWsByUid` could still hand back the DEAD socket,
    // making the new device's own session_check 409. Track it as excluded from
    // here on so every read below sees the room as it will actually be.
    const superseded = this.findWsByUid(ticket.uid);
    // [ADDCALL-4-SRV] Read the doomed attachment BEFORE closing it, so a recorder
    // who merely reconnects does not silently go dark for everyone else. The room
    // state is derived from live sockets, so without this carry-forward a network
    // blip on the recorder's phone would drop the indicator on the other nine
    // screens until their client happened to re-announce — the exact ambiguous
    // moment the "fail toward showing" rule is about. A terminal departure still
    // clears (webSocketClose / evict / sweep); only a same-uid takeover inherits.
    const supersededAtt = superseded ? this.att(superseded) : null;
    if (superseded) {
      try { superseded.close(1000, "superseded by reconnect"); } catch { /* ignore */ }
    }

    // [GCALL-W1-NONCE] Every rejectable check has now passed — this socket is
    // being accepted, so and only so is the one-time ticket spent.
    await this.state.storage.put(nonceKey, ticket.exp);

    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    this.state.acceptWebSocket(server, [ticket.uid]);
    const now = Date.now();
    const att: Att = {
      uid: ticket.uid, session: ticket.session_id, generation: ticket.generation,
      audioTrack: null, videoTrack: null, videoEnabled: false, muted: false,
      recording: supersededAtt?.recording === true,
      audioPulls: [], videoPulls: [], level: 0, ts: now, born: now,
    };
    (server as any).serializeAttachment(att);

    if (a.state === "starting") { a.state = "live"; await this.saveAuthority(a); }

    // [ADDCALL-4-SRV] Computed AFTER this socket's attachment is written, so a
    // reconnecting recorder's carried-forward state is already reflected.
    const recUids = this.recordingUids();

    this.sendTo(server, {
      t: "welcome", you: ticket.uid, call_id: a.call_id, call_trace_id: a.call_trace_id,
      generation: a.generation, v: WIRE_VERSION, media_kind: a.media_kind, roster: this.roster(),
      // [ADDCALL-4-SRV] A LATE JOINER IS EXACTLY THE PERSON LEAST LIKELY TO KNOW.
      // Someone dropped into a call that is already being recorded must learn it
      // immediately, not on the next change — the same failure the 1:1 `callrec`
      // frame had to fix with its re-announce-on-connect, and worse here because
      // in a group nobody has any reason to re-announce for the new arrival.
      // Carried on `welcome` AND repeated as a standalone frame below, so a
      // client that implements either one is informed.
      recording: { on: recUids.length > 0, uids: recUids, count: recUids.length },
    });
    if (recUids.length > 0) {
      this.sendTo(server, { t: "recording", on: true, uids: recUids, count: recUids.length });
      this.emitRecordingTelemetry(a, ticket.uid, true, [ticket.uid], "join", recUids);
    }
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
        // [ADDCALL-4-SRV] `hello` is the client saying "I am up" — the second
        // chance for a joiner to learn the room is being recorded, in case the
        // frames sent alongside `welcome` were dropped in the handshake window.
        this.sendRecordingTo(ws);
        break;
      // Publish/clear ONE track kind. uid is never taken from the message — it is
      // fixed to this socket's ticket-verified attachment. Camera-off is
      // {kind:"video", trackName:null, enabled:false}: it clears/disables ONLY
      // the video track, never touches audioTrack, and never creates a new
      // session (Phase 2 requirement).
      // [GCALL-W4-MUTE] Mute is now a call fact, not a private one. Without this
      // the only mute indicator other people had was `audioTrack == null`, which
      // is true only before the first publish — so a muted participant looked
      // live to everyone, and people talked over each other believing they were
      // being heard.
      case "mute": {
        att.muted = data.muted === true;
        (ws as any).serializeAttachment(att);
        this.broadcastRoster();
        break;
      }
      case "track": {
        const kind = data.kind === "video" ? "video" : "audio";
        const trackName = typeof data.trackName === "string" && data.trackName ? data.trackName.slice(0, MAX_TRACK_NAME) : null;
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
        att.audioTrack = typeof data.track === "string" ? data.track.slice(0, MAX_TRACK_NAME) : null;
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
      // [ADDCALL-4-SRV] Recording state, relayed through the room.
      // Spec §7: the conference indicator must light for EVERY participant
      // whenever ANY participant is recording. This is the transport for that —
      // deliberately the SAME socket that already carries roster/mute/speakers
      // rather than a second channel, and deliberately tiny (one boolean).
      //
      // FAIL TOWARD SHOWING THE INDICATOR. `on` is true unless the client says
      // an explicit falsey OFF, so a malformed or truncated frame lights the
      // indicator instead of hiding it. The asymmetry is the whole point: a
      // spurious indicator is a minor annoyance, a missing one is the consent
      // failure this feature exists to prevent. A client that has stopped
      // recording sends `on:false` and that is honoured exactly.
      //
      // uid is NEVER read from the message — it is fixed to this socket's
      // ticket-verified attachment, so nobody can flip someone else's flag
      // (in either direction; falsely clearing another person's indicator
      // would be the more dangerous of the two).
      case "recording": {
        const on = !(data.on === false || data.on === 0 || data.on === "false");
        const changed = (att.recording === true) !== on;
        att.recording = on;
        (ws as any).serializeAttachment(att);
        // Broadcast unconditionally, even when unchanged: a re-announce is a few
        // dozen bytes and is the cheap repair for anyone whose earlier frame was
        // lost. Change-detection is used only to keep telemetry from duplicating.
        this.broadcastRecording();
        this.broadcastRoster();
        if (changed) {
          void this.loadAuthority().then((a) => {
            if (a) this.emitRecordingTelemetry(a, att.uid, on, this.liveUids(), "toggle", this.recordingUids());
          }).catch(() => { /* best-effort */ });
        }
        break;
      }
      case "roster":
        this.sendTo(ws, { t: "roster", roster: this.roster() });
        // [ADDCALL-4-SRV] A client asking to resync its roster is a client that
        // thinks its view may be stale. Recording state is part of that view and
        // costs one small frame, so never make them ask twice for it.
        this.sendRecordingTo(ws);
        break;
      // [ADDCALL-4-SRV] Unknown frame types remain a silent no-op — an older
      // client that has never heard of `recording` is unaffected, and this
      // `default` must never start throwing.
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
    // [ADDCALL-4-SRV] A recorder who drops off must not leave a phantom
    // indicator lit forever. State is derived from live sockets, so excluding
    // this one from the recompute IS the clear.
    this.broadcastRecording(ws);
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
    const nonces = await this.state.storage.list<number>({ prefix: TICKET_NONCE_PREFIX });
    for (const [key, exp] of nonces) {
      if (exp < now) await this.state.storage.delete(key);
    }
    // Eviction bars are short-lived by design — expire them on the same sweep so
    // they cannot accumulate one key per removal for the DO's lifetime.
    const bars = await this.state.storage.list<number>({ prefix: EVICT_PREFIX });
    for (const [key, until] of bars) {
      if (until < now) await this.state.storage.delete(key);
    }
    // [GCALL-W1-SWEEP-BCAST] Evict, then TELL EVERYONE. A server-initiated
    // close does NOT re-enter webSocketClose for hibernatable WebSockets, so
    // the old code evicted silently: in a quiet call the survivors kept
    // rendering the ghost's frozen tile until some unrelated event happened to
    // trigger a roster broadcast. Collect the evicted sockets, exclude them
    // from the roster we compute, and push both {t:'left'} and a fresh roster.
    const all = this.state.getWebSockets();
    const evicted = new Set<WebSocket>();
    const evictedUids: string[] = [];
    for (const ws of all) {
      const a = this.att(ws);
      if (!a) continue;
      if (now - a.ts > STALE_MS || now - a.born > MAX_ROOM_MS) {
        evicted.add(ws);
        evictedUids.push(a.uid);
        try { ws.close(1000, "evicted (idle/zombie)"); } catch { /* ignore */ }
      }
    }
    if (evicted.size > 0) {
      for (const uid of evictedUids) {
        for (const ws of this.state.getWebSockets()) {
          if (evicted.has(ws)) continue;
          this.sendTo(ws, { t: "left", uid });
        }
      }
      this.broadcastRoster(evicted);
      // [ADDCALL-4-SRV] Same reason as webSocketClose: a swept zombie must not
      // leave the survivors staring at a "Recording" pill for a phone that is no
      // longer in the call.
      this.broadcastRecording(evicted);
      this.recomputeSpeakers(evicted);
    }

    const remaining = this.state.getWebSockets().filter((ws) => !evicted.has(ws)).length;
    if (remaining > 0) {
      try { await this.state.storage.setAlarm(now + SWEEP_MS); } catch { /* ignore */ }
      return;
    }
    // Zero sockets. A room in state:"starting" may simply have a joiner still
    // completing the WS handshake — ending it here would kill a healthy call
    // and turn that upgrade into a 409. Wait out STARTING_GRACE_MS instead, and
    // CRITICALLY re-arm the alarm ([GCALL-W1-SWEEP] R1): declining to end
    // without scheduling the next check would leave the room wedged again, just
    // politely, because the branch below is the only thing that re-arms.
    const auth = await this.loadAuthority();
    if (auth && auth.state === "starting" && now - auth.created_at <= STARTING_GRACE_MS) {
      try { await this.state.storage.setAlarm(auth.created_at + STARTING_GRACE_MS); } catch { /* ignore */ }
      return;
    }
    await this.endAuthority();
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
    // [GCALL-W4-RING] Stop every phone that is still ringing for this call. Without
    // this a call that ends before anyone answers leaves the rest of the group
    // ringing until their own timeout — and answering it would drop them into a
    // call that no longer exists.
    await this.cancelRing(a);
    // [GCALL-W1-NONCE] The call is over and its generation is spent, so every
    // ticket nonce recorded against it is dead weight. Dropping them here is
    // the only bounded point available: the sweep alarm stops re-arming once
    // the room empties, so expired nonces would otherwise accumulate one key
    // per join/reconnect attempt for the lifetime of the DO.
    try {
      const stale = await this.state.storage.list<number>({ prefix: TICKET_NONCE_PREFIX });
      for (const [key] of stale) await this.state.storage.delete(key);
    } catch { /* best-effort cleanup */ }
  }

  /** [GCALL-W4-RING] Fan a ring-cancel to everyone who was rung for this call.
   *  [ADDCALL-3-SRV] "Everyone" now includes people rung AFTER the call started,
   *  because /authority/ring_add appends them to this same `ring_targets` key. */
  private async cancelRing(a: Authority): Promise<void> {
    let targets: string[] = [];
    try { targets = (await this.state.storage.get<string[]>("ring_targets")) ?? []; } catch { /* none */ }
    if (!targets.length) return;
    let gid = "";
    try { gid = (await this.state.storage.get<string>("ring_gid")) ?? ""; } catch { /* unknown */ }
    try {
      await this.state.storage.delete("ring_targets");
      await this.state.storage.delete("ring_gid");
    } catch { /* best-effort */ }
    const body = JSON.stringify({
      type: "group_call_ring_cancel", call_id: a.call_id, gid, ts: Date.now(),
    });
    await Promise.all(targets.map(async (uid) => {
      try {
        await this.env.INBOX.get(this.env.INBOX.idFromName(uid)).fetch("https://inbox/event", {
          method: "POST", headers: { "content-type": "application/json" }, body,
        });
      } catch { /* one unreachable inbox must not block the others */ }
    }));
  }

  // ---- socket/roster helpers -----------------------------------------------------

  private att(ws: WebSocket): Att | null {
    try { return (ws as any).deserializeAttachment() as Att; } catch { return null; }
  }

  // [GCALL-W4-DUPE] Count PEOPLE, not sockets. During a reconnect flurry the same
  // uid can briefly hold two sockets (the superseded one is closed server-side,
  // which does not re-enter webSocketClose), and counting both let one person
  // consume two seats — pushing a full-ish room over the cap and rejecting a
  // legitimate joiner.
  private liveCount(exclude?: WebSocket): number {
    const uids = new Set<string>();
    let anon = 0;
    for (const ws of this.state.getWebSockets()) {
      if (ws === exclude) continue;
      const a = this.att(ws);
      if (a?.uid) uids.add(a.uid); else anon++;
    }
    return uids.size + anon;
  }

  private hasLiveUid(uid: string): boolean {
    return !!this.findWsByUid(uid);
  }

  // [GCALL-W4-DUPE] When a uid has more than one socket, always return the
  // NEWEST. The old code returned whichever came first out of getWebSockets(),
  // so a just-superseded socket could win and the new device's session_check
  // would 409 against an attachment that was already dead.
  private findWsByUid(uid: string): WebSocket | null {
    let best: WebSocket | null = null;
    let bestBorn = -1;
    for (const ws of this.state.getWebSockets()) {
      const a = this.att(ws);
      if (!a || a.uid !== uid) continue;
      const born = a.born ?? 0;
      if (born >= bestBorn) { bestBorn = born; best = ws; }
    }
    return best;
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

  /** True when `ws` is the excluded socket / one of the excluded sockets. */
  private isExcluded(ws: WebSocket, exclude?: WebSocket | Set<WebSocket>): boolean {
    if (!exclude) return false;
    return exclude instanceof Set ? exclude.has(ws) : ws === exclude;
  }

  // [GCALL-W1-SWEEP-BCAST] `exclude` now filters the roster CONTENT as well as
  // the send list. It previously only skipped the send, so the roster broadcast
  // that follows a departure still listed the departing member — and since the
  // client applies a roster by clear-and-rebuild, that frame re-added the very
  // participant the preceding {t:'left'} had just removed.
  private roster(exclude?: WebSocket | Set<WebSocket>): RosterRow[] {
    const out: RosterRow[] = [];
    const seen = new Set<string>();
    for (const ws of this.state.getWebSockets()) {
      if (this.isExcluded(ws, exclude)) continue;
      const a = this.att(ws);
      if (!a) continue;
      // [GCALL-W4-DUPE] One row per person: a reconnect flurry can leave the same
      // uid on two sockets for a beat, and a duplicated roster row renders as a
      // duplicate tile (and double-counts the participant total on screen).
      if (seen.has(a.uid)) continue;
      seen.add(a.uid);
      out.push({
        uid: a.uid, session: a.session, audio_track: a.audioTrack,
        video_track: a.videoTrack, video_enabled: a.videoEnabled, muted: a.muted === true,
        // [ADDCALL-4-SRV] Per-participant so the client can name the recorder
        // ("Ana is recording") rather than only saying "Recording". Deliberately
        // redundant with the {t:"recording"} frame: whichever of the two a client
        // happens to apply, it ends up showing the indicator.
        recording: a.recording === true,
      });
    }
    return out;
  }

  private broadcastRoster(exclude?: WebSocket | Set<WebSocket>): void {
    const msg = JSON.stringify({ t: "roster", roster: this.roster(exclude) });
    for (const ws of this.state.getWebSockets()) {
      if (this.isExcluded(ws, exclude)) continue;
      try { ws.send(msg); } catch { /* gone */ }
    }
  }

  // Compute the top-N debounced talkers and broadcast — COALESCED so a change that
  // reverts within SPEAKER_COALESCE_MS never hits the wire (prevents SDP
  // renegotiation thrash). Uses the hysteresis `speaking` flag, not the raw level.
  private recomputeSpeakers(exclude?: WebSocket | Set<WebSocket>): void {
    const live: { uid: string; level: number }[] = [];
    for (const ws of this.state.getWebSockets()) {
      if (this.isExcluded(ws, exclude)) continue;
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
      if (this.isExcluded(ws, exclude)) continue;
      try { ws.send(msg); } catch { /* gone */ }
    }
  }

  private sendTo(ws: WebSocket, obj: unknown): void {
    try { ws.send(JSON.stringify(obj)); } catch { /* gone */ }
  }

  // ---- [ADDCALL-4-SRV] recording relay -------------------------------------------
  // Spec: Specs/SPEC-ADD-TO-CALL-2026-08-06.md §7.
  //
  // The whole reason this lives in the DO rather than in the 1:1 CallRoom relay:
  // CallRoom forwards a frame to ONE peer (or broadcasts to the other seat of a
  // two-seat room). A conference has up to 25 sockets and the roster IS the set
  // of live sockets, so the fan-out has to be computed here, from the same source
  // of truth that already drives roster and active-speaker updates.

  /** Every uid currently telling the room it is recording. Derived from LIVE
   *  sockets only, which is what makes disconnect-clears-it free: a socket that
   *  is gone (closed, evicted, swept, superseded) simply is not counted. */
  private recordingUids(exclude?: WebSocket | Set<WebSocket>): string[] {
    const out = new Set<string>();
    for (const ws of this.state.getWebSockets()) {
      if (this.isExcluded(ws, exclude)) continue;
      const a = this.att(ws);
      if (a?.recording === true && a.uid) out.add(a.uid);
    }
    return [...out].sort();
  }

  /** All live uids — the participant list a multi-party telemetry event tags so
   *  ANY participant's email retrieves the interaction (CLAUDE.md telemetry rule). */
  private liveUids(exclude?: WebSocket | Set<WebSocket>): string[] {
    const out = new Set<string>();
    for (const ws of this.state.getWebSockets()) {
      if (this.isExcluded(ws, exclude)) continue;
      const a = this.att(ws);
      if (a?.uid) out.add(a.uid);
    }
    return [...out];
  }

  /** Push room recording state to one socket. */
  private sendRecordingTo(ws: WebSocket): void {
    const uids = this.recordingUids();
    this.sendTo(ws, { t: "recording", on: uids.length > 0, uids, count: uids.length });
  }

  /** Fan room recording state to everyone, following the broadcastRoster idiom
   *  (same `exclude` semantics: excluded sockets are left OUT of the computed
   *  state as well as the send list — the departure case). */
  private broadcastRecording(exclude?: WebSocket | Set<WebSocket>): void {
    const uids = this.recordingUids(exclude);
    const msg = JSON.stringify({ t: "recording", on: uids.length > 0, uids, count: uids.length });
    for (const ws of this.state.getWebSockets()) {
      if (this.isExcluded(ws, exclude)) continue;
      try { ws.send(msg); } catch { /* gone */ }
    }
  }

  /**
   * [ADDCALL-4-SRV] `callrec_peer_indicator` — the consent proof, group edition.
   *
   * The 1:1 version of this event (client-side, [CALLREC-TELEM-1]) pairs a
   * `dir:sent` on the recorder's timeline with a `dir:received` on the peer's, so
   * "the other person saw an indicator" is an observation rather than an
   * assumption. In a conference the server is the only component that knows the
   * full participant set, so it emits the RELAY half: one event per live
   * participant, each stamped with THAT participant's own email/phone, so any of
   * up to ten testers' emails retrieves the same moment. The client's own
   * `dir:received` remains the genuine proof of receipt — this does not replace
   * it and does not reuse its `dir` value.
   *
   * `dir` values used here:
   *   "sent"    — the recorder's own row (they are the one who toggled)
   *   "relayed" — a row for each other participant the frame was fanned out to
   *
   * Entirely best-effort and detached from the call path: a telemetry failure
   * must never affect whether the indicator is delivered. Failures are routed to
   * `trackException` rather than swallowed, per CLAUDE.md ("no silent catch").
   */
  private emitRecordingTelemetry(
    a: Authority,
    actorUid: string,
    on: boolean,
    recipients: string[],
    reason: "toggle" | "join",
    recordingUids: string[],
  ): void {
    const p = (async () => {
      // De-duplicate and bound: the cap is 25 sockets, but never let a malformed
      // roster turn one toggle into an unbounded PostHog fan-out.
      const targets = [...new Set([actorUid, ...recipients].filter(Boolean))].slice(0, MAX_CONF_PARTICIPANTS + 1);
      await Promise.all(targets.map(async (uid) => {
        const c = await contactFor(this.env, uid).catch(() => ({ email: null, phone: null }));
        await trackUserContact(this.env, uid, c.email, c.phone, "callrec_peer_indicator", "avatok", {
          surface: "conference",
          dir: uid === actorUid && reason === "toggle" ? "sent" : "relayed",
          reason,
          on,
          call_id: a.call_id,
          rec_id: `callrec:${a.call_id}`,
          generation: a.generation,
          media_kind: a.media_kind,
          // Who is recording, and everyone the state was fanned out to. Both are
          // uids (never emails) — the per-event email above is what makes a pull
          // by tester possible, and duplicating other people's emails into one
          // event would spread PII across timelines that should not carry it.
          recorder_uid: actorUid,
          recording_uids: recordingUids,
          recording_count: recordingUids.length,
          participants: targets,
          participant_count: targets.length,
        }, a.call_trace_id);
      }));
    })().catch((e) => {
      // A DO WebSocket handler has no ExecutionContext, so there is no
      // ctx.waitUntil to reach for; `state.waitUntil` is the DO equivalent and is
      // used below to keep this alive past the handler return.
      void trackException(this.env, e, {
        route: "do/group_call_room#recording", handled: true, uid: actorUid,
        extra: { call_id: a.call_id, reason },
      }).catch(() => { /* give up quietly */ });
    });
    // [ADDCALL-4-SRV] workerd drops unawaited telemetry when the surrounding
    // invocation returns — the trap recorded in Graphiti as
    // "avatok-worker-error-path-telemetry-dropped". `state.waitUntil` is the DO's
    // waitUntil; the `void p` fallback covers a runtime where it is absent.
    try { (this.state as unknown as { waitUntil?: (pr: Promise<unknown>) => void }).waitUntil?.(p); } catch { /* ignore */ }
    void p;
  }
}
