// [AUMFE-CONSULT-W4-1] Consultant desk API — a signed-in consultant's own profile, availability, rate, bookings,
// customers and earnings. Spec: Specs/SPEC-2026-10-02-REAL-CONSULTANTS-BUILD.md §W4.
// Returns a Response for paths this module owns, null otherwise. NOT ours (lane W2): /desk/bookings/:id/{file,cards,rerun,notes}, /desk/photo/*.
import type { Env } from "../../types";
import { json } from "../../util";
import { requireUser, isFail } from "../../authz";
import { track, trackException } from "../../hooks";
import { BRAND } from "../../lib/brand";
import { metaDb } from "../../db/shard";
import { consultantByUid, toDetail, ratingFor, type ConsultantRow } from "../../lib/consultants/store";
import { priceFor, validRate } from "../../lib/consultants/pricing";
import { istDate, istMidnight, JOIN_EARLY_MS } from "../../lib/consultants/slots";
import { validateAvailability, validateDeskProfile, ageFromDob } from "../../lib/consultants/validate";
import type { BookingStatus, DeskBookingDTO, Discipline, PrepStatus } from "../../lib/consultants/types";

const APP = BRAND.slug;
const PAID: BookingStatus[] = ["confirmed", "in_call", "completed", "no_show_customer", "no_show_consultant"];
const DAY_MS = 86_400_000;

const err = (status: number, error: string) => json({ error }, status);
const inList = (xs: readonly string[]) => xs.map((s) => `'${s}'`).join(",");

async function readJson(req: Request): Promise<unknown> {
  const t = await req.text().catch(() => "");
  if (!t || t.length > 64_000) return {};
  try { return JSON.parse(t); } catch { return {}; }
}

interface BookingRow {
  id: string; ref: string; consultant_id: string; uid: string; discipline: Discipline; slot_start_ms: number; slot_end_ms: number;
  status: BookingStatus; rate_rupees: number; gst_rupees: number; total_rupees: number; fee_rupees: number; payout_rupees: number;
  intake_json: string; questions_json: string; prep_status: PrepStatus; expires_at: number | null; created_at: number;
}

const safe = <T>(s: string | null | undefined, d: T): T => { try { return s ? (JSON.parse(s) as T) : d; } catch { return d; } };

/** Pull name / city / dob / age out of whichever intake shape the customer filled. */
export function customerFromIntake(intakeJson: string, nowMs: number): { name: string | null; city: string | null; age: number | null } {
  const i = safe<Record<string, any>>(intakeJson, {});
  const name = i.birth?.name ?? i.birth_name ?? i.name ?? null;
  const city = i.current_city ?? i.birth?.place ?? null;
  const age = ageFromDob(i.birth?.dob ?? i.dob, nowMs) ?? (typeof i.age === "number" ? i.age : null);
  return { name: typeof name === "string" && name ? name : null, city: typeof city === "string" && city ? city : null, age };
}

