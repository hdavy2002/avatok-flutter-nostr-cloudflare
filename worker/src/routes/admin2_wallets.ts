// [AUMFE-WALLET-ADMIN-1] Admin 2 "Wallets": every user who has a wallet, what they topped up,
// what they spent, their balance, and an admin "add money / deduct" action.
// Registered with ONE spread line in routes/admin2.ts ADMIN2_ROUTES. Admin-only (requireAdmin).
// THE UNIT IS A TOKEN AND 1 TOKEN = ₹1 (CLAUDE.md): amounts on this wire are integer TOKENS.
//
//   GET  /api/admin/v2/wallets?q&filter&sort&from&to&cursor
//   GET  /api/admin/v2/wallets/:uid
//   POST /api/admin/v2/wallets/:uid/adjust   {amount_tokens, reason}   header Idempotency-Key
//
// WHERE THE LIST COMES FROM (no new table, no migration)
//   A user's authoritative balance lives INSIDE their WalletDO, so there is nothing to
//   SELECT it from. Every DO mutation is mirrored to DB_WALLET.wallet_transactions through
//   the Q_WALLET outbox (uid, type, signed amount, balance_after, created_at, ...). The list
//   is a GROUP BY uid over that table: topped_up = Σ topup credits, spent = Σ debits (admin
//   corrections excluded), last_activity = MAX(created_at), balance = balance_after of the
//   newest row that carries one. That is an eventually-consistent mirror, so the list is
//   labelled as such and the DETAIL view always asks the DO itself (walletOp balance).
//   Rejected: a wallet_balances projection — the legacy table exists in wallet.sql but nothing
//   writes it, so reviving it would mean touching the DO/queue hot path for no extra truth.
//   Names/emails/phones live in DB_META (a different D1), so the page is enriched after the
//   wallet query, and a search first resolves candidate uids in DB_META + Clerk.
import type { Env } from "../types";
import type { Admin2RouteDef } from "./admin2";
import { json } from "../util";
import { track, trackException } from "../hooks";
import { emailFor } from "../lib/identity";
import { requireAdmin } from "./admin_money";
import { walletOp } from "./wallet";
import { adjust } from "../ledger";
import { peopleQuery } from "./admin2_people";
import { clerkSearch, clerkUsers, offsetCursor, readOffset, CLERK_BATCH } from "./admin2_users";
import { ADMIN2_PAGE, phoneSql, personName } from "../lib/admin2_people_data";
import { maskE164, msParam } from "../lib/me_dashboard_logic";

const APP = "saathum";
const NO_STORE = { "cache-control": "private, no-store" };
export const MAX_ADJUST_TOKENS = 100_000;
export const MIN_REASON_CHARS = 5;
/** sort=name has to enrich names before it can order, so it looks at the most recent N wallets only. */
export const NAME_SORT_CAP = 1000;
const IN_CHUNK = 80;

const err = (status: number, error: string, message: string, extra: Record<string, unknown> = {}) =>
  json({ error, message, ...extra }, status);

async function admin(req: Request, env: Env): Promise<{ uid: string } | Response> {
  const a = await requireAdmin(req, env);
  if (a instanceof Response) {
    return a.status === 403 ? err(403, "admin_only", "You don't have admin access.") : err(a.status, "unauthorized", "Please sign in again.");
  }
  return a;
}

export const WALLET_FILTERS = ["has_balance", "topped_up", "spent_voice", "zero_balance"] as const;
export type WalletFilter = (typeof WALLET_FILTERS)[number];
export const WALLET_SORTS = ["balance", "last_activity", "name"] as const;
export type WalletSort = (typeof WALLET_SORTS)[number];

