// Team Receptionist (IVR / auto-attendant) — Specs/TEAM-RECEPTIONIST-IVR-SPEC.md.
//
// A manager subscribes to a Team plan, then adds staff by {name, role, voice,
// greeting, AvaTOK number}. The ordered staff list IS the "press 1 / press 2" menu
// on the team's AvaTOK number. Caller taps an entry → 1:1 call to that staffer
// (existing CallRoom path) → no answer → that staffer's Ava takes a message →
// message card fans out to the dialed staffer + the manager. All staff usage bills
// to the team wallet (see team_billing.ts); staff get Pro for free while on the team.
//
// Routes (all gated by the `teamIvrEnabled` KV flag):
//   POST   /api/team                 create team
//   GET    /api/team                 my team (owner or member) + members + pools
//   PUT    /api/team                 update name/greeting/team_number
//   POST   /api/team/members         add a staff entry
//   PUT    /api/team/members/:id     edit / reorder a staff entry
//   DELETE /api/team/members/:id     remove a staff entry (revert billing + tier)
//   POST   /api/team/invite/accept   staffer accepts enrolment
//   POST   /api/team/invite/decline  staffer declines / leaves
//   GET    /api/team/messages        inbox (manager: whole team; staff: own)
//   GET    /api/team/ivr?number=<n>  caller: the auto-attendant menu
//   POST   /api/team/ivr/route       caller: resolve slot → dial target
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { metaDb, metaSession, sha256hex } from "../db/shard";
import { readConfig } from "./config";
import { TEAM_PLAN } from "./plans";
import { track, metric } from "../hooks";

const APP = "team";
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SLOTS = 9;

const digits = (s: unknown) => String(s ?? "").replace(/[^0-9]/g, "").slice(0, 20);
const clip = (s: unknown, n: number) => String(s ?? "").trim().slice(0, n);

// ── kill switch ─────────────────────────────────────────────────────────────
async function flagOff(env: Env): Promise<Response | null> {
  const cfg = await readConfig(env);
  return (cfg as any).teamIvrEnabled === false
    ? json({ error: "team feature disabled", flag: "teamIvrEnabled" }, 503) : null;
}

interface TeamRow {
  id: string; owner_uid: string; name: string; team_number: string | null;
  greeting_text: string | null; greeting_clip: string | null; billing_uid: string;
  plan_tier: number; seat_limit: number;
  recept_min_quota: number; ai_msg_quota: number;
  recept_min_used: number; ai_msg_used: number; period_start: number | null;
  status: string;
}

// Resolve an AvaTOK number (digits, no '+') to its owner uid, if any.
async function uidForNumber(env: Env, number: string): Promise<string | null> {
  if (!number) return null;
  const r = await metaSession(env)
    .prepare("SELECT uid FROM avatok_numbers WHERE number=?1 AND status='active'")
    .bind(number).first<{ uid: string | null }>();
  return r?.uid ?? null;
}

// The team this uid OWNS, else null.
async function ownedTeam(env: Env, uid: string): Promise<TeamRow | null> {
  return await metaSession(env)
    .prepare("SELECT * FROM teams WHERE owner_uid=?1 AND status='active' LIMIT 1")
    .bind(uid).first<TeamRow>();
}

// The team this uid is a MEMBER of (via team_billing_map), else null.
async function memberTeam(env: Env, uid: string): Promise<TeamRow | null> {
  const m = await metaSession(env)
    .prepare("SELECT team_id FROM team_billing_map WHERE member_uid=?1")
    .bind(uid).first<{ team_id: string }>();
  if (!m) return null;
  return await metaSession(env)
    .prepare("SELECT * FROM teams WHERE id=?1").bind(m.team_id).first<TeamRow>();
}

