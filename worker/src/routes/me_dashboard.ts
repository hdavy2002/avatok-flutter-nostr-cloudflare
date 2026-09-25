// [DASH2-API 2026-09-25] Customer dashboard (Dashboard 2) API.
// Contract: Specs/SPEC-2026-09-25-DASHBOARD-2.md "API contract (worker)". Every route
// requires Clerk auth and returns ONLY the caller's rows. Money on the wire is integer
// PAISE. Errors are { error, message } with a real status; unexpected failures go to
// PostHog through hooks.trackException (see meDashboardRoute) — no silent catch.
//
// Receipts: lib/me_receipt_pdf.ts. Pure rules (state, refund window, VPA, cursor):
// lib/me_dashboard_logic.ts. SQL read models: lib/me_dashboard_data.ts.
import type { Env } from "../types";
import { json, sha256Hex } from "../util";
import { requireUser, isFail } from "../authz";
import { trackException, trackUser } from "../hooks";
import { emailFor } from "../lib/identity";
import { requireAdmin } from "./admin_money";
import { HIDDEN_LISTING_SQL } from "./listings";
import { notStuckLiveSql } from "../lib/listing_schedule";
import {
  indianMobileE164, twoFactor, phoneTakenByOther, OTP_TTL_MS, RESEND_GAP_MS, HOUR_MS,
  MAX_SENDS_PER_UID_HOUR, MAX_SENDS_PER_PHONE_HOUR, MAX_SENDS_GLOBAL_HOUR, MAX_VERIFY_ATTEMPTS,
} from "./phone_otp";
import {
  eventState, isUpcomingScope, refundEligibility, normalizeVpa, encodeCursor, decodeCursor,
  maskE164, rupeesParamToPaise, msParam, istTimeOfDay, istYear, PAGE_SIZE,
  PHONE_SENDS_PER_WINDOW, PHONE_SEND_WINDOW_MS, validateProfilePatch, parseYoutubeVideoId, type TimeOfDay,
} from "../lib/me_dashboard_logic";
import {
  buildPaymentsQuery, EVENTS_SQL, PAYMENT_OWNER_SQL, shapeListing, startsMsSql, phoneSwapStatements, type PaymentRow,
} from "../lib/me_dashboard_data";
import { renderReceiptPdf } from "../lib/me_receipt_pdf";

const APP = "saathum";

const err = (status: number, error: string, message: string, extra: Record<string, unknown> = {}) =>
  json({ error, message, ...extra }, status);

async function authed(req: Request, env: Env): Promise<{ uid: string } | Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return err(ctx.status, ctx.status === 401 ? "unauthorized" : ctx.error, "Please sign in again.");
  return { uid: ctx.uid };
}

async function body(req: Request, max = 8192): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (text.length > max) return null;
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

/** Telemetry with the caller's email (identity.ts: KV-cached Clerk lookup). */
async function tel(env: Env, uid: string, event: string, props: Record<string, unknown>): Promise<void> {
  const email = await emailFor(env, uid).catch(() => null);
  await trackUser(env, uid, email, event, APP, props);
}

// ---------------------------------------------------------------------------
// GET /api/me/catalog?q&cat&from&to&tod&min&max
// ---------------------------------------------------------------------------
export async function meCatalog(req: Request, env: Env): Promise<Response> {
  const a = await authed(req, env); if (a instanceof Response) return a;
  const u = new URL(req.url).searchParams;
  const now = Date.now();
  const binds: unknown[] = [now];
  const where = [
    "l.status IN ('published','live')", "l.kind='live_event'", "COALESCE(l.is_example,0)=0",
    HIDDEN_LISTING_SQL,
    // Saathum's keep-list IS the set of active categories (2026-09-20-saathum-taxonomy.sql).
    "l.category IN (SELECT id FROM listing_categories WHERE active=1)",
    `((l.status='live' AND ${notStuckLiveSql("l", "?1")}) OR ${startsMsSql("l")} > ?1)`,
  ];
  const q = (u.get("q") ?? "").trim();
  if (q) {
    const tokens = q.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean).slice(0, 6);
    if (tokens.length) {
      const match = `{title description category} : (${tokens.map((t) => `"${t}"*`).join(" OR ")})`;
      const ids = await env.DB_META.prepare("SELECT listing_id FROM listings_fts WHERE listings_fts MATCH ?1 LIMIT 300")
        .bind(match).all<{ listing_id: string }>();
      const idList = (ids.results ?? []).map((r) => String(r.listing_id));
      if (!idList.length) return json({ categories: [], groups: [] });
      where.push(`l.id IN (${idList.map((_, i) => `?${binds.length + i + 1}`).join(",")})`);
      binds.push(...idList);
    }
  }
  const from = msParam(u.get("from")), to = msParam(u.get("to"));
  if (from != null) { binds.push(from); where.push(`${startsMsSql("l")} >= ?${binds.length}`); }
  if (to != null) { binds.push(to); where.push(`${startsMsSql("l")} <= ?${binds.length}`); }
  const min = rupeesParamToPaise(u.get("min")), max = rupeesParamToPaise(u.get("max"));
  if (min != null) { binds.push(min); where.push(`CASE WHEN l.free_entry=1 THEN 0 ELSE l.price*100 END >= ?${binds.length}`); }
  if (max != null) { binds.push(max); where.push(`CASE WHEN l.free_entry=1 THEN 0 ELSE l.price*100 END <= ?${binds.length}`); }
  const rs = await env.DB_META.prepare(
    `SELECT l.id,l.title,l.description,l.category,l.attrs,l.cover_media,l.starts_at,l.duration_min,l.price,l.free_entry,
            l.capacity,l.status,c.label AS category_label,c.sort AS category_sort,
            CASE WHEN l.capacity IS NULL THEN NULL ELSE
              (SELECT COUNT(*) FROM orders o WHERE o.listing_id=l.id AND o.status IN ('held','free','released')) END AS seats_taken
       FROM listings l LEFT JOIN listing_categories c ON c.id=l.category
      WHERE ${where.join(" AND ")}
      ORDER BY c.sort, ${startsMsSql("l")} LIMIT 300`,
  ).bind(...binds).all<any>();
  const todRaw = u.get("tod");
  const tod: TimeOfDay | null = todRaw === "morning" || todRaw === "afternoon" || todRaw === "evening" ? todRaw : null;
  let rows = (rs.results ?? []).map((r) => ({ r, l: shapeListing(r) }));
  if (tod) rows = rows.filter(({ l }) => l.starts_at != null && istTimeOfDay(l.starts_at) === tod);
  // Category chips count every match EXCEPT the category filter itself, so the
  // chips never collapse to the one selected.
  const catCounts = new Map<string, { id: string; label: string; count: number; sort: number }>();
  for (const { r, l } of rows) {
    const c = catCounts.get(l.category) ?? { id: l.category, label: l.category_label ?? l.category, count: 0, sort: Number(r.category_sort ?? 9999) };
    c.count++; catCounts.set(l.category, c);
  }
  const cat = u.get("cat");
  if (cat) rows = rows.filter(({ l }) => l.category === cat);
  const groups = new Map<string, { category: { id: string; label: string }; items: ReturnType<typeof shapeListing>[] }>();
  for (const { l } of rows) {
    const g = groups.get(l.category) ?? { category: { id: l.category, label: l.category_label ?? l.category }, items: [] };
    g.items.push(l); groups.set(l.category, g);
  }
  const categories = [...catCounts.values()].sort((x, y) => x.sort - y.sort).map(({ id, label, count }) => ({ id, label, count }));
  return json({ categories, groups: [...groups.values()] }, 200, { "cache-control": "private, no-store" });
}