export function parseWalletFilters(raw: string | null | undefined): WalletFilter[] {
  return [...new Set((raw ?? "").split(",").map((s) => s.trim()).filter((s): s is WalletFilter => (WALLET_FILTERS as readonly string[]).includes(s)))];
}
export function parseWalletSort(raw: string | null | undefined): WalletSort {
  return (WALLET_SORTS as readonly string[]).includes(raw ?? "") ? (raw as WalletSort) : "last_activity";
}

/**
 * One row per wallet user, from the wallet_transactions mirror. Voice spend = a debit whose
 * category is call/agent/voice or whose app name says voice (feature_pricing + the voice
 * agents tag their charges that way). Admin corrections (app_name 'admin') are neither
 * top-ups nor spend.
 */
const AGG = `SELECT t.uid AS uid,
       COUNT(*) AS txns,
       COALESCE(SUM(CASE WHEN t.type='topup' AND t.amount>0 THEN t.amount ELSE 0 END),0) AS topped_up,
       COALESCE(SUM(CASE WHEN t.amount<0 AND COALESCE(t.app_name,'')<>'admin' THEN -t.amount ELSE 0 END),0) AS spent,
       COALESCE(SUM(CASE WHEN t.amount<0 AND COALESCE(t.app_name,'')<>'admin'
                          AND (COALESCE(t.category,'') IN ('call','agent','voice') OR COALESCE(t.app_name,'') LIKE '%voice%')
                         THEN -t.amount ELSE 0 END),0) AS spent_voice,
       MAX(t.created_at) AS last_activity_at,
       (SELECT b.balance_after FROM wallet_transactions b WHERE b.uid=t.uid AND b.balance_after IS NOT NULL
         ORDER BY b.created_at DESC, b.id DESC LIMIT 1) AS balance
  FROM wallet_transactions t`;

export type WalletListFilters = {
  uids?: string[] | null;
  filter?: string | null; sort?: string | null;
  from?: number | null; to?: number | null;
  offset?: number; limit?: number;
};

function walletWhere(f: WalletListFilters): { inner: string; outer: string; binds: unknown[] } {
  const binds: unknown[] = [];
  const ref = (v: unknown) => { binds.push(v); return `?${binds.length}`; };
  const inner = f.uids ? ` WHERE t.uid IN (${f.uids.length ? f.uids.map((u) => ref(u)).join(",") : "NULL"})` : "";
  const parts: string[] = [];
  const fl = parseWalletFilters(f.filter);
  if (fl.includes("has_balance")) parts.push("COALESCE(p.balance,0)>0");
  if (fl.includes("zero_balance")) parts.push("COALESCE(p.balance,0)<=0");
  if (fl.includes("topped_up")) parts.push("p.topped_up>0");
  if (fl.includes("spent_voice")) parts.push("p.spent_voice>0");
  if (f.from != null) parts.push(`p.last_activity_at>=${ref(f.from)}`);
  if (f.to != null) parts.push(`p.last_activity_at<=${ref(f.to)}`);
  return { inner, outer: parts.length ? " WHERE " + parts.join(" AND ") : "", binds };
}

const ORDER: Record<WalletSort, string> = {
  balance: "COALESCE(p.balance,0) DESC, p.last_activity_at DESC, p.uid ASC",
  last_activity: "p.last_activity_at DESC, p.uid ASC",
  name: "p.last_activity_at DESC, p.uid ASC", // re-ordered in memory after names are known
};

export function buildWalletsQuery(f: WalletListFilters): { sql: string; binds: unknown[] } {
  const { inner, outer, binds } = walletWhere(f);
  const sort = parseWalletSort(f.sort);
  const limit = Math.max(1, Math.min(NAME_SORT_CAP, f.limit ?? ADMIN2_PAGE + 1));
  const offset = Math.max(0, Math.floor(f.offset ?? 0));
  return { sql: `SELECT * FROM (${AGG}${inner} GROUP BY t.uid) p${outer} ORDER BY ${ORDER[sort]} LIMIT ${limit} OFFSET ${offset}`, binds };
}

