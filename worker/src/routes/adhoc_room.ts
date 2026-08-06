// [ADDCALL-1-SRV] Add-to-call — the invisible ad-hoc conversation.
// Spec: Specs/SPEC-ADD-TO-CALL-2026-08-06.md (§2 the room, §8 caps).
//
// WHY THIS FILE EXISTS AT ALL
// ---------------------------
// The conference stack refuses to admit anyone who is not in `conversation_members`
// (`routes/groupcall.ts` guard(), `do/conference_room.ts` isGroupMember), so
// escalating a 1:1 into a group call REQUIRES a conversation row. But the owner's
// product decision (2026-08-06) is the WhatsApp model: adding someone to a call
// must NOT create a group chat. The room is therefore made **invisible** rather
// than absent.
//
// `kind='call'` IS NOT A TYPO. It is a NEW third value in a column that has only
// ever held 'dm' and 'group', and that single value is what makes the room
// invisible — visibility is entirely client-side:
//   • the Chats tab is built from the CONTACT BOOK, not from conversations at all
//     (app/lib/features/avatok/chat_list.dart, owner decision 2026-06-28), so a
//     conversation row can never surface there;
//   • the Groups tab filters on `kind == 'group'` (app/lib/sync/group_api.dart),
//     so a 'call' row is skipped before it reaches GroupStore;
//   • `groupMembers` (groupcall.ts) and `isGroupMember` (conference_room.ts) both
//     query `conversation_members` WITHOUT checking kind, so the entire call stack
//     works untouched.
// `context='system'` is set for the same reason: it keeps the row out of every
// context-filtered conversation listing (convList's ?context= filter).
//
// The cost of that new value: `convIsGroup` (messaging.ts) hard-requires
// kind==='group', so `/api/conversations/members/add` 400s "not a group" on our
// rooms. That is exactly why `/api/adhoc-room/add` below exists — it is not a
// duplicate of convAddMembers, it is the only member-management path an ad-hoc
// room has.
//
// NOT IN THIS PHASE (see spec §9): no migration, no ring, no GroupCallRoom or
// ConferenceRoomDO changes, no conference join logic. Phase 1 creates the room and
// nothing else; joining the conference cold is a valid intermediate state.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { readConfig } from "./config";
// [AVA-IDGATE-1] The one liveness gate. convCreate's group branch calls this with
// "group_create" before writing a conversation row; this route is a sibling of
// that branch and creates a conversation row too, so it must gate identically or
// add-to-call becomes an UNGATED conversation-creation path that bypasses the
// whole identity ladder. "group_create" is reused deliberately: PublicAction is a
// closed union in lib/identity_gate.ts and this IS a group-creation action from
// the gate's point of view. A new member of that union would need a matching
// policy decision, which this issue does not own.
import { gatePublicAction, emailOf } from "../lib/identity_gate";
import { nameFor, contactFor } from "../lib/identity";
import { trackUserContact, trackException } from "../hooks";
import { CallEvent } from "../lib/call_telemetry_events";

const APP = "avatok";

/**
 * THE PRODUCT CAP (spec §8) — 10 participants, enforced HERE and only here.
 *
 * Deliberately NOT a fourth constant in the media layer: `groupcall.ts`
 * (MAX_CONF_PARTICIPANTS = 25) and `do/group_call_room.ts` carry explicit
 * "never weakened" / "never raised past this" comments on their own caps, and
 * those are the SERVER-SIDE BACKSTOP, not the product limit. 10 is well inside
 * every one of them (25 / 32 / 25), so this cap violates nothing and can be
 * changed here without touching a single line of media code.
 *
 * Both routes below count the RESULTING membership against this number before
 * any D1 write, so there is no path that creates an over-cap room.
 */
const MAX_ADHOC_MEMBERS = 10;

/** Same shape as the media layer's call ids (callrec.ts uses this exact regex). */
const CALL_ID_RE = /^[A-Za-z0-9_:.-]{1,64}$/;
/** Conversation ids we mint are `g_<uuid>`; be liberal but bounded on input. */
const CONV_ID_RE = /^[A-Za-z0-9_:.-]{1,80}$/;
const MAX_TITLE = 120;