// Refresh the monthly pool window if it has rolled over. Returns the live team.
async function ensurePeriod(env: Env, t: TeamRow): Promise<TeamRow> {
  const now = Date.now();
  if (!t.period_start || now - t.period_start >= MONTH_MS) {
    await metaDb(env).prepare(
      "UPDATE teams SET period_start=?2, recept_min_used=0, ai_msg_used=0, updated_at=?2 WHERE id=?1",
    ).bind(t.id, now).run();
    return { ...t, period_start: now, recept_min_used: 0, ai_msg_used: 0 };
  }
  return t;
}

async function membersOf(env: Env, teamId: string) {
  const r = await metaSession(env).prepare(
    `SELECT id, slot, display_name, role_label, member_uid, member_number, voice_name,
            greeting_text, invite_status
       FROM team_members WHERE team_id=?1 AND invite_status!='removed' ORDER BY slot ASC`,
  ).bind(teamId).all();
  return (r.results ?? []) as any[];
}

function teamPublic(t: TeamRow, members: any[]) {
  return {
    id: t.id, owner_uid: t.owner_uid, name: t.name,
    team_number: t.team_number, greeting_text: t.greeting_text, greeting_clip: t.greeting_clip,
    seat_limit: t.seat_limit,
    pools: {
      recept_min: { used: t.recept_min_used, quota: t.recept_min_quota },
      ai_msg: { used: t.ai_msg_used, quota: t.ai_msg_quota },
      calls: "unlimited",
    },
    members,
  };
}

// ── POST /api/team — create ──────────────────────────────────────────────────
export async function teamCreate(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env); if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const off = await flagOff(env); if (off) return off;
  const existing = await ownedTeam(env, ctx.uid);
  if (existing) return json({ error: "team_exists", team: teamPublic(existing, await membersOf(env, existing.id)) }, 409);

  const b = (await req.json().catch(() => ({}))) as any;
  const name = clip(b.name, 80) || "My Team";
  const id = crypto.randomUUID();
  const now = Date.now();
  await metaDb(env).prepare(
    `INSERT INTO teams
       (id, owner_uid, name, team_number, greeting_text, billing_uid, plan_tier, seat_limit,
        recept_min_quota, ai_msg_quota, recept_min_used, ai_msg_used, period_start, status, created_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,?2,?6,?7,?8,?9,0,0,?10,'active',?10,?10)`,
  ).bind(
    id, ctx.uid, name, b.team_number ? digits(b.team_number) : null, clip(b.greeting_text, 200) || `You've reached ${name}`,
    TEAM_PLAN.memberTier, TEAM_PLAN.defaultSeatLimit, TEAM_PLAN.receptMinutesPerMonth, TEAM_PLAN.aiMessagesPerMonth, now,
  ).run();
  track(env, ctx.uid, "team_created", APP, { team_id: id, name });
  metric(env, "team_created", [1]);
  const t = await metaSession(env).prepare("SELECT * FROM teams WHERE id=?1").bind(id).first<TeamRow>();
  return json({ ok: true, team: teamPublic(t!, []) });
}

// ── GET /api/team — my team (as owner or member) ─────────────────────────────
export async function teamGet(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env); if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const off = await flagOff(env); if (off) return off;
  let role: "owner" | "member" = "owner";
  let t = await ownedTeam(env, ctx.uid);
  if (!t) { t = await memberTeam(env, ctx.uid); role = "member"; }
  if (!t) return json({ team: null, role: null });
  t = await ensurePeriod(env, t);
  return json({ role, team: teamPublic(t, await membersOf(env, t.id)) });
}