export function buildWalletTotalsQuery(f: WalletListFilters): { sql: string; binds: unknown[] } {
  const { inner, outer, binds } = walletWhere(f);
  return {
    sql: `SELECT COUNT(*) AS wallets, COALESCE(SUM(MAX(COALESCE(p.balance,0),0)),0) AS balance_tokens,
                 COALESCE(SUM(p.topped_up),0) AS topped_up_tokens, COALESCE(SUM(p.spent),0) AS spent_tokens
            FROM (${AGG}${inner} GROUP BY t.uid) p${outer}`,
    binds,
  };
}

// ---------------------------------------------------------------------------
// People (DB_META + Clerk)
// ---------------------------------------------------------------------------
const esc = (s: string) => s.replace(/[\\%_]/g, (ch) => "\\" + ch);

/** Candidate uids for a search box: name / uid prefix / email hash / phone in DB_META, plus Clerk's own search. */
export async function resolveSearchUids(env: Env, raw: string | null): Promise<string[] | null> {
  const q = await peopleQuery(raw);
  if (!q) return null;
  const binds: unknown[] = [];
  const ref = (v: unknown) => { binds.push(v); return `?${binds.length}`; };
  const sub = ref(`%${esc(q.text.toLowerCase())}%`);
  const ors = [
    `lower(COALESCE(u.display_name,'')) LIKE ${sub} ESCAPE '\\'`,
    `lower(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) LIKE ${sub} ESCAPE '\\'`,
    `u.uid LIKE ${ref(`${esc(q.text)}%`)} ESCAPE '\\'`,
  ];
  if (q.emailHash) ors.push(`u.email_hash=${ref(q.emailHash)}`);
  if (q.phoneHash) ors.push(`u.phone_hash=${ref(q.phoneHash)}`, `u.uid IN (SELECT po.uid FROM phone_otp po WHERE po.phone_hash=${ref(q.phoneHash)})`);
  if (q.phoneLast4) ors.push(`COALESCE(${phoneSql("u.uid", "u")},'') LIKE ${ref(`%${q.phoneLast4}`)}`);
  const found = new Set<string>([q.text]); // a pasted uid works even without a users row
  try {
    const rs = await env.DB_META.prepare(`SELECT u.uid FROM users u WHERE ${ors.join(" OR ")} LIMIT 200`).bind(...binds).all<{ uid: string }>();
    for (const r of rs.results ?? []) found.add(String(r.uid));
  } catch (e) {
    await trackException(env, e, { route: "/api/admin/v2/wallets", method: "GET", handled: true, app_name: APP, extra: { area: "admin2_wallets", step: "search_users" } });
  }
  for (const id of await clerkSearch(env, q.text)) found.add(id);
  return [...found];
}

interface Person { name: string | null; phone_masked: string | null }

async function people(env: Env, uids: string[]): Promise<Map<string, Person>> {
  const out = new Map<string, Person>();
  const uniq = [...new Set(uids)];
  for (let i = 0; i < uniq.length; i += IN_CHUNK) {
    const chunk = uniq.slice(i, i + IN_CHUNK);
    try {
      const rs = await env.DB_META.prepare(
        `SELECT u.uid AS uid, u.display_name, u.first_name, u.last_name, ${phoneSql("u.uid", "u")} AS phone_e164
           FROM users u WHERE u.uid IN (${chunk.map((_, k) => `?${k + 1}`).join(",")})`,
      ).bind(...chunk).all<any>();
      for (const r of rs.results ?? []) out.set(String(r.uid), { name: personName(r), phone_masked: maskE164(r.phone_e164 ?? null) });
    } catch (e) {
      await trackException(env, e, { route: "/api/admin/v2/wallets", method: "GET", handled: true, app_name: APP, extra: { area: "admin2_wallets", step: "people" } });
    }
  }
  return out;
}

