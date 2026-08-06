// ConferenceRoomDO — the MIGRATION COORDINATOR for an ad-hoc 1:1 → SFU
// promotion. Spec: Specs/SPEC-ADD-TO-CALL-2026-08-06.md §3 (DO ownership) and
// §4 (the migration).
//
// ============================================================================
// THE TWO-DO BOUNDARY — settled by [ADDCALL-2-SRV], do not blur it
// ============================================================================
// `GroupCallRoom` (do/group_call_room.ts) OWNS MEDIA AND IS AUTHORITATIVE.
// It holds the SFU authority record, mints and validates join tickets, keeps
// the roster (which IS the set of open hibernating sockets), fans out active
// speaker, evicts, and enforces admission. Every question of the form "may
// this person have audio?" is answered THERE and only there.
//
// `ConferenceRoomDO` (this file) is a coordination record. It exists for ONE
// reason: EITHER party may press Add to call (spec §decision summary), so two
// devices can start an escalation of the same 1:1 at the same instant.
// `reserveMigration`'s single-flight is the lock that picks a winner, and it
// cannot be enforced client-side. THIS OBJECT NEVER GATES A JOIN.
//
// ── ADDRESSING (spec §3.1) ──────────────────────────────────────────────────
//   ConferenceRoomDO  = idFromName(<the 1:1 call_id being escalated>)
//   GroupCallRoom     = idFromName(<the ad-hoc conversation id / groupId>)
// Keying this object by the 1:1 call_id is what makes the single-flight work:
// both devices in the same 1:1 necessarily resolve to the SAME instance, even
// though each may have minted a DIFFERENT ad-hoc room. Key it by groupId
// instead and the two racing escalations land in two different DOs, both
// "win", and the call splits in half. See routes/conference_room.ts.
//
// ── CAPS (spec §3.2, §8) ────────────────────────────────────────────────────
// MAX_PARTICIPANTS below is a sanity backstop on THIS record, never an
// admission decision. The product cap of 10 is enforced at the invite surface
// (routes/adhoc_room.ts MAX_ADHOC_MEMBERS); the media cap is GroupCallRoom's.
//
// ── GENERATIONS (spec §3.3) ─────────────────────────────────────────────────
// `record.generation` here and GroupCallRoom's authority generation are
// INDEPENDENT counters over different lifecycles, and nothing maps between
// them. NEVER use this object's generation to mint or validate a GroupCallRoom
// join ticket, and never compare the two. If you are here to "helpfully" wire
// them together: don't — a ticket minted from the wrong counter is either
// permanently invalid (nobody can join) or permanently valid (anybody can).
import type { Env } from "../types";
import { refundUnused, conferenceBillingId } from "../lib/call_billing";

export type MigrationState = "idle" | "preparing" | "committed" | "aborted";
export type RoomState = "starting" | "live" | "ending" | "ended";
export type ConferenceMediaKind = "audio" | "video" | "audio_video";

interface Participant {
  uid: string;
  sessionId: string;
  joinedAt: number;
  tenureSince: number;
  provisional: boolean;
  present: boolean;
  capabilities: string[];
}

interface BillingSegment {
  id: string;
  sponsorUid: string;
  startsAt: number;
  endsAt: number | null;
  tariffPerMinute: number;
  reservedMinutes: number;
  settledMinutes: number;
  status: "reserved" | "active" | "closed" | "exhausted";
}

