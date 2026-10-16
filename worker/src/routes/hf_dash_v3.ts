// [HF-DASH-V3-1] The new customer dashboard's own reads and writes. Signed-in person only; never a phone number or another person's uid.
//   GET    /api/hf/me/insights          -> { ok, talkDaily:[{day,seconds,paise,calls}] (14 IST days, oldest first), month:{calls,seconds,paise,missed},
//                                            lastMonth:{calls,seconds,paise}, topFraands:[{slug,name,seconds}] (last 30 days, top 5), talkedTo,
//                                            streakDays, pendingReviews:[{callId,hostName,hostSlug,at,seconds}], blockedCount }
//   GET    /api/hf/me/profile           -> { ok, firstName, lastName, username, displayName, city, languages[], talkAbout, joinedAt }
//   PUT    /api/hf/me/profile           { firstName?, lastName?, city?, languages?, talkAbout? } -> same as GET
//   GET    /api/hf/me/prefs             -> { ok, notifyWhatsapp, apptReminders }
//   PUT    /api/hf/me/prefs             { notifyWhatsapp?, apptReminders? } -> same   (notifyWhatsapp false pauses every "Notify me" WhatsApp;
//                                         apptReminders false stops the 1 h / 10 min appointment reminders, HF-APPT-REMIND-1)
//   POST   /api/hf/calls/:id/block      { reason } -> { ok }   the other person of one of your calls; also files an incident for the team
//   GET    /api/hf/blocks               -> { ok, items:[{key,name,slug,at}] }
//   DELETE /api/hf/blocks/:key          -> { ok }
//   GET    /api/hf/support/tickets      -> { ok, items:[{id,topic,status,createdAt}] }
//   POST   /api/hf/support/tickets      { topic, message } -> { ok, id }   stored + emailed to the support inbox
import type { Env } from "../types";
import { json, sha256Hex } from "../util";
import { requireUser, isFail } from "../authz";
import { rateLimit } from "../money";
import { track, trackException } from "../hooks";
import { BRAND } from "../lib/brand";
import { contactLeak } from "../lib/hf_options";
import { callerHandle } from "../lib/hf_call_math";
import { REVIEW_WINDOW_MS } from "../lib/hf_reviews_pure";
import { enqueueEmail } from "../lib/email_outbox";

const APP = BRAND.slug;
const DAY_MS = 86_400_000;
const IST_MS = 19_800_000;
const NO_STORE = { "cache-control": "private, no-store" };
const err = (status: number, error: string, message?: string, extra: Record<string, unknown> = {}) => json({ error, message: message ?? error, ...extra }, status);

export const DASH_LANGUAGES = ["Hindi", "English", "Bengali", "Marathi", "Telugu", "Tamil", "Gujarati", "Urdu", "Kannada", "Odia", "Malayalam", "Punjabi", "Assamese", "Garhwali", "Kumaoni", "Bhojpuri", "Konkani", "Hinglish"];
export const BLOCK_REASONS = ["rude", "money_or_otp", "inappropriate", "other"] as const;
export const TICKET_TOPICS = ["wallet", "call", "appointment", "safety", "account", "other"] as const;

