// [AUMFE-CONSULT-W1-1 2026-10-02] Real Consultants — customer booking API (lane W1): create (held slot + unique UPI amount),
// "I've paid", wallet pay, my bookings, one booking, cancel. The UPI side deliberately MIRRORS routes/shop_orders.ts.
// Prices are ALWAYS frozen server-side from priceFor(consultant.rate_rupees); nothing price-like is read from the client.
import type { Env } from "../../types";
import { json } from "../../util";
import { BRAND } from "../../lib/brand";
import { metaDb } from "../../db/shard";
import { requireUser, isFail, requireVerifiedWhatsApp } from "../../authz";
import { rateLimit } from "../../money";
import { track, trackException, trackUser } from "../../hooks";
import { emailFor } from "../../lib/identity";
import { chargeAmount } from "../../feature_pricing";
import { walletOp } from "../wallet";
import { policy as hdfcPolicy, UUID } from "../../lib/hdfc_sms_smoke";
import { MCC_RE, MERCHANT_REF_RE, readUpiSettings } from "../../lib/upi_settings";
import { reserveUniqueAmount, releaseAmount, dropReservation } from "../../lib/saathum_upi3";
import { normalizeUtr, AMOUNT_COOLDOWN_MS } from "../../lib/saathum_checkout_logic";
import { shopUpiUri } from "../../lib/shop_orders_logic";
import { consultVisible } from "../../lib/consultants/access";
import { isPreviewer } from "../../lib/preview";
import { readConfig } from "../config";
import { consultantById, consultantBySlug, newId, bookingRefOf, type ConsultantRow } from "../../lib/consultants/store";
import { priceFor } from "../../lib/consultants/pricing";
import { validateIntake, validateQuestions } from "../../lib/consultants/intake";
import { loadSchedules, slotDays } from "../../lib/consultants/schedule";
import { HOLD_MS, istDate } from "../../lib/consultants/slots";
import {
  BOOKING_ID_RE, MAX_OPEN_HOLDS, admitSlot, canCancel, externalStatus, openForMatching, toBookingDTO, visibleStatuses, type BookingRow,
} from "../../lib/consultants/booking_logic";
import {
  confirmConsultBooking, expireStaleHoldAt, finalizeConsultByIntent, reconcileOpenConsultBooking,
} from "../../lib/consultants/payment";
import { DISCIPLINES, type BookingDTO, type Discipline } from "../../lib/consultants/types";

const APP = BRAND.slug;
const PRIVATE = { "cache-control": "private, no-store" };
const failure = (error: string, status = 400, extra: Record<string, unknown> = {}) => json({ error, message: extra.message ?? error, ...extra }, status, PRIVATE);
const ok = (data: unknown, status = 200) => json(data, status, PRIVATE);
const changed = (r: unknown): boolean => Number((r as any)?.meta?.changes ?? 0) === 1;
const isUnique = (err: unknown, what: string): boolean => /UNIQUE constraint failed/i.test(String((err as Error)?.message ?? err)) && String((err as Error)?.message ?? err).includes(what);

async function limited(env: Env, bucket: string, max: number, windowSec = 60) {
  const r = await rateLimit(env, `consult-book:${bucket}`, max, windowSec);
  return r ? failure("rate_limited", 429, { retryable: true }) : null;
}

// ---------------------------------------------------------------------------
// Loading + DTO
// ---------------------------------------------------------------------------
async function loadOwn(env: Env, uid: string, id: string): Promise<BookingRow | null> {
  if (!BOOKING_ID_RE.test(id)) return null;
  return metaDb(env).prepare(`SELECT * FROM consult_bookings WHERE id=?1 AND uid=?2`).bind(id, uid).first<BookingRow>();
}

type PayCtx = { enabled: boolean; vpa: string; payeeName: string; merchant: Record<string, string> };
async function loadPayCtx(env: Env): Promise<PayCtx> {
  const [p, saved] = await Promise.all([hdfcPolicy(env), readUpiSettings(env)]);
  const merchant: Record<string, string> = {};
  if (saved.vpa?.trim() === p.vpa) {
    if (saved.merchant_code && MCC_RE.test(saved.merchant_code)) merchant.mc = saved.merchant_code;
    if (merchant.mc && saved.merchant_ref && MERCHANT_REF_RE.test(saved.merchant_ref)) merchant.tr = saved.merchant_ref;
  }
  return { enabled: p.enabled, vpa: p.vpa, payeeName: p.payee_name, merchant };
}