interface RoomRecord {
  callId: string;
  groupId: string;
  mediaKind: ConferenceMediaKind;
  state: RoomState;
  generation: number;
  startedBy: string;
  hostUid: string | null;
  sponsorUid: string | null;
  sponsorGraceUntil: number | null;
  migration: {
    state: MigrationState;
    id: string | null;
    targetConferenceId: string | null;
    reservedBy: string | null;
    reservedAt: number | null;
    committedAt: number | null;
    /** [ADDCALL-2-SRV] Wall clock at which the escalating client reported the
     *  1:1 leg torn down (spec §4.1 step 8). Set by /migration/release, which
     *  is the ONLY moment the escalation is actually finished. Persisting it
     *  separately from `committedAt` is what lets us tell "committed but the
     *  P2P leg is still up" (both audio paths live, the risky window) from
     *  "done". Never cleared by an abort of a LATER migration. */
    p2pReleasedAt: number | null;
    /** [ADDCALL-2-SRV] Why the last migration ended in `aborted`. Purely
     *  diagnostic — nothing branches on it. Kept because the first thing a
     *  user does after a failed escalation is press Add again, and this is the
     *  only record of what the previous attempt hit. */
    lastAbortReason: string | null;
  };
  participants: Participant[];
  billing: {
    tariffPerMinute: number | null;
    segments: BillingSegment[];
    enabled: boolean;
  };
  createdAt: number;
  endedAt: number | null;
}

/**
 * SANITY BACKSTOP ONLY — NOT AN ADMISSION DECISION (spec §3.2, §8).
 *
 * This counts `participants.filter(present)` on THIS coordination record.
 * `GroupCallRoom` counts live sockets against its own `a.max_participants` and
 * is the ONLY authority for whether someone gets media. The product cap of 10
 * is enforced once, at the invite surface (routes/adhoc_room.ts).
 *
 * It is set to the same 25 as the media layer deliberately, so this object can
 * never be the thing that rejects a participant `GroupCallRoom` would have
 * admitted (which would strand someone in a call they can hear but not join).
 * Membership in `conversation_members` is itself capped at 10 by
 * routes/adhoc_room.ts, so for add-to-call this limit is unreachable by design
 * — it exists to bound the array, not to enforce policy. Never lower it below
 * the media cap.
 */
const MAX_PARTICIPANTS = 25;
/** [ADDCALL-2-SRV] A `preparing` migration that nobody commits or aborts is a
 *  stuck single-flight lock — the user presses Add, nothing happens, and every
 *  retry 409s "escalation already in progress" until this fires. 10s is the
 *  make-before-break budget from spec §4; see `alarm()`. */
const MIGRATION_PREPARE_TIMEOUT_MS = 10_000;
const SPONSOR_GRACE_MS = 5 * 60 * 1000;
const CAPABILITIES = [
  "can_invite", "can_remove_participants", "can_end_for_all",
  "can_manage_recording", "can_view_billing", "can_accept_sponsorship",
] as const;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function bad(message: string, status = 400): Response { return json({ error: message }, status); }

/** A migration slot with no escalation in flight. */
function idleMigration(): RoomRecord["migration"] {
  return {
    state: "idle", id: null, targetConferenceId: null, reservedBy: null,
    reservedAt: null, committedAt: null, p2pReleasedAt: null, lastAbortReason: null,
  };
}

