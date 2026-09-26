// [ADMIN2-USERS 2026-09-26] Admin 2 "Users": every account, what they spent, and the
// account actions (block / unblock, sign out everywhere, delete).
// Contract: Specs/SPEC-2026-09-26-ADMIN-2.md. Registered with ONE spread line in
// routes/admin2.ts ADMIN2_ROUTES. Every route is admin-only (requireAdmin → ADMIN_UIDS).
// Money on the wire is integer PAISE; CSV shows plain rupees.
//
//   GET    /api/admin/v2/users?q&filter&sort&joined_from&joined_to&cursor&format=csv
//   GET    /api/admin/v2/users/:uid
//   POST   /api/admin/v2/users/:uid/block        {reason?}
//   POST   /api/admin/v2/users/:uid/unblock
//   POST   /api/admin/v2/users/:uid/signout-all
//   DELETE /api/admin/v2/users/:uid              {confirm}  (the user's email, or the uid when there is none)
//
// Saa Thum sign-in has NO passwords (email code or Google only; passwords are disabled in
// Clerk), so there is no "reset password": signout-all revokes every Clerk session instead.
//
// HOW THE ACTIONS WORK
//   * block   — 1) account_status.status='perm_banned' (DB_META): authz.ts requireUser
//               already reads this row on EVERY authed request, so the user's still-valid
//               JWT is refused with 403 from the next request on (no new per-request cost).
//               2) admin2_user_blocks row (who / when / reason; migration
//               2026-09-26-admin2-user-blocks.sql — best-effort until applied).
//               3) Clerk POST /v1/users/:id/ban for the uid and every Clerk alias id that
//               resolves to it (clerk_uid_alias): the user can't sign in again and Clerk
//               revokes their sessions.
//   * unblock — the reverse: Clerk unban, account_status back to 'active', block row deleted.
//   * signout-all — lists the user's ACTIVE Clerk sessions (uid + aliases) and revokes each.
//               A session JWT already issued stays valid for its short life (about a minute).
//   * delete  — reuses routes/admin_delete_user.ts adminDeleteUser (the same immediate
//               15-store cascade, deletion queue, Clerk identity delete, ADMIN_UIDS guard).
//   Refused for yourself and for any ADMIN_UIDS account: block, sign-out-all, delete.
//   Every action writes admin_audit (DB_WALLET) and emits admin2_user_action {action, ok}.
import type { Env } from "../types";
// Type-only: routes/admin2.ts imports this file, so a runtime import back would be circular.
import type { Admin2RouteDef } from "./admin2";
import { json, CORS } from "../util";
import { track, trackException } from "../hooks";
import { emailFor } from "../lib/identity";
import { requireAdmin } from "./admin_money";
import { adminDeleteUser } from "./admin_delete_user";
import { adminV2Customer, peopleQuery } from "./admin2_people";
import { decodeCursor, encodeCursor, msParam, maskE164 } from "../lib/me_dashboard_logic";
import { SMOKE_LISTING_ID } from "../lib/me_dashboard_data";
import {
  PAYMENT_ROWS_SQL, ADMIN2_PAGE, ADMIN2_EXPORT_MAX, emailHashSql, phoneSql, phoneHashSql, personName, phoneView,
  toCsv, csvRupees, csvIst, csvFilename, type PeopleQuery,
} from "../lib/admin2_people_data";

const APP = "saathum";
const CLERK_API = "https://api.clerk.com/v1";
/** Users per Clerk batch lookup (GET /v1/users?user_id=…); Clerk's max page is 500, keep URLs short. */
export const CLERK_BATCH = 100;
/** CSV: Clerk details (email, last active) for at most this many rows. */
export const EXPORT_CLERK_MAX = 2000;

const err = (status: number, error: string, message: string, extra: Record<string, unknown> = {}) =>
  json({ error, message, ...extra }, status);
const NO_STORE = { "cache-control": "private, no-store" };

async function admin(req: Request, env: Env): Promise<{ uid: string } | Response> {
  const a = await requireAdmin(req, env);
  // Same shape as admin2.ts adminGuard (not imported: see the type-only import above).
  if (a instanceof Response) {
    return a.status === 403 ? err(403, "admin_only", "You don't have admin access.") : err(a.status, "unauthorized", "Please sign in again.");
  }
  return a;
}