export type ConsultPay = { upi_uri: string | null; qr_svg?: string; payee_vpa: string | null; amount_paise: number; payer_reference: string | null; expires_at: number | null };
function payOf(row: BookingRow, ctx: PayCtx, now = Date.now()): ConsultPay {
  const live = row.pay_method === "upi" && ctx.enabled && (row.status === "held" || row.status === "awaiting_review") && externalStatus(row, now) !== "expired";
  return {
    upi_uri: live ? shopUpiUri({ vpa: ctx.vpa, payeeName: ctx.payeeName, amountPaise: row.amount_paise ?? row.total_rupees * 100, note: `${BRAND.name} ${row.ref}`, merchant: ctx.merchant }) : null,
    payee_vpa: ctx.vpa || null, amount_paise: row.amount_paise ?? row.total_rupees * 100, payer_reference: row.payer_reference, expires_at: row.expires_at,
  };
}

async function dtoFor(env: Env, row: BookingRow): Promise<BookingDTO> {
  const c = await consultantById(env, row.consultant_id);
  return toBookingDTO(row, { slug: c?.slug ?? "", name: c?.name ?? "", photo_url: c?.photo_url ?? "" });
}

// ---------------------------------------------------------------------------
// POST /api/consultants/bookings
// ---------------------------------------------------------------------------
function bookableBy(c: ConsultantRow, isPublic: boolean, previewer: boolean): boolean {
  return (visibleStatuses(isPublic, previewer) as string[]).includes(c.status);
}

async function replay(env: Env, uid: string, key: string): Promise<Response | null> {
  const ex = await metaDb(env).prepare(`SELECT id FROM consult_bookings WHERE uid=?1 AND request_key=?2`).bind(uid, key).first<{ id: string }>();
  if (!ex) return null;
  const row = await loadOwn(env, uid, ex.id);
  if (!row) return null;
  return ok({ booking: await dtoFor(env, row), pay: payOf(row, await loadPayCtx(env)) }, 200);
}