async function emails(env: Env, uids: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const clerk = await clerkUsers(env, uids.slice(0, CLERK_BATCH * 5));
  for (const [id, c] of clerk) out.set(id, c.email);
  const missing = uids.filter((u) => !out.has(u));
  for (let i = 0; i < missing.length; i += 8) {
    const got = await Promise.all(missing.slice(i, i + 8).map(async (id) => [id, await emailFor(env, id).catch(() => null)] as const));
    for (const [id, e] of got) out.set(id, e);
  }
  return out;
}

const n0 = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : 0; };

function walletItem(r: any, p: Person | undefined, email: string | null) {
  return {
    uid: String(r.uid), name: p?.name ?? null, email, phone_masked: p?.phone_masked ?? null,
    balance_tokens: n0(r.balance), topped_up_tokens: n0(r.topped_up), spent_tokens: n0(r.spent), spent_voice_tokens: n0(r.spent_voice),
    last_activity_at: r.last_activity_at != null ? Number(r.last_activity_at) : null,
    transactions: n0(r.txns),
  };
}

// ---------------------------------------------------------------------------
// GET /api/admin/v2/wallets
// ---------------------------------------------------------------------------
export async function adminV2Wallets(req: Request, env: Env): Promise<Response> {
  const a = await admin(req, env); if (a instanceof Response) return a;
  const u = new URL(req.url).searchParams;
  const offset = readOffset(u.get("cursor"));
  if (offset === null) return err(400, "invalid_cursor", "That page link is no longer valid. Reload the list.");
  const uids = await resolveSearchUids(env, u.get("q"));
  const sort = parseWalletSort(u.get("sort"));
  const f: WalletListFilters = { uids, filter: u.get("filter"), sort, from: msParam(u.get("from")), to: msParam(u.get("to")) };

  const byName = sort === "name";
  const q = buildWalletsQuery(byName ? { ...f, offset: 0, limit: NAME_SORT_CAP } : { ...f, offset, limit: ADMIN2_PAGE + 1 });
  const tq = offset === 0 ? buildWalletTotalsQuery(f) : null;
  const [rs, tot] = await Promise.all([
    env.DB_WALLET.prepare(q.sql).bind(...q.binds).all<any>(),
    tq ? env.DB_WALLET.prepare(tq.sql).bind(...tq.binds).first<Record<string, number>>() : Promise.resolve(null),
  ]);
  let rows = rs.results ?? [];
  let hasMore: boolean;
  let ppl: Map<string, Person>;
  if (byName) {
    ppl = await people(env, rows.map((r) => String(r.uid)));
    const key = (r: any) => (ppl.get(String(r.uid))?.name ?? "~").toLowerCase();
    rows = [...rows].sort((x, y) => key(x).localeCompare(key(y)) || String(x.uid).localeCompare(String(y.uid)));
    hasMore = rows.length > offset + ADMIN2_PAGE;
    rows = rows.slice(offset, offset + ADMIN2_PAGE);
  } else {
    hasMore = rows.length > ADMIN2_PAGE;
    rows = rows.slice(0, ADMIN2_PAGE);
    ppl = await people(env, rows.map((r) => String(r.uid)));
  }
  const em = await emails(env, rows.map((r) => String(r.uid)));
  return json({
    items: rows.map((r) => walletItem(r, ppl.get(String(r.uid)), em.get(String(r.uid)) ?? null)),
    ...(hasMore ? { next_cursor: offsetCursor(offset + ADMIN2_PAGE) } : {}),
    ...(tot ? { totals: Object.fromEntries(Object.entries(tot).map(([k, v]) => [k, Number(v ?? 0)])) } : {}),
    sort,
    source: "wallet_transactions_mirror",
  }, 200, NO_STORE);
}

// ---------------------------------------------------------------------------
// GET /api/admin/v2/wallets/:uid — the live balance, the statement and the profile.
// ---------------------------------------------------------------------------
const validUid = (uid: string) => !!uid && uid.length <= 200 && !/[\s/]/.test(uid);