// ---------------------------------------------------------------------------
// GET /api/me/events?scope=upcoming|past
// ---------------------------------------------------------------------------
export async function meEvents(req: Request, env: Env): Promise<Response> {
  const a = await authed(req, env); if (a instanceof Response) return a;
  const scope = new URL(req.url).searchParams.get("scope") === "past" ? "past" : "upcoming";
  const now = Date.now();
  const rs = await env.DB_META.prepare(EVENTS_SQL).bind(a.uid, now).all<any>();
  const items = (rs.results ?? []).map((r) => {
    const paid = Number(r.paid) === 1;
    const { state, schedule } = eventState(r, paid, now);
    const listing = shapeListing(r);
    const endsAt = r.ends_ms != null ? Number(r.ends_ms) : null;
    const item: Record<string, unknown> = {
      order_id: r.order_id ?? null, payment_id: r.payment_id, listing, state, schedule_state: schedule,
      starts_at: listing.starts_at, ends_at: endsAt,
      // Owner decision 2026-09-25: the event's unlisted YouTube video serves live AND replay.
      replay: { available: state === "ended" && (r.replay_state === "available" || (paid && !!r.youtube_video_id)) },
    };
    // Only to a seat holder (paid or free). Unpaid pending_payment rows never carry it.
    if (paid && typeof r.youtube_video_id === "string" && r.youtube_video_id) item.youtube_video_id = r.youtube_video_id;
    // The customer joins from the web live page (lib/commercial_notifications.ts link).
    if (paid && (state === "upcoming" || state === "live")) item.join_url = `/live/${encodeURIComponent(listing.id)}`;
    return item;
  }).filter((i) => (scope === "past") !== isUpcomingScope(i.state as any));
  items.sort((x: any, y: any) => scope === "past"
    ? (y.starts_at ?? 0) - (x.starts_at ?? 0)
    : (x.starts_at ?? Number.MAX_SAFE_INTEGER) - (y.starts_at ?? Number.MAX_SAFE_INTEGER));
  return json({ now, items }, 200, { "cache-control": "private, no-store" });
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------
function paymentLine(p: PaymentRow) {
  return {
    id: p.id, listing_id: p.listing_id, event_title: p.event_title, category: p.category,
    category_label: p.category_label, event_starts_at: p.event_starts_at,
    amount_paise: Number(p.amount_paise), status: p.status,
    paid_at: p.base_status === "pending" ? null : p.paid_at,
  };
}

async function loadPayment(env: Env, uid: string, id: string): Promise<PaymentRow | null> {
  if (!id || id.length > 200) return null;
  const { sql, binds } = buildPaymentsQuery(uid, Date.now(), { id, limit: 1 });
  return env.DB_META.prepare(sql).bind(...binds).first<PaymentRow>();
}

export async function mePayments(req: Request, env: Env): Promise<Response> {
  const a = await authed(req, env); if (a instanceof Response) return a;
  const u = new URL(req.url).searchParams;
  const rawCursor = u.get("cursor");
  const cursor = decodeCursor(rawCursor);
  if (rawCursor && !cursor) return err(400, "invalid_cursor", "That page link is no longer valid. Reload the list.");
  const { sql, binds } = buildPaymentsQuery(a.uid, Date.now(), {
    q: u.get("q"), cat: u.get("cat"), status: u.get("status"),
    eventFrom: msParam(u.get("event_from")), eventTo: msParam(u.get("event_to")),
    paidFrom: msParam(u.get("paid_from")), paidTo: msParam(u.get("paid_to")),
    minPaise: rupeesParamToPaise(u.get("min")), maxPaise: rupeesParamToPaise(u.get("max")),
    cursor, limit: PAGE_SIZE + 1,
  });
  const rows = (await env.DB_META.prepare(sql).bind(...binds).all<PaymentRow>()).results ?? [];
  const page = rows.slice(0, PAGE_SIZE);
  const last = page[page.length - 1];
  return json({
    items: page.map(paymentLine),
    ...(rows.length > PAGE_SIZE && last ? { next_cursor: encodeCursor({ t: Number(last.sort_ts), id: last.id }) } : {}),
  }, 200, { "cache-control": "private, no-store" });
}

function refundOf(p: PaymentRow) {
  if (!p.refund_status) return undefined;
  return {
    status: p.refund_status, requested_at: p.refund_requested_at,
    ...(p.refund_refunded_at != null ? { refunded_at: p.refund_refunded_at } : {}),
    ...(p.refund_amount_paise != null ? { amount_paise: Number(p.refund_amount_paise) } : {}),
    ...(p.refund_vpa ? { refund_vpa: p.refund_vpa } : {}),
    ...(p.refund_utr ? { refund_utr: p.refund_utr } : {}),
  };
}

const receiptAvailable = (p: PaymentRow) => p.status !== "pending";

export async function mePaymentDetail(req: Request, env: Env, id: string): Promise<Response> {
  const a = await authed(req, env); if (a instanceof Response) return a;
  const p = await loadPayment(env, a.uid, id);
  if (!p) return err(404, "not_found", "We couldn't find that payment.");
  const refund = refundOf(p);
  return json({
    ...paymentLine(p),
    // payer_vpa: the UPI rail's intent table records no payer VPA, so it is omitted.
    ...(p.utr ? { utr: p.utr } : {}),
    order_id: p.order_id,
    ...(refund ? { refund } : {}),
    can_request_refund: refundEligibility({ status: p.status, eventStartsAt: p.event_starts_at }).ok && !p.id.startsWith("agl_") && !(p.order_id ?? "").startsWith("agl_"),
    receipt_url: receiptAvailable(p) ? `/api/me/payments/${encodeURIComponent(p.id)}/receipt.pdf` : null,
  }, 200, { "cache-control": "private, no-store" });
}

async function defaultVpa(env: Env, uid: string): Promise<string | null> {
  const r = await env.DB_META.prepare("SELECT vpa FROM user_vpas WHERE uid=?1 ORDER BY is_default DESC, created_at DESC LIMIT 1")
    .bind(uid).first<{ vpa: string }>();
  return r?.vpa ?? null;
}

export async function meRefundRequest(req: Request, env: Env, id: string): Promise<Response> {
  const a = await authed(req, env); if (a instanceof Response) return a;
  const b = await body(req, 4096);
  if (!b) return err(400, "invalid_request", "Send a JSON body.");
  const reason = b.reason == null ? null : typeof b.reason === "string" ? b.reason.trim().slice(0, 500) || null : undefined;
  if (reason === undefined) return err(400, "invalid_reason", "The reason must be text.");
  const p = await loadPayment(env, a.uid, id);
  if (!p) return err(404, "not_found", "We couldn't find that payment.");
  // [AGENT-LIVE-1 M1/M6] agl_ orders move money only through the agent-live authority.
  if (p.id.startsWith("agl_") || (p.order_id ?? "").startsWith("agl_")) {
    return err(409, "not_refundable_here", "This booking can't be refunded from the dashboard. Please contact support@saathum.com.");
  }
  const now = Date.now();
  const ok = refundEligibility({ status: p.status, eventStartsAt: p.event_starts_at, now });
  if (!ok.ok) {
    await tel(env, a.uid, "dash2_refund_request", { payment_id: p.id, ok: false, reason_code: ok.error });
    return err(409, ok.error, ok.message);
  }
  const refundId = crypto.randomUUID();
  const vpa = await defaultVpa(env, a.uid);
  const res = await env.DB_META.prepare(
    `INSERT INTO refunds (id,payment_id,uid,amount_paise,reason,status,refund_vpa,requested_at)
     SELECT ?1,?2,?3,?4,?5,'requested',?6,?7
      WHERE NOT EXISTS (SELECT 1 FROM refunds WHERE payment_id=?2 AND status IN ('requested','refunded'))`,
  ).bind(refundId, p.id, a.uid, Number(p.amount_paise), reason, vpa, now).run();
  if (!res.meta.changes) return err(409, "refund_already_requested", "A refund has already been requested for this payment.");
  await tel(env, a.uid, "dash2_refund_request", {
    payment_id: p.id, order_id: p.order_id, listing_id: p.listing_id, ok: true,
    amount_paise: Number(p.amount_paise), has_refund_vpa: !!vpa, hours_before_event: p.event_starts_at ? Math.floor((p.event_starts_at - now) / 3_600_000) : null,
  });
  return json({
    ok: true,
    refund: { status: "requested", requested_at: now, amount_paise: Number(p.amount_paise), ...(vpa ? { refund_vpa: vpa } : {}) },
  });
}

// ---------------------------------------------------------------------------
// GET /api/me/payments/:id/receipt.pdf
// ---------------------------------------------------------------------------
async function ensureReceiptRow(env: Env, uid: string, paymentId: string, now: number): Promise<{ receipt_no: string; r2_key: string; created_at: number }> {
  const read = () => env.DB_META.prepare("SELECT receipt_no,r2_key,created_at FROM receipts WHERE payment_id=?1 AND uid=?2")
    .bind(paymentId, uid).first<{ receipt_no: string; r2_key: string; created_at: number }>();
  const existing = await read();
  if (existing) return existing;
  const year = String(istYear(now));
  const next = `'SH-'||?4||'-'||printf('%06d', COALESCE(MAX(CAST(substr(receipt_no,9) AS INTEGER)),0)+1)`;
  const insert = () => env.DB_META.prepare(
    `INSERT INTO receipts (id,payment_id,uid,receipt_no,r2_key,created_at)
     SELECT ?1, ?2, ?3, ${next}, 'receipts/'||?3||'/'||${next}||'.pdf', ?5
       FROM receipts WHERE receipt_no LIKE 'SH-'||?4||'-%'
     ON CONFLICT(payment_id) DO NOTHING`,
  ).bind(crypto.randomUUID(), paymentId, uid, year, now).run();
  try { await insert(); }
  catch (e) {
    // Two receipts racing for the same number: the UNIQUE(receipt_no) loser retries once.
    if (!/UNIQUE/i.test(String(e))) throw e;
    await insert();
  }
  const row = await read();
  if (!row) throw new Error("receipt row missing after insert");
  return row;
}

export async function meReceiptPdf(req: Request, env: Env, id: string): Promise<Response> {
  const a = await authed(req, env); if (a instanceof Response) return a;
  const p = await loadPayment(env, a.uid, id);
  if (!p) return err(404, "not_found", "We couldn't find that payment.");
  if (!receiptAvailable(p)) return err(409, "not_paid", "A receipt is available once the payment is confirmed.");
  const now = Date.now();
  const receipt = await ensureReceiptRow(env, a.uid, p.id, now);
  const stamp = p.status === "refunded" ? "REFUNDED" : "PAID";
  const filename = `${receipt.receipt_no}.pdf`;
  const headers = {
    "content-type": "application/pdf",
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "private, no-store",
  };
  const cached = await env.DIGITAL.get(receipt.r2_key);
  // Generated once; regenerated only when the stamp changes (PAID -> REFUNDED).
  if (cached && cached.customMetadata?.stamp === stamp) {
    return new Response(cached.body, { headers: { ...headers } });
  }
  const [profile, email, addr] = await Promise.all([
    env.DB_META.prepare("SELECT display_name, first_name, last_name FROM users WHERE uid=?1").bind(a.uid).first<any>(),
    emailFor(env, a.uid).catch(() => null),
    env.DB_META.prepare("SELECT name,line1,line2,city,state,pin,country FROM user_addresses WHERE uid=?1").bind(a.uid).first<any>(),
  ]);
  const listing = await env.DB_META.prepare("SELECT title, starts_at, duration_min FROM listings WHERE id=?1").bind(p.listing_id).first<any>();
  const name = addr?.name || profile?.display_name || [profile?.first_name, profile?.last_name].filter(Boolean).join(" ") || null;
  const cityLine = [addr?.city, addr?.state, addr?.pin].filter(Boolean).join(", ");
  const pdf = await renderReceiptPdf({
    receiptNo: receipt.receipt_no, issuedAt: Number(receipt.created_at),
    billedTo: { name, email, address: [addr?.line1, addr?.line2, cityLine, addr?.country].filter(Boolean) as string[] },
    item: { title: p.event_title ?? listing?.title ?? "Saathum booking", startsAt: p.event_starts_at, durationMin: listing?.duration_min ?? null },
    amountPaise: Number(p.amount_paise), paidAt: p.paid_at, utr: p.utr, payerVpa: null,
    paymentId: p.id, orderId: p.order_id, status: stamp,
    refund: stamp === "REFUNDED" ? { amountPaise: p.refund_amount_paise, utr: p.refund_utr, at: p.refund_refunded_at } : null,
  });
  await env.DIGITAL.put(receipt.r2_key, pdf, {
    httpMetadata: { contentType: "application/pdf" },
    customMetadata: { stamp, uid: a.uid, payment_id: p.id },
  });
  await tel(env, a.uid, "dash2_receipt_generated", {
    payment_id: p.id, receipt_no: receipt.receipt_no, stamp, regenerated: !!cached, bytes: pdf.byteLength,
  });
  return new Response(pdf, { headers });
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------
const DEFAULT_NOTIFY = { push: false, email: true, whatsapp: false };

function parseJsonSafe<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

async function verifiedPhone(env: Env, uid: string): Promise<{ e164: string | null; verified: boolean }> {
  const cv = await env.DB_META.prepare("SELECT phone_verified, phone_hash FROM contact_verification WHERE uid=?1")
    .bind(uid).first<{ phone_verified: number; phone_hash: string | null }>();
  const verified = !!cv && Number(cv.phone_verified) === 1 && !!cv.phone_hash;
  if (!verified) return { e164: null, verified: false };
  const r = await env.DB_META.prepare(
    "SELECT e164 FROM phone_otp WHERE uid=?1 AND phone_hash=?2 AND status='verified' ORDER BY verified_at DESC LIMIT 1",
  ).bind(uid, cv!.phone_hash).first<{ e164: string }>();
  return { e164: r?.e164 ?? null, verified: true };
}

export async function meProfileGet(req: Request, env: Env): Promise<Response> {
  const a = await authed(req, env); if (a instanceof Response) return a;
  const db = env.DB_META;
  const [user, extras, addr, vpas, phone, email] = await Promise.all([
    db.prepare("SELECT display_name, first_name, last_name, avatar_url FROM users WHERE uid=?1").bind(a.uid).first<any>(),
    db.prepare("SELECT gotra, family_json, language, notify_json FROM user_profile_extras WHERE uid=?1").bind(a.uid).first<any>(),
    db.prepare("SELECT name,line1,line2,city,state,pin,country FROM user_addresses WHERE uid=?1").bind(a.uid).first<any>(),
    db.prepare("SELECT id, vpa, is_default FROM user_vpas WHERE uid=?1 ORDER BY is_default DESC, created_at ASC").bind(a.uid).all<any>(),
    verifiedPhone(env, a.uid),
    emailFor(env, a.uid).catch(() => null),
  ]);
  const name = user?.display_name || [user?.first_name, user?.last_name].filter(Boolean).join(" ") || null;
  return json({
    name, email,
    ...(user?.avatar_url ? { photo_url: user.avatar_url } : {}),
    ...(extras?.language ? { language: extras.language } : {}),
    ...(extras?.gotra ? { gotra: extras.gotra } : {}),
    family: parseJsonSafe<unknown[]>(extras?.family_json, []),
    phone: { e164_masked: maskE164(phone.e164), verified: phone.verified },
    vpas: (vpas.results ?? []).map((v) => ({ id: v.id, vpa: v.vpa, is_default: Number(v.is_default) === 1 })),
    ...(addr ? { address: { name: addr.name, line1: addr.line1, line2: addr.line2, city: addr.city, state: addr.state, pin: addr.pin, country: addr.country } } : {}),
    notify: { ...DEFAULT_NOTIFY, ...parseJsonSafe<Record<string, boolean>>(extras?.notify_json, {}) },
  }, 200, { "cache-control": "private, no-store" });
}

export async function meProfilePut(req: Request, env: Env): Promise<Response> {
  const a = await authed(req, env); if (a instanceof Response) return a;
  const b = await body(req, 16384);
  if (!b) return err(400, "invalid_request", "Send a JSON body.");
  if ("phone" in b || "vpas" in b || "email" in b) return err(400, "not_editable", "Phone, email and UPI ids are changed with their own actions.");
  const v = validateProfilePatch(b);
  if ("invalid" in v) return err(400, "invalid_field", v.invalid.message, { field: v.invalid.field });
  const p = v.patch, db = env.DB_META, now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  if ("name" in p) stmts.push(db.prepare("UPDATE users SET display_name=?2, updated_at=?3 WHERE uid=?1").bind(a.uid, p.name, now));
  if ("gotra" in p || "language" in p || "family" in p || "notify" in p) {
    const cur = await db.prepare("SELECT notify_json FROM user_profile_extras WHERE uid=?1").bind(a.uid).first<{ notify_json: string | null }>();
    const notify = "notify" in p ? JSON.stringify({ ...DEFAULT_NOTIFY, ...parseJsonSafe(cur?.notify_json, {}), ...p.notify }) : null;
    stmts.push(db.prepare(
      `INSERT INTO user_profile_extras (uid,gotra,family_json,language,notify_json,updated_at) VALUES (?1,?2,?3,?4,?5,?6)
       ON CONFLICT(uid) DO UPDATE SET
         gotra=CASE WHEN ?7 THEN excluded.gotra ELSE gotra END,
         family_json=CASE WHEN ?8 THEN excluded.family_json ELSE family_json END,
         language=CASE WHEN ?9 THEN excluded.language ELSE language END,
         notify_json=CASE WHEN ?10 THEN excluded.notify_json ELSE notify_json END,
         updated_at=excluded.updated_at`,
    ).bind(a.uid, p.gotra ?? null, "family" in p ? JSON.stringify(p.family) : null, p.language ?? null, notify, now,
      "gotra" in p ? 1 : 0, "family" in p ? 1 : 0, "language" in p ? 1 : 0, "notify" in p ? 1 : 0));
  }
  if ("address" in p) {
    if (p.address === null) stmts.push(db.prepare("DELETE FROM user_addresses WHERE uid=?1").bind(a.uid));
    else {
      const ad = p.address;
      stmts.push(db.prepare(
        `INSERT INTO user_addresses (uid,name,line1,line2,city,state,pin,country,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
         ON CONFLICT(uid) DO UPDATE SET name=excluded.name,line1=excluded.line1,line2=excluded.line2,city=excluded.city,
           state=excluded.state,pin=excluded.pin,country=excluded.country,updated_at=excluded.updated_at`,
      ).bind(a.uid, ad.name, ad.line1, ad.line2, ad.city, ad.state, ad.pin, ad.country, now));
    }
  }
  if (stmts.length) await db.batch(stmts);
  return meProfileGet(new Request(req.url, { method: "GET", headers: req.headers }), env);
}

// ---------------------------------------------------------------------------
// UPI ids
// ---------------------------------------------------------------------------
const MAX_VPAS = 10;
async function vpaList(env: Env, uid: string) {
  const rs = await env.DB_META.prepare("SELECT id, vpa, is_default FROM user_vpas WHERE uid=?1 ORDER BY is_default DESC, created_at ASC").bind(uid).all<any>();
  return (rs.results ?? []).map((v) => ({ id: v.id, vpa: v.vpa, is_default: Number(v.is_default) === 1 }));
}

export async function meVpaAdd(req: Request, env: Env): Promise<Response> {
  const a = await authed(req, env); if (a instanceof Response) return a;
  const b = await body(req, 2048);
  if (!b) return err(400, "invalid_request", "Send a JSON body.");
  const vpa = normalizeVpa(b.vpa);
  if (!vpa) return err(400, "invalid_vpa", "Enter a valid UPI id, like name@bank.", { field: "vpa" });
  const db = env.DB_META, now = Date.now(), id = crypto.randomUUID();
  const res = await db.prepare(
    `INSERT INTO user_vpas (id,uid,vpa,is_default,created_at)
     SELECT ?1,?2,?3, CASE WHEN EXISTS(SELECT 1 FROM user_vpas WHERE uid=?2) THEN 0 ELSE 1 END, ?4
      WHERE (SELECT COUNT(*) FROM user_vpas WHERE uid=?2) < ?5
        AND NOT EXISTS (SELECT 1 FROM user_vpas WHERE uid=?2 AND vpa=?3)`,
  ).bind(id, a.uid, vpa, now, MAX_VPAS).run();
  if (!res.meta.changes) {
    const dup = await db.prepare("SELECT 1 FROM user_vpas WHERE uid=?1 AND vpa=?2").bind(a.uid, vpa).first();
    return dup ? err(409, "vpa_exists", "That UPI id is already saved.", { field: "vpa" })
      : err(409, "too_many_vpas", `You can save up to ${MAX_VPAS} UPI ids.`, { field: "vpa" });
  }
  const vpas = await vpaList(env, a.uid);
  return json({ ok: true, vpa: vpas.find((v) => v.id === id), vpas }, 201);
}

export async function meVpaDelete(req: Request, env: Env, id: string): Promise<Response> {
  const a = await authed(req, env); if (a instanceof Response) return a;
  const db = env.DB_META;
  const row = await db.prepare("SELECT is_default FROM user_vpas WHERE id=?1 AND uid=?2").bind(id, a.uid).first<{ is_default: number }>();
  if (!row) return err(404, "not_found", "That UPI id isn't saved on your account.");
  const stmts = [db.prepare("DELETE FROM user_vpas WHERE id=?1 AND uid=?2").bind(id, a.uid)];
  if (Number(row.is_default) === 1) {
    // Promote the oldest remaining id so there is still a default refund VPA.
    stmts.push(db.prepare(
      `UPDATE user_vpas SET is_default=1 WHERE id=(SELECT id FROM user_vpas WHERE uid=?1 ORDER BY created_at ASC LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM user_vpas WHERE uid=?1 AND is_default=1)`,
    ).bind(a.uid));
  }
  await db.batch(stmts);
  return json({ ok: true, vpas: await vpaList(env, a.uid) });
}

export async function meVpaDefault(req: Request, env: Env, id: string): Promise<Response> {
  const a = await authed(req, env); if (a instanceof Response) return a;
  const db = env.DB_META;
  const row = await db.prepare("SELECT 1 FROM user_vpas WHERE id=?1 AND uid=?2").bind(id, a.uid).first();
  if (!row) return err(404, "not_found", "That UPI id isn't saved on your account.");
  await db.batch([
    db.prepare("UPDATE user_vpas SET is_default=0 WHERE uid=?1 AND id<>?2 AND is_default=1").bind(a.uid, id),
    db.prepare("UPDATE user_vpas SET is_default=1 WHERE uid=?1 AND id=?2").bind(a.uid, id),
  ]);
  return json({ ok: true, vpas: await vpaList(env, a.uid) });
}

// ---------------------------------------------------------------------------
// Phone change — OTP to the NEW number, then ONE-transaction swap.
// Reuses routes/phone_otp.ts (2Factor, the phone_otp ledger, contact_verification).
// ---------------------------------------------------------------------------
export async function mePhoneStart(req: Request, env: Env): Promise<Response> {
  const a = await authed(req, env); if (a instanceof Response) return a;
  if (!env.TWOFACTOR_API_KEY) return err(503, "otp_unavailable", "Phone verification isn't available right now. Please try again shortly.");
  const b = await body(req, 2048);
  if (!b) return err(400, "invalid_request", "Send a JSON body.");
  const e164 = indianMobileE164(b.phone);
  if (!e164) return err(400, "invalid_phone", "Enter a 10-digit Indian mobile number.", { field: "phone" });
  const db = env.DB_META, now = Date.now(), hash = await sha256Hex(e164);
  const step = (ok: boolean, outcome: string, extra: Record<string, unknown> = {}) =>
    tel(env, a.uid, "dash2_phone_change", { step: "start", ok, outcome, phone_masked: maskE164(e164), ...extra });

  const mine = await db.prepare("SELECT phone_verified, phone_hash FROM contact_verification WHERE uid=?1")
    .bind(a.uid).first<{ phone_verified: number; phone_hash: string | null }>();
  if (mine && Number(mine.phone_verified) === 1 && mine.phone_hash === hash) {
    return err(409, "same_phone", "That's already your phone number.", { field: "phone" });
  }
  if (await phoneTakenByOther(env, hash, a.uid)) {
    await step(false, "phone_taken");
    return err(409, "phone_taken", "This number is already linked to another account. Use a different number.", { field: "phone" });
  }
  const lim = await db.prepare(
    `SELECT (SELECT COUNT(*) FROM phone_otp WHERE uid=?1 AND created_at>?2) AS by_uid_window,
            (SELECT COUNT(*) FROM phone_otp WHERE uid=?1 AND created_at>?3) AS by_uid_hour,
            (SELECT MAX(created_at) FROM phone_otp WHERE uid=?1) AS last_uid,
            (SELECT COUNT(*) FROM phone_otp WHERE phone_hash=?4 AND created_at>?3) AS by_phone,
            (SELECT COUNT(*) FROM phone_otp WHERE created_at>?3) AS global`,
  ).bind(a.uid, now - PHONE_SEND_WINDOW_MS, now - HOUR_MS, hash)
    .first<{ by_uid_window: number; by_uid_hour: number; last_uid: number | null; by_phone: number; global: number }>();
  if (lim?.last_uid && now - lim.last_uid < RESEND_GAP_MS) {
    const wait = Math.ceil((RESEND_GAP_MS - (now - lim.last_uid)) / 1000);
    return err(429, "too_soon", `Please wait ${wait}s before asking for another code.`, { retry_after_s: wait, field: "phone" });
  }
  if ((lim?.by_uid_window ?? 0) >= PHONE_SENDS_PER_WINDOW || (lim?.by_uid_hour ?? 0) >= MAX_SENDS_PER_UID_HOUR || (lim?.by_phone ?? 0) >= MAX_SENDS_PER_PHONE_HOUR) {
    await step(false, "rate_limited", { by_uid_window: lim?.by_uid_window });
    return err(429, "too_many", "Too many codes requested. Please try again in 10 minutes.", { field: "phone" });
  }
  if ((lim?.global ?? 0) >= MAX_SENDS_GLOBAL_HOUR) {
    await step(false, "global_breaker");
    return err(429, "busy", "We're busy right now. Please try again in a few minutes.", { field: "phone" });
  }
  const tpl = (env.TWOFACTOR_OTP_TEMPLATE ?? "").trim();
  const res = await twoFactor(env, `SMS/${e164.slice(1)}/AUTOGEN${tpl ? "/" + encodeURIComponent(tpl) : ""}`);
  const ok = res?.Status === "Success" && !!res.Details;
  await db.prepare(
    "INSERT INTO phone_otp (uid, phone_hash, e164, session_id, status, attempts, created_at) VALUES (?1,?2,?3,?4,?5,0,?6)",
  ).bind(a.uid, hash, e164, ok ? res!.Details! : null, ok ? "sent" : "failed", now).run();
  await step(ok, ok ? "sent" : "provider_error", ok ? {} : { provider_detail: String(res?.Details ?? "no_response").slice(0, 120) });
  if (!ok) return err(502, "send_failed", "We couldn't send the SMS. Check the number and try again.", { field: "phone" });
  return json({ ok: true, expires_in_s: OTP_TTL_MS / 1000 });
}

export async function mePhoneConfirm(req: Request, env: Env): Promise<Response> {
  const a = await authed(req, env); if (a instanceof Response) return a;
  if (!env.TWOFACTOR_API_KEY) return err(503, "otp_unavailable", "Phone verification isn't available right now. Please try again shortly.");
  const b = await body(req, 2048);
  if (!b) return err(400, "invalid_request", "Send a JSON body.");
  const code = String(b.code ?? "").replace(/\D/g, "");
  if (!/^\d{4,6}$/.test(code)) return err(400, "invalid_code", "Enter the code from the SMS.", { field: "code" });
  const db = env.DB_META, now = Date.now();
  const row = await db.prepare(
    "SELECT id, e164, phone_hash, session_id, attempts, created_at FROM phone_otp WHERE uid=?1 AND status='sent' ORDER BY created_at DESC LIMIT 1",
  ).bind(a.uid).first<{ id: number; e164: string; phone_hash: string; session_id: string; attempts: number; created_at: number }>();
  const step = (ok: boolean, outcome: string, extra: Record<string, unknown> = {}) =>
    tel(env, a.uid, "dash2_phone_change", { step: "confirm", ok, outcome, phone_masked: maskE164(row?.e164), ...extra });
  if (!row) return err(400, "no_code", "Ask for a code first.", { field: "code" });
  if (now - row.created_at > OTP_TTL_MS) {
    await db.prepare("UPDATE phone_otp SET status='expired' WHERE id=?1").bind(row.id).run();
    await step(false, "expired");
    return err(410, "code_expired", "That code has expired. Ask for a new one.", { field: "code" });
  }
  if (row.attempts >= MAX_VERIFY_ATTEMPTS) return err(429, "too_many_attempts", "Too many wrong tries. Ask for a new code.", { field: "code" });
  await db.prepare("UPDATE phone_otp SET attempts=attempts+1 WHERE id=?1").bind(row.id).run();
  const res = await twoFactor(env, `SMS/VERIFY/${encodeURIComponent(row.session_id)}/${code}`);
  if (!res) {
    await step(false, "provider_unreachable");
    return err(502, "verify_failed", "We couldn't check the code just now. Please try again.", { field: "code" });
  }
  if (!(res.Status === "Success" && /match/i.test(String(res.Details ?? "")))) {
    const left = Math.max(0, MAX_VERIFY_ATTEMPTS - (row.attempts + 1));
    await step(false, "mismatch", { attempts_left: left });
    return err(400, "wrong_code", left > 0 ? `That code isn't right. ${left} ${left === 1 ? "try" : "tries"} left.` : "That code isn't right. Ask for a new one.", { attempts_left: left, field: "code" });
  }
  if (await phoneTakenByOther(env, row.phone_hash, a.uid)) {
    await step(false, "phone_taken");
    return err(409, "phone_taken", "This number is already linked to another account.", { field: "phone" });
  }
  await db.batch(phoneSwapStatements(db, { uid: a.uid, otpId: row.id, hash: row.phone_hash, e164: row.e164, now }));
  await step(true, "swapped", { ms_since_send: now - row.created_at });
  return json({ ok: true, phone: { e164_masked: maskE164(row.e164), verified: true } });
}

/** An account always keeps one verified phone; removing it outright is refused. */
export async function mePhoneDelete(req: Request, env: Env): Promise<Response> {
  const a = await authed(req, env); if (a instanceof Response) return a;
  const p = await verifiedPhone(env, a.uid);
  if (!p.verified) return err(404, "no_phone", "There is no phone on this account.");
  return err(409, "phone_required", "Your account needs a phone number. Change it to a new number instead.");
}

// ---------------------------------------------------------------------------
// POST /api/admin/refunds/:payment_id {refund_utr, amount_paise, refund_vpa}
// Records a refund an admin made BY HAND from the bank app. Moves no money and does
// not touch orders/escrow: the ledger side of a refund stays with the existing rails.
// ---------------------------------------------------------------------------
export async function adminRecordRefund(req: Request, env: Env, paymentId: string): Promise<Response> {
  const admin = await requireAdmin(req, env);
  if (admin instanceof Response) return err(admin.status, admin.status === 403 ? "admin_only" : "unauthorized", "Admins only.");
  const b = await body(req, 2048);
  if (!b) return err(400, "invalid_request", "Send a JSON body.");
  const utr = typeof b.refund_utr === "string" ? b.refund_utr.trim() : "";
  if (!/^[A-Za-z0-9]{6,35}$/.test(utr)) return err(400, "invalid_refund_utr", "Enter the bank's refund UTR/reference.", { field: "refund_utr" });
  const amount = Number(b.amount_paise);
  if (!Number.isSafeInteger(amount) || amount <= 0) return err(400, "invalid_amount", "amount_paise must be a positive integer.", { field: "amount_paise" });
  const vpa = normalizeVpa(b.refund_vpa);
  if (!vpa) return err(400, "invalid_vpa", "Enter the UPI id the refund was sent to.", { field: "refund_vpa" });
  const db = env.DB_META;
  const owner = await db.prepare(PAYMENT_OWNER_SQL).bind(paymentId).first<{ uid: string }>();
  // A PaymentLine id is the intent id when one exists — resolve an order id to it too.
  let p = owner ? await loadPayment(env, owner.uid, paymentId) : null;
  if (!p && owner) {
    const viaIntent = await db.prepare("SELECT intent_id FROM hdfc_sms_payment_intents WHERE commercial_order_id=?1 LIMIT 1").bind(paymentId).first<{ intent_id: string }>();
    if (viaIntent) p = await loadPayment(env, owner.uid, viaIntent.intent_id);
  }
  if (!owner || !p) return err(404, "not_found", "No such payment.");
  if (p.id.startsWith("agl_") || (p.order_id ?? "").startsWith("agl_")) return err(409, "agent_live_order", "agl_ orders are refunded only through the agent-live authority.");
  if (p.status === "pending") return err(409, "not_paid", "That payment is not confirmed.");
  if (p.status === "refunded") return err(409, "already_refunded", "That payment is already recorded as refunded.");
  if (amount > Number(p.amount_paise)) return err(400, "amount_exceeds_payment", "The refund is larger than the payment.", { field: "amount_paise" });
  const now = Date.now();
  const upd = await db.prepare(
    `UPDATE refunds SET status='refunded', refund_utr=?2, amount_paise=?3, refund_vpa=?4, refunded_at=?5, admin_uid=?6
      WHERE payment_id=?1 AND status='requested'`,
  ).bind(p.id, utr, amount, vpa, now, admin.uid).run();
  if (!upd.meta.changes) {
    const ins = await db.prepare(
      `INSERT INTO refunds (id,payment_id,uid,amount_paise,reason,status,refund_vpa,refund_utr,requested_at,refunded_at,admin_uid)
       SELECT ?1,?2,?3,?4,'admin_initiated','refunded',?5,?6,?7,?7,?8
        WHERE NOT EXISTS (SELECT 1 FROM refunds WHERE payment_id=?2 AND status IN ('requested','refunded'))`,
    ).bind(crypto.randomUUID(), p.id, owner.uid, amount, vpa, utr, now, admin.uid).run();
    if (!ins.meta.changes) return err(409, "already_refunded", "That payment is already recorded as refunded.");
  }
  await tel(env, owner.uid, "dash2_refund_recorded", { payment_id: p.id, order_id: p.order_id, amount_paise: amount, admin_uid: admin.uid });
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// GET|PUT /api/admin/listings/:id/youtube  {url}   (url:'' clears)
// ---------------------------------------------------------------------------
export async function adminEventVideo(req: Request, env: Env, listingId: string): Promise<Response> {
  const admin = await requireAdmin(req, env);
  if (admin instanceof Response) return err(admin.status, admin.status === 403 ? "admin_only" : "unauthorized", "Admins only.");
  if (!listingId || listingId.length > 200) return err(404, "not_found", "No such listing.");
  const db = env.DB_META;
  if (req.method === "GET") {
    const row = await db.prepare("SELECT youtube_video_id, source_url FROM event_videos WHERE listing_id=?1").bind(listingId).first<{ youtube_video_id: string; source_url: string | null }>();
    return json(row ? { youtube_video_id: row.youtube_video_id, url: row.source_url ?? `https://www.youtube.com/watch?v=${row.youtube_video_id}` } : {});
  }
  const b = await body(req, 2048);
  if (!b || typeof b.url !== "string") return err(400, "invalid_request", "Send {url}.", { field: "url" });
  const listing = await db.prepare("SELECT id FROM listings WHERE id=?1").bind(listingId).first();
  if (!listing) return err(404, "not_found", "No such listing.");
  const url = b.url.trim();
  if (!url) {
    await db.prepare("DELETE FROM event_videos WHERE listing_id=?1").bind(listingId).run();
    await tel(env, admin.uid, "dash2_video_link_set", { listing_id: listingId, cleared: true });
    return json({ ok: true, youtube_video_id: null });
  }
  const id = parseYoutubeVideoId(url);
  if (!id) return err(400, "invalid_youtube_url", "Paste a YouTube video or live link (or the 11-character video id).", { field: "url" });
  await db.prepare(
    `INSERT INTO event_videos (listing_id, youtube_video_id, source_url, updated_at, admin_uid) VALUES (?1,?2,?3,?4,?5)
     ON CONFLICT(listing_id) DO UPDATE SET youtube_video_id=excluded.youtube_video_id, source_url=excluded.source_url,
       updated_at=excluded.updated_at, admin_uid=excluded.admin_uid`,
  ).bind(listingId, id, url.slice(0, 500), Date.now(), admin.uid).run();
  await tel(env, admin.uid, "dash2_video_link_set", { listing_id: listingId, cleared: false });
  return json({ ok: true, youtube_video_id: id });
}

// ---------------------------------------------------------------------------
// Dispatcher — registered in index.ts next to /api/me.
// ---------------------------------------------------------------------------
export async function meDashboardRoute(req: Request, env: Env, p: string): Promise<Response | null> {
  const m = req.method;
  const seg = (prefix: string) => decodeURIComponent(p.slice(prefix.length));
  try {
    if (p === "/api/me/catalog" && m === "GET") return await meCatalog(req, env);
    if (p === "/api/me/events" && m === "GET") return await meEvents(req, env);
    if (p === "/api/me/payments" && m === "GET") return await mePayments(req, env);
    if (p.startsWith("/api/me/payments/")) {
      const rest = p.slice("/api/me/payments/".length).split("/");
      const id = decodeURIComponent(rest[0] ?? "");
      if (rest.length === 1 && m === "GET") return await mePaymentDetail(req, env, id);
      if (rest.length === 2 && rest[1] === "refund-request" && m === "POST") return await meRefundRequest(req, env, id);
      if (rest.length === 2 && rest[1] === "receipt.pdf" && m === "GET") return await meReceiptPdf(req, env, id);
      return null;
    }
    if (p === "/api/me/profile" && m === "GET") return await meProfileGet(req, env);
    if (p === "/api/me/profile" && m === "PUT") return await meProfilePut(req, env);
    if (p === "/api/me/vpas" && m === "POST") return await meVpaAdd(req, env);
    if (p.startsWith("/api/me/vpas/")) {
      const rest = p.slice("/api/me/vpas/".length).split("/");
      const id = decodeURIComponent(rest[0] ?? "");
      if (rest.length === 1 && m === "DELETE") return await meVpaDelete(req, env, id);
      if (rest.length === 2 && rest[1] === "default" && m === "POST") return await meVpaDefault(req, env, id);
      return null;
    }
    if (p === "/api/me/phone/start" && m === "POST") return await mePhoneStart(req, env);
    if (p === "/api/me/phone/confirm" && m === "POST") return await mePhoneConfirm(req, env);
    if (p === "/api/me/phone" && m === "DELETE") return await mePhoneDelete(req, env);
    if (p.startsWith("/api/admin/listings/") && p.endsWith("/youtube") && (m === "GET" || m === "PUT")) {
      const id = p.slice("/api/admin/listings/".length, -"/youtube".length);
      if (id && !id.includes("/")) return await adminEventVideo(req, env, decodeURIComponent(id));
      return null;
    }
    if (p.startsWith("/api/admin/refunds/") && m === "POST") return await adminRecordRefund(req, env, seg("/api/admin/refunds/"));
    return null;
  } catch (e) {
    await trackException(env, e, { route: p, method: m, handled: true, app_name: APP, extra: { area: "dash2" } });
    return err(500, "internal", "Something went wrong. Please try again.");
  }
}