async function createBooking(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return failure(auth.error, auth.status);
  const { uid } = auth;
  const fail = (reason: string, status: number, extra: Record<string, unknown> = {}) => {
    void track(env, uid, "consult_booking_failed", APP, { reason, stage: "create" });
    return failure(reason, status, extra);
  };
  const waGate = await requireVerifiedWhatsApp(env, uid);
  if (waGate) {
    void track(env, uid, "whatsapp_required_blocked", APP, { route: "/api/consultants/bookings" });
    return fail("whatsapp_required", 403, { message: "Verify your WhatsApp number to continue." });
  }
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return fail("invalid_request", 400); }
  if (!b || typeof b !== "object" || typeof b.request_key !== "string" || !UUID.test(b.request_key)
    || typeof b.slug !== "string" || typeof b.discipline !== "string" || !(DISCIPLINES as readonly string[]).includes(b.discipline)
    || !Number.isSafeInteger(b.slot_start_ms)) return fail("invalid_request", 400);
  if (b.terms !== true || b.refund_policy !== true) {
    return fail("terms_required", 400, { message: "Please agree to the Terms & Conditions and the Refund policy to continue." });
  }
  const discipline = b.discipline as Discipline;
  const slotStart = b.slot_start_ms as number;
  const throttle = await limited(env, `create:${uid}`, 10); if (throttle) return throttle;

  const replayed = await replay(env, uid, b.request_key);
  if (replayed) return replayed;

  const cfg = await readConfig(env);
  const previewer = isPreviewer(env, uid);
  const consultant = (await consultVisible(env, uid)) ? await consultantBySlug(env, b.slug) : null;
  if (!consultant || !bookableBy(consultant, cfg.consultantsEnabled === true, previewer)) return fail("consultant_not_found", 404);
  if (consultant.uid && consultant.uid === uid) return fail("own_consultant", 400, { message: "You cannot book your own session." });
  let offered: Discipline[] = [];
  try { offered = JSON.parse(consultant.disciplines_json); } catch { /* none */ }
  if (!offered.includes(discipline)) return fail("discipline_not_offered", 400, { field: "discipline", message: "This consultant does not offer that service." });

  const now = Date.now();
  const intake = validateIntake(discipline, b.intake, now);
  if (!intake.ok) return fail(intake.error, 400, { field: intake.field, message: intake.message });
  const questions = validateQuestions(b.questions);
  if (!questions.ok) return fail("invalid_questions", 400, { field: "questions", message: questions.message });

  // Slot must be exactly one slotsFor produces right now (grid, availability, exceptions, busy, lead time, horizon).
  await expireStaleHoldAt(env, consultant.id, slotStart, now);
  const date = istDate(slotStart);
  const sched = (await loadSchedules(env, [consultant.id], slotStart - 86_400_000, slotStart + 86_400_000, now)).get(consultant.id)!;
  const produced = slotDays(sched, date, 1, consultant.slot_minutes, consultant.buffer_minutes, now)[0]?.slots.map((s) => s.start_ms) ?? [];
  const adm = admitSlot(slotStart, now, produced);
  if (!adm.ok) return fail(adm.error === "slot_unavailable" ? "slot_taken" : adm.error, adm.error === "slot_unavailable" ? 409 : 400,
    { message: adm.error === "slot_unavailable" ? "That time is no longer available. Please pick another." : "Please pick a later time." });

  const db = metaDb(env);
  const holds = await db.prepare(`SELECT COUNT(*) AS n FROM consult_bookings WHERE uid=?1 AND status='held' AND expires_at>?2`).bind(uid, now).first<{ n: number }>();
  if (Number(holds?.n || 0) >= MAX_OPEN_HOLDS) return fail("too_many_holds", 429, { message: "You have several unpaid bookings open. Please pay or cancel one first." });

  const price = priceFor(consultant.rate_rupees);
  const p = await hdfcPolicy(env);
  const id = newId("cb_");
  const expiresAt = now + HOLD_MS;
  let reservation: Awaited<ReturnType<typeof reserveUniqueAmount>>;
  try {
    reservation = await reserveUniqueAmount(env, { account: p.account, totalRupees: price.total, checkoutId: id, now, expiresAt });
  } catch (err) {
    await trackException(env, err, { uid, route: "/api/consultants/bookings:reserve", method: "POST", handled: true, app_name: APP });
    return fail("checkout_unavailable", 503);
  }
  if (!reservation) return fail("amount_pool_exhausted", 503, { message: "Too many payments are in progress right now. Please try again in a few minutes.", retryable: true });

  try {
    await db.prepare(
      `INSERT INTO consult_bookings
        (id,ref,consultant_id,uid,request_key,discipline,slot_start_ms,slot_end_ms,status,rate_rupees,gst_rupees,total_rupees,fee_rupees,payout_rupees,
         intake_json,questions_json,terms_accepted_at,refund_policy_accepted_at,pay_method,receiving_account_key,amount_paise,rounding_discount_paise,
         expires_at,created_at,updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'held',?9,?10,?11,?12,?13,?14,?15,?16,?16,'upi',?17,?18,?19,?20,?16,?16)`,
    ).bind(
      id, bookingRefOf(id), consultant.id, uid, b.request_key, discipline, slotStart, slotStart + consultant.slot_minutes * 60_000,
      price.rate, price.gst, price.total, price.fee, price.payout, JSON.stringify(intake.value), JSON.stringify(questions.value), now,
      p.account, reservation.amountPaise, reservation.roundingDiscountPaise, expiresAt,
    ).run();
  } catch (err) {
    await dropReservation(env, id);
    if (isUnique(err, "request_key")) { const r = await replay(env, uid, b.request_key); if (r) return r; }
    if (isUnique(err, "slot_start_ms")) return fail("slot_taken", 409, { message: "That time was just booked by someone else. Please pick another." });
    await trackException(env, err, { uid, route: "/api/consultants/bookings", method: "POST", handled: true, app_name: APP });
    return fail("checkout_unavailable", 503);
  }
  const row = await loadOwn(env, uid, id);
  if (!row) return fail("checkout_unavailable", 503);
  const email = await emailFor(env, uid).catch(() => null);
  const t = trackUser(env, uid, email, "consult_booking_created", APP, { booking_id: id, discipline, consultant: consultant.slug, total_rupees: price.total });
  if (ctx) ctx.waitUntil(t); else await t;
  return ok({ booking: await dtoFor(env, row), pay: payOf(row, await loadPayCtx(env)) }, 201);
}