/** IST calendar day number (days since epoch) for an epoch-ms instant. */
export const istDay = (ms: number): number => Math.floor((ms + IST_MS) / DAY_MS);
/** Start (epoch ms) of the IST month that contains `ms`, shifted by `offset` months. */
export function istMonthStart(ms: number, offset = 0): number {
  const d = new Date(ms + IST_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1) - IST_MS;
}
/** Days in a row with at least one completed call, counting back from today (or from yesterday if today has none yet). */
export function streakFrom(days: number[], today: number): number {
  const set = new Set(days);
  let d = set.has(today) ? today : today - 1;
  let n = 0;
  while (set.has(d)) { n++; d--; }
  return n;
}
export type ProfileInput = { firstName?: string; lastName?: string; city?: string | null; languages?: string[]; talkAbout?: string | null };
export type ProfileCheck = { ok: true; value: ProfileInput } | { ok: false; field: string; message: string };
const clean = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim();
/** Validates the editable profile fields. Names: 1-30 letters; city: up to 40; talkAbout: up to 200, no contact details. */
export function validateProfile(b: Record<string, unknown>): ProfileCheck {
  const out: ProfileInput = {};
  for (const f of ["firstName", "lastName"] as const) {
    if (b[f] === undefined) continue;
    if (typeof b[f] !== "string") return { ok: false, field: f, message: "Please enter your name." };
    const v = clean(b[f] as string);
    if ([...v].length < 1 || [...v].length > 30 || /[\p{Nd}<>@/\\]/u.test(v) || contactLeak(v)) return { ok: false, field: f, message: "Names can have 1 to 30 letters, no numbers or links." };
    out[f] = v;
  }
  if (b.city !== undefined) {
    if (b.city !== null && typeof b.city !== "string") return { ok: false, field: "city", message: "Please enter a city." };
    const v = b.city == null ? "" : clean(b.city as string);
    if ([...v].length > 40 || /[\p{Nd}<>@/\\]/u.test(v)) return { ok: false, field: "city", message: "City can have up to 40 letters." };
    out.city = v || null;
  }
  if (b.languages !== undefined) {
    if (!Array.isArray(b.languages) || b.languages.length > 8) return { ok: false, field: "languages", message: "Choose up to 8 languages." };
    const langs = [...new Set(b.languages.map(String))];
    if (langs.some((l) => !DASH_LANGUAGES.includes(l))) return { ok: false, field: "languages", message: "Please pick languages from the list." };
    out.languages = langs;
  }
  if (b.talkAbout !== undefined) {
    if (b.talkAbout !== null && typeof b.talkAbout !== "string") return { ok: false, field: "talkAbout", message: "Please write a few words." };
    const v = b.talkAbout == null ? "" : clean(b.talkAbout as string);
    if ([...v].length > 200) return { ok: false, field: "talkAbout", message: "Keep it under 200 characters." };
    if (v && (contactLeak(v) || /[<>]/.test(v))) return { ok: false, field: "talkAbout", message: "Please don't share phone numbers, links or handles." };
    out.talkAbout = v || null;
  }
  return { ok: true, value: out };
}

const SECS = "COALESCE(c.billable_seconds, COALESCE(c.billed_minutes,0)*60)";
const PAISE = "COALESCE(c.consumed_value_paise, c.charged_paise, 0)";
const DONE = "c.status='completed' AND (COALESCE(c.billable_seconds,0) > 0 OR COALESCE(c.billed_minutes,0) >= 1)";