// ── PUT /api/team — update (owner only) ──────────────────────────────────────
export async function teamUpdate(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env); if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const off = await flagOff(env); if (off) return off;
  const t = await ownedTeam(env, ctx.uid);
  if (!t) return json({ error: "no_team" }, 404);
  const b = (await req.json().catch(() => ({}))) as any;
  const name = b.name == null ? t.name : (clip(b.name, 80) || t.name);
  const greeting = b.greeting_text == null ? t.greeting_text : clip(b.greeting_text, 200);
  const clipKey = b.greeting_clip == null ? t.greeting_clip : clip(b.greeting_clip, 256);
  const number = b.team_number == null ? t.team_number : (digits(b.team_number) || null);
  // Guard: the team number must belong to the manager (it's their AvaTOK number).
  if (number && number !== t.team_number) {
    const owner = await uidForNumber(env, number);
    if (owner && owner !== ctx.uid) return json({ error: "number_not_yours" }, 403);
  }
  await metaDb(env).prepare(
    "UPDATE teams SET name=?2, greeting_text=?3, greeting_clip=?4, team_number=?5, updated_at=?6 WHERE id=?1",
  ).bind(t.id, name, greeting, clipKey, number, Date.now()).run();
  track(env, ctx.uid, "team_updated", APP, { team_id: t.id, has_number: !!number });
  const fresh = await metaSession(env).prepare("SELECT * FROM teams WHERE id=?1").bind(t.id).first<TeamRow>();
  return json({ ok: true, team: teamPublic(fresh!, await membersOf(env, t.id)) });
}

// Enable the staffer's own Ava receptionist with the department voice/greeting so
// the no-answer fallback works. Upserts only columns known to exist on every env.
async function enableStaffAva(env: Env, memberUid: string, displayName: string, voice: string, greeting: string | null) {
  const now = Date.now();
  await metaDb(env).prepare(
    `INSERT INTO receptionist_settings (owner_uid, enabled, voice_name, display_name, greeting_text, status_preset, created_at, updated_at)
     VALUES (?1, 1, ?2, ?3, ?4, 'busy', ?5, ?5)
     ON CONFLICT(owner_uid) DO UPDATE SET enabled=1, voice_name=?2, display_name=COALESCE(NULLIF(?3,''),display_name),
        greeting_text=COALESCE(?4,greeting_text), updated_at=?5`,
  ).bind(memberUid, voice, displayName, greeting, now).run().catch(() => {});
}

// Activate a member: write the billing map (team wallet pays + Pro tier) and turn
// on their Ava. Idempotent.
async function activateMember(env: Env, t: TeamRow, m: any) {
  const now = Date.now();
  await metaDb(env).prepare(
    `INSERT INTO team_billing_map (member_uid, team_id, billing_uid, member_tier, updated_at)
     VALUES (?1,?2,?3,?4,?5)
     ON CONFLICT(member_uid) DO UPDATE SET team_id=?2, billing_uid=?3, member_tier=?4, updated_at=?5`,
  ).bind(m.member_uid, t.id, t.billing_uid, t.plan_tier, now).run();
  await metaDb(env).prepare(
    "UPDATE team_members SET invite_status='active', updated_at=?2 WHERE id=?1",
  ).bind(m.id, now).run();
  await enableStaffAva(env, m.member_uid, m.display_name, m.voice_name, m.greeting_text);
  // Notify the staffer they're now Pro, billed by the team.
  try {
    await env.Q_PUSH.send({ kind: "notify", to: m.member_uid, fromName: t.name,
      preview: `You're now Pro on ${t.name} — billed by the team.`, ts: now });
  } catch { /* best-effort */ }
}