/**
 * The conversation `kind` written by this file. Exported so a future cleanup
 * sweep (spec §11 item 1 — nothing deletes conversations today, so these rows
 * accumulate forever) has ONE symbol to select on rather than a magic string
 * copied into a cron job:
 *
 *   DELETE FROM conversations WHERE kind = ADHOC_ROOM_KIND AND updated_at < cutoff
 *
 * That sweep is NOT built here, on purpose: it must also drop the matching
 * `conversation_members` rows and reckon with the permanent GroupCallRoom DO
 * instance at idFromName(convId), which is a design decision, not a one-liner.
 */
export const ADHOC_ROOM_KIND = "call";

/** Shared funnel key across client and worker, the way `rec_id` works for
 *  recordings (spec §10). One escalation reconstructs as one funnel.
 *
 *  [ADDCALL-2-SRV] Exported so routes/conference_room.ts stamps the SAME id on
 *  the migration half of the funnel. Both halves key on the 1:1 `call_id`
 *  (which is also the ConferenceRoomDO's `idFromName`), so room creation and
 *  the reserve/prepare/commit/release chain join up as one escalation. If this
 *  is ever computed by hand anywhere else, the funnel silently splits in two. */
export function escalationIdFor(key: string): string {
  return `addcall:${key}`;
}

/** Telemetry that never throws — every call site sits inside `waitUntil`.
 *  workerd DROPS unawaited telemetry on an early-return error path (CLAUDE.md),
 *  and almost every emit below is immediately followed by a return. */
async function emit(
  env: Env, uid: string, event: string, props: Record<string, unknown>,
): Promise<void> {
  try {
    const c = await contactFor(env, uid).catch(() => ({ email: null, phone: null }));
    await trackUserContact(env, uid, c.email, c.phone, event, APP, props);
  } catch { /* best-effort */ }
}

/** Every uid in `uids` that actually exists in `users`. ONE query, not N. */
async function existingUids(env: Env, uids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!uids.length) return out;
  const rs = await env.DB_META.prepare(
    `SELECT uid FROM users WHERE uid IN (${uids.map((_, i) => `?${i + 1}`).join(",")})`,
  ).bind(...uids).all<{ uid: string }>();
  for (const r of rs.results ?? []) out.add(r.uid);
  return out;
}

/**
 * Anyone in `uids` on either side of a block with `me`.
 *
 * BOTH directions, unlike `messaging.blockersOf` which only asks "who blocked the
 * sender". A call is two-way and unmutable-in-place: pulling someone the caller
 * has blocked into a live audio room is as wrong as pulling in someone who
 * blocked the caller. One query, `blocks` is the single consolidated table
 * (authz.ts:84, safety.ts writes it).
 *
 * [ADDCALL-3-SRV] Exported so `POST /api/groupcall/:id/invite` (spec §5) applies
 * the IDENTICAL rule when it rings someone into a call that is already running.
 * Re-deriving it there would be a second, drifting copy of a safety check.
 */
export async function blockedEitherWay(env: Env, me: string, uids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!uids.length) return out;
  const ph = uids.map((_, i) => `?${i + 2}`).join(",");
  const rs = await env.DB_META.prepare(
    `SELECT uid, blocked_uid FROM blocks
      WHERE (blocked_uid = ?1 AND uid IN (${ph}))
         OR (uid = ?1 AND blocked_uid IN (${ph}))`,
  ).bind(me, ...uids).all<{ uid: string; blocked_uid: string }>();
  for (const r of rs.results ?? []) {
    if (r.uid !== me) out.add(r.uid);
    if (r.blocked_uid !== me) out.add(r.blocked_uid);
  }
  return out;
}

async function memberUids(env: Env, conv: string): Promise<string[]> {
  const rows = await env.DB_META
    .prepare("SELECT uid FROM conversation_members WHERE conv_id = ?1")
    .bind(conv).all<{ uid: string }>();
  return (rows.results || []).map((r) => r.uid);
}

/** "Ana, Ben & Chi" — a human title for the call-history row. Best-effort: a
 *  missing display name degrades the title, it never fails the request. */
async function deriveTitle(env: Env, uids: string[]): Promise<string | null> {
  try {
    const names: string[] = [];
    for (const u of uids.slice(0, 4)) {
      const n = await nameFor(env, u).catch(() => null);
      if (n) names.push(n);
    }
    if (!names.length) return null;
    const extra = uids.length - names.length;
    const base = names.length > 1
      ? `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`
      : names[0];
    return (extra > 0 ? `${base} +${extra}` : base).slice(0, MAX_TITLE);
  } catch { return null; }
}