async function displayNames(env: Env, uids: string[]): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  const u = [...new Set(uids)];
  for (let i = 0; i < u.length; i += 80) {
    const chunk = u.slice(i, i + 80);
    const rs = await metaDb(env).prepare(`SELECT uid, display_name FROM users WHERE uid IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all<{ uid: string; display_name: string | null }>().catch(() => null);
    for (const r of rs?.results ?? []) if (r.display_name) m.set(r.uid, r.display_name);
  }
  return m;
}

async function toDeskBookings(env: Env, c: ConsultantRow, rows: BookingRow[], nowMs: number): Promise<DeskBookingDTO[]> {
  if (!rows.length) return [];
  const uids = [...new Set(rows.map((r) => r.uid))];
  const repeat = new Set<string>();
  const rs = await metaDb(env).prepare(
    `SELECT uid, COUNT(*) AS n FROM consult_bookings WHERE consultant_id = ? AND status IN (${inList(PAID)}) AND uid IN (${uids.map(() => "?").join(",")}) GROUP BY uid`,
  ).bind(c.id, ...uids).all<{ uid: string; n: number }>();
  for (const r of rs.results ?? []) if (Number(r.n) > 1) repeat.add(r.uid);
  const names = await displayNames(env, uids);
  return rows.map((r) => {
    const cu = customerFromIntake(r.intake_json, nowMs);
    return {
      id: r.id, ref: r.ref, consultant: { slug: c.slug, name: c.name, photo_url: c.photo_url }, discipline: r.discipline,
      slot_start_ms: r.slot_start_ms, slot_end_ms: r.slot_end_ms, status: r.status,
      price: { rate: r.rate_rupees, gst: r.gst_rupees, total: r.total_rupees, fee: r.fee_rupees, payout: r.payout_rupees, gst_rate_pct: 18, fee_rate_pct: 20 },
      questions: safe<string[]>(r.questions_json, []), prep_status: r.prep_status, join_opens_ms: r.slot_start_ms - JOIN_EARLY_MS,
      expires_at: r.expires_at, created_at: r.created_at,
      customer: { uid: r.uid, name: cu.name ?? names.get(r.uid) ?? "Customer", city: cu.city, age: cu.age, repeat: repeat.has(r.uid) },
    };
  });
}

const COLS = "id, ref, consultant_id, uid, discipline, slot_start_ms, slot_end_ms, status, rate_rupees, gst_rupees, total_rupees, fee_rupees, payout_rupees, intake_json, questions_json, prep_status, expires_at, created_at";

async function listAvailability(env: Env, id: string) {
  const [r, e] = await Promise.all([
    metaDb(env).prepare("SELECT weekday, start_hm, end_hm FROM consultant_availability WHERE consultant_id = ? ORDER BY weekday, start_hm").bind(id).all<{ weekday: number; start_hm: string; end_hm: string }>(),
    metaDb(env).prepare("SELECT date, off, start_hm, end_hm FROM consultant_exceptions WHERE consultant_id = ? ORDER BY date, start_hm").bind(id).all<{ date: string; off: number; start_hm: string | null; end_hm: string | null }>(),
  ]);
  return {
    rules: (r.results ?? []).map((x) => ({ weekday: x.weekday, start: x.start_hm, end: x.end_hm })),
    exceptions: (e.results ?? []).map((x) => (x.off ? { date: x.date, off: true } : { date: x.date, off: false, start: x.start_hm, end: x.end_hm })),
  };
}

export async function deskRoutes(req: Request, env: Env, p: string, ctx?: ExecutionContext): Promise<Response | null> {
  const m = /^\/api\/consultants\/desk\/(me|profile|availability|rate|bookings|customers|earnings)$/.exec(p);
  if (!m) return null;
  const route = m[1];
  const method = req.method;
  const allowed: Record<string, string[]> = { me: ["GET"], profile: ["PUT"], availability: ["GET", "PUT"], rate: ["PUT"], bookings: ["GET"], customers: ["GET"], earnings: ["GET"] };
  if (!allowed[route].includes(method)) return err(405, "method_not_allowed");

  const auth = await requireUser(req, env);
  if (isFail(auth)) return err(auth.status, auth.error);
  const uid = auth.uid;

  try {
    const c = await consultantByUid(env, uid);
    if (!c) return err(403, "not_a_consultant");
    const now = Date.now();
    const db = metaDb(env);
    const fire = (event: string, props: Record<string, unknown>) => { const t = track(env, uid, event, APP, props); ctx?.waitUntil(t); };

    if (route === "me") {
      const rating = await ratingFor(env, c.id, false);
      return json({ consultant: toDetail(c, { ...rating, next_free_ms: null }), rate_floor: c.rate_floor, rate_ceil: c.rate_ceil });
    }

    if (route === "profile") {
      const v = validateDeskProfile(await readJson(req));
      if (!v.ok) return err(400, v.error);
      const sets = Object.keys(v.value);
      await db.prepare(`UPDATE consultants SET ${sets.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
        .bind(...sets.map((k) => (v.value as Record<string, unknown>)[k]), now, c.id).run();
      const fresh = (await consultantByUid(env, uid))!;
      const rating = await ratingFor(env, c.id, false);
      return json({ consultant: toDetail(fresh, { ...rating, next_free_ms: null }), rate_floor: fresh.rate_floor, rate_ceil: fresh.rate_ceil });
    }

    if (route === "availability") {
      if (method === "GET") return json({ ...(await listAvailability(env, c.id)), slot_minutes: c.slot_minutes, buffer_minutes: c.buffer_minutes });
      const v = validateAvailability(await readJson(req));
      if (!v.ok) return err(400, v.error);
      const { rules, exceptions, slot_minutes, buffer_minutes } = v.value;
      const stmts = [
        db.prepare("DELETE FROM consultant_availability WHERE consultant_id = ?").bind(c.id),
        db.prepare("DELETE FROM consultant_exceptions WHERE consultant_id = ?").bind(c.id),
        ...rules.map((r) => db.prepare("INSERT OR REPLACE INTO consultant_availability (consultant_id, weekday, start_hm, end_hm) VALUES (?,?,?,?)").bind(c.id, r.weekday, r.start, r.end)),
        ...exceptions.map((e) => db.prepare("INSERT OR REPLACE INTO consultant_exceptions (consultant_id, date, off, start_hm, end_hm) VALUES (?,?,?,?,?)").bind(c.id, e.date, e.off ? 1 : 0, e.off ? null : e.start ?? null, e.off ? null : e.end ?? null)),
        db.prepare("UPDATE consultants SET slot_minutes = ?, buffer_minutes = ?, updated_at = ? WHERE id = ?").bind(slot_minutes, buffer_minutes, now, c.id),
      ];
      await db.batch(stmts);
      fire("consult_desk_availability_saved", { rules: rules.length, exceptions: exceptions.length, slot_minutes, buffer_minutes, ok: true });
      return json({ rules, exceptions, slot_minutes, buffer_minutes });
    }

    if (route === "rate") {
      const body = (await readJson(req)) as Record<string, unknown>;
      if (!validRate(body.rate, c.rate_floor, c.rate_ceil)) return err(400, "rate_out_of_range");
      await db.prepare("UPDATE consultants SET rate_rupees = ?, updated_at = ? WHERE id = ?").bind(body.rate, now, c.id).run();
      fire("consult_desk_rate_saved", { rate: body.rate, ok: true });
      return json({ price: priceFor(body.rate) });
    }

    if (route === "bookings") {
      const scope = new URL(req.url).searchParams.get("scope") || "today";
      if (!["today", "upcoming", "past"].includes(scope)) return err(400, "bad_scope");
      const today = istMidnight(istDate(now));
      let sql: string; let binds: unknown[];
      if (scope === "today") {
        sql = `SELECT ${COLS} FROM consult_bookings WHERE consultant_id = ? AND status IN (${inList(PAID)}) AND slot_start_ms >= ? AND slot_start_ms < ? ORDER BY slot_start_ms ASC LIMIT 100`;
        binds = [c.id, today, today + DAY_MS];
      } else if (scope === "upcoming") {
        sql = `SELECT ${COLS} FROM consult_bookings WHERE consultant_id = ? AND status IN ('confirmed','in_call') AND slot_start_ms >= ? ORDER BY slot_start_ms ASC LIMIT 200`;
        binds = [c.id, today + DAY_MS];
      } else {
        sql = `SELECT ${COLS} FROM consult_bookings WHERE consultant_id = ? AND status IN ('completed','no_show_customer','no_show_consultant') AND slot_start_ms < ? ORDER BY slot_start_ms DESC LIMIT 100`;
        binds = [c.id, today + DAY_MS];
      }
      const rs = await db.prepare(sql).bind(...binds).all<BookingRow>();
      return json({ bookings: await toDeskBookings(env, c, rs.results ?? [], now) });
    }

    if (route === "customers") {
      const rs = await db.prepare(
        `SELECT uid, slot_start_ms, status, intake_json FROM consult_bookings WHERE consultant_id = ? AND status IN (${inList(PAID)}) ORDER BY slot_start_ms DESC LIMIT 2000`,
      ).bind(c.id).all<{ uid: string; slot_start_ms: number; status: BookingStatus; intake_json: string }>();
      const by = new Map<string, { uid: string; name: string | null; city: string | null; age: number | null; sessions: number; completed: number; last_session_ms: number }>();
      for (const r of rs.results ?? []) {
        let e = by.get(r.uid);
        if (!e) { // rows are newest-first, so the first one carries the freshest intake
          const cu = customerFromIntake(r.intake_json, now);
          e = { uid: r.uid, name: cu.name, city: cu.city, age: cu.age, sessions: 0, completed: 0, last_session_ms: r.slot_start_ms };
          by.set(r.uid, e);
        }
        e.sessions++;
        if (r.status === "completed") e.completed++;
      }
      const names = await displayNames(env, [...by.keys()]);
      const customers = [...by.values()].map((e) => ({ ...e, name: e.name ?? names.get(e.uid) ?? "Customer", repeat: e.sessions > 1 }));
      return json({ customers });
    }

    // earnings: this and last IST month, by session start
    const ym = istDate(now).slice(0, 7);
    const [y, mo] = ym.split("-").map(Number);
    const start = (yy: number, mm: number) => istMidnight(`${yy}-${String(mm).padStart(2, "0")}-01`);
    const thisStart = start(y, mo);
    const lastStart = mo === 1 ? start(y - 1, 12) : start(y, mo - 1);
    const nextStart = mo === 12 ? start(y + 1, 1) : start(y, mo + 1);
    const agg = async (a: number, b: number) => {
      const r = await db.prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(payout_rupees),0) AS payout, COALESCE(SUM(fee_rupees),0) AS fee
           FROM consult_bookings WHERE consultant_id = ? AND status IN ('completed','no_show_customer') AND slot_start_ms >= ? AND slot_start_ms < ?`,
      ).bind(c.id, a, b).first<{ n: number; payout: number; fee: number }>();
      return { completed: Number(r?.n || 0), payout: Number(r?.payout || 0), fee: Number(r?.fee || 0) };
    };
    const [thisMonth, lastMonth] = await Promise.all([agg(thisStart, nextStart), agg(lastStart, thisStart)]);
    return json({
      this_month: { month: ym, ...thisMonth },
      last_month: { month: istDate(lastStart).slice(0, 7), ...lastMonth },
      // [AUMFE-CONSULT-LAND-1] flat fields the desk Today screen reads
      month_total_rupees: thisMonth.payout, month_sessions: thisMonth.completed,
    });
  } catch (e) {
    await trackException(env, e, { route: `/api/consultants/desk/${route}`, method, handled: true, app_name: APP, extra: { area: "consult_desk", uid } });
    return err(500, "server_error");
  }
}