async function insights(env: Env, uid: string, now: number): Promise<Response> {
  const db = env.DB_META;
  const today = istDay(now);
  const from14 = (today - 13) * DAY_MS - IST_MS;
  const m0 = istMonthStart(now), m1 = istMonthStart(now, -1);
  const [daily, month, last, top, talked, days, pending, blocked, missed] = await Promise.all([
    db.prepare(`SELECT CAST((COALESCE(c.connected_at,c.created_at)+${IST_MS})/${DAY_MS} AS INTEGER) AS d, SUM(${SECS}) AS s, SUM(${PAISE}) AS p, COUNT(*) AS n
                  FROM hf_calls c WHERE c.caller_uid=?1 AND ${DONE} AND c.created_at>=?2 GROUP BY d`).bind(uid, from14).all<{ d: number; s: number; p: number; n: number }>(),
    db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(${SECS}),0) AS s, COALESCE(SUM(${PAISE}),0) AS p FROM hf_calls c WHERE c.caller_uid=?1 AND ${DONE} AND c.created_at>=?2`).bind(uid, m0).first<{ n: number; s: number; p: number }>(),
    db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(${SECS}),0) AS s, COALESCE(SUM(${PAISE}),0) AS p FROM hf_calls c WHERE c.caller_uid=?1 AND ${DONE} AND c.created_at>=?2 AND c.created_at<?3`).bind(uid, m1, m0).first<{ n: number; s: number; p: number }>(),
    db.prepare(`SELECT h.slug AS slug, h.display_name AS name, SUM(${SECS}) AS s FROM hf_calls c JOIN hf_hosts h ON h.uid=c.host_uid
                 WHERE c.caller_uid=?1 AND ${DONE} AND c.created_at>=?2 GROUP BY c.host_uid ORDER BY s DESC LIMIT 5`).bind(uid, now - 30 * DAY_MS).all<{ slug: string | null; name: string | null; s: number }>(),
    db.prepare(`SELECT COUNT(DISTINCT c.host_uid) AS n FROM hf_calls c WHERE c.caller_uid=?1 AND ${DONE}`).bind(uid).first<{ n: number }>(),
    db.prepare(`SELECT DISTINCT CAST((COALESCE(c.connected_at,c.created_at)+${IST_MS})/${DAY_MS} AS INTEGER) AS d FROM hf_calls c WHERE c.caller_uid=?1 AND ${DONE} AND c.created_at>=?2`).bind(uid, now - 120 * DAY_MS).all<{ d: number }>(),
    db.prepare(`SELECT c.id AS id, h.slug AS slug, h.display_name AS name, COALESCE(c.connected_at,c.created_at) AS at, ${SECS} AS s FROM hf_calls c JOIN hf_hosts h ON h.uid=c.host_uid
                 WHERE c.caller_uid=?1 AND ${DONE} AND COALESCE(c.ended_at,c.created_at)>=?2
                   AND NOT EXISTS (SELECT 1 FROM hf_reviews r WHERE r.call_id=c.id) ORDER BY c.created_at DESC LIMIT 20`).bind(uid, now - REVIEW_WINDOW_MS).all<{ id: string; slug: string | null; name: string | null; at: number; s: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM hf_blocks WHERE blocker_uid=?1").bind(uid).first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM hf_calls c WHERE c.caller_uid=?1 AND c.status NOT IN ('completed','connected','ringing_host','ringing_caller','finalizing') AND c.created_at>=?2").bind(uid, m0).first<{ n: number }>(),
  ]);
  const byDay = new Map((daily.results ?? []).map((r) => [Number(r.d), r]));
  const talkDaily = Array.from({ length: 14 }, (_, i) => {
    const d = today - 13 + i, r = byDay.get(d);
    return { day: new Date(d * DAY_MS).toISOString().slice(0, 10), seconds: Math.trunc(Number(r?.s ?? 0)), paise: Math.trunc(Number(r?.p ?? 0)), calls: Number(r?.n ?? 0) };
  });
  const sum = (r: { n: number; s: number; p: number } | null) => ({ calls: Number(r?.n ?? 0), seconds: Math.trunc(Number(r?.s ?? 0)), paise: Math.trunc(Number(r?.p ?? 0)) });
  return json({
    ok: true, talkDaily, month: { ...sum(month), missed: Number(missed?.n ?? 0) }, lastMonth: sum(last),
    topFraands: (top.results ?? []).map((r) => ({ slug: r.slug, name: (r.name ?? "").trim() || "Influencer", seconds: Math.trunc(Number(r.s ?? 0)) })),
    talkedTo: Number(talked?.n ?? 0),
    streakDays: streakFrom((days.results ?? []).map((r) => Number(r.d)), today),
    pendingReviews: (pending.results ?? []).map((r) => ({ callId: r.id, hostName: (r.name ?? "").trim() || "Influencer", hostSlug: r.slug, at: Number(r.at), seconds: Math.trunc(Number(r.s ?? 0)) })),
    blockedCount: Number(blocked?.n ?? 0),
  }, 200, NO_STORE);
}