/** Normalise a `string[]` body field: strings only, trimmed, non-empty, deduped. */
function uidList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  for (const x of v) {
    const s = String(x ?? "").trim();
    if (s && s.length <= 128) seen.add(s);
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// POST /api/adhoc-room/create
//   { call_id, peer_uid, invitees: string[], title? }
//   → { ok: true, conv_id, members: string[] }
//
// Creates the invisible room for an escalating 1:1. Sibling of convCreate's group
// branch (messaging.ts) — same gate, same id prefix, same immediate-membership
// semantics — differing ONLY in `kind`/`context` and in NOT fanning invites.
// ---------------------------------------------------------------------------
export async function adhocRoomCreate(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const uid = ctx.uid;

  const cfg = await readConfig(env).catch(() => null);
  if (cfg?.addToCallEnabled !== true) {
    return json({ error: "disabled", flag: "addToCallEnabled" }, 403);
  }

  let b: any;
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  const callId = String(b?.call_id ?? "").trim();
  if (!CALL_ID_RE.test(callId)) return json({ error: "call_id required" }, 400);
  const escalationId = escalationIdFor(callId);

  const peerUid = String(b?.peer_uid ?? "").trim();
  if (!peerUid || peerUid === uid) return json({ error: "peer_uid required" }, 400);

  const invitees = uidList(b?.invitees).filter((u) => u !== uid && u !== peerUid);
  if (!invitees.length) return json({ error: "invitees required" }, 400);

  // [AVA-IDGATE-1] Liveness gate BEFORE any lookup or write — see the import note.
  {
    const g = await gatePublicAction(env, uid, await emailOf(env, uid).catch(() => null), "group_create");
    if (g) {
      exec.waitUntil(emit(env, uid, CallEvent.groupcall_escalate_failed, {
        escalation_id: escalationId, call_id: callId, reason: "identity_required",
        invitee_count: invitees.length,
      }));
      return g;
    }
  }

  // Members = caller + the existing 1:1 peer + invitees, deduped and ordered.
  const members = [uid, peerUid, ...invitees];

  // ── THE CAP (spec §8) — before any D1 write, counting the RESULTING room. ──
  if (members.length > MAX_ADHOC_MEMBERS) {
    exec.waitUntil(emit(env, uid, CallEvent.groupcall_full_rejected, {
      escalation_id: escalationId, call_id: callId,
      requested: members.length, max_members: MAX_ADHOC_MEMBERS, stage: "create",
    }));
    return json({
      error: "too_many_participants", code: "adhoc_room_full",
      max_members: MAX_ADHOC_MEMBERS, requested: members.length,
      message: `A call can have at most ${MAX_ADHOC_MEMBERS} people.`,
    }, 400);
  }

  // ── Validate the targets. The body is NOT trusted: convAddMembers inserts
  // whatever uids it is handed (no existence check, no block check), and this
  // route mints a room whose membership is the ONLY thing standing between a
  // stranger and a live audio conference — so it validates properly.
  const targets = [peerUid, ...invitees];
  let known: Set<string>;
  let blocked: Set<string>;
  try {
    [known, blocked] = await Promise.all([
      existingUids(env, targets),
      blockedEitherWay(env, uid, targets),
    ]);
  } catch (e) {
    exec.waitUntil(trackException(env, e, {
      uid, route: "/api/adhoc-room/create", method: "POST", handled: true,
      extra: { escalation_id: escalationId, call_id: callId, stage: "validate" },
    }));
    return json({ error: "lookup_failed" }, 500);
  }

  const unknown = targets.filter((u) => !known.has(u));
  if (unknown.length) {
    exec.waitUntil(emit(env, uid, CallEvent.groupcall_escalate_failed, {
      escalation_id: escalationId, call_id: callId, reason: "unknown_uid",
      invalid_count: unknown.length,
    }));
    return json({ error: "invalid_invitees", code: "unknown_uid", invalid: unknown }, 400);
  }
  const barred = targets.filter((u) => blocked.has(u));
  if (barred.length) {
    exec.waitUntil(emit(env, uid, CallEvent.groupcall_escalate_failed, {
      escalation_id: escalationId, call_id: callId, reason: "blocked",
      blocked_count: barred.length,
    }));
    return json({ error: "invalid_invitees", code: "blocked", invalid: barred }, 403);
  }

  const conv = "g_" + crypto.randomUUID();  // SAME prefix as convCreate — nothing
                                            // keys on it structurally, and keeping
                                            // it means every existing conv-id
                                            // parser/log stays valid.
  const now = Date.now();
  const title = (typeof b?.title === "string" && b.title.trim())
    ? b.title.trim().slice(0, MAX_TITLE)
    : await deriveTitle(env, members.filter((u) => u !== uid));

  try {
    await env.DB_META.batch([
      // kind='call' + context='system' — the two values that make this row
      // invisible on the client. See the header comment; this is not a typo.
      env.DB_META.prepare(
        "INSERT INTO conversations (id, kind, title, context, created_by, created_at, updated_at) VALUES (?1,?2,?3,'system',?4,?5,?5)",
      ).bind(conv, ADHOC_ROOM_KIND, title, uid, now),
      env.DB_META.prepare(
        "INSERT OR IGNORE INTO conversation_members (conv_id, uid, role, joined_at) VALUES (?1,?2,'owner',?3)",
      ).bind(conv, uid, now),
      // IMMEDIATE membership, never pending. convCreate honours the
      // `groupInvitesEnabled` kill switch and can leave invitees in a pending
      // state; this path must NOT, because a live call cannot wait on an invite
      // accept — the ring would reach someone the conference then refuses to
      // admit (guard() checks conversation_members). If groupInvitesEnabled is
      // ever turned on, this route stays immediate on purpose.
      ...members.filter((u) => u !== uid).map((u) => env.DB_META.prepare(
        "INSERT OR IGNORE INTO conversation_members (conv_id, uid, role, joined_at) VALUES (?1,?2,'member',?3)",
      ).bind(conv, u, now)),
    ]);
  } catch (e) {
    exec.waitUntil(trackException(env, e, {
      uid, route: "/api/adhoc-room/create", method: "POST", handled: true,
      extra: { escalation_id: escalationId, call_id: callId, conv, stage: "insert" },
    }));
    exec.waitUntil(emit(env, uid, CallEvent.groupcall_escalate_failed, {
      escalation_id: escalationId, call_id: callId, reason: "db_write_failed",
    }));
    return json({ error: "create_failed" }, 500);
  }

  // DO NOT call fanGroupInvites() here.
  // ----------------------------------
  // convCreate fans a "you were added to a group" push to every invitee. For an
  // ad-hoc call room that notification is WRONG twice over: there is no group to
  // be added to (the row is invisible by design), and the group-call RING is the
  // notification — Phase 3 rings these same people through ringGroup. Fanning
  // invites as well would double-ping every invitee, once with a push pointing at
  // a chat they cannot see. If you are reading this because member fan-out "looks
  // missing", it is missing deliberately (spec §2).

  exec.waitUntil(emit(env, uid, CallEvent.groupcall_escalate_started, {
    escalation_id: escalationId, call_id: callId, conv, kind: ADHOC_ROOM_KIND,
    member_count: members.length, invitee_count: invitees.length,
    peer_uid: peerUid,
    // Tag EVERY participant (CLAUDE.md): a multi-party event must be retrievable
    // from any one of the people in it, not just the person who pressed Add.
    participants: members,
  }));

  return json({ ok: true, conv_id: conv, members });
}

// ---------------------------------------------------------------------------
// POST /api/adhoc-room/add
//   { conv_id, invitees: string[] }
//   → { ok: true, members: string[], added: string[] }
//
// Adds more people to an EXISTING ad-hoc room. This route exists because
// `/api/conversations/members/add` cannot serve it: convAddMembers calls
// convIsGroup, which hard-requires kind==='group', and 400s "not a group" on
// every room this file creates.
//
// It is also deliberately NOT a general-purpose member API — it refuses any
// conversation that is not kind='call', so it can never be used as a back door
// into a real group or a DM (convAddMembers' owner/admin gate does not apply
// here; membership is the gate, because in a call every participant is a peer).
// ---------------------------------------------------------------------------
export async function adhocRoomAdd(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const uid = ctx.uid;

  const cfg = await readConfig(env).catch(() => null);
  if (cfg?.addToCallEnabled !== true) {
    return json({ error: "disabled", flag: "addToCallEnabled" }, 403);
  }

  let b: any;
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  const conv = String(b?.conv_id ?? "").trim();
  if (!CONV_ID_RE.test(conv)) return json({ error: "conv_id required" }, 400);
  const escalationId = escalationIdFor(conv);

  const invitees = uidList(b?.invitees).filter((u) => u !== uid);
  if (!invitees.length) return json({ error: "invitees required" }, 400);

  // The conversation must be one of OURS. Fail closed on a missing row.
  const row = await env.DB_META
    .prepare("SELECT kind FROM conversations WHERE id=?1")
    .bind(conv).first<{ kind: string }>()
    .catch(() => null);
  if (!row) return json({ error: "not found" }, 404);
  if (row.kind !== ADHOC_ROOM_KIND) {
    return json({ error: "not_an_adhoc_room", code: "wrong_kind", kind: row.kind }, 400);
  }

  // The caller must already be in the room — the same membership check the
  // conference itself uses, so this route cannot grant access the call would not.
  const current = await memberUids(env, conv).catch(() => [] as string[]);
  if (!current.includes(uid)) return json({ error: "not a member" }, 403);

  const fresh = invitees.filter((u) => !current.includes(u));
  if (!fresh.length) return json({ ok: true, members: current, added: [] });

  // ── THE CAP (spec §8), counting EXISTING members + this batch. ────────────
  if (current.length + fresh.length > MAX_ADHOC_MEMBERS) {
    exec.waitUntil(emit(env, uid, CallEvent.groupcall_full_rejected, {
      escalation_id: escalationId, conv,
      requested: current.length + fresh.length, max_members: MAX_ADHOC_MEMBERS, stage: "add",
    }));
    return json({
      error: "too_many_participants", code: "adhoc_room_full",
      max_members: MAX_ADHOC_MEMBERS, requested: current.length + fresh.length,
      message: `A call can have at most ${MAX_ADHOC_MEMBERS} people.`,
    }, 400);
  }

  let known: Set<string>;
  let blocked: Set<string>;
  try {
    [known, blocked] = await Promise.all([
      existingUids(env, fresh),
      blockedEitherWay(env, uid, fresh),
    ]);
  } catch (e) {
    exec.waitUntil(trackException(env, e, {
      uid, route: "/api/adhoc-room/add", method: "POST", handled: true,
      extra: { escalation_id: escalationId, conv, stage: "validate" },
    }));
    return json({ error: "lookup_failed" }, 500);
  }

  const unknown = fresh.filter((u) => !known.has(u));
  if (unknown.length) {
    exec.waitUntil(emit(env, uid, CallEvent.groupcall_escalate_failed, {
      escalation_id: escalationId, conv, reason: "unknown_uid", invalid_count: unknown.length,
    }));
    return json({ error: "invalid_invitees", code: "unknown_uid", invalid: unknown }, 400);
  }
  const barred = fresh.filter((u) => blocked.has(u));
  if (barred.length) {
    exec.waitUntil(emit(env, uid, CallEvent.groupcall_escalate_failed, {
      escalation_id: escalationId, conv, reason: "blocked", blocked_count: barred.length,
    }));
    return json({ error: "invalid_invitees", code: "blocked", invalid: barred }, 403);
  }

  const now = Date.now();
  try {
    await env.DB_META.batch([
      env.DB_META.prepare("UPDATE conversations SET updated_at=?2 WHERE id=?1").bind(conv, now),
      // Immediate membership again — same reasoning as create(). No pending state,
      // and again NO fanGroupInvites: the ring is the notification (spec §2).
      ...fresh.map((u) => env.DB_META.prepare(
        "INSERT OR IGNORE INTO conversation_members (conv_id, uid, role, joined_at) VALUES (?1,?2,'member',?3)",
      ).bind(conv, u, now)),
    ]);
  } catch (e) {
    exec.waitUntil(trackException(env, e, {
      uid, route: "/api/adhoc-room/add", method: "POST", handled: true,
      extra: { escalation_id: escalationId, conv, stage: "insert" },
    }));
    return json({ error: "add_failed" }, 500);
  }

  const members = [...current, ...fresh];
  exec.waitUntil(emit(env, uid, CallEvent.groupcall_invite_created, {
    escalation_id: escalationId, conv, kind: ADHOC_ROOM_KIND,
    added_count: fresh.length, member_count: members.length,
    participants: members,
  }));

  return json({ ok: true, members, added: fresh });
}
