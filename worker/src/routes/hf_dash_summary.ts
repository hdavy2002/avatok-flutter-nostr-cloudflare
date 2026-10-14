// [HF-DASH-SUMMARY-1] One read for the dashboard Overview: role-aware numbers for the signed-in person only.
//   GET /api/hf/me/summary  signed in ->
//     { ok, role: 'host'|'customer', callsToday: {made, received}, appointmentsToday, expectedHostNetPaise,
//       fraands: {saved, newThisWeek}, recentMade: [{ id, otherHandle, status, at, seconds, amountPaise }] | null }
// Every part is read on its own; a part that fails becomes null (and is reported) while the answer stays 200.
// Never returns a phone number, email or another person's uid: the other side of a call is the host's public display name.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { trackException } from "../hooks";
import { hostExpectedNetPaise } from "./hf_bookings";

const DAY_MS = 86_400_000;
const IST_MS = 19_800_000;
const WEEK_MS = 7 * DAY_MS;

export interface RecentMade { id: string; otherHandle: string; status: string; at: number; seconds: number; amountPaise: number | null }

async function part<T>(env: Env, uid: string, name: string, fn: () => Promise<T>): Promise<T | null> {
  try { return await fn(); }
  catch (e) { void trackException(env, e, { uid, route: "/api/hf/me/summary", method: "GET", handled: true, extra: { area: "hf_dash_summary", part: name } }).catch(() => undefined); return null; }
}

export async function hfDashSummaryRoute(req: Request, env: Env): Promise<Response | null> {
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);
  const u = await requireUser(req, env);
  if (isFail(u)) return json({ error: u.error, message: u.error }, u.status);
  const uid = u.uid;
  const now = Date.now();
  // "Today" = the IST day (same maths as the host calls list).
  const istStart = Math.floor((now + IST_MS) / DAY_MS) * DAY_MS - IST_MS;
  const istEnd = istStart + DAY_MS;
  const db = env.DB_META;

  const host = await part(env, uid, "role", async () =>
    (await db.prepare("SELECT status FROM hf_hosts WHERE uid=?1").bind(uid).first<{ status: string }>()) ?? { status: "" });
  const isHost = host?.status === "live";

  const [made, received, appointments, expected, saved, newThisWeek, recent] = await Promise.all([
    part(env, uid, "calls_made", async () => Number((await db.prepare(
      "SELECT COUNT(*) AS n FROM hf_calls WHERE caller_uid=?1 AND status='completed' AND billed_minutes>=1 AND created_at>=?2 AND created_at<?3",
    ).bind(uid, istStart, istEnd).first<{ n: number }>())?.n ?? 0)),
    part(env, uid, "calls_received", async () => Number((await db.prepare(
      "SELECT COUNT(*) AS n FROM hf_calls WHERE host_uid=?1 AND status='completed' AND billed_minutes>=1 AND created_at>=?2 AND created_at<?3",
    ).bind(uid, istStart, istEnd).first<{ n: number }>())?.n ?? 0)),
    part(env, uid, "appointments", async () => Number((await db.prepare(
      "SELECT COUNT(*) AS n FROM hf_bookings WHERE (customer_uid=?1 OR host_uid=?1) AND status IN ('confirmed','starting','active') AND cancelled_at IS NULL AND starts_at>=?2 AND starts_at<?3",
    ).bind(uid, istStart, istEnd).first<{ n: number }>())?.n ?? 0)),
    isHost ? part(env, uid, "expected", () => hostExpectedNetPaise(env, uid)) : Promise.resolve(null),
    // hf_favourites is created by another change; until it exists this part is simply null.
    part(env, uid, "fraands_saved", async () => Number((await db.prepare("SELECT COUNT(*) AS n FROM hf_favourites WHERE uid=?1").bind(uid).first<{ n: number }>())?.n ?? 0)),
    isHost ? part(env, uid, "fraands_new", async () => Number((await db.prepare(
      "SELECT COUNT(*) AS n FROM (SELECT caller_uid FROM hf_calls WHERE host_uid=?1 AND status='completed' AND billed_minutes>=1 GROUP BY caller_uid HAVING MIN(created_at)>=?2)",
    ).bind(uid, now - WEEK_MS).first<{ n: number }>())?.n ?? 0)) : Promise.resolve(null),
    part(env, uid, "recent_made", async (): Promise<RecentMade[]> => {
      const rows = (await db.prepare(
        `SELECT c.id, c.status, c.created_at, c.connected_at, c.ended_at, c.billed_minutes, c.charged_paise,
                (SELECT display_name FROM hf_hosts h WHERE h.uid=c.host_uid) AS host_name
           FROM hf_calls c WHERE c.caller_uid=?1 ORDER BY c.created_at DESC LIMIT 3`,
      ).bind(uid).all<{ id: string; status: string; created_at: number; connected_at: number | null; ended_at: number | null; billed_minutes: number; charged_paise: number; host_name: string | null }>()).results ?? [];
      return rows.map((r) => {
        const done = r.status === "completed" && Number(r.billed_minutes) >= 1;
        const secs = r.connected_at && r.ended_at ? Math.max(0, Math.round((Number(r.ended_at) - Number(r.connected_at)) / 1000)) : 0;
        return { id: r.id, otherHandle: (r.host_name ?? "").trim() || "Host", status: r.status, at: Number(r.created_at), seconds: secs, amountPaise: done ? Math.round(Number(r.charged_paise ?? 0)) : null };
      });
    }),
  ]);

  return json({
    ok: true,
    role: isHost ? "host" : "customer",
    callsToday: { made, received },
    appointmentsToday: appointments,
    expectedHostNetPaise: isHost ? expected : null,
    fraands: { saved, newThisWeek: isHost ? newThisWeek : null },
    recentMade: recent, // null when that part failed
  }, 200, { "cache-control": "private, no-store" });
}