type RegRow = { first_name: string; last_name: string; username: string; created_at: number };
type ProfRow = { city: string | null; languages_json: string; talk_about: string | null };
async function readProfile(env: Env, uid: string) {
  const [reg, prof, user] = await Promise.all([
    env.DB_META.prepare("SELECT first_name, last_name, username, created_at FROM hf_user_registration WHERE uid=?1").bind(uid).first<RegRow>().catch(() => null),
    env.DB_META.prepare("SELECT city, languages_json, talk_about FROM hf_user_profile WHERE uid=?1").bind(uid).first<ProfRow>().catch(() => null),
    env.DB_META.prepare("SELECT display_name, created_at FROM users WHERE uid=?1").bind(uid).first<{ display_name: string | null; created_at: number | null }>().catch(() => null),
  ]);
  let languages: string[] = [];
  try { const a = JSON.parse(prof?.languages_json ?? "[]"); if (Array.isArray(a)) languages = a.map(String); } catch { /* keep [] */ }
  return {
    ok: true, firstName: reg?.first_name ?? null, lastName: reg?.last_name ?? null, username: reg?.username ?? null,
    displayName: user?.display_name?.trim() ? user.display_name : null,
    city: prof?.city ?? null, languages, talkAbout: prof?.talk_about ?? null,
    joinedAt: Number(reg?.created_at ?? user?.created_at ?? 0) || null,
  };
}
async function putProfile(req: Request, env: Env, uid: string): Promise<Response> {
  const lim = await rateLimit(env, `hfprof:${uid}`, 30, 3600);
  if (lim) return lim;
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return err(400, "invalid_body", "Please send your profile.");
  const v = validateProfile(b);
  if (!v.ok) return err(400, "invalid_field", v.message, { field: v.field });
  const now = Date.now(), p = v.value;
  if (p.firstName !== undefined || p.lastName !== undefined) {
    const r = await env.DB_META.prepare("UPDATE hf_user_registration SET first_name=COALESCE(?2,first_name), last_name=COALESCE(?3,last_name) WHERE uid=?1")
      .bind(uid, p.firstName ?? null, p.lastName ?? null).run();
    if (!Number(r.meta?.changes ?? 0)) return err(409, "not_registered", "Please finish signing up first.");
  }
  if (p.city !== undefined || p.languages !== undefined || p.talkAbout !== undefined) {
    const cur = await readProfile(env, uid);
    await env.DB_META.prepare(
      `INSERT INTO hf_user_profile (uid, city, languages_json, talk_about, updated_at) VALUES (?1,?2,?3,?4,?5)
       ON CONFLICT(uid) DO UPDATE SET city=excluded.city, languages_json=excluded.languages_json, talk_about=excluded.talk_about, updated_at=excluded.updated_at`,
    ).bind(uid, p.city !== undefined ? p.city : cur.city, JSON.stringify(p.languages ?? cur.languages), p.talkAbout !== undefined ? p.talkAbout : cur.talkAbout, now).run();
  }
  void track(env, uid, "hf_dash_profile_saved", APP, { fields: Object.keys(p).join(",") });
  return json(await readProfile(env, uid), 200, NO_STORE);
}

async function prefs(req: Request, env: Env, uid: string): Promise<Response> {
  if (req.method === "PUT") {
    const b = (await req.json().catch(() => null)) as { notifyWhatsapp?: unknown; apptReminders?: unknown } | null;
    const nw = b?.notifyWhatsapp, ar = b?.apptReminders;
    if (!b || (nw === undefined && ar === undefined) || (nw !== undefined && typeof nw !== "boolean") || (ar !== undefined && typeof ar !== "boolean"))
      return err(400, "invalid_field", "notifyWhatsapp and apptReminders must be true or false.");
    const cur = await readPrefs(env, uid);
    const next = { notifyWhatsapp: typeof nw === "boolean" ? nw : cur.notifyWhatsapp, apptReminders: typeof ar === "boolean" ? ar : cur.apptReminders };
    await env.DB_META.prepare(
      `INSERT INTO hf_user_prefs (uid, notify_whatsapp, appt_reminders, updated_at) VALUES (?1,?2,?3,?4)
       ON CONFLICT(uid) DO UPDATE SET notify_whatsapp=excluded.notify_whatsapp, appt_reminders=excluded.appt_reminders, updated_at=excluded.updated_at`,
    ).bind(uid, next.notifyWhatsapp ? 1 : 0, next.apptReminders ? 1 : 0, Date.now()).run();
    void track(env, uid, "hf_dash_prefs_saved", APP, { notify_whatsapp: next.notifyWhatsapp, appt_reminders: next.apptReminders });
    return json({ ok: true, ...next }, 200, NO_STORE);
  }
  return json({ ok: true, ...(await readPrefs(env, uid)) }, 200, NO_STORE);
}
async function readPrefs(env: Env, uid: string): Promise<{ notifyWhatsapp: boolean; apptReminders: boolean }> {
  const r = await env.DB_META.prepare("SELECT notify_whatsapp, appt_reminders FROM hf_user_prefs WHERE uid=?1").bind(uid).first<{ notify_whatsapp: number; appt_reminders: number | null }>().catch(() => null);
  return { notifyWhatsapp: r ? Number(r.notify_whatsapp) === 1 : true, apptReminders: r ? Number(r.appt_reminders ?? 1) !== 0 : true };
}
/** [HF-DASH-V3-1] The caller's "Notify me on WhatsApp" switch. Default on; a missing table or row counts as on. */
export async function notifyWhatsappOn(env: Env, uid: string): Promise<boolean> {
  const r = await env.DB_META.prepare("SELECT notify_whatsapp FROM hf_user_prefs WHERE uid=?1").bind(uid).first<{ notify_whatsapp: number }>().catch(() => null);
  return r ? Number(r.notify_whatsapp) === 1 : true;
}

