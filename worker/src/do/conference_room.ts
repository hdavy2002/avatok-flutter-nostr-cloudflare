// ConferenceRoomDO — migration and billing authority for ad-hoc 1:1 → SFU
// promotion. Media remains in Cloudflare Realtime/GroupCallRoom; this object
// owns the durable protocol around it.
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

const MAX_PARTICIPANTS = 25;
const SPONSOR_GRACE_MS = 5 * 60 * 1000;
const CAPABILITIES = [
  "can_invite", "can_remove_participants", "can_end_for_all",
  "can_manage_recording", "can_view_billing", "can_accept_sponsorship",
] as const;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function bad(message: string, status = 400): Response { return json({ error: message }, status); }

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
    if (r.migration.state === "preparing" && r.migration.reservedAt != null && now - r.migration.reservedAt > 10_000) {
      r.migration = { state: "aborted", id: null, targetConferenceId: null, reservedBy: null, reservedAt: null, committedAt: null };
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
      sponsorGraceUntil: null, migration: { state: "idle", id: null, targetConferenceId: null, reservedBy: null, reservedAt: null, committedAt: null },
      participants: [], billing: { tariffPerMinute: null, segments: [], enabled: false }, createdAt: 0, endedAt: null,
    };
    return this.record;
  }

  private async save(r: RoomRecord): Promise<void> {
    this.record = r;
    await this.state.storage.put("room", r);
    if (r.state !== "ended") await this.state.storage.setAlarm(Date.now() + 15_000);
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

  private async start(b: any): Promise<Response> {
    const uid = String(b?.uid ?? "").trim();
    const groupId = String(b?.group_id ?? "").trim();
    if (!uid || !groupId) return bad("uid and group_id required");
    const r = await this.load();
    if (r.state !== "ended" && r.state !== "starting") return json(this.publicState(r));
    const now = Date.now();
    const mediaKind: ConferenceMediaKind = b?.media_kind === "audio_video" || b?.media_kind === "video" ? b.media_kind : "audio";
    const next: RoomRecord = {
      ...r, callId: crypto.randomUUID(), groupId, mediaKind, state: "starting", generation: r.generation + 1,
      startedBy: uid, hostUid: uid, sponsorUid: uid, sponsorGraceUntil: null,
      migration: { state: "idle", id: null, targetConferenceId: null, reservedBy: null, reservedAt: null, committedAt: null },
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

  private async joinParticipant(b: any): Promise<Response> {
    const r = await this.load(); const uid = String(b?.uid ?? "");
    const denied = this.requireMember(r, uid); if (denied) return denied;
    if (!(await this.isGroupMember(r.groupId, uid))) return bad("not a group participant", 403);
    const p = this.member(r, uid)!;
    if (r.migration.state !== "committed") return bad("conference join requires committed migration", 409);
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

  private async reserveMigration(b: any): Promise<Response> {
    const r = await this.load(); const uid = String(b?.uid ?? "");
    const denied = this.requireMember(r, uid); if (denied) return denied;
    if (r.migration.state === "preparing") return bad("escalation already in progress", 409);
    const id = crypto.randomUUID();
    r.migration = { state: "preparing", id, targetConferenceId: String(b?.conference_id ?? crypto.randomUUID()), reservedBy: uid, reservedAt: Date.now(), committedAt: null };
    await this.save(r); return json({ ok: true, migration_id: id, conference_id: r.migration.targetConferenceId });
  }

  private async prepareMigration(b: any): Promise<Response> {
    const r = await this.load(); const uid = String(b?.uid ?? "");
    const denied = this.requireMember(r, uid); if (denied) return denied;
    if (r.migration.state !== "preparing" || r.migration.id !== b?.migration_id) return bad("migration is not active", 409);
    if (String(b?.call_epoch ?? r.generation) !== String(r.generation)) return bad("stale call epoch", 409);
    return json({ ok: true, migration_id: r.migration.id, conference_id: r.migration.targetConferenceId, provisional: true, participants: r.participants.filter((p) => p.present).map((p) => ({ uid: p.uid, session_id: p.sessionId })) });
  }

  private async commitMigration(b: any): Promise<Response> {
    const r = await this.load(); const uid = String(b?.uid ?? "");
    const denied = this.requireMember(r, uid); if (denied) return denied;
    if (r.migration.state !== "preparing" || r.migration.id !== b?.migration_id) return bad("migration is not active", 409);
    if (b?.sfu_ready !== true) return bad("sfu readiness evidence required", 409);
    r.migration.state = "committed"; r.migration.committedAt = Date.now();
    await this.save(r); return json({ ok: true, call_id: r.callId, conference_id: r.migration.targetConferenceId, generation: r.generation });
  }

  private async abortMigration(b: any): Promise<Response> {
    const r = await this.load(); const uid = String(b?.uid ?? "");
    const denied = this.requireMember(r, uid); if (denied) return denied;
    if (r.migration.id !== b?.migration_id) return bad("migration is not active", 409);
    r.migration.state = "aborted"; await this.save(r); return json({ ok: true });
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
    return { call_id: r.callId, group_id: r.groupId, media_kind: r.mediaKind, state: r.state, generation: r.generation, host_uid: r.hostUid, sponsor_uid: r.sponsorUid, sponsor_grace_until: r.sponsorGraceUntil, migration: r.migration, participants: r.participants.filter((p) => p.present).map((p) => ({ uid: p.uid, session_id: p.sessionId, provisional: p.provisional, tenure_since: p.tenureSince, capabilities: p.capabilities })), billing: { enabled: r.billing.enabled, tariff_per_hour: r.billing.tariffPerMinute, segments: r.billing.segments } };
  }
}