export class ConferenceRoomDO {
  private state: DurableObjectState;
  private env: Env;
  private record: RoomRecord | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const body = req.method === "GET" ? {} : await req.json().catch(() => ({}));
    switch (url.pathname) {
      case "/state": return json(await this.load());
      case "/start": return this.start(body);
      case "/participant/reserve": return this.reserveParticipant(body);
      case "/participant/join": return this.joinParticipant(body);
      case "/participant/leave": return this.leaveParticipant(body);
      case "/migration/reserve": return this.reserveMigration(body);
      case "/migration/prepare": return this.prepareMigration(body);
      case "/migration/commit": return this.commitMigration(body);
      case "/migration/abort": return this.abortMigration(body);
      case "/migration/release": return this.releaseP2p(body);
      case "/billing/start": return this.startBilling(body);
      case "/billing/sponsor/accept": return this.acceptSponsorship(body);
      case "/billing/tick": return this.billingTick(body);
      case "/host/transfer": return this.transferHost(body);
      case "/end": return this.end(body);
      default: return bad("not found", 404);
    }
  }

  async alarm(): Promise<void> {
    const r = await this.load();
    if (r.state === "ended") return;
    const now = Date.now();
    let changed = false;
    // [ADDCALL-2-SRV] ROLLBACK MUST BE REAL (spec §4.4). A client that dies
    // between reserve and commit leaves the single-flight lock held; without
    // this the feature looks PERMANENTLY broken to that user, because every
    // subsequent Add returns 409 "escalation already in progress" forever.
    //
    // `committedAt` and `p2pReleasedAt` are deliberately PRESERVED across the
    // abort: they are evidence that an EARLIER migration on this call already
    // succeeded, and `joinParticipant` reads that evidence. Wiping them (as the
    // original code did) meant one failed second escalation attempt locked out
    // every late joiner of the conference that was already running.
    if (r.migration.state === "preparing" && r.migration.reservedAt != null && now - r.migration.reservedAt > MIGRATION_PREPARE_TIMEOUT_MS) {
      r.migration = {
        ...r.migration,
        state: "aborted", id: null, targetConferenceId: null, reservedBy: null, reservedAt: null,
        lastAbortReason: "prepare_timeout",
      };
      changed = true;
    }
    if (r.sponsorGraceUntil != null && now >= r.sponsorGraceUntil && r.sponsorUid != null) {
      const active = r.billing.segments.find((s) => s.status === "active");
      if (!active || active.settledMinutes >= active.reservedMinutes) {
        r.state = "ended";
        r.endedAt = now;
        for (const participant of r.participants) participant.present = false;
        changed = true;
      }
    }
    if (changed) {
      await this.save(r);
      if (r.state === "ending" || r.state === "ended") await this.refundSponsor(r);
    }
  }

  private async load(): Promise<RoomRecord> {
    if (this.record) return this.record;
    this.record = await this.state.storage.get<RoomRecord>("room") ?? {
      callId: "", groupId: "", mediaKind: "audio", state: "ended", generation: 0, startedBy: "", hostUid: null, sponsorUid: null,
      sponsorGraceUntil: null, migration: idleMigration(),
      participants: [], billing: { tariffPerMinute: null, segments: [], enabled: false }, createdAt: 0, endedAt: null,
    };
    // [ADDCALL-2-SRV] Records written before p2pReleasedAt/lastAbortReason
    // existed deserialize with those fields `undefined`. Normalise on read so
    // every downstream `!= null` check means what it says.
    if (this.record.migration.p2pReleasedAt === undefined) this.record.migration.p2pReleasedAt = null;
    if (this.record.migration.lastAbortReason === undefined) this.record.migration.lastAbortReason = null;
    return this.record;
  }

  private async save(r: RoomRecord): Promise<void> {
    this.record = r;
    await this.state.storage.put("room", r);
    if (r.state === "ended") return;
    // [ADDCALL-2-SRV] The old flat +15s meant the 10s prepare timeout actually
    // fired at 15s at best — and, because every save RESETS the alarm, a client
    // that kept poking the room could push the auto-abort out indefinitely.
    // While a migration is preparing, pin the alarm to the deadline itself.
    const now = Date.now();
    let at = now + 15_000;
    if (r.migration.state === "preparing" && r.migration.reservedAt != null) {
      at = Math.min(at, r.migration.reservedAt + MIGRATION_PREPARE_TIMEOUT_MS + 250);
    }
    await this.state.storage.setAlarm(Math.max(at, now + 250));
  }

  private member(r: RoomRecord, uid: string): Participant | null {
    return r.participants.find((p) => p.uid === uid && p.present) ?? null;
  }

  private requireMember(r: RoomRecord, uid: string): Response | null {
    return this.member(r, uid) ? null : bad("not a present participant", 403);
  }

  /**
   * A room participant is not proof of conversation membership. The room can
   * outlive a client reservation, and a caller who learns a room id must not
   * be able to consume a roster slot by posting an arbitrary uid.
   *
   * Admission therefore checks the authoritative membership table on every
   * reserve/join path. Fail closed if the membership lookup is unavailable.
   */
  private async isGroupMember(groupId: string, uid: string): Promise<boolean> {
    if (!groupId || !uid) return false;
    try {
      const row = await this.env.DB_META
        .prepare("SELECT 1 AS ok FROM conversation_members WHERE conv_id=?1 AND uid=?2 LIMIT 1")
        .bind(groupId, uid)
        .first<{ ok: number }>();
      return row?.ok === 1;
    } catch {
      return false;
    }
  }

  /**
   * `/start` — GAP #1 FROM SPEC §4.3, AND THE REASON THE MIGRATION STATE
   * MACHINE HAS NEVER BEEN REACHABLE.
   *
   * Every migration entry point runs `requireMember(r, uid)` against
   * `r.participants`, which is EMPTY on a room nobody has started — so the very
   * first `/migration/reserve` always answered 403 "not a present participant".
   * `/start` is what seeds that array, and no client has ever called it.
   *
   * [ADDCALL-2-SRV] It is now IDEMPOTENT AND ADDITIVE, which it had to become
   * before it could safely be called at all. The original body re-initialised
   * the whole record whenever `state` was `starting`, and `starting` is exactly
   * the state a freshly-started room sits in. Since EITHER party may press Add
   * (spec §decision summary), the realistic sequence was:
   *
   *    A /start  -> record{ participants:[A], generation:1, state:starting }
   *    B /start  -> record{ participants:[B], generation:2, ... }   <-- A GONE
   *
   * A's in-flight migration id, reservation and epoch all vanish, A's next call
   * 403s, and the single-flight lock this object exists to provide has silently
   * done the opposite of its job. Worse, `prepareMigration` compares
   * `call_epoch` against `generation`, so B's start would also invalidate A's
   * epoch — the failure surfaces as "stale call epoch" three steps downstream
   * from the actual cause.
   *
   * Now: the first caller creates the room; every later caller is ADDED to it
   * and gets the existing record back, generation untouched. That makes the
   * race resolve where it is supposed to — at `reserveMigration`, where the
   * loser gets a clean 409 "escalation already in progress".
   *
   * `group_id` is still required and is still verified against
   * `conversation_members` by routes/conference_room.ts BEFORE we are reached;
   * `kind='call'` does not affect that lookup (neither this file's
   * `isGroupMember` nor the route's query filters on kind), so an ad-hoc room
   * satisfies it exactly like a real group.
   */
  private async start(b: any): Promise<Response> {
    const uid = String(b?.uid ?? "").trim();
    const groupId = String(b?.group_id ?? "").trim();
    if (!uid || !groupId) return bad("uid and group_id required");
    const r = await this.load();
    const now = Date.now();
    const mediaKind: ConferenceMediaKind = b?.media_kind === "audio_video" || b?.media_kind === "video" ? b.media_kind : "audio";

    // ── Already live (or starting): join the existing record, never replace it.
    if (r.state !== "ended" && r.groupId) {
      // A second escalation of the same 1:1 that minted its OWN ad-hoc room is
      // the losing side of the race. Tell it plainly which room won rather than
      // letting it proceed against a group the coordinator is not tracking —
      // otherwise the two halves of the call escalate into two rooms.
      if (groupId !== r.groupId) {
        return json({
          error: "escalation already in progress", code: "group_mismatch",
          group_id: r.groupId, call_id: r.callId, generation: r.generation,
        }, 409);
      }
      const existing = r.participants.find((p) => p.uid === uid);
      if (existing) {
        existing.present = true;
        existing.provisional = false;
        existing.sessionId = String(b?.session_id ?? existing.sessionId);
      } else {
        if (r.participants.filter((p) => p.present).length >= MAX_PARTICIPANTS) return bad("conference full", 409);
        r.participants.push({
          uid, sessionId: String(b?.session_id ?? crypto.randomUUID()), joinedAt: now, tenureSince: now,
          provisional: false, present: true,
          capabilities: uid === r.startedBy ? [...CAPABILITIES] : ["can_invite"],
        });
      }
      await this.save(r);
      return json(this.publicState(r));
    }

    const next: RoomRecord = {
      ...r, callId: crypto.randomUUID(), groupId, mediaKind, state: "starting", generation: r.generation + 1,
      startedBy: uid, hostUid: uid, sponsorUid: uid, sponsorGraceUntil: null,
      migration: idleMigration(),
      participants: [{ uid, sessionId: String(b?.session_id ?? crypto.randomUUID()), joinedAt: now, tenureSince: now, provisional: false, present: true, capabilities: [...CAPABILITIES] }],
      billing: { tariffPerMinute: null, segments: [], enabled: false }, createdAt: now, endedAt: null,
    };
    await this.save(next);
    return json(this.publicState(next));
  }

  private async reserveParticipant(b: any): Promise<Response> {
    const r = await this.load(); const uid = String(b?.uid ?? "");
    if (!uid) return bad("uid required");
    if (r.state === "ended") return bad("room ended", 409);
    if (!(await this.isGroupMember(r.groupId, uid))) return bad("not a group participant", 403);
    if (r.participants.filter((p) => p.present).length >= MAX_PARTICIPANTS && !this.member(r, uid)) return bad("conference full", 409);
    const existing = r.participants.find((p) => p.uid === uid);
    if (existing) { existing.present = true; existing.provisional = true; existing.sessionId = String(b?.session_id ?? existing.sessionId); await this.save(r); return json({ ok: true, provisional: true, call_id: r.callId }); }
    const now = Date.now();
    r.participants.push({ uid, sessionId: String(b?.session_id ?? crypto.randomUUID()), joinedAt: now, tenureSince: now, provisional: true, present: true, capabilities: uid === r.startedBy ? [...CAPABILITIES] : ["can_invite"] });
    if (r.state === "starting") r.state = "live";
    await this.save(r);
    return json({ ok: true, provisional: true, call_id: r.callId, generation: r.generation });
  }

  /**
   * A COORDINATION ASSERTION, NOT A SECURITY BOUNDARY (spec §3).
   *
   * Media admission is `GroupCallRoom`'s job, via the join ticket it mints
   * itself. A 409 from here does not and must not stop anyone getting audio —
   * it only says "the coordination record does not yet believe this call has
   * been promoted". If you are tempted to lean on this as an access check,
   * re-read the two-DO boundary at the top of this file: doing so would put
   * admission in an object that has no view of the sockets.
   *
   * [ADDCALL-2-SRV] The gate now reads `committedAt != null` rather than
   * `state === "committed"`. Those differ in exactly the case that matters: a
   * conference that escalated successfully, and on which someone later starts
   * (and fails) a SECOND escalation. `migration.state` is then "aborted" while
   * the conference is very much live, and the strict check would have refused
   * every late joiner of a working call. `committedAt` is monotonic evidence
   * that this call was promoted at least once, and abort paths preserve it.
   */
  private async joinParticipant(b: any): Promise<Response> {
    const r = await this.load(); const uid = String(b?.uid ?? "");
    const denied = this.requireMember(r, uid); if (denied) return denied;
    if (!(await this.isGroupMember(r.groupId, uid))) return bad("not a group participant", 403);
    const p = this.member(r, uid)!;
    if (r.migration.committedAt == null) return bad("conference join requires committed migration", 409);
    p.provisional = false; p.sessionId = String(b?.session_id ?? p.sessionId);
    await this.save(r); return json({ ok: true, call_id: r.callId, generation: r.generation, capabilities: p.capabilities });
  }

  private async leaveParticipant(b: any): Promise<Response> {
    const r = await this.load(); const uid = String(b?.uid ?? "");
    const p = this.member(r, uid); if (!p) return json({ ok: true, already_left: true });
    p.present = false;
    if (uid === r.hostUid) r.hostUid = this.electHost(r);
    if (uid === r.sponsorUid) r.sponsorGraceUntil = Date.now() + SPONSOR_GRACE_MS;
    if (!r.participants.some((x) => x.present)) { r.state = "ended"; r.endedAt = Date.now(); }
    await this.save(r);
    if (r.state === "ended") await this.refundSponsor(r);
    return json({ ok: true, host_uid: r.hostUid, sponsor_grace_until: r.sponsorGraceUntil });
  }

  /**
   * THE SINGLE-FLIGHT LOCK — the whole reason this object is in the loop.
   *
   * [ADDCALL-2-SRV] Two changes, both about the SECOND attempt (spec §4.4):
   *
   * 1. A `preparing` state whose deadline has already passed is treated as
   *    expired HERE, not only in `alarm()`. The alarm is a backstop, not a
   *    guarantee — Durable Object alarms can be delayed, and a user whose first
   *    escalation failed presses Add again within a second or two. Without this
   *    lazy expiry the retry meets a 409 for a migration nobody is running,
   *    which reads to the user as "the feature is permanently broken".
   * 2. `committedAt` / `p2pReleasedAt` from a PREVIOUS successful migration are
   *    carried forward, so starting a new escalation never retracts the fact
   *    that this call is already a conference.
   */
  private async reserveMigration(b: any): Promise<Response> {
    const r = await this.load(); const uid = String(b?.uid ?? "");
    const denied = this.requireMember(r, uid); if (denied) return denied;
    const now = Date.now();
    if (r.migration.state === "preparing") {
      const expired = r.migration.reservedAt == null || now - r.migration.reservedAt > MIGRATION_PREPARE_TIMEOUT_MS;
      if (!expired) {
        return json({
          error: "escalation already in progress", code: "single_flight",
          reserved_by: r.migration.reservedBy,
          retry_after_ms: Math.max(0, (r.migration.reservedAt ?? now) + MIGRATION_PREPARE_TIMEOUT_MS - now),
        }, 409);
      }
      r.migration.lastAbortReason = "prepare_timeout_lazy";
    }
    const id = crypto.randomUUID();
    r.migration = {
      ...r.migration,
      state: "preparing", id,
      targetConferenceId: String(b?.conference_id ?? crypto.randomUUID()),
      reservedBy: uid, reservedAt: now,
    };
    await this.save(r);
    return json({
      ok: true, migration_id: id, conference_id: r.migration.targetConferenceId,
      group_id: r.groupId, call_id: r.callId, generation: r.generation,
      participants: this.presentUids(r),
    });
  }

  /**
   * `call_epoch` IS THIS OBJECT'S `generation`, NOT THE 1:1 CALL'S EPOCH.
   *
   * [ADDCALL-2-SRV] They are different counters over different lifecycles (see
   * the generations note at the top of this file), and passing the wrong one
   * fails the whole escalation with "stale call epoch" — a message that points
   * at the call, three steps away from the actual mistake. `/start` and
   * `/migration/reserve` both return `generation`; echo THAT value back here.
   * The 409 now carries the expected value so a client that got it wrong can
   * say so in its telemetry instead of retrying forever.
   */
  private async prepareMigration(b: any): Promise<Response> {
    const r = await this.load(); const uid = String(b?.uid ?? "");
    const denied = this.requireMember(r, uid); if (denied) return denied;
    if (r.migration.state !== "preparing" || r.migration.id !== b?.migration_id) return bad("migration is not active", 409);
    if (String(b?.call_epoch ?? r.generation) !== String(r.generation)) {
      return json({ error: "stale call epoch", code: "stale_epoch", expected_generation: r.generation }, 409);
    }
    return json({
      ok: true, migration_id: r.migration.id, conference_id: r.migration.targetConferenceId,
      group_id: r.groupId, generation: r.generation, provisional: true,
      participants: r.participants.filter((p) => p.present).map((p) => ({ uid: p.uid, session_id: p.sessionId })),
      participant_uids: this.presentUids(r),
    });
  }

  /**
   * The evidence gate. `sfu_ready` must be a literal `true`, and the client
   * only sends it once the conference connection is `connected` AND
   * `hasMediaEvidence` (spec §4.1 step 6). Committing is what authorises the
   * NEXT step — releasing the 1:1 leg — so a commit on unverified media is the
   * one failure that produces a call with no audio at all.
   */
  private async commitMigration(b: any): Promise<Response> {
    const r = await this.load(); const uid = String(b?.uid ?? "");
    const denied = this.requireMember(r, uid); if (denied) return denied;
    if (r.migration.state !== "preparing" || r.migration.id !== b?.migration_id) return bad("migration is not active", 409);
    if (b?.sfu_ready !== true) return bad("sfu readiness evidence required", 409);
    r.migration.state = "committed"; r.migration.committedAt = Date.now();
    // A commit belongs to a NEW escalation, so the previous escalation's P2P
    // release does not apply to it. Clear it; /migration/release re-stamps.
    r.migration.p2pReleasedAt = null;
    if (r.state === "starting") r.state = "live";
    await this.save(r);
    return json({
      ok: true, call_id: r.callId, group_id: r.groupId,
      conference_id: r.migration.targetConferenceId, generation: r.generation,
      participants: this.presentUids(r),
    });
  }

  /**
   * ABORT IS IDEMPOTENT AND MUST NEVER LEAVE THE LOCK HELD (spec §4.4).
   *
   * [ADDCALL-2-SRV] The original refused unless `migration.id` matched, which
   * broke precisely the case it exists for: the DO auto-aborts a stuck prepare
   * and NULLS the id, so the client's own rollback then met 409 "migration is
   * not active" and its rollback telemetry recorded a failure to roll back
   * something that had already rolled back. Now: an id that matches nothing
   * because there IS no active migration is a no-op success, and the lock is
   * released either way. A mismatched id against a DIFFERENT live migration is
   * still refused — one client must not cancel another's escalation.
   */
  private async abortMigration(b: any): Promise<Response> {
    const r = await this.load(); const uid = String(b?.uid ?? "");
    const denied = this.requireMember(r, uid); if (denied) return denied;
    const wanted = b?.migration_id == null ? null : String(b.migration_id);
    if (r.migration.state !== "preparing") {
      return json({ ok: true, already: r.migration.state, migration_id: r.migration.id, participants: this.presentUids(r) });
    }
    if (wanted != null && r.migration.id !== wanted) {
      return json({ error: "migration is not active", code: "migration_mismatch", active_migration_id: r.migration.id }, 409);
    }
    r.migration = {
      ...r.migration,
      state: "aborted", id: null, targetConferenceId: null, reservedBy: null, reservedAt: null,
      lastAbortReason: String(b?.reason ?? "client_abort").slice(0, 64),
    };
    await this.save(r);
    return json({ ok: true, aborted: true, participants: this.presentUids(r) });
  }

  /**
   * `/migration/release` — spec §4.1 step 8, the last step of the escalation.
   *
   * [ADDCALL-2-SRV] NEW. The 1:1 leg is torn down on the DEVICE, so the server
   * would otherwise have no record of the single moment the feature is
   * actually finished — and `groupcall_release_p2p` (catalogued at
   * lib/call_telemetry_events.ts with zero emit sites) is named precisely
   * because it marks one of the two moments that can fail. This action exists
   * to give that event a server-side emit site and to close the record.
   *
   * It is deliberately POST-COMMIT ONLY. Releasing before commit is the exact
   * failure make-before-break exists to prevent: the old leg gone, the new one
   * unproven, and nobody able to hear anyone.
   */
  private async releaseP2p(b: any): Promise<Response> {
    const r = await this.load(); const uid = String(b?.uid ?? "");
    const denied = this.requireMember(r, uid); if (denied) return denied;
    if (r.migration.committedAt == null) return bad("cannot release p2p before commit", 409);
    if (r.migration.p2pReleasedAt == null) {
      r.migration.p2pReleasedAt = Date.now();
      if (r.state === "starting") r.state = "live";
      await this.save(r);
    }
    return json({
      ok: true, call_id: r.callId, group_id: r.groupId, generation: r.generation,
      committed_at: r.migration.committedAt, p2p_released_at: r.migration.p2pReleasedAt,
      overlap_ms: r.migration.p2pReleasedAt - r.migration.committedAt,
      participants: this.presentUids(r),
    });
  }

  private async startBilling(b: any): Promise<Response> {
    void b;
    return json({ ok: true, free: true, tariff_per_hour: 0, billing_disabled: true });
  }

  private async acceptSponsorship(b: any): Promise<Response> {
    void b;
    return json({ ok: true, free: true, tariff_per_hour: 0, billing_disabled: true });
  }

  private async billingTick(b: any): Promise<Response> {
    void b;
    return json({ ok: true, free: true, settled: false, billing_disabled: true });
  }

  private async transferHost(b: any): Promise<Response> {
    const r = await this.load(); const uid = String(b?.uid ?? "");
    const denied = this.requireMember(r, uid); if (denied) return denied;
    const target = this.member(r, String(b?.target_uid ?? "")); if (!target) return bad("target is not present", 404);
    r.hostUid = target.uid; await this.save(r); return json({ ok: true, host_uid: r.hostUid, sponsor_uid: r.sponsorUid });
  }

  private async end(b: any): Promise<Response> {
    const r = await this.load(); const uid = String(b?.uid ?? "");
    const denied = this.requireMember(r, uid); if (denied) return denied;
    if (uid !== r.hostUid && uid !== r.startedBy) return bad("not allowed to end room", 403);
    r.state = "ended"; r.endedAt = Date.now(); for (const p of r.participants) p.present = false;
    await this.save(r);
    await this.refundSponsor(r);
    return json({ ok: true });
  }

  /** Present participants as bare uids. Returned on every migration action so
   *  routes/conference_room.ts can TAG EVERY PARTICIPANT on the telemetry it
   *  emits (CLAUDE.md: a multi-party event must be retrievable from any one of
   *  the people in it) without a second round trip. */
  private presentUids(r: RoomRecord): string[] {
    return r.participants.filter((p) => p.present).map((p) => p.uid);
  }

  private electHost(r: RoomRecord): string | null {
    return r.participants.filter((p) => p.present && p.capabilities.includes("can_end_for_all")).sort((a, b) => a.tenureSince - b.tenureSince)[0]?.uid ?? null;
  }

  private async refundSponsor(r: RoomRecord): Promise<void> {
    if (!r.sponsorUid || !r.callId) return;
    await Promise.all(r.billing.segments.map((segment) => refundUnused(this.env, {
      call_id: conferenceBillingId(r.callId, segment.sponsorUid),
      caller_id: segment.sponsorUid,
      callee_id: segment.sponsorUid,
      caller_or_callee_id: segment.sponsorUid,
      reason: "CALL_ENDED",
      billing_mode: "B",
    }).catch(() => undefined)));
  }

  private publicState(r: RoomRecord): unknown {
    return { call_id: r.callId, group_id: r.groupId, media_kind: r.mediaKind, state: r.state, generation: r.generation, participant_uids: this.presentUids(r), host_uid: r.hostUid, sponsor_uid: r.sponsorUid, sponsor_grace_until: r.sponsorGraceUntil, migration: r.migration, participants: r.participants.filter((p) => p.present).map((p) => ({ uid: p.uid, session_id: p.sessionId, provisional: p.provisional, tenure_since: p.tenureSince, capabilities: p.capabilities })), billing: { enabled: r.billing.enabled, tariff_per_hour: r.billing.tariffPerMinute, segments: r.billing.segments } };
  }
}