async function blockFromCall(req: Request, env: Env, uid: string, callId: string): Promise<Response> {
  const lim = await rateLimit(env, `hfblock:${uid}`, 20, 3600);
  if (lim) return lim;
  const b = (await req.json().catch(() => ({}))) as { reason?: unknown };
  const reason = typeof b.reason === "string" && (BLOCK_REASONS as readonly string[]).includes(b.reason) ? b.reason : "other";
  const c = await env.DB_META.prepare("SELECT caller_uid, host_uid FROM hf_calls WHERE id=?1").bind(callId).first<{ caller_uid: string; host_uid: string }>();
  if (!c || (c.caller_uid !== uid && c.host_uid !== uid)) return err(404, "not_found", "Call not found.");
  const other = c.caller_uid === uid ? c.host_uid : c.caller_uid;
  const now = Date.now();
  await env.DB_META.batch([
    env.DB_META.prepare("INSERT OR REPLACE INTO hf_blocks (blocker_uid, blocked_uid, call_id, created_at) VALUES (?1,?2,?3,?4)").bind(uid, other, callId, now),
    env.DB_META.prepare("INSERT INTO hf_incidents (id, call_id, reporter_uid, kind, created_at) VALUES (?1,?2,?3,?4,?5)").bind(crypto.randomUUID(), callId, uid, `dash_report:${reason}`, now),
    env.DB_META.prepare("DELETE FROM hf_notify WHERE caller_uid=?1 AND host_uid=?2").bind(uid, other),
  ]);
  void track(env, uid, "hf_dash_block", APP, { reason, call_id: callId });
  return json({ ok: true }, 200, NO_STORE);
}
const blockKey = async (blocker: string, blocked: string) => (await sha256Hex(`hfblk:${blocker}:${blocked}`)).toLowerCase().slice(0, 20);
async function listBlocks(env: Env, uid: string) {
  const rows = (await env.DB_META.prepare(
    `SELECT b.blocked_uid AS blocked, b.created_at AS at, h.slug AS slug, h.display_name AS host_name, u.display_name AS user_name
       FROM hf_blocks b LEFT JOIN hf_hosts h ON h.uid=b.blocked_uid LEFT JOIN users u ON u.uid=b.blocked_uid
      WHERE b.blocker_uid=?1 ORDER BY b.created_at DESC LIMIT 200`,
  ).bind(uid).all<{ blocked: string; at: number; slug: string | null; host_name: string | null; user_name: string | null }>()).results ?? [];
  return Promise.all(rows.map(async (r) => ({
    key: await blockKey(uid, r.blocked), blocked: r.blocked,
    name: r.host_name?.trim() || callerHandle(r.user_name), slug: r.slug ?? null, at: Number(r.at),
  })));
}