export async function adminV2Wallet(req: Request, env: Env, uid: string): Promise<Response> {
  const a = await admin(req, env); if (a instanceof Response) return a;
  if (!validUid(uid)) return err(404, "not_found", "We couldn't find that user.");
  const [live, stmt, agg, ppl, clerk] = await Promise.all([
    walletOp(env, uid, { op: "balance", uid } as any),
    env.DB_WALLET.prepare(
      `SELECT id, type, amount, balance_after, app_name, category, context, ref, status, created_at
         FROM wallet_transactions WHERE uid=?1 ORDER BY created_at DESC, id DESC LIMIT 100`,
    ).bind(uid).all<any>(),
    env.DB_WALLET.prepare(`SELECT * FROM (${AGG} WHERE t.uid=?1 GROUP BY t.uid) p`).bind(uid).first<any>(),
    people(env, [uid]),
    clerkUsers(env, [uid]),
  ]);
  if (live.status !== 200) return err(502, "wallet_unavailable", "The live balance could not be read. Please try again.");
  const p = ppl.get(uid);
  const c = clerk.get(uid);
  const email = c?.email ?? (await emailFor(env, uid).catch(() => null));
  const clerkName = [c?.first_name, c?.last_name].map((s) => (s ?? "").trim()).filter(Boolean).join(" ") || null;
  const b = live.body ?? {};
  return json({
    uid,
    profile: { name: p?.name ?? clerkName, email, phone_masked: p?.phone_masked ?? null, profile_url: `/admin/users?user=${encodeURIComponent(uid)}` },
    live: {
      balance_tokens: n0(b.balance), held_tokens: n0(b.held), free_tokens: n0(b.free), bonus_tokens: n0(b.bonus),
      spendable_tokens: n0(b.spendable), as_of: Date.now(),
    },
    totals: agg ? walletItem(agg, p, email) : null,
    statement: (stmt.results ?? []).map((r) => ({
      id: String(r.id), type: String(r.type ?? ""), amount_tokens: n0(r.amount), balance_after_tokens: r.balance_after != null ? n0(r.balance_after) : null,
      app_name: r.app_name ?? null, category: r.category ?? null, context: r.context ?? null, ref: r.ref ?? null,
      status: r.status ?? null, created_at: Number(r.created_at ?? 0),
    })),
  }, 200, NO_STORE);
}

// ---------------------------------------------------------------------------
// POST /api/admin/v2/wallets/:uid/adjust
// ---------------------------------------------------------------------------
async function readBody(req: Request): Promise<Record<string, unknown>> {
  const t = await req.text().catch(() => "");
  if (!t || t.length > 4096) return {};
  try { const v = JSON.parse(t); return v && typeof v === "object" ? v as Record<string, unknown> : {}; } catch { return {}; }
}

async function audit(env: Env, adminUid: string, target: string, meta: Record<string, unknown>): Promise<void> {
  try {
    await env.DB_WALLET.prepare(
      "INSERT INTO admin_audit (id, admin_id, action, target, meta, created_at) VALUES (?1,?2,?3,?4,?5,?6)",
    ).bind(crypto.randomUUID(), adminUid, "wallet_adjust", target, JSON.stringify(meta), Date.now()).run();
  } catch (e) {
    // The money already moved; a missing audit row is reported, never swallowed.
    await trackException(env, e, { route: "/api/admin/v2/wallets/:uid/adjust", method: "POST", handled: true, app_name: APP, extra: { area: "admin2_wallets", step: "admin_audit" } });
  }
}

