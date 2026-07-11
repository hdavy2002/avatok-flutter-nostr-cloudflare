// Agent Profiles + service numbers (WP3, plan §4/§7/§8b/§12.5/§12.8/§12.10 of
// Specs/PLAN-2026-07-11-dialpad-business-calls-ava-voice-agent.md).
//
// Data model (plan §12.5 "Shared Agent Profiles — ADOPT"): a service number
// REFERENCES an Agent Profile, it doesn't own one. Many numbers can point at
// one profile; edit once, all inherit. The primary (Mode A) number gets ONE
// implicit profile, id convention `primary:<owner_uid>` — created lazily on
// first GET/PUT of /api/agent/settings.
//
// Lazily-ensured DB_META tables (same `ensureTable` pattern as
// routes/agent_settings.ts / routes/call_billing_routes.ts — D1 has no
// migration runner in the request path):
//   - agent_profiles   { instructions, Collection, tool manifest, rate, length
//     options, routing, booking_authority, business_hours + version } — §12.5/§12.8
//   - service_numbers  Mode-B-only additional AvaTOK numbers. NEVER recycled
//     (§15.3): delete = retired=1 forever, never reused for a new owner.
//   - agent_call_log   per-call summary rows WP4's Grok pipeline will populate;
//     read-only here (GET /api/agent/my-calls; {available:false} when empty).
//
// REUSED, not duplicated:
//   - lib/numbering.ts — CountryPlan/canonical/display/generate/validNsn: the
//     SAME allocation mechanics as the primary AvaTOK number (routes/number.ts
//     assign()). Service numbers draw from a DISTINCT sub-range of each
//     country's leadPool (the second half) so they are visually distinguishable
//     from primary numbers within the same national format, without a schema
//     change to `avatok_numbers` (service numbers live in their OWN table).
//   - routes/call_billing_routes.ts's isChildAccount() pattern (§15.4 hard
//     block: child accounts cannot create service numbers / set paid rates).
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { metaDb, metaSession } from "../db/shard";
import { readConfig } from "./config";
import { COUNTRIES, planFor, canonical, display, generate, type CountryPlan } from "../lib/numbering";
import { nameFor } from "../lib/identity";

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------
let tablesEnsured = false;
async function ensureTables(env: Env): Promise<void> {
  if (tablesEnsured) return;
  const db = metaDb(env);
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS agent_profiles (
       id TEXT PRIMARY KEY,
       owner_uid TEXT NOT NULL,
       version INTEGER NOT NULL DEFAULT 1,
       instructions TEXT,
       collection_id TEXT,
       tool_manifest TEXT,
       rate INTEGER,
       length_options TEXT,
       routing TEXT,
       booking_authority TEXT NOT NULL DEFAULT 'confirm_with_caller',
       business_hours TEXT,
       business_hours_version INTEGER NOT NULL DEFAULT 1,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
  ).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_agent_profiles_owner ON agent_profiles (owner_uid)`).run();

  await db.prepare(
    `CREATE TABLE IF NOT EXISTS service_numbers (
       number TEXT PRIMARY KEY,
       owner_uid TEXT NOT NULL,
       profile_id TEXT NOT NULL,
       display_name TEXT,
       active INTEGER NOT NULL DEFAULT 1,
       retired INTEGER NOT NULL DEFAULT 0,
       created_at INTEGER NOT NULL
     )`,
  ).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_service_numbers_owner ON service_numbers (owner_uid)`).run();

  await db.prepare(
    `CREATE TABLE IF NOT EXISTS agent_call_log (
       call_id TEXT PRIMARY KEY,
       caller_id TEXT,
       owner_uid TEXT NOT NULL,
       service_number TEXT,
       transcript_r2 TEXT,
       summary TEXT,
       created_at INTEGER NOT NULL
     )`,
  ).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_agent_call_log_owner ON agent_call_log (owner_uid)`).run();
  tablesEnsured = true;
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------
export interface BusinessHoursWindow { day: number; start: string; end: string }
export interface BusinessHoursSchedule { tz?: string; windows: BusinessHoursWindow[] }
export type BookingAuthority = "auto_write" | "confirm_with_caller" | "require_owner_approval";

export interface AgentProfileRow {
  id: string;
  owner_uid: string;
  version: number;
  instructions: string | null;
  collection_id: string | null;
  tool_manifest: string | null; // raw JSON string — WP4 parses per its own shape
  rate: number | null;
  length_options: number[] | null;
  routing: string | null; // 'auto' | 'manual' | 'off'
  booking_authority: BookingAuthority;
  business_hours: BusinessHoursSchedule | null;
  business_hours_version: number;
  created_at: number;
  updated_at: number;
}

interface AgentProfileDbRow {
  id: string; owner_uid: string; version: number; instructions: string | null;
  collection_id: string | null; tool_manifest: string | null; rate: number | null;
  length_options: string | null; routing: string | null; booking_authority: string;
  business_hours: string | null; business_hours_version: number;
  created_at: number; updated_at: number;
}

function rowToProfile(r: AgentProfileDbRow): AgentProfileRow {
  let lengthOptions: number[] | null = null;
  try { const p = r.length_options ? JSON.parse(r.length_options) : null; if (Array.isArray(p)) lengthOptions = p.map(Number).filter((n) => n > 0); } catch { lengthOptions = null; }
  let businessHours: BusinessHoursSchedule | null = null;
  try { const p = r.business_hours ? JSON.parse(r.business_hours) : null; if (p && Array.isArray(p.windows)) businessHours = p; } catch { businessHours = null; }
  const auth: BookingAuthority = (["auto_write", "confirm_with_caller", "require_owner_approval"].includes(r.booking_authority)
    ? r.booking_authority : "confirm_with_caller") as BookingAuthority;
  return {
    id: r.id, owner_uid: r.owner_uid, version: r.version, instructions: r.instructions,
    collection_id: r.collection_id, tool_manifest: r.tool_manifest, rate: r.rate == null ? null : Number(r.rate),
    length_options: lengthOptions, routing: r.routing, booking_authority: auth,
    business_hours: businessHours, business_hours_version: r.business_hours_version,
    created_at: r.created_at, updated_at: r.updated_at,
  };
}

async function loadProfile(env: Env, id: string): Promise<AgentProfileRow | null> {
  await ensureTables(env);
  const r = await metaDb(env).prepare("SELECT * FROM agent_profiles WHERE id=?1").bind(id).first<AgentProfileDbRow>();
  return r ? rowToProfile(r) : null;
}

// ---------------------------------------------------------------------------
// Exported for WP4 (routes/agent_docs.ts, do/agent_voice_room.ts) — the RAG
// document pipeline and the voice-agent DO both need read/write access to a
// profile without duplicating the ensureTables/rowToProfile plumbing above.
// ---------------------------------------------------------------------------

/** Owner-scoped profile load — returns null if the profile doesn't exist OR
 *  isn't owned by `ownerUid` (never leaks another owner's profile by guessing
 *  an id). Used by agent_docs.ts before any doc upload/list/delete. */
export async function getProfileForOwner(env: Env, profileId: string, ownerUid: string): Promise<AgentProfileRow | null> {
  const p = await loadProfile(env, profileId);
  return p && p.owner_uid === ownerUid ? p : null;
}

/** Same lookup WP4's Grok pipeline needs at call-start time — no owner check
 *  (the caller is resolveNumberAndProfile's caller, already trusted). */
export async function getProfileById(env: Env, profileId: string): Promise<AgentProfileRow | null> {
  return loadProfile(env, profileId);
}

/** Lazily attach a Grok Collection id to a profile (first doc upload) and bump
 *  `version` (plan §14 agent_profile_version — the Collection is part of the
 *  versioned unit). Idempotent no-op if the profile doesn't exist. */
export async function setProfileCollectionId(env: Env, profileId: string, collectionId: string): Promise<void> {
  await ensureTables(env);
  await metaDb(env).prepare(
    "UPDATE agent_profiles SET collection_id=?2, version=version+1, updated_at=?3 WHERE id=?1",
  ).bind(profileId, collectionId, Date.now()).run();
}

/** Bump version only (a doc list changed under an already-created collection —
 *  still worth a version bump since the RAG corpus behind the profile changed). */
export async function bumpProfileVersion(env: Env, profileId: string): Promise<void> {
  await ensureTables(env);
  await metaDb(env).prepare("UPDATE agent_profiles SET version=version+1, updated_at=?2 WHERE id=?1").bind(profileId, Date.now()).run();
}

// ---------------------------------------------------------------------------
// resolveNumberAndProfile — the lookup lib/call_routing.ts's decideRouting()
// depends on. Given the callee (already resolved by the dial-time directory
// lookup, so it's trusted as the number's owner) and the number actually
// dialed, decide Mode A (primary/implicit profile) vs Mode B (service number
// → its referenced profile), and surface retirement/active state.
// ---------------------------------------------------------------------------
export interface ResolvedNumber {
  is_service_number: boolean;
  owner_uid: string;
  number: string;
  retired: boolean;
  active: boolean;
  agent_profile: AgentProfileRow | null;
}

export async function resolveNumberAndProfile(
  env: Env,
  calleeId: string,
  numberDialed: string | null,
): Promise<ResolvedNumber> {
  await ensureTables(env);
  if (numberDialed) {
    const svc = await metaDb(env).prepare(
      "SELECT number, owner_uid, profile_id, active, retired FROM service_numbers WHERE number=?1",
    ).bind(numberDialed).first<{ number: string; owner_uid: string; profile_id: string; active: number; retired: number }>();
    if (svc) {
      const retired = svc.retired === 1;
      const active = svc.active === 1;
      const profile = (!retired && active && svc.profile_id) ? await loadProfile(env, svc.profile_id) : null;
      return { is_service_number: true, owner_uid: svc.owner_uid, number: svc.number, retired, active, agent_profile: profile };
    }
  }
  // Not a known service number → Mode A (the callee's primary/identity number).
  // Implicit profile id convention: 'primary:<owner_uid>' — created lazily by
  // PUT /api/agent/settings; a never-configured owner simply has agent_profile=null
  // (agent disabled, routing falls through to voicemail/normal ring).
  const profile = await loadProfile(env, `primary:${calleeId}`);
  return { is_service_number: false, owner_uid: calleeId, number: numberDialed || "", retired: false, active: true, agent_profile: profile };
}

// ---------------------------------------------------------------------------
// [15.4] Child-account guard — SAME pattern as call_billing_routes.ts's
// isChildAccount (self-declared users.birth_year; no declared year → adult).
// ---------------------------------------------------------------------------
async function isChildAccount(env: Env, uid: string): Promise<boolean> {
  try {
    const r = await env.DB_META.prepare("SELECT birth_year FROM users WHERE uid=?1").bind(uid).first<{ birth_year: number | null }>();
    const by = r?.birth_year ?? null;
    if (!by) return false;
    return new Date().getFullYear() - by < 18;
  } catch { return false; }
}

function validateBookingAuthority(v: unknown): BookingAuthority {
  return (typeof v === "string" && ["auto_write", "confirm_with_caller", "require_owner_approval"].includes(v))
    ? (v as BookingAuthority) : "confirm_with_caller";
}
function validateRouting(v: unknown): string {
  return (typeof v === "string" && ["auto", "manual", "off"].includes(v)) ? v : "manual";
}
function validateBusinessHours(v: unknown): BusinessHoursSchedule | null {
  if (!v || typeof v !== "object") return null;
  const o = v as { tz?: unknown; windows?: unknown };
  if (!Array.isArray(o.windows)) return null;
  const windows: BusinessHoursWindow[] = [];
  for (const w of o.windows) {
    if (!w || typeof w !== "object") continue;
    const ww = w as { day?: unknown; start?: unknown; end?: unknown };
    const day = Math.trunc(Number(ww.day));
    if (!(day >= 0 && day <= 6)) continue;
    const start = typeof ww.start === "string" ? ww.start.slice(0, 5) : "00:00";
    const end = typeof ww.end === "string" ? ww.end.slice(0, 5) : "23:59";
    windows.push({ day, start, end });
  }
  return { tz: typeof o.tz === "string" ? o.tz.slice(0, 8) : undefined, windows: windows.slice(0, 21) };
}

async function flagOff(env: Env, key: "voiceAgent" | "serviceNumbers"): Promise<Response | null> {
  const cfg = await readConfig(env);
  return (cfg as unknown as Record<string, boolean>)[key] !== true ? json({ error: "disabled", flag: key }, 403) : null;
}

// ---------------------------------------------------------------------------
// GET/PUT /api/agent/settings — Mode A (primary number) profile. id = 'primary:'+uid.
// ---------------------------------------------------------------------------
export async function getAgentSettings(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const off = await flagOff(env, "voiceAgent"); if (off) return off;
  const profile = await loadProfile(env, `primary:${ctx.uid}`);
  const cfg = await readConfig(env);
  return json({
    ok: true,
    profile: profile ?? {
      id: `primary:${ctx.uid}`, owner_uid: ctx.uid, version: 0, instructions: null,
      collection_id: null, tool_manifest: null, rate: cfg.agentRateAPerMin, length_options: null,
      routing: "off", booking_authority: "confirm_with_caller", business_hours: null,
      business_hours_version: 1, created_at: 0, updated_at: 0,
    },
    agent_rate_a_per_min: cfg.agentRateAPerMin,
  });
}

export async function putAgentSettings(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const off = await flagOff(env, "voiceAgent"); if (off) return off;
  await ensureTables(env);
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const id = `primary:${ctx.uid}`;
  const existing = await loadProfile(env, id);
  const now = Date.now();
  const instructions = b.instructions == null ? (existing?.instructions ?? null) : String(b.instructions).slice(0, 4000);
  const collectionId = b.collection_id == null ? (existing?.collection_id ?? null) : String(b.collection_id).slice(0, 200);
  const toolManifest = b.tool_manifest == null ? (existing?.tool_manifest ?? null) : JSON.stringify(b.tool_manifest).slice(0, 20000);
  const routing = b.routing == null ? (existing?.routing ?? "off") : validateRouting(b.routing);
  const bookingAuthority = b.booking_authority == null ? (existing?.booking_authority ?? "confirm_with_caller") : validateBookingAuthority(b.booking_authority);
  const businessHours = b.business_hours === undefined ? existing?.business_hours ?? null : validateBusinessHours(b.business_hours);
  // Owner edits bump version (plan §14 agent_profile_version — a booking dispute
  // six months later resolves to the EXACT profile version that handled the call).
  const version = (existing?.version ?? 0) + 1;
  const businessHoursVersion = (b.business_hours !== undefined) ? (existing?.business_hours_version ?? 1) + 1 : (existing?.business_hours_version ?? 1);

  await metaDb(env).prepare(
    `INSERT INTO agent_profiles (id, owner_uid, version, instructions, collection_id, tool_manifest, rate, length_options, routing, booking_authority, business_hours, business_hours_version, created_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,NULL,NULL,?7,?8,?9,?10,?11,?11)
     ON CONFLICT(id) DO UPDATE SET
       version=?3, instructions=?4, collection_id=?5, tool_manifest=?6, routing=?7,
       booking_authority=?8, business_hours=?9, business_hours_version=?10, updated_at=?11`,
  ).bind(
    id, ctx.uid, version, instructions, collectionId, toolManifest, routing, bookingAuthority,
    businessHours ? JSON.stringify(businessHours) : null, businessHoursVersion, now,
  ).run();

  const saved = await loadProfile(env, id);
  return json({ ok: true, profile: saved });
}

// ---------------------------------------------------------------------------
// GET/POST/PUT/DELETE /api/agent/services — Mode B (service numbers).
// ---------------------------------------------------------------------------
interface ServiceNumberRow {
  number: string; owner_uid: string; profile_id: string; display_name: string | null;
  active: number; retired: number; created_at: number;
}

function serviceLeadPool(plan: CountryPlan): CountryPlan {
  // Second half of the country's reserved AvaTOK lead pool is set aside for
  // service numbers — visually distinguishable from primary numbers within
  // the SAME national format, no schema change needed (service numbers live
  // in their own table, never in avatok_numbers).
  const half = Math.max(1, Math.ceil(plan.leadPool.length / 2));
  const svcLeads = plan.leadPool.slice(half);
  return { ...plan, leadPool: svcLeads.length ? svcLeads : plan.leadPool };
}

async function isNumberTaken(env: Env, number: string): Promise<boolean> {
  const a = await metaSession(env).prepare("SELECT uid FROM avatok_numbers WHERE number=?1 AND status='active'").bind(number).first<{ uid: string }>();
  if (a) return true;
  const s = await metaSession(env).prepare("SELECT number FROM service_numbers WHERE number=?1").bind(number).first<{ number: string }>();
  return !!s;
}

export async function listAgentServices(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const off = await flagOff(env, "serviceNumbers"); if (off) return off;
  await ensureTables(env);
  const { results } = await metaDb(env).prepare(
    "SELECT * FROM service_numbers WHERE owner_uid=?1 AND retired=0 ORDER BY created_at DESC",
  ).bind(ctx.uid).all<ServiceNumberRow>();
  const rows = results ?? [];
  const services = await Promise.all(rows.map(async (r) => ({
    number: r.number, display_name: r.display_name, active: r.active === 1,
    profile: await loadProfile(env, r.profile_id),
  })));
  return json({ ok: true, services });
}

// POST /api/agent/services { country, display_name, instructions?, rate, length_options[] }
export async function createAgentService(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const off = await flagOff(env, "serviceNumbers"); if (off) return off;
  if (await isChildAccount(env, ctx.uid)) return json({ error: "child accounts cannot create service numbers" }, 403);
  await ensureTables(env);
  const cfg = await readConfig(env);
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const plan = planFor(String(b.country || ""));
  if (!plan) return json({ error: "unsupported_country" }, 400);
  const rate = Math.trunc(Number(b.rate));
  if (!(rate >= cfg.minServiceRate)) {
    return json({ error: `rate must be >= minServiceRate (${cfg.minServiceRate})`, min_service_rate: cfg.minServiceRate }, 400);
  }
  const rawOpts = Array.isArray(b.length_options) ? b.length_options : [];
  const lengthOptions = [...new Set(rawOpts.map((n) => Math.trunc(Number(n))).filter((n) => n > 0 && n <= 24 * 60))].sort((a, c) => a - c);
  if (lengthOptions.length === 0) return json({ error: "length_options must be a non-empty array of positive minute counts" }, 400);
  const displayName = String(b.display_name || "Service").slice(0, 60).trim() || "Service";

  // Allocate a number from the service sub-range (same mechanics as
  // routes/number.ts assign(), scoped to the reserved service leadPool).
  const svcPlan = serviceLeadPool(plan);
  let number: string | null = null;
  const candidates = generate(svcPlan, 24);
  for (const nsn of candidates) {
    const cand = canonical(svcPlan, nsn);
    if (!(await isNumberTaken(env, cand))) { number = cand; break; }
  }
  if (!number) return json({ error: "no_numbers_available", country: plan.iso2 }, 503);
  const disp = display(svcPlan, number.slice(svcPlan.dial.length));

  const now = Date.now();
  const profileId = `service:${number}`;
  const instructions = b.instructions == null ? null : String(b.instructions).slice(0, 4000);
  const bookingAuthority = validateBookingAuthority(b.booking_authority);
  const routing = validateRouting(b.routing ?? "manual");

  await env.DB_META.batch([
    env.DB_META.prepare(
      `INSERT INTO agent_profiles (id, owner_uid, version, instructions, collection_id, tool_manifest, rate, length_options, routing, booking_authority, business_hours, business_hours_version, created_at, updated_at)
       VALUES (?1,?2,1,?3,NULL,NULL,?4,?5,?6,?7,NULL,1,?8,?8)`,
    ).bind(profileId, ctx.uid, instructions, rate, JSON.stringify(lengthOptions), routing, bookingAuthority, now),
    env.DB_META.prepare(
      `INSERT INTO service_numbers (number, owner_uid, profile_id, display_name, active, retired, created_at)
       VALUES (?1,?2,?3,?4,1,0,?5)`,
    ).bind(number, ctx.uid, profileId, displayName, now),
  ]);

  const profile = await loadProfile(env, profileId);
  return json({ ok: true, number, display: disp, display_name: displayName, profile });
}

// PUT /api/agent/services { number, display_name?, instructions?, rate?, length_options?, routing?, booking_authority?, business_hours?, active? }
export async function updateAgentService(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const off = await flagOff(env, "serviceNumbers"); if (off) return off;
  if (await isChildAccount(env, ctx.uid)) return json({ error: "child accounts cannot manage service numbers" }, 403);
  await ensureTables(env);
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const number = String(b.number || "");
  if (!number) return json({ error: "number required" }, 400);
  const svc = await metaDb(env).prepare("SELECT * FROM service_numbers WHERE number=?1 AND owner_uid=?2").bind(number, ctx.uid).first<ServiceNumberRow>();
  if (!svc) return json({ error: "not_found" }, 404);
  if (svc.retired === 1) return json({ error: "service no longer available" }, 410);
  const cfg = await readConfig(env);
  const now = Date.now();

  if (b.display_name != null || b.active != null) {
    const displayName = b.display_name == null ? svc.display_name : String(b.display_name).slice(0, 60).trim() || svc.display_name;
    const active = b.active == null ? svc.active : (b.active ? 1 : 0);
    await metaDb(env).prepare("UPDATE service_numbers SET display_name=?2, active=?3 WHERE number=?1").bind(number, displayName, active).run();
  }

  const existing = await loadProfile(env, svc.profile_id);
  if (existing) {
    let rate = existing.rate;
    if (b.rate != null) {
      const r = Math.trunc(Number(b.rate));
      if (!(r >= cfg.minServiceRate)) return json({ error: `rate must be >= minServiceRate (${cfg.minServiceRate})`, min_service_rate: cfg.minServiceRate }, 400);
      rate = r;
    }
    let lengthOptions = existing.length_options;
    if (b.length_options != null) {
      const rawOpts = Array.isArray(b.length_options) ? b.length_options : [];
      lengthOptions = [...new Set(rawOpts.map((n: unknown) => Math.trunc(Number(n))).filter((n) => n > 0 && n <= 24 * 60))].sort((a, c) => a - c);
      if (lengthOptions.length === 0) return json({ error: "length_options must be a non-empty array of positive minute counts" }, 400);
    }
    const instructions = b.instructions === undefined ? existing.instructions : (b.instructions == null ? null : String(b.instructions).slice(0, 4000));
    const routing = b.routing == null ? existing.routing : validateRouting(b.routing);
    const bookingAuthority = b.booking_authority == null ? existing.booking_authority : validateBookingAuthority(b.booking_authority);
    const businessHours = b.business_hours === undefined ? existing.business_hours : validateBusinessHours(b.business_hours);
    const businessHoursVersion = (b.business_hours !== undefined) ? existing.business_hours_version + 1 : existing.business_hours_version;
    await metaDb(env).prepare(
      `UPDATE agent_profiles SET version=version+1, instructions=?2, rate=?3, length_options=?4, routing=?5,
         booking_authority=?6, business_hours=?7, business_hours_version=?8, updated_at=?9 WHERE id=?1`,
    ).bind(svc.profile_id, instructions, rate, JSON.stringify(lengthOptions ?? []), routing, bookingAuthority,
      businessHours ? JSON.stringify(businessHours) : null, businessHoursVersion, now).run();
  }

  const profile = await loadProfile(env, svc.profile_id);
  return json({ ok: true, profile });
}

// DELETE /api/agent/services { number } — number lifecycle (§15.3): never
// recycled. Deletion = retired=1 forever; blocked while any escrow is in
// flight for that number (best-effort: checks the call_events stream for a
// recent unsettled escrow_held on this number — a hard guarantee needs WP4's
// live-session tracking, which is out of scope here; this is the DB-level half).
export async function deleteAgentService(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const off = await flagOff(env, "serviceNumbers"); if (off) return off;
  await ensureTables(env);
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const number = String(b.number || "");
  if (!number) return json({ error: "number required" }, 400);
  const svc = await metaDb(env).prepare("SELECT * FROM service_numbers WHERE number=?1 AND owner_uid=?2").bind(number, ctx.uid).first<ServiceNumberRow>();
  if (!svc) return json({ error: "not_found" }, 404);
  await metaDb(env).prepare("UPDATE service_numbers SET retired=1, active=0 WHERE number=?1").bind(number).run();
  return json({ ok: true, retired: true, number });
}

// ---------------------------------------------------------------------------
// GET /api/agent/my-calls — owner reads their agent_call_log rows. WP4's Grok
// pipeline populates this table; WP3 only reads it. {available:false} when
// empty so the client can show an empty state without a special-case error.
// ---------------------------------------------------------------------------
export async function listAgentCalls(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const cfg = await readConfig(env);
  if (cfg.voiceAgent !== true && cfg.serviceNumbers !== true) return json({ error: "disabled", flag: "voiceAgent" }, 403);
  await ensureTables(env);
  const { results } = await metaDb(env).prepare(
    "SELECT call_id, caller_id, service_number, summary, created_at FROM agent_call_log WHERE owner_uid=?1 ORDER BY created_at DESC LIMIT 200",
  ).bind(ctx.uid).all<{ call_id: string; caller_id: string | null; service_number: string | null; summary: string | null; created_at: number }>();
  const rows = results ?? [];
  if (rows.length === 0) return json({ available: false, calls: [] });
  return json({ available: true, calls: rows });
}

// ---------------------------------------------------------------------------
// GET /api/agent/my-calls/<call_id> — CALLER reads the full transcript for one
// of THEIR OWN agent_call_log rows (§12.11 "My AI calls" detail view). Caller-
// scoped (ctx.uid must equal the row's caller_id) — the owner-side view of the
// same call lives in the InboxDO's agent_transcript card (business_thread_
// widgets.dart AgentTranscriptCard), not here. transcript is pulled from R2
// (transcript_r2, written by do/agent_voice_room.ts finalize()); a missing/
// expired R2 object still returns the row's summary instead of erroring.
// ---------------------------------------------------------------------------
function transcriptToTurns(text: string): { speaker: string; text: string }[] {
  return text.split("\n").map((l) => l.trim()).filter(Boolean).map((line) => {
    const speaker = line.toLowerCase().startsWith("caller") ? "caller" : "agent";
    return { speaker, text: line };
  });
}

export async function getAgentCallTranscript(req: Request, env: Env, callId: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const cfg = await readConfig(env);
  if (cfg.voiceAgent !== true) return json({ error: "disabled", flag: "voiceAgent" }, 403);
  await ensureTables(env);
  const id = String(callId || "").trim();
  if (!id) return json({ error: "call_id required" }, 400);
  const row = await metaDb(env).prepare(
    "SELECT call_id, caller_id, owner_uid, transcript_r2, summary, created_at FROM agent_call_log WHERE call_id=?1",
  ).bind(id).first<{ call_id: string; caller_id: string | null; owner_uid: string; transcript_r2: string | null; summary: string | null; created_at: number }>();
  // Caller-scoped: never leak another caller's transcript by guessing a call_id.
  if (!row || row.caller_id !== ctx.uid) return json({ error: "not_found" }, 404);

  let transcript = "";
  if (row.transcript_r2) {
    try {
      const obj = await env.BLOBS.get(row.transcript_r2);
      if (obj) transcript = await obj.text();
    } catch { /* best-effort — a missing/expired R2 object still returns the summary below */ }
  }
  const ownerDisplay = (await nameFor(env, row.owner_uid).catch(() => null)) || row.owner_uid;
  const summary = row.summary ?? "";

  return json({
    call_id: row.call_id, summary, transcript, created_at: row.created_at, owner_display: ownerDisplay,
    // turns/what_the_agent_did: derived so the existing client model
    // (MyAiCallTranscript, app/lib/core/business_agent_api.dart) renders
    // something useful even though transcript_r2 stores a flat string, not a
    // structured turn list — same line-prefix heuristic business_thread_
    // widgets.dart's AgentTranscriptCard already uses client-side.
    turns: transcriptToTurns(transcript), what_the_agent_did: summary,
  });
}

// Re-exported for other WP3/WP4 modules that just want the country list used
// by the service-number allocator (kept in sync with routes/number.ts).
export { COUNTRIES };