// ---------------------------------------------------------------------------
// GET mine / one
// ---------------------------------------------------------------------------
async function myBookings(req: Request, env: Env): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return failure(auth.error, auth.status);
  const rows = await metaDb(env).prepare(
    `SELECT b.*, c.slug AS c_slug, c.name AS c_name, c.photo_url AS c_photo FROM consult_bookings b JOIN consultants c ON c.id=b.consultant_id
      WHERE b.uid=?1 AND NOT (b.status IN ('expired','cancelled') AND b.confirmed_at IS NULL) ORDER BY b.slot_start_ms DESC LIMIT 100`,
  ).bind(auth.uid).all<BookingRow & { c_slug: string; c_name: string; c_photo: string }>();
  const now = Date.now();
  const bookings: BookingDTO[] = [];
  for (const r of rows.results ?? []) {
    // An unpaid hold that lapsed is effectively expired (computed on read): hide it like the shop does.
    if (!r.confirmed_at && externalStatus(r, now) === "expired") continue;
    bookings.push(toBookingDTO(r, { slug: r.c_slug, name: r.c_name, photo_url: r.c_photo }, now));
  }
  return ok({ bookings });
}

async function oneBooking(req: Request, env: Env, id: string, ctx?: ExecutionContext): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return failure(auth.error, auth.status);
  let row = await loadOwn(env, auth.uid, id);
  if (!row) return failure("not_found", 404);
  if (openForMatching(row)) {
    await reconcileOpenConsultBooking(env, id, ctx).catch((err) => trackException(env, err, { uid: auth.uid, route: "/api/consultants/bookings/:id", method: "GET", handled: true, app_name: APP }));
    row = (await loadOwn(env, auth.uid, id)) ?? row;
  }
  return ok({ booking: await dtoFor(env, row), pay: payOf(row, await loadPayCtx(env)) });
}