// ── POST /api/team/members — add staff ───────────────────────────────────────
export async function teamMemberAdd(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env); if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const off = await flagOff(env); if (off) return off;
  const t = await ownedTeam(env, ctx.uid);
  if (!t) return json({ error: "no_team" }, 404);
  const members = await membersOf(env, t.id);
  if (members.length >= t.seat_limit) return json({ error: "seat_limit", seat_limit: t.seat_limit }, 402);

  const b = (await req.json().catch(() => ({}))) as any;
  const display = clip(b.display_name, 60);
  const role = clip(b.role_label, 60);
  const number = digits(b.member_number);
  const voice = clip(b.voice_name, 40) || "Aoede";
  const greeting = b.greeting_text == null ? null : clip(b.greeting_text, 200);
  if (!display || !role || !number) return json({ error: "missing_fields" }, 400);

  // Slot: requested, else the lowest free slot 1..9.
  let slot = Number(b.slot) || 0;
  const used = new Set(members.map((m) => m.slot));
  if (!slot || used.has(slot)) { slot = 0; for (let i = 1; i <= MAX_SLOTS; i++) if (!used.has(i)) { slot = i; break; } }
  if (!slot) return json({ error: "menu_full", max: MAX_SLOTS }, 402);

  const memberUid = await uidForNumber(env, number); // may be null (not an AvaTOK user yet)
  const id = crypto.randomUUID();
  const now = Date.now();
  await metaDb(env).prepare(
    `INSERT INTO team_members
       (id, team_id, slot, display_name, role_label, member_uid, member_number, voice_name, greeting_text, invite_status, created_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11)`,
  ).bind(id, t.id, slot, display, role, memberUid, number, voice, greeting,
    memberUid ? "active" : "pending", now).run();

  const row = { id, slot, display_name: display, role_label: role, member_uid: memberUid, member_number: number, voice_name: voice, greeting_text: greeting, invite_status: memberUid ? "active" : "pending" };
  if (memberUid) await activateMember(env, t, row);
  track(env, ctx.uid, "team_member_added", APP, { team_id: t.id, slot, role, resolved: !!memberUid });
  metric(env, "team_member_added", [1]);
  return json({ ok: true, member: row, resolved: !!memberUid });
}

// ── PUT /api/team/members/:id — edit / reorder ───────────────────────────────
export async function teamMemberUpdate(req: Request, env: Env, mid: string): Promise<Response> {
  const ctx = await requireUser(req, env); if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const off = await flagOff(env); if (off) return off;
  const t = await ownedTeam(env, ctx.uid);
  if (!t) return json({ error: "no_team" }, 404);
  const m = await metaSession(env).prepare("SELECT * FROM team_members WHERE id=?1 AND team_id=?2").bind(mid, t.id).first<any>();
  if (!m) return json({ error: "not_found" }, 404);
  const b = (await req.json().catch(() => ({}))) as any;
  const display = b.display_name == null ? m.display_name : (clip(b.display_name, 60) || m.display_name);
  const role = b.role_label == null ? m.role_label : (clip(b.role_label, 60) || m.role_label);
  const voice = b.voice_name == null ? m.voice_name : (clip(b.voice_name, 40) || m.voice_name);
  const greeting = b.greeting_text == null ? m.greeting_text : clip(b.greeting_text, 200);
  let slot = b.slot == null ? m.slot : Number(b.slot);
  if (slot !== m.slot) {
    // Swap with whoever currently holds the target slot (simple reorder).
    const holder = await metaSession(env).prepare(
      "SELECT id FROM team_members WHERE team_id=?1 AND slot=?2 AND invite_status!='removed' AND id!=?3",
    ).bind(t.id, slot, mid).first<{ id: string }>();
    if (holder) await metaDb(env).prepare("UPDATE team_members SET slot=?2, updated_at=?3 WHERE id=?1").bind(holder.id, m.slot, Date.now()).run();
  }
  await metaDb(env).prepare(
    "UPDATE team_members SET display_name=?2, role_label=?3, voice_name=?4, greeting_text=?5, slot=?6, updated_at=?7 WHERE id=?1",
  ).bind(mid, display, role, voice, greeting, slot, Date.now()).run();
  // Keep the staffer's Ava persona in sync.
  if (m.member_uid) await enableStaffAva(env, m.member_uid, display, voice, greeting);
  track(env, ctx.uid, "team_member_updated", APP, { team_id: t.id, slot });
  return json({ ok: true });
}