export function adminUidList(env: Env): string[] {
  return (env.ADMIN_UIDS ?? "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// List query
// ---------------------------------------------------------------------------
export const USER_FILTERS = ["verified", "not_verified", "blocked", "active", "has_spent"] as const;
export type UserFilter = (typeof USER_FILTERS)[number];
export const USER_SORTS = ["joined", "spent", "name"] as const;
export type UserSort = (typeof USER_SORTS)[number];

/**
 * One row per users row. Binds: ?1 = now (ms) — PAYMENT_ROWS_SQL uses it for live intents.
 *  - spent_paise: what the user paid (GST included), net of refunds: paid + refund-requested
 *    lines in full, a refunded line only for what was NOT sent back (partial refund).
 *  - payments / refunds / pending: counts; pending_paise: UPI payments not yet a seat.
 *  - bookings: live-event seats held (paid, free, released) — refunded seats drop out.
 *  - blocked: account_status says banned (what authz.ts enforces).
 */
export const USER_ROWS_SQL = `SELECT * FROM (
  SELECT u.uid AS uid, u.display_name, u.first_name, u.last_name, u.avatar_url, u.created_at AS joined_at,
         ${emailHashSql("u.uid", "u")} AS email_hash, ${phoneSql("u.uid", "u")} AS phone_e164, ${phoneHashSql("u.uid", "u")} AS phone_hash,
         CASE WHEN EXISTS (SELECT 1 FROM contact_verification cv WHERE cv.uid=u.uid AND cv.phone_verified=1)
                OR EXISTS (SELECT 1 FROM phone_otp pv WHERE pv.uid=u.uid AND pv.status='verified') THEN 1 ELSE 0 END AS phone_verified,
         CASE WHEN EXISTS (SELECT 1 FROM account_status s WHERE s.clerk_user_id=u.uid
                             AND (s.status='perm_banned' OR (s.status='temp_blocked' AND (s.blocked_until IS NULL OR s.blocked_until>?1))))
              THEN 1 ELSE 0 END AS blocked,
         (SELECT d.status FROM deletion_requests d WHERE d.uid=u.uid AND d.status IN ('pending','processing')) AS deletion_status,
         COALESCE(bk.bookings,0) AS bookings,
         COALESCE(pay.spent_paise,0) AS spent_paise, COALESCE(pay.payments,0) AS payments,
         COALESCE(pay.refunds,0) AS refunds, COALESCE(pay.refunded_paise,0) AS refunded_paise,
         COALESCE(pay.pending,0) AS pending, COALESCE(pay.pending_paise,0) AS pending_paise,
         lower(COALESCE(NULLIF(trim(u.display_name),''), NULLIF(trim(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')),''), '~')) AS sort_name
    FROM users u
    LEFT JOIN (
      SELECT o.buyer_id AS uid, COUNT(*) AS bookings
        FROM orders o JOIN listings l ON l.id=o.listing_id AND l.kind='live_event'
       WHERE o.status IN ('held','free','released') AND o.listing_id<>'${SMOKE_LISTING_ID}'
       GROUP BY o.buyer_id
    ) bk ON bk.uid=u.uid
    LEFT JOIN (
      SELECT pp.uid AS uid,
             SUM(CASE WHEN pp.status IN ('paid','refund_requested') THEN pp.amount_paise
                      WHEN pp.status='refunded' THEN MAX(0, pp.amount_paise - COALESCE(pp.refund_amount_paise, pp.amount_paise))
                      ELSE 0 END) AS spent_paise,
             SUM(CASE WHEN pp.status IN ('paid','refund_requested','refunded') THEN 1 ELSE 0 END) AS payments,
             SUM(CASE WHEN pp.status='refunded' THEN 1 ELSE 0 END) AS refunds,
             SUM(CASE WHEN pp.status='refunded' THEN COALESCE(pp.refund_amount_paise, pp.amount_paise) ELSE 0 END) AS refunded_paise,
             SUM(CASE WHEN pp.status='pending' THEN 1 ELSE 0 END) AS pending,
             SUM(CASE WHEN pp.status='pending' THEN pp.amount_paise ELSE 0 END) AS pending_paise
        FROM (${PAYMENT_ROWS_SQL}) pp
       GROUP BY pp.uid
    ) pay ON pay.uid=u.uid
) p`;

export type UserRow = {
  uid: string; display_name: string | null; first_name: string | null; last_name: string | null; avatar_url: string | null;
  joined_at: number | null; email_hash: string | null; phone_e164: string | null; phone_hash: string | null;
  phone_verified: number; blocked: number; deletion_status: string | null; bookings: number;
  spent_paise: number; payments: number; refunds: number; refunded_paise: number; pending: number; pending_paise: number;
  sort_name: string;
};

export type UserListFilters = {
  q?: PeopleQuery | null;
  /** Extra uids that match the search (Clerk's own name/email/phone search). */
  qUids?: string[] | null;
  filter?: string | null; sort?: string | null;
  joinedFrom?: number | null; joinedTo?: number | null;
  uid?: string | null; offset?: number; limit?: number;
};

const esc = (s: string) => s.replace(/[\\%_]/g, (ch) => "\\" + ch);
const like = (col: string, r: string) => `${col} LIKE ${r} ESCAPE '\\'`;

export function parseFilters(raw: string | null | undefined): UserFilter[] {
  return [...new Set((raw ?? "").split(",").map((s) => s.trim()).filter((s): s is UserFilter => (USER_FILTERS as readonly string[]).includes(s)))];
}
export function parseSort(raw: string | null | undefined): UserSort {
  return (USER_SORTS as readonly string[]).includes(raw ?? "") ? (raw as UserSort) : "joined";
}

function userWhere(now: number, f: UserListFilters): { where: string; binds: unknown[] } {
  const binds: unknown[] = [now];
  const ref = (v: unknown) => { binds.push(v); return `?${binds.length}`; };
  const parts: string[] = [];
  if (f.uid) parts.push(`p.uid=${ref(f.uid)}`);
  const q = f.q && f.q.text ? f.q : null;
  if (q) {
    const sub = ref(`%${esc(q.text.toLowerCase())}%`);
    const ors = [
      like("lower(COALESCE(p.display_name,''))", sub),
      like("lower(COALESCE(p.first_name,'') || ' ' || COALESCE(p.last_name,''))", sub),
      like("p.uid", ref(`${esc(q.text)}%`)),
    ];
    if (q.emailHash) ors.push(`p.email_hash=${ref(q.emailHash)}`);
    if (q.phoneLast4) ors.push(like("COALESCE(p.phone_e164,'')", ref(`%${q.phoneLast4}`)));
    if (q.phoneHash) ors.push(`p.phone_hash=${ref(q.phoneHash)}`);
    const extra = (f.qUids ?? []).slice(0, CLERK_BATCH);
    if (extra.length) ors.push(`p.uid IN (${extra.map((u) => ref(u)).join(",")})`);
    parts.push(`(${ors.join(" OR ")})`);
  }
  const fl = parseFilters(f.filter);
  const verified = fl.includes("verified"), notVerified = fl.includes("not_verified");
  if (verified && !notVerified) parts.push("p.phone_verified=1");
  if (notVerified && !verified) parts.push("p.phone_verified=0");
  const blocked = fl.includes("blocked"), active = fl.includes("active");
  if (blocked && !active) parts.push("p.blocked=1");
  if (active && !blocked) parts.push("p.blocked=0");
  if (fl.includes("has_spent")) parts.push("p.spent_paise>0");
  if (f.joinedFrom != null) parts.push(`p.joined_at>=${ref(f.joinedFrom)}`);
  if (f.joinedTo != null) parts.push(`p.joined_at<=${ref(f.joinedTo)}`);
  return { where: parts.length ? " WHERE " + parts.join(" AND ") : "", binds };
}

const ORDER: Record<UserSort, string> = {
  joined: "p.joined_at DESC, p.uid DESC",
  spent: "p.spent_paise DESC, p.joined_at DESC, p.uid DESC",
  name: "p.sort_name ASC, p.uid ASC",
};

/** Page query. Offset paging (every sort key is stable with the uid tie-break). */
export function buildUsersQuery(now: number, f: UserListFilters): { sql: string; binds: unknown[] } {
  const { where, binds } = userWhere(now, f);
  const limit = Math.max(1, Math.min(ADMIN2_EXPORT_MAX + 1, f.limit ?? ADMIN2_PAGE + 1));
  const offset = Math.max(0, Math.floor(f.offset ?? 0));
  return { sql: `${USER_ROWS_SQL}${where} ORDER BY ${ORDER[parseSort(f.sort)]} LIMIT ${limit} OFFSET ${offset}`, binds };
}

export function buildUserTotalsQuery(now: number, f: UserListFilters): { sql: string; binds: unknown[] } {
  const { where, binds } = userWhere(now, f);
  return {
    sql: `SELECT COUNT(*) AS users, COALESCE(SUM(p.spent_paise),0) AS spent_paise,
            COALESCE(SUM(CASE WHEN p.blocked=1 THEN 1 ELSE 0 END),0) AS blocked,
            COALESCE(SUM(CASE WHEN p.phone_verified=1 THEN 1 ELSE 0 END),0) AS verified
          FROM (${USER_ROWS_SQL}${where}) p`,
    binds,
  };
}

// Offset cursor, carried in the shared cursor codec ({t: offset, id: "o"}).
export const offsetCursor = (offset: number) => encodeCursor({ t: offset, id: "o" });
export function readOffset(raw: string | null): number | null {
  if (!raw) return 0;
  const c = decodeCursor(raw);
  return c && c.id === "o" && Number.isInteger(c.t) && c.t >= 0 ? c.t : null;
}

// ---------------------------------------------------------------------------
// Clerk (Backend API). All helpers are tolerant: a Clerk outage never breaks the list.
// ---------------------------------------------------------------------------
export interface ClerkInfo {
  email: string | null; email_verified: boolean; first_name: string | null; last_name: string | null;
  image_url: string | null; created_at: number | null; last_sign_in_at: number | null; last_active_at: number | null;
  banned: boolean; locked: boolean; phone: string | null;
}

export function shapeClerkUser(u: any): ClerkInfo {
  const addrs = Array.isArray(u?.email_addresses) ? u.email_addresses : [];
  const primary = addrs.find((e: any) => e?.id === u?.primary_email_address_id) ?? addrs[0];
  const nums = Array.isArray(u?.phone_numbers) ? u.phone_numbers : [];
  const phone = nums.find((p: any) => p?.id === u?.primary_phone_number_id) ?? nums[0];
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  return {
    email: primary?.email_address ?? null,
    email_verified: primary?.verification?.status === "verified",
    first_name: u?.first_name ?? null, last_name: u?.last_name ?? null,
    image_url: u?.has_image === false ? null : (u?.image_url ?? null),
    created_at: n(u?.created_at), last_sign_in_at: n(u?.last_sign_in_at), last_active_at: n(u?.last_active_at),
    banned: u?.banned === true, locked: u?.locked === true,
    phone: phone?.phone_number ?? null,
  };
}

const clerkHeaders = (env: Env) => ({ authorization: `Bearer ${env.CLERK_SECRET_KEY}`, "content-type": "application/json" });
const listOf = (body: any): any[] => (Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : []);

/** uid -> Clerk info for many users, CLERK_BATCH per call. Missing / failed ids are simply absent. */
export async function clerkUsers(env: Env, uids: string[]): Promise<Map<string, ClerkInfo>> {
  const out = new Map<string, ClerkInfo>();
  if (!env.CLERK_SECRET_KEY) return out;
  const uniq = [...new Set(uids.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += CLERK_BATCH) {
    const chunk = uniq.slice(i, i + CLERK_BATCH);
    const qs = new URLSearchParams({ limit: String(chunk.length) });
    for (const u of chunk) qs.append("user_id", u);
    try {
      const r = await fetch(`${CLERK_API}/users?${qs.toString()}`, { headers: clerkHeaders(env) });
      if (!r.ok) continue;
      for (const u of listOf(await r.json())) if (u?.id) out.set(String(u.id), shapeClerkUser(u));
    } catch { /* tolerated: the row falls back to D1 + the cached email */ }
  }
  return out;
}

/** Clerk's own user search (name, email or phone, partial). Returns Clerk ids; [] on any failure. */
export async function clerkSearch(env: Env, text: string): Promise<string[]> {
  if (!env.CLERK_SECRET_KEY || text.trim().length < 2) return [];
  try {
    const qs = new URLSearchParams({ query: text.trim().slice(0, 80), limit: String(CLERK_BATCH) });
    const r = await fetch(`${CLERK_API}/users?${qs.toString()}`, { headers: clerkHeaders(env) });
    if (!r.ok) return [];
    return listOf(await r.json()).map((u) => String(u?.id ?? "")).filter(Boolean);
  } catch { return []; }
}

/** The Clerk ids of an account: its uid plus every alias id that resolves to it (ACCT-RELINK-1). */
export async function clerkIdsFor(env: Env, uid: string): Promise<string[]> {
  const ids = [uid];
  try {
    const rs = await env.DB_META.prepare("SELECT alias_clerk_id FROM clerk_uid_alias WHERE canonical_uid=?1").bind(uid).all<{ alias_clerk_id: string }>();
    for (const r of rs.results ?? []) if (r.alias_clerk_id && !ids.includes(r.alias_clerk_id)) ids.push(r.alias_clerk_id);
  } catch { /* alias table missing: the uid alone */ }
  return ids;
}

/** POST /v1/users/:id/{ban|unban}. A 404 (Clerk user already gone) counts as done. */
async function clerkBan(env: Env, id: string, ban: boolean): Promise<boolean> {
  const r = await fetch(`${CLERK_API}/users/${encodeURIComponent(id)}/${ban ? "ban" : "unban"}`, { method: "POST", headers: clerkHeaders(env) });
  return r.ok || r.status === 404;
}

/** Revokes every ACTIVE Clerk session of one Clerk id. Returns how many were revoked. */
export async function revokeSessions(env: Env, id: string): Promise<{ revoked: number; failed: number }> {
  const qs = new URLSearchParams({ user_id: id, status: "active", limit: "100" });
  const r = await fetch(`${CLERK_API}/sessions?${qs.toString()}`, { headers: clerkHeaders(env) });
  if (r.status === 404) return { revoked: 0, failed: 0 };
  if (!r.ok) throw new Error(`clerk sessions list ${r.status}`);
  let revoked = 0, failed = 0;
  for (const s of listOf(await r.json())) {
    if (!s?.id) continue;
    const x = await fetch(`${CLERK_API}/sessions/${encodeURIComponent(String(s.id))}/revoke`, { method: "POST", headers: clerkHeaders(env) });
    if (x.ok) revoked++; else failed++;
  }
  return { revoked, failed };
}

// ---------------------------------------------------------------------------
// Audit + telemetry
// ---------------------------------------------------------------------------
async function audit(env: Env, adminUid: string, action: string, target: string, meta: Record<string, unknown>): Promise<void> {
  try {
    await env.DB_WALLET.prepare(
      "INSERT INTO admin_audit (id, admin_id, action, target, meta, created_at) VALUES (?1,?2,?3,?4,?5,?6)",
    ).bind(crypto.randomUUID(), adminUid, `user_${action}`, target, JSON.stringify(meta), Date.now()).run();
  } catch (e) {
    // The action stands; a missing audit row is reported, never swallowed.
    await trackException(env, e, { route: "/api/admin/v2/users/:uid", method: "POST", handled: true, app_name: APP, extra: { area: "admin2_users", step: "admin_audit", action } });
  }
}

async function tel(env: Env, adminUid: string, action: string, ok: boolean, extra: Record<string, unknown> = {}): Promise<void> {
  try { await track(env, adminUid, "admin2_user_action", APP, { action, ok, ...extra }); } catch { /* best-effort */ }
}

/** Why an action on `uid` is refused (yourself / another admin), or null. */
export function protectedReason(env: Env, actor: string, uid: string): string | null {
  if (uid === actor) return "You can't do this to your own account.";
  if (adminUidList(env).includes(uid)) return "This is an admin account. Admin accounts can't be blocked, signed out or deleted here.";
  return null;
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const t = await req.text().catch(() => "");
  if (!t || t.length > 4096) return {};
  try { const v = JSON.parse(t); return v && typeof v === "object" ? v as Record<string, unknown> : {}; } catch { return {}; }
}

const validUid = (uid: string) => !!uid && uid.length <= 200 && !/[\s/]/.test(uid);

// ---------------------------------------------------------------------------
// GET /api/admin/v2/users
// ---------------------------------------------------------------------------
function userItem(env: Env, actor: string, r: UserRow, c: ClerkInfo | undefined, fallbackEmail: string | null) {
  const ph = phoneView(r);
  const clerkName = [c?.first_name, c?.last_name].map((s) => (s ?? "").trim()).filter(Boolean).join(" ") || null;
  return {
    uid: r.uid,
    name: personName(r) ?? clerkName,
    email: c?.email ?? fallbackEmail,
    photo_url: r.avatar_url || c?.image_url || null,
    phone_masked: ph.masked, phone_hash_only: ph.hash_only, phone_verified: Number(r.phone_verified) === 1,
    joined_at: r.joined_at != null ? Number(r.joined_at) : (c?.created_at ?? null),
    last_active_at: c?.last_active_at ?? c?.last_sign_in_at ?? null,
    bookings: Number(r.bookings ?? 0),
    spent_paise: Number(r.spent_paise ?? 0),
    status: Number(r.blocked) === 1 ? "blocked" : "active",
    deleting: !!r.deletion_status,
    is_admin: adminUidList(env).includes(r.uid),
    is_self: r.uid === actor,
  };
}

function csvResponse(body: string, filename: string, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: {
      ...CORS,
      "content-type": "text/csv; charset=utf-8; header=present",
      "content-disposition": `attachment; filename="${filename}"`,
      "access-control-expose-headers": "content-disposition, x-export-truncated, x-export-rows",
      ...NO_STORE, ...extra,
    },
  });
}

export async function adminV2Users(req: Request, env: Env): Promise<Response> {
  const a = await admin(req, env); if (a instanceof Response) return a;
  const u = new URL(req.url).searchParams;
  const offset = readOffset(u.get("cursor"));
  if (offset === null) return err(400, "invalid_cursor", "That page link is no longer valid. Reload the list.");
  const now = Date.now();
  const q = await peopleQuery(u.get("q"));
  const qUids = q ? await clerkSearch(env, q.text) : [];
  const f: UserListFilters = {
    q, qUids, filter: u.get("filter"), sort: parseSort(u.get("sort")),
    joinedFrom: msParam(u.get("joined_from")), joinedTo: msParam(u.get("joined_to")),
  };
  const db = env.DB_META;

  if (u.get("format") === "csv") {
    const { sql, binds } = buildUsersQuery(now, { ...f, limit: ADMIN2_EXPORT_MAX + 1 });
    const rows = (await db.prepare(sql).bind(...binds).all<UserRow>()).results ?? [];
    const page = rows.slice(0, ADMIN2_EXPORT_MAX);
    const clerk = await clerkUsers(env, page.slice(0, EXPORT_CLERK_MAX).map((r) => r.uid));
    const body = toCsv(
      ["User ID", "Name", "Email", "Phone (masked)", "Phone verified", "Joined (IST)", "Last active (IST)",
        "Bookings", "Total spent (INR)", "Payments", "Refunds", "Refunded (INR)", "Status"],
      page.map((r) => {
        const it = userItem(env, a.uid, r, clerk.get(r.uid), null);
        return [r.uid, it.name, it.email ?? "", it.phone_masked ?? (it.phone_hash_only ? "on file (hash only)" : ""),
          it.phone_verified ? "Yes" : "No", csvIst(it.joined_at), csvIst(it.last_active_at), it.bookings,
          csvRupees(it.spent_paise), Number(r.payments ?? 0), Number(r.refunds ?? 0), csvRupees(Number(r.refunded_paise ?? 0)),
          it.status === "blocked" ? "Blocked" : "Active"];
      }),
    );
    return csvResponse(body, csvFilename("users", now), {
      "x-export-rows": String(page.length),
      ...(rows.length > ADMIN2_EXPORT_MAX ? { "x-export-truncated": "1" } : {}),
      ...(page.length > EXPORT_CLERK_MAX ? { "x-export-emails-capped": "1" } : {}),
    });
  }

  const { sql, binds } = buildUsersQuery(now, { ...f, offset, limit: ADMIN2_PAGE + 1 });
  const tq = offset === 0 ? buildUserTotalsQuery(now, f) : null;
  const [rs, tot] = await Promise.all([
    db.prepare(sql).bind(...binds).all<UserRow>(),
    tq ? db.prepare(tq.sql).bind(...tq.binds).first<Record<string, number>>() : Promise.resolve(null),
  ]);
  const rows = rs.results ?? [];
  const page = rows.slice(0, ADMIN2_PAGE);
  const clerk = await clerkUsers(env, page.map((r) => r.uid));
  // Clerk unreachable for some rows: fall back to the KV-cached email lookup.
  const fallback = new Map<string, string | null>();
  const missing = page.filter((r) => !clerk.has(r.uid)).map((r) => r.uid);
  for (let i = 0; i < missing.length; i += 8) {
    const got = await Promise.all(missing.slice(i, i + 8).map(async (id) => [id, await emailFor(env, id).catch(() => null)] as const));
    for (const [id, e] of got) fallback.set(id, e);
  }
  return json({
    items: page.map((r) => userItem(env, a.uid, r, clerk.get(r.uid), fallback.get(r.uid) ?? null)),
    ...(rows.length > ADMIN2_PAGE ? { next_cursor: offsetCursor(offset + ADMIN2_PAGE) } : {}),
    ...(tot ? { totals: Object.fromEntries(Object.entries(tot).map(([k, v]) => [k, Number(v ?? 0)])) } : {}),
    sort: f.sort,
  }, 200, NO_STORE);
}

// ---------------------------------------------------------------------------
// GET /api/admin/v2/users/:uid — the customer detail (admin2_people) + account + money.
// ---------------------------------------------------------------------------
export async function adminV2User(req: Request, env: Env, uid: string): Promise<Response> {
  const a = await admin(req, env); if (a instanceof Response) return a;
  if (!validUid(uid)) return err(404, "not_found", "We couldn't find that user.");
  const base = await adminV2Customer(req, env, uid);
  if (!base.ok) return base;
  const detail = await base.json() as Record<string, any>;
  const now = Date.now();
  const s = buildUsersQuery(now, { uid, limit: 1 });
  const [row, clerk, block] = await Promise.all([
    env.DB_META.prepare(s.sql).bind(...s.binds).first<UserRow>(),
    clerkUsers(env, [uid]),
    env.DB_META.prepare("SELECT blocked_at, admin_uid, reason FROM admin2_user_blocks WHERE uid=?1").bind(uid)
      .first<{ blocked_at: number; admin_uid: string; reason: string | null }>().catch(() => null),
  ]);
  const c = clerk.get(uid);
  const blocked = row ? Number(row.blocked) === 1 : false;
  const profile = detail.profile ?? {};
  return json({
    ...detail,
    profile: {
      ...profile,
      name: profile.name ?? ([c?.first_name, c?.last_name].filter(Boolean).join(" ") || null),
      email: profile.email ?? c?.email ?? null,
      photo_url: profile.photo_url ?? c?.image_url ?? undefined,
      phone: { ...(profile.phone ?? {}), verified: !!profile.phone?.verified || (row ? Number(row.phone_verified) === 1 : false) },
      clerk_phone_masked: c?.phone ? maskE164(c.phone) : null,
    },
    account: {
      status: blocked ? "blocked" : "active",
      blocked: blocked ? { at: block?.blocked_at ?? null, by: block?.admin_uid ?? null, reason: block?.reason ?? null } : null,
      clerk: c ? {
        found: true, email_verified: c.email_verified, created_at: c.created_at, last_sign_in_at: c.last_sign_in_at,
        last_active_at: c.last_active_at, banned: c.banned, locked: c.locked,
      } : { found: false },
      deleting: !!row?.deletion_status,
      is_admin: adminUidList(env).includes(uid),
      is_self: uid === a.uid,
      sign_in: "Email code or Google. There are no passwords.",
    },
    money: {
      spent_paise: Number(row?.spent_paise ?? 0),
      payments: Number(row?.payments ?? 0),
      refunds: Number(row?.refunds ?? 0),
      refunded_paise: Number(row?.refunded_paise ?? 0),
      pending: Number(row?.pending ?? 0),
      pending_paise: Number(row?.pending_paise ?? 0),
      bookings: Number(row?.bookings ?? 0),
    },
  }, 200, NO_STORE);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function actionGuard(req: Request, env: Env, uid: string, action: string): Promise<{ actor: string } | Response> {
  const a = await admin(req, env); if (a instanceof Response) return a;
  if (!validUid(uid)) return err(404, "not_found", "We couldn't find that user.");
  if (action !== "unblock") {
    const why = protectedReason(env, a.uid, uid);
    if (why) { await tel(env, a.uid, action, false, { reason: "protected_account" }); return err(403, "protected_account", why); }
  }
  return { actor: a.uid };
}

export async function adminV2BlockUser(req: Request, env: Env, uid: string): Promise<Response> {
  const g = await actionGuard(req, env, uid, "block"); if (g instanceof Response) return g;
  const b = await readBody(req);
  const reason = typeof b.reason === "string" ? b.reason.trim().slice(0, 300) || null : null;
  const now = Date.now();
  const db = env.DB_META;
  // 1) API refusal first: authz.ts requireUser reads account_status on every authed request.
  await db.prepare(
    `INSERT INTO account_status (clerk_user_id, uid, status, reason, blocked_until, blocked_at)
     VALUES (?1, ?1, 'perm_banned', ?2, NULL, ?3)
     ON CONFLICT(clerk_user_id) DO UPDATE SET status='perm_banned', reason=?2, blocked_until=NULL, blocked_at=?3`,
  ).bind(uid, reason ? `admin: ${reason}` : "admin block", now).run();
  // 2) Who/when/why (table from 2026-09-26-admin2-user-blocks.sql; best-effort until applied).
  let recorded = true;
  try {
    await db.prepare(
      `INSERT INTO admin2_user_blocks (uid, blocked_at, admin_uid, reason) VALUES (?1,?2,?3,?4)
       ON CONFLICT(uid) DO UPDATE SET blocked_at=?2, admin_uid=?3, reason=?4`,
    ).bind(uid, now, g.actor, reason).run();
  } catch (e) {
    recorded = false;
    await trackException(env, e, { route: "/api/admin/v2/users/:uid/block", method: "POST", handled: true, app_name: APP, extra: { area: "admin2_users", step: "block_row" } });
  }
  // 3) Clerk ban for every Clerk id of the account (no new sign-in; Clerk ends the sessions).
  const ids = await clerkIdsFor(env, uid);
  let clerkOk = !!env.CLERK_SECRET_KEY;
  if (clerkOk) {
    for (const id of ids) {
      try { if (!(await clerkBan(env, id, true))) clerkOk = false; } catch { clerkOk = false; }
    }
  }
  await audit(env, g.actor, "block", uid, { reason, clerk_ok: clerkOk, clerk_ids: ids.length, recorded });
  await tel(env, g.actor, "block", clerkOk, { target_uid: uid, has_reason: !!reason, clerk_ok: clerkOk });
  if (!clerkOk) {
    return err(502, "clerk_failed", "Blocked on Saa Thum (their app and website requests are refused), but Clerk didn't confirm the sign-in ban. Try again.", { partial: true, status: "blocked" });
  }
  return json({ ok: true, uid, status: "blocked", blocked_at: now, reason });
}

export async function adminV2UnblockUser(req: Request, env: Env, uid: string): Promise<Response> {
  const g = await actionGuard(req, env, uid, "unblock"); if (g instanceof Response) return g;
  const db = env.DB_META;
  const ids = await clerkIdsFor(env, uid);
  let clerkOk = !!env.CLERK_SECRET_KEY;
  if (clerkOk) {
    for (const id of ids) {
      try { if (!(await clerkBan(env, id, false))) clerkOk = false; } catch { clerkOk = false; }
    }
  }
  if (!clerkOk) {
    await audit(env, g.actor, "unblock", uid, { clerk_ok: false });
    await tel(env, g.actor, "unblock", false, { target_uid: uid, clerk_ok: false });
    // Stay blocked everywhere rather than half-unblocked.
    return err(502, "clerk_failed", "Clerk didn't confirm the unban, so the user is still blocked. Try again.");
  }
  await db.prepare("UPDATE account_status SET status='active', blocked_until=NULL, reason=NULL WHERE clerk_user_id=?1").bind(uid).run();
  try { await db.prepare("DELETE FROM admin2_user_blocks WHERE uid=?1").bind(uid).run(); } catch { /* table not applied yet */ }
  await audit(env, g.actor, "unblock", uid, { clerk_ok: true, clerk_ids: ids.length });
  await tel(env, g.actor, "unblock", true, { target_uid: uid });
  return json({ ok: true, uid, status: "active" });
}

export async function adminV2SignOutAll(req: Request, env: Env, uid: string): Promise<Response> {
  const g = await actionGuard(req, env, uid, "signout_all"); if (g instanceof Response) return g;
  if (!env.CLERK_SECRET_KEY) {
    await tel(env, g.actor, "signout_all", false, { target_uid: uid, reason: "unconfigured" });
    return err(503, "clerk_unconfigured", "Sign-in service isn't configured, so sessions can't be ended right now.");
  }
  const ids = await clerkIdsFor(env, uid);
  let revoked = 0, failed = 0;
  try {
    for (const id of ids) { const r = await revokeSessions(env, id); revoked += r.revoked; failed += r.failed; }
  } catch (e) {
    await trackException(env, e, { route: "/api/admin/v2/users/:uid/signout-all", method: "POST", handled: true, app_name: APP, extra: { area: "admin2_users" } });
    await audit(env, g.actor, "signout_all", uid, { ok: false, revoked });
    await tel(env, g.actor, "signout_all", false, { target_uid: uid, revoked });
    return err(502, "clerk_failed", "Couldn't reach the sign-in service. Try again.", { revoked });
  }
  const ok = failed === 0;
  await audit(env, g.actor, "signout_all", uid, { ok, revoked, failed });
  await tel(env, g.actor, "signout_all", ok, { target_uid: uid, revoked, failed });
  if (!ok) return err(502, "clerk_failed", `Ended ${revoked} session${revoked === 1 ? "" : "s"}, but ${failed} didn't end. Try again.`, { revoked, failed });
  return json({ ok: true, uid, revoked });
}

export async function adminV2DeleteUser(req: Request, env: Env, uid: string): Promise<Response> {
  const g = await actionGuard(req, env, uid, "delete"); if (g instanceof Response) return g;
  const b = await readBody(req);
  const confirm = typeof b.confirm === "string" ? b.confirm.trim() : "";
  const email = await emailFor(env, uid).catch(() => null);
  const expected = email ?? uid;
  if (!confirm || confirm.toLowerCase() !== expected.toLowerCase()) {
    await tel(env, g.actor, "delete", false, { target_uid: uid, reason: "confirm_mismatch" });
    return err(400, "confirm_mismatch", email ? "Type the user's email exactly to confirm." : "Type the user's ID exactly to confirm.", { field: "confirm" });
  }
  // Same cascade + safety rules as POST /api/admin/delete-user (it re-checks requireAdmin
  // and refuses ADMIN_UIDS targets itself).
  const inner = new Request(`https://admin2.internal/api/admin/delete-user?uid=${encodeURIComponent(uid)}`, {
    method: "POST", headers: { authorization: req.headers.get("authorization") ?? "" },
  });
  const res = await adminDeleteUser(inner, env);
  const out = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const ok = res.ok && out.ok === true;
  await audit(env, g.actor, "delete", uid, { ok, status: res.status, had_email: !!email });
  await tel(env, g.actor, "delete", ok, { target_uid: uid, status: res.status });
  if (!ok) return err(res.status >= 400 ? res.status : 500, "delete_failed", "The deletion couldn't be started. Nothing was deleted. Try again.", { detail: out.error ?? null });
  try { await env.DB_META.prepare("DELETE FROM admin2_user_blocks WHERE uid=?1").bind(uid).run(); } catch { /* table not applied yet */ }
  return json({ ok: true, uid, deleting: true, immediate: true });
}

// ---------------------------------------------------------------------------
// Registration: routes/admin2.ts spreads this into ADMIN2_ROUTES (its dispatcher owns
// the try/catch → trackException).
// ---------------------------------------------------------------------------
const one = /^\/api\/admin\/v2\/users\/([^/]+)$/;
export const ADMIN2_USER_ROUTES: Admin2RouteDef[] = [
  { method: "GET", path: "/api/admin/v2/users", handler: (req, env) => adminV2Users(req, env) },
  { method: "GET", path: one, handler: (req, env, [uid]) => adminV2User(req, env, uid ?? "") },
  { method: "DELETE", path: one, handler: (req, env, [uid]) => adminV2DeleteUser(req, env, uid ?? "") },
  { method: "POST", path: /^\/api\/admin\/v2\/users\/([^/]+)\/block$/, handler: (req, env, [uid]) => adminV2BlockUser(req, env, uid ?? "") },
  { method: "POST", path: /^\/api\/admin\/v2\/users\/([^/]+)\/unblock$/, handler: (req, env, [uid]) => adminV2UnblockUser(req, env, uid ?? "") },
  { method: "POST", path: /^\/api\/admin\/v2\/users\/([^/]+)\/signout-all$/, handler: (req, env, [uid]) => adminV2SignOutAll(req, env, uid ?? "") },
];