async function referenceTaken(env: Env, account: string, utr: string, selfId: string): Promise<boolean> {
  const db = metaDb(env);
  const probes: [string, unknown[]][] = [
    [`SELECT 1 AS x FROM consult_bookings WHERE receiving_account_key=?1 AND payer_reference=?2 AND id<>?3 LIMIT 1`, [account, utr, selfId]],
    [`SELECT 1 AS x FROM saathum_checkouts WHERE receiving_account_key=?1 AND payer_reference=?2 LIMIT 1`, [account, utr]],
    [`SELECT 1 AS x FROM shop_orders WHERE receiving_account_key=?1 AND payer_reference=?2 LIMIT 1`, [account, utr]],
  ];
  for (const [sql, args] of probes) {
    const hit = await db.prepare(sql).bind(...args).first().catch(() => null); // a table not migrated yet cannot hold a claim
    if (hit) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// POST :id/paid  (+ optional typed UTR)
// ---------------------------------------------------------------------------
async function markPaid(req: Request, env: Env, id: string, ctx?: ExecutionContext): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return failure(auth.error, auth.status);
  const throttle = await limited(env, `paid:${auth.uid}`, 20); if (throttle) return throttle;
  let b: Record<string, unknown> = {};
  try { const t = await req.text(); b = t ? JSON.parse(t) : {}; } catch { return failure("invalid_request"); }
  const utr = b?.utr === undefined || b.utr === null || b.utr === "" ? null : normalizeUtr(b.utr);
  if (b?.utr !== undefined && b.utr !== null && b.utr !== "" && !utr) return failure("reference_must_be_12_digits");
  let row = await loadOwn(env, auth.uid, id);
  if (!row) return failure("not_found", 404);
  const db = metaDb(env);
  const now = Date.now();
  if (utr && row.pay_method === "upi" && openForMatching(row) && row.payer_reference !== utr && row.receiving_account_key) {
    // A reference any other booking / shop order / event checkout already carries on this account is never claimable.
    const taken = await referenceTaken(env, row.receiving_account_key, utr, id);
    if (taken) { void track(env, auth.uid, "consult_booking_paid", APP, { method: "upi", ok: false, reason: "reference_conflict" }); return failure("reference_conflict", 409); }
    await db.prepare(
      `UPDATE consult_bookings SET payer_reference=?3, reference_revision=reference_revision+1, updated_at=?4
        WHERE id=?1 AND uid=?2 AND status IN ('held','awaiting_review') AND confirmed_at IS NULL`,
    ).bind(id, auth.uid, utr, now).run();
  }
  if (row.status === "held" && (row.expires_at ?? 0) > now && !row.paid_claimed_at) {
    const res = await db.prepare(
      `UPDATE consult_bookings SET paid_claimed_at=?3, updated_at=?3 WHERE id=?1 AND uid=?2 AND status='held' AND paid_claimed_at IS NULL`,
    ).bind(id, auth.uid, now).run();
    if (changed(res)) {
      // Claimed: the hold no longer lapses at expires_at; keep the unique amount reserved for the late-SMS window.
      try { await db.prepare(`UPDATE saathum_amount_reservations SET reserved_until=MAX(reserved_until,?2) WHERE checkout_id=?1`).bind(id, now + 25 * 3_600_000).run(); } catch { /* best-effort */ }
    }
    void track(env, auth.uid, "consult_booking_paid", APP, { method: "upi", ok: true, stage: "claimed", utr: !!utr });
    row = (await loadOwn(env, auth.uid, id)) ?? row;
  }
  if (openForMatching(row)) {
    await finalizeConsultByIntent(env, id, ctx).catch(() => {});
    await reconcileOpenConsultBooking(env, id, ctx).catch((err) => trackException(env, err, { uid: auth.uid, route: "/api/consultants/bookings/:id/paid", method: "POST", handled: true, app_name: APP }));
    row = (await loadOwn(env, auth.uid, id)) ?? row;
  }
  return ok({ booking: await dtoFor(env, row), pay: payOf(row, await loadPayCtx(env)) });
}

// ---------------------------------------------------------------------------
// POST :id/pay-wallet
// ---------------------------------------------------------------------------
async function payWallet(req: Request, env: Env, id: string, ctx?: ExecutionContext): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return failure(auth.error, auth.status);
  const { uid } = auth;
  const throttle = await limited(env, `wallet:${uid}`, 10); if (throttle) return throttle;
  const row = await loadOwn(env, uid, id);
  if (!row) return failure("not_found", 404);
  if (row.status === "confirmed" && row.pay_method === "wallet") return ok({ booking: await dtoFor(env, row) }); // idempotent retry
  const now = Date.now();
  if (row.status !== "held" || row.paid_claimed_at || (row.expires_at ?? 0) <= now + 5_000) {
    void track(env, uid, "consult_booking_paid", APP, { method: "wallet", ok: false, reason: row.status === "held" ? "expired_or_claimed" : `status_${row.status}` });
    return failure(row.status === "held" ? "hold_expired" : "not_payable", 409, { message: "This booking can no longer be paid from the wallet." });
  }
  const consultant = await consultantById(env, row.consultant_id);
  const opId = `consult:${id}:pay`;
  const charge = await chargeAmount(env, uid, "consultation", row.total_rupees, opId, {
    forceMeter: true, allowFree: false,
    meta: { category: "consultation", context: `${BRAND.name} consultation ${row.ref}`, counterpartyName: consultant?.name },
  });
  if (!charge.ok) {
    void track(env, uid, "consult_booking_paid", APP, { method: "wallet", ok: false, reason: charge.reason ?? "error" });
    if (charge.reason === "insufficient") return failure("insufficient", 402, { balance: charge.balance ?? null, needed: row.total_rupees, message: "Not enough wallet balance." });
    void trackException(env, new Error(`consult_wallet_charge_${charge.reason}`), { uid, route: "/api/consultants/bookings/:id/pay-wallet", handled: true, app_name: APP });
    return failure("wallet_error", 502, { message: "The wallet could not be charged. Please try again." });
  }
  const out = await confirmConsultBooking(env, id, { via: "wallet", bankReference: null }, ctx);
  if (out === "confirmed") return ok({ booking: await dtoFor(env, (await loadOwn(env, uid, id)) ?? row) });
  // Lost the race (UPI SMS/admin confirmed it, or the slot lapsed) -> hand the wallet charge straight back. This is NOT a
  // customer refund: the booking never got a second payment, so the wallet is made whole automatically.
  const after = await loadOwn(env, uid, id);
  if (after && after.status === "confirmed" && after.pay_method === "wallet") return ok({ booking: await dtoFor(env, after) });
  try {
    await walletOp(env, uid, {
      op: "credit", uid, amount: row.total_rupees, type: "refund", app_name: "consultation", ref: opId, op_id: `${opId}:refund`,
      ledger: { debit: "platform:fees", credit: `user:${uid}`, type: "consult_refund", ref: opId },
    });
  } catch (err) { await trackException(env, err, { uid, route: "consult_wallet_autorefund", handled: false, app_name: APP, extra: { booking_id: id } }); }
  void track(env, uid, "consult_booking_failed", APP, { reason: "wallet_race_lost", booking_id: id });
  return failure("already_paid_or_expired", 409, { message: "This booking changed while paying. Your wallet was not charged." });
}