// ── DELETE /api/team/members/:id — remove ────────────────────────────────────
export async function teamMemberRemove(req: Request, env: Env, mid: string): Promise<Response> {
  const ctx = await requireUser(req, env); if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const off = await flagOff(env); if (off) return off;
  const t = await ownedTeam(env, ctx.uid);
  if (!t) return json({ error: "no_team" }, 404);
  const m = await metaSession(env).prepare("SELECT * FROM team_members WHERE id=?1 AND team_id=?2").bind(mid, t.id).first<any>();
  if (!m) return json({ error: "not_found" }, 404);
  const now = Date.now();
  await metaDb(env).prepare("UPDATE team_members SET invite_status='removed', updated_at=?2 WHERE id=?1").bind(mid, now).run();
  if (m.member_uid) {
    // Revert billing + tier: deleting the map row makes billingUidFor/tierOf fall
    // back to the member's own wallet + personal subscription (non-destructive).
    await metaDb(env).prepare("DELETE FROM team_billing_map WHERE member_uid=?1 AND team_id=?2").bind(m.member_uid, t.id).run();
    try { await env.Q_PUSH.send({ kind: "notify", to: m.member_uid, fromName: t.name, preview: `You were removed from ${t.name}.`, ts: now }); } catch { /* best-effort */ }
  }
  track(env, ctx.uid, "team_member_removed", APP, { team_id: t.id, slot: m.slot });
  return json({ ok: true });
}

// ── POST /api/team/invite/accept | /decline ──────────────────────────────────
export async function teamInviteAccept(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env); if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const off = await flagOff(env); if (off) return off;
  const b = (await req.json().catch(() => ({}))) as any;
  const teamId = clip(b.team_id, 64);
  // Match the pending entry by this user's AvaTOK number.
  const me = await metaSession(env).prepare("SELECT avatok_number FROM users WHERE uid=?1").bind(ctx.uid).first<{ avatok_number: string | null }>();
  const myNum = digits(me?.avatok_number);
  const t = await metaSession(env).prepare("SELECT * FROM teams WHERE id=?1 AND status='active'").bind(teamId).first<TeamRow>();
  if (!t) return json({ error: "no_team" }, 404);
  const m = await metaSession(env).prepare(
    "SELECT * FROM team_members WHERE team_id=?1 AND member_number=?2 AND invite_status!='removed' LIMIT 1",
  ).bind(teamId, myNum).first<any>();
  if (!m) return json({ error: "no_invite" }, 404);
  await metaDb(env).prepare("UPDATE team_members SET member_uid=?2, updated_at=?3 WHERE id=?1").bind(m.id, ctx.uid, Date.now()).run();
  await activateMember(env, t, { ...m, member_uid: ctx.uid });
  track(env, ctx.uid, "team_member_accepted", APP, { team_id: teamId, slot: m.slot });
  return json({ ok: true });
}

export async function teamInviteDecline(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env); if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const off = await flagOff(env); if (off) return off;
  const t = await memberTeam(env, ctx.uid);
  await metaDb(env).prepare("DELETE FROM team_billing_map WHERE member_uid=?1").bind(ctx.uid).run();
  if (t) await metaDb(env).prepare("UPDATE team_members SET invite_status='removed', updated_at=?2 WHERE team_id=?1 AND member_uid=?3").bind(t.id, Date.now(), ctx.uid).run();
  track(env, ctx.uid, "team_member_declined", APP, { team_id: t?.id ?? "" });
  return json({ ok: true });
}

// ── GET /api/team/messages — inbox ───────────────────────────────────────────
// Manager sees the whole team's voicemail cards; a staffer sees their own.
export async function teamMessages(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env); if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const off = await flagOff(env); if (off) return off;
  const owned = await ownedTeam(env, ctx.uid);
  const limit = Math.min(100, Math.max(1, Number(new URL(req.url).searchParams.get("limit")) || 50));
  let rows: any[] = [];
  if (owned) {
    const r = await metaSession(env).prepare(
      `SELECT id, owner_uid, caller_uid, caller_phone, caller_name, team_slot, summary_json, recording_url, duration_s, created_at
         FROM receptionist_sessions WHERE team_id=?1 AND status='ended' ORDER BY created_at DESC LIMIT ?2`,
    ).bind(owned.id, limit).all();
    rows = (r.results ?? []) as any[];
  } else {
    const r = await metaSession(env).prepare(
      `SELECT id, owner_uid, caller_uid, caller_phone, caller_name, team_slot, summary_json, recording_url, duration_s, created_at
         FROM receptionist_sessions WHERE owner_uid=?1 AND team_id IS NOT NULL AND status='ended' ORDER BY created_at DESC LIMIT ?2`,
    ).bind(ctx.uid, limit).all();
    rows = (r.results ?? []) as any[];
  }
  const cards = rows.map((r) => {
    let summary: any = {};
    try { summary = r.summary_json ? JSON.parse(r.summary_json) : {}; } catch { /* ignore */ }
    return {
      id: r.id, caller_uid: r.caller_uid, caller_phone: r.caller_phone, caller_name: r.caller_name || summary.caller_name || null,
      slot: r.team_slot, message: summary.message || summary.reason || null,
      callback: summary.callback || null, urgency: summary.urgency || null,
      duration_s: r.duration_s, has_recording: !!r.recording_url, created_at: r.created_at,
    };
  });
  return json({ messages: cards, role: owned ? "owner" : "member" });
}