async function tickets(req: Request, env: Env, uid: string): Promise<Response> {
  if (req.method === "GET") {
    const rows = (await env.DB_META.prepare("SELECT id, topic, status, created_at FROM hf_support_tickets WHERE uid=?1 ORDER BY created_at DESC LIMIT 20").bind(uid)
      .all<{ id: string; topic: string; status: string; created_at: number }>()).results ?? [];
    return json({ ok: true, items: rows.map((r) => ({ id: r.id, topic: r.topic, status: r.status, createdAt: Number(r.created_at) })) }, 200, NO_STORE);
  }
  const lim = await rateLimit(env, `hfticket:${uid}`, 5, 86400);
  if (lim) return lim;
  const b = (await req.json().catch(() => null)) as { topic?: unknown; message?: unknown } | null;
  const topic = typeof b?.topic === "string" && (TICKET_TOPICS as readonly string[]).includes(b.topic) ? b.topic : null;
  if (!topic) return err(400, "invalid_field", "Please pick a topic.", { field: "topic" });
  const message = typeof b?.message === "string" ? b.message.normalize("NFKC").trim() : "";
  if ([...message].length < 10 || [...message].length > 2000) return err(400, "invalid_field", "Please write 10 to 2,000 characters.", { field: "message" });
  const now = Date.now();
  const id = `HF-T-${(await sha256Hex(`${uid}:${now}:${crypto.randomUUID()}`)).slice(0, 8).toUpperCase()}`;
  await env.DB_META.prepare("INSERT INTO hf_support_tickets (id, uid, topic, message, status, created_at, updated_at) VALUES (?1,?2,?3,?4,'open',?5,?5)")
    .bind(id, uid, topic, message, now).run();
  try {
    const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] as string));
    await enqueueEmail(env, {
      to: BRAND.emails.support, subject: `[${id}] Dashboard question: ${topic}`, outboxKey: `hf-ticket:${id}`, kind: "hf_support_ticket", recipientId: uid,
      html: `<p><strong>${id}</strong> · topic: ${esc(topic)} · account ${esc(uid)}</p><pre style="white-space:pre-wrap;font:15px/1.5 system-ui">${esc(message)}</pre>`,
    });
  } catch (e) { await trackException(env, e, { uid, route: "/api/hf/support/tickets", handled: true, app_name: APP, extra: { area: "hf_dash_v3", step: "ticket_email" } }); }
  void track(env, uid, "hf_dash_ticket_created", APP, { topic, ticket_id: id });
  return json({ ok: true, id }, 200, NO_STORE);
}

const CALL_BLOCK_RE = /^\/api\/hf\/calls\/([A-Za-z0-9_-]{4,64})\/block$/;
const BLOCK_KEY_RE = /^\/api\/hf\/blocks\/([a-f0-9]{20})$/;
export function isDashV3Path(p: string): boolean {
  return p === "/api/hf/me/insights" || p === "/api/hf/me/profile" || p === "/api/hf/me/prefs" || p === "/api/hf/blocks"
    || p === "/api/hf/support/tickets" || CALL_BLOCK_RE.test(p) || BLOCK_KEY_RE.test(p);
}

export async function hfDashV3Route(req: Request, env: Env, p: string): Promise<Response | null> {
  if (!isDashV3Path(p)) return null;
  const m = req.method;
  const allowed = (p === "/api/hf/me/insights" && m === "GET") || ((p === "/api/hf/me/profile" || p === "/api/hf/me/prefs") && (m === "GET" || m === "PUT"))
    || (p === "/api/hf/blocks" && m === "GET") || (p === "/api/hf/support/tickets" && (m === "GET" || m === "POST"))
    || (CALL_BLOCK_RE.test(p) && m === "POST") || (BLOCK_KEY_RE.test(p) && m === "DELETE");
  if (!allowed) return err(405, "method_not_allowed");
  let uid: string | undefined;
  try {
    const u = await requireUser(req, env);
    if (isFail(u)) return err(u.status, u.error);
    uid = u.uid;
    if (p === "/api/hf/me/insights") return await insights(env, uid, Date.now());
    if (p === "/api/hf/me/profile") return m === "PUT" ? await putProfile(req, env, uid) : json(await readProfile(env, uid), 200, NO_STORE);
    if (p === "/api/hf/me/prefs") return await prefs(req, env, uid);
    if (p === "/api/hf/support/tickets") return await tickets(req, env, uid);
    if (p === "/api/hf/blocks") return json({ ok: true, items: (await listBlocks(env, uid)).map(({ blocked: _b, ...rest }) => rest) }, 200, NO_STORE);
    const cb = p.match(CALL_BLOCK_RE);
    if (cb) return await blockFromCall(req, env, uid, cb[1]);
    const bk = p.match(BLOCK_KEY_RE);
    if (bk) {
      const hit = (await listBlocks(env, uid)).find((x) => x.key === bk[1]);
      if (!hit) return err(404, "not_found", "Not in your blocked list.");
      await env.DB_META.prepare("DELETE FROM hf_blocks WHERE blocker_uid=?1 AND blocked_uid=?2").bind(uid, hit.blocked).run();
      void track(env, uid, "hf_dash_unblock", APP, {});
      return json({ ok: true }, 200, NO_STORE);
    }
    return null;
  } catch (e) {
    await trackException(env, e, { uid, route: p, method: m, handled: true, app_name: APP, extra: { area: "hf_dash_v3" } });
    return err(500, "internal_error", "Something went wrong. Please try again.");
  }
}