// ---------------------------------------------------------------------------
// POST :id/cancel
// ---------------------------------------------------------------------------
async function cancelBooking(req: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return failure(auth.error, auth.status);
  const throttle = await limited(env, `cancel:${auth.uid}`, 20); if (throttle) return throttle;
  const row = await loadOwn(env, auth.uid, id);
  if (!row) return failure("not_found", 404);
  if (!canCancel(row.status)) {
    return failure("not_cancellable", 409, { message: "Paid bookings can only be cancelled through support.", booking: await dtoFor(env, row) });
  }
  const now = Date.now();
  const res = await metaDb(env).prepare(
    `UPDATE consult_bookings SET status='cancelled', cancel_reason='customer', updated_at=?3 WHERE id=?1 AND uid=?2 AND status IN ('held','awaiting_review') AND confirmed_at IS NULL`,
  ).bind(id, auth.uid, now).run();
  if (!changed(res)) {
    const cur = (await loadOwn(env, auth.uid, id)) ?? row;
    return failure("not_cancellable", 409, { message: "Paid bookings can only be cancelled through support.", booking: await dtoFor(env, cur) });
  }
  await releaseAmount(env, id, now, row.paid_claimed_at ? AMOUNT_COOLDOWN_MS : 0);
  void track(env, auth.uid, "consult_booking_failed", APP, { reason: "cancelled_by_customer", booking_id: id });
  return ok({ booking: await dtoFor(env, (await loadOwn(env, auth.uid, id)) ?? row) });
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------
export async function bookingsRoutes(req: Request, env: Env, p: string, ctx?: ExecutionContext): Promise<Response | null> {
  const m = req.method;
  try {
    if (p === "/api/consultants/bookings" && m === "POST") return await createBooking(req, env, ctx);
    if (p === "/api/consultants/bookings/mine" && m === "GET") return await myBookings(req, env);
    const mm = /^\/api\/consultants\/bookings\/([^/]+)(?:\/(paid|pay-wallet|cancel))?$/.exec(p);
    if (!mm) return null;
    let id: string;
    try { id = decodeURIComponent(mm[1]); } catch { return failure("not_found", 404); }
    if (!mm[2] && m === "GET") return await oneBooking(req, env, id, ctx);
    if (mm[2] === "paid" && m === "POST") return await markPaid(req, env, id, ctx);
    if (mm[2] === "pay-wallet" && m === "POST") return await payWallet(req, env, id, ctx);
    if (mm[2] === "cancel" && m === "POST") return await cancelBooking(req, env, id);
    return null;
  } catch (err) {
    await trackException(env, err, { route: p, method: m, handled: true, app_name: APP, extra: { area: "consult_bookings" } });
    return failure("internal", 500, { message: "Something went wrong. Please try again." });
  }
}