// ── GET /api/team/ivr?number=<n> — the auto-attendant menu (caller side) ──────
export async function teamIvrMenu(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env); if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const off = await flagOff(env); if (off) return off;
  const number = digits(new URL(req.url).searchParams.get("number"));
  if (!number) return json({ error: "number_required" }, 400);
  const t = await metaSession(env).prepare("SELECT * FROM teams WHERE team_number=?1 AND status='active'").bind(number).first<TeamRow>();
  if (!t) return json({ is_team: false });
  const members = await membersOf(env, t.id);
  const entries = members.map((m) => ({
    slot: m.slot, role_label: m.role_label, display_name: m.display_name,
    // Greyed when the entry has no live account yet — caller still routed to the
    // manager's voicemail rather than dead-ended (handled in /ivr/route).
    available: m.invite_status === "active" && !!m.member_uid,
  }));
  track(env, ctx.uid, "ivr_menu_shown", APP, { team_id: t.id, entries: entries.length });
  return json({
    is_team: true, team_id: t.id, team_name: t.name,
    greeting_text: t.greeting_text || `You've reached ${t.name}`,
    greeting_clip: t.greeting_clip || null,
    entries,
  });
}

// ── IVR voice (Ava speaks the greeting/menu/transfer) ────────────────────────
// One-way TTS via Workers AI (same Aura-2 voice family as agent_tts.ts). The caller
// answers with dialpad digits, not voice, so NO dialogue model is needed here —
// Gemini Live is reserved for the staffer's voicemail. Each clip is cached in R2
// (avatok-agent-audio) keyed by a hash of its text+voice, so a line is synthesized
// once and replayed free on every later call. Spec: TEAM-RECEPTIONIST-IVR-SPEC.md §1b.
const TTS_MODEL = "@cf/deepgram/aura-2-en";
const GREETER_VOICE = "thalia"; // warm default greeter (Aura-2); per-team voice is a future option

// Normalize Workers-AI TTS output (base64 | {audio} | ArrayBuffer | ReadableStream) → bytes.
async function ttsBytes(out: any): Promise<Uint8Array | null> {
  if (!out) return null;
  if (out instanceof ArrayBuffer) return new Uint8Array(out);
  if (out instanceof Uint8Array) return out;
  if (typeof out.getReader === "function") {
    const reader = out.getReader(); const chunks: Uint8Array[] = []; let n = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); n += value.length; }
    const all = new Uint8Array(n); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; } return all;
  }
  const b64 = typeof out === "string" ? out : (typeof out.audio === "string" ? out.audio : null);
  if (b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  return null;
}

// Synthesize-or-serve a spoken line; returns the MP3 bytes (cached in R2). null on failure.
async function speak(env: Env, text: string, voice: string): Promise<Uint8Array | null> {
  const key = `ivr/${await sha256hex(`${voice}:${text}`)}.mp3`;
  try {
    const hit = await env.AGENT_AUDIO.get(key);
    if (hit) return new Uint8Array(await hit.arrayBuffer());
  } catch { /* synth fresh */ }
  try {
    const out: any = await env.AI.run(TTS_MODEL, { text: text.slice(0, 800), speaker: voice } as any);
    const buf = await ttsBytes(out);
    if (!buf || !buf.length) return null;
    await env.AGENT_AUDIO.put(key, buf, { httpMetadata: { contentType: "audio/mpeg" } });
    return buf;
  } catch { return null; }
}