export async function adminV2WalletAdjust(req: Request, env: Env, uid: string): Promise<Response> {
  const a = await admin(req, env); if (a instanceof Response) return a;
  if (!validUid(uid)) return err(404, "not_found", "We couldn't find that user.");
  const key = (req.headers.get("idempotency-key") ?? "").trim();
  if (!/^[A-Za-z0-9._:-]{8,80}$/.test(key)) return err(400, "idempotency_key_required", "This request needs an Idempotency-Key header (8 to 80 letters or digits).");
  const b = await readBody(req);
  const amount = typeof b.amount_tokens === "number" ? b.amount_tokens : Number(b.amount_tokens);
  const reason = typeof b.reason === "string" ? b.reason.trim().slice(0, 300) : "";
  if (!Number.isInteger(amount) || amount === 0) return err(400, "invalid_amount", "Enter a whole number of tokens (₹), not zero.");
  if (Math.abs(amount) > MAX_ADJUST_TOKENS) return err(400, "amount_too_large", `One adjustment can be at most ₹${MAX_ADJUST_TOKENS.toLocaleString("en-IN")}.`);
  if (reason.length < MIN_REASON_CHARS) return err(400, "reason_required", `Write a reason of at least ${MIN_REASON_CHARS} characters. It is kept in the audit log.`);

  // Only real accounts: a typo must not conjure a wallet.
  const known = await env.DB_META.prepare("SELECT 1 AS ok FROM users WHERE uid=?1").bind(uid).first<{ ok: number }>().catch(() => null)
    ?? await env.DB_WALLET.prepare("SELECT 1 AS ok FROM wallet_transactions WHERE uid=?1 LIMIT 1").bind(uid).first<{ ok: number }>().catch(() => null);
  if (!known) return err(404, "not_found", "We couldn't find that user.");

  const opId = `admwal:${uid}:${key}`;
  if (amount < 0) {
    const live = await walletOp(env, uid, { op: "balance", uid } as any);
    const have = n0(live.body?.balance);
    // A replay of an already-applied deduct must return the original result, not a false "too low".
    const seen = await walletOp(env, uid, { op: "op_result", uid, op_id: opId } as any);
    if (!(seen.status === 200 && seen.body?.found) && -amount > have) {
      await track(env, a.uid, "admin_wallet_adjusted", APP, { admin_uid: a.uid, uid, amount, reason, ok: false, refused: "below_zero" }).catch(() => {});
      return err(409, "insufficient_balance", `They only have ₹${have.toLocaleString("en-IN")}. A deduction can't take the balance below zero.`, { balance_tokens: have });
    }
  }
  const r = await adjust(env, uid, amount, `admin: ${reason}`, a.uid, opId);
  const duplicate = r.body?.duplicate === true;
  if (!duplicate) {
    await audit(env, a.uid, uid, { amount_tokens: amount, reason, op_id: opId, ok: r.ok, status: r.status });
    await track(env, a.uid, "admin_wallet_adjusted", APP, { admin_uid: a.uid, uid, amount, reason, ok: r.ok }).catch(() => {});
  }
  if (!r.ok) {
    if (r.status === 402) return err(409, "insufficient_balance", "A deduction can't take the balance below zero.");
    return err(r.status >= 400 && r.status < 600 ? r.status : 502, "adjust_failed", "The wallet could not be changed. Nothing was changed; please try again.");
  }
  return json({
    ok: true, duplicate, amount_tokens: amount,
    balance_tokens: n0(r.body?.balance), spendable_tokens: n0(r.body?.spendable), held_tokens: n0(r.body?.held),
  }, 200, NO_STORE);
}

export const ADMIN2_WALLET_ROUTES: Admin2RouteDef[] = [
  { method: "GET", path: "/api/admin/v2/wallets", handler: (req, env) => adminV2Wallets(req, env) },
  { method: "GET", path: /^\/api\/admin\/v2\/wallets\/([^/]+)$/, handler: (req, env, p) => adminV2Wallet(req, env, p[0]) },
  { method: "POST", path: /^\/api\/admin\/v2\/wallets\/([^/]+)\/adjust$/, handler: (req, env, p) => adminV2WalletAdjust(req, env, p[0]) },
];