// Build the spoken greeting+menu text from the team + its active entries.
function greetingScript(t: TeamRow, members: any[]): string {
  const open = (t.greeting_text && t.greeting_text.trim()) || `You've reached ${t.name}`;
  const lines = members
    .filter((m) => m.invite_status === "active")
    .sort((a, b) => a.slot - b.slot)
    .map((m) => `For ${m.role_label}, press ${m.slot}.`);
  const tail = lines.length ? ` ${lines.join(" ")}` : " Please hold and we'll connect you.";
  return `${open}.${tail}`;
}

// ── GET /api/team/ivr/audio?number=<n>[&slot=N] — spoken greeting/menu or transfer line ──
export async function teamIvrAudio(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env); if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const off = await flagOff(env); if (off) return off;
  const url = new URL(req.url);
  const number = digits(url.searchParams.get("number"));
  const slotParam = url.searchParams.get("slot");
  const t = await metaSession(env).prepare("SELECT * FROM teams WHERE team_number=?1 AND status='active'").bind(number).first<TeamRow>();
  if (!t) return json({ error: "not_team" }, 404);
  let text: string;
  if (slotParam != null) {
    const slot = Number(slotParam) || 0;
    const m = await metaSession(env).prepare(
      "SELECT role_label FROM team_members WHERE team_id=?1 AND slot=?2 AND invite_status='active' LIMIT 1",
    ).bind(t.id, slot).first<{ role_label: string }>();
    text = m ? `Hold on, I'm transferring you to ${m.role_label}.`
             : `Sorry, that's not a valid option. ${greetingScript(t, await membersOf(env, t.id))}`;
  } else {
    text = greetingScript(t, await membersOf(env, t.id));
  }
  const buf = await speak(env, text, GREETER_VOICE);
  track(env, ctx.uid, "ivr_audio_served", APP, { team_id: t.id, kind: slotParam != null ? "transfer" : "greeting", ok: !!buf, bytes: buf?.length ?? 0 });
  if (!buf) return json({ error: "tts_unavailable" }, 503);
  return new Response(buf, { headers: { "content-type": "audio/mpeg", "cache-control": "private, max-age=86400" } });
}

// ── POST /api/team/ivr/route — caller tapped slot N → dial target ────────────
export async function teamIvrRoute(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env); if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const off = await flagOff(env); if (off) return off;
  const b = (await req.json().catch(() => ({}))) as any;
  const number = digits(b.number);
  const slot = Number(b.slot) || 0;
  const t = await metaSession(env).prepare("SELECT * FROM teams WHERE team_number=?1 AND status='active'").bind(number).first<TeamRow>();
  if (!t) return json({ error: "not_team" }, 404);
  const m = await metaSession(env).prepare(
    "SELECT * FROM team_members WHERE team_id=?1 AND slot=?2 AND invite_status='active' LIMIT 1",
  ).bind(t.id, slot).first<any>();
  if (!m || !m.member_uid) {
    // Dead-end guard: route to the manager's own Ava so the caller is never stuck.
    track(env, ctx.uid, "ivr_slot_tapped", APP, { team_id: t.id, slot, routed: "fallback_owner" });
    return json({ ok: true, fallback: true, target_uid: t.owner_uid, target_number: t.team_number, team_id: t.id, slot });
  }
  track(env, ctx.uid, "ivr_slot_tapped", APP, { team_id: t.id, slot, role: m.role_label, routed: "staff" });
  metric(env, "ivr_slot_tapped", [1]);
  return json({
    ok: true, fallback: false,
    target_uid: m.member_uid, target_number: m.member_number,
    target_name: m.display_name, role_label: m.role_label,
    voice_name: m.voice_name, team_id: t.id, slot,
  });
}
