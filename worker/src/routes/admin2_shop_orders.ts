// [SAATHUM-SHOP-API-ORDERS-1 2026-10-01] Admin 2 -- Shop orders (Specs/SPEC-2026-10-01-SAATHUM-SHOP.md §4.5).
// Spread into ADMIN2_ROUTES by routes/admin2.ts ("ADMIN2_SHOP_ORDER_ROUTES"). All under /api/admin/v2/shop/.
//   GET  orders?tab&q&cursor · GET orders/:id · GET kpis
//   POST orders/:id/confirm-payment | reject-payment | at-printer | shipped | delivered | cancel | refund
// Every fulfilment transition is a compare-and-set UPDATE (double clicks are 409 bad_transition, never a second event),
// writes shop_order_events + admin_audit (DB_WALLET, like chadhava) + track("shop_order_status_changed"), and tells the
// buyer on WhatsApp (+ email for shipped/refunded) unless the admin sent notify:false.
//
// NOTE: only a TYPE is imported from ./admin2 (admin2 imports this file at runtime -- no value cycle); the admin guard
// below is the same 6 lines as admin2's adminGuard.
import type { Env } from "../types";
import type { Admin2RouteDef } from "./admin2";
import { json } from "../util";
import { metaDb } from "../db/shard";
import { track, trackException } from "../hooks";
import { emailFor } from "../lib/identity";
import { requireAdmin } from "./admin_money";
import { verifiedWhatsAppNumber } from "../lib/whatsapp_notify";
import { maskE164, encodeCursor, decodeCursor } from "../lib/me_dashboard_logic";
import { normalizeUtr, LATE_SMS_GRACE_MS, type Address } from "../lib/saathum_checkout_logic";
import {
  SHOP_ORDER_ID_RE, SHOP_TRANSITIONS, SHOP_TAB_SQL, SHOP_TABS, SHOP_STALE_MS, canTransition, isShopTab, istDayStartMs, orderItems,
  shopExternalStatus, utrLast4, validHttpUrl, type ShopAction, type ShopOrderRow, type ShopTab,
} from "../lib/shop_orders_logic";
import { notifyShopTransition } from "../lib/shop_notify";
import { describeShipment, loadFulfilmentEvents, loadOrderExtras, moneyAndProduction, type OrderExtras } from "../lib/pod_fulfil"; // [AUMFE-POD-FULFIL-1]
import { loadShopOrder, appendShopEvent, confirmShopOrder, rejectShopOrder } from "./shop_orders";

const APP = "saathum";
const DAY_MS = 86_400_000;
const PAGE = 25;
const err = (status: number, error: string, message: string, extra: Record<string, unknown> = {}) => json({ error, message, ...extra }, status);

async function admin(req: Request, env: Env): Promise<{ uid: string } | Response> {
  const a = await requireAdmin(req, env);
  if (a instanceof Response) {
    return a.status === 403 ? err(403, "admin_only", "You don't have admin access.") : err(a.status, "unauthorized", "Please sign in again.");
  }
  return a;
}

async function audit(env: Env, adminId: string, action: string, target: string, meta: Record<string, unknown>): Promise<void> {
  try {
    await env.DB_WALLET.prepare("INSERT INTO admin_audit (id, admin_id, action, target, meta, created_at) VALUES (?1,?2,?3,?4,?5,?6)")
      .bind(crypto.randomUUID(), adminId, action, target, JSON.stringify(meta), Date.now()).run();
  } catch { /* audit is best-effort, matching the other admin routes */ }
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try { const v = await req.json(); return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null; } catch { return null; }
}
const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------
async function adminShape(env: Env, row: ShopOrderRow, now = Date.now(), extras?: OrderExtras) {
  const address = (() => { try { return JSON.parse(row.address_json) as Partial<Address>; } catch { return {} as Partial<Address>; } })();
  const [email, wa] = await Promise.all([emailFor(env, row.uid).catch(() => null), verifiedWhatsAppNumber(env, row.uid).catch(() => null)]);
  const phone = wa ?? (address.phone ? `+91${address.phone}` : null);
  // [AUMFE-POD-FULFIL-1] money + production (spec §6.1). A list preloads `extras` once; a single order loads its own.
  const { money, production } = moneyAndProduction(row, extras ?? await loadOrderExtras(env, [row]), wa, now);
  return {
    order_id: row.order_id, order_no: row.order_no, created_at: row.created_at,
    customer: { uid: row.uid, name: row.contact_name ?? address.name ?? null, email, phone_masked: maskE164(phone), city: address.city ?? null },
    items: orderItems(row), total_rupees: row.total_rupees,
    pay_status: shopExternalStatus(row, now), payer_reference: row.payer_reference, utr_last4: utrLast4(row.utr ?? row.payer_reference),
    fulfil_status: row.fulfil_status, courier: row.courier, awb: row.awb, tracking_url: row.tracking_url, eta_text: row.eta_text,
    money, production,
  };
}

// ---------------------------------------------------------------------------
// GET orders
// ---------------------------------------------------------------------------
async function tabCounts(env: Env, now: number): Promise<Record<ShopTab, number>> {
  const cols = SHOP_TABS.map((t) => `COALESCE(SUM(CASE WHEN ${SHOP_TAB_SQL[t]} THEN 1 ELSE 0 END),0) AS n_${t}`).join(", "); // aliased: "all" is an SQL keyword
  const r = await metaDb(env).prepare(`SELECT ${cols} FROM shop_orders`).bind(now).first<Record<ShopTab, number>>();
  const out = {} as Record<ShopTab, number>;
  for (const t of SHOP_TABS) out[t] = Number((r as Record<string, number> | null)?.[`n_${t}`] ?? 0);
  return out;
}

async function adminOrderList(req: Request, env: Env): Promise<Response> {
  const a = await admin(req, env); if (a instanceof Response) return a;
  const u = new URL(req.url).searchParams;
  const tabRaw = u.get("tab") ?? "all";
  if (!isShopTab(tabRaw)) return err(400, "invalid_tab", "Unknown tab.");
  const rawCursor = u.get("cursor");
  const cursor = decodeCursor(rawCursor);
  if (rawCursor && !cursor) return err(400, "invalid_cursor", "That page link is no longer valid. Reload the list.");
  const now = Date.now();
  const binds: unknown[] = [now];
  const where: string[] = [`?1 IS NOT NULL`, SHOP_TAB_SQL[tabRaw]]; // ?1 (= now) is always referenced, whichever tab
  const q = (u.get("q") ?? "").trim().slice(0, 60);
  if (q) {
    const esc = q.replace(/[\\%_]/g, (ch) => "\\" + ch);
    binds.push(`%${esc.toLowerCase()}%`); const sub = `?${binds.length}`;
    binds.push(`${esc}%`); const pre = `?${binds.length}`;
    const like = (col: string, ref: string) => `${col} LIKE ${ref} ESCAPE '\\'`;
    where.push(`(${like("lower(order_no)", sub)} OR ${like("lower(contact_name)", sub)} OR ${like("lower(address_json)", sub)}
      OR ${like("order_id", pre)} OR ${like("payer_reference", pre)} OR ${like("awb", pre)})`);
  }
  if (cursor) {
    binds.push(cursor.t); const t = `?${binds.length}`;
    binds.push(cursor.id); const i = `?${binds.length}`;
    where.push(`(created_at<${t} OR (created_at=${t} AND order_id<${i}))`);
  }
  const rows = (await metaDb(env).prepare(
    `SELECT * FROM shop_orders WHERE ${where.join(" AND ")} ORDER BY created_at DESC, order_id DESC LIMIT ${PAGE + 1}`,
  ).bind(...binds).all<ShopOrderRow>()).results ?? [];
  const page = rows.slice(0, PAGE);
  const last = page[page.length - 1];
  const items = [];
  const extras = await loadOrderExtras(env, page);
  for (const r of page) items.push(await adminShape(env, r, now, extras));
  return json({
    items, next_cursor: rows.length > PAGE && last ? encodeCursor({ t: last.created_at, id: last.order_id }) : null,
    counts: await tabCounts(env, now),
  }, 200, { "cache-control": "private, no-store" });
}

// ---------------------------------------------------------------------------
// GET orders/:id
// ---------------------------------------------------------------------------
async function adminOrderDetail(req: Request, env: Env, id: string): Promise<Response> {
  const a = await admin(req, env); if (a instanceof Response) return a;
  const row = await loadShopOrder(env, id);
  if (!row) return err(404, "not_found", "No such order.");
  const db = metaDb(env);
  const [ev, sms] = await Promise.all([
    db.prepare(`SELECT kind, at, actor, note FROM shop_order_events WHERE order_id=?1 ORDER BY at ASC, id ASC LIMIT 200`).bind(id).all<{ kind: string; at: number; actor: string | null; note: string | null }>(),
    // Bank SMS of exactly this payable amount that nothing has claimed yet -- the admin's "pick the SMS" list.
    db.prepare(
      `SELECT r.message_hash, r.amount_paise, r.bank_reference, r.received_at_ms
         FROM hdfc_sms_smoke_receipts r
        WHERE r.receiving_account_key=?1 AND r.amount_paise=?2 AND r.disposition IN ('accepted','review_required') AND r.claimed_intent_id IS NULL
          AND r.received_at_end_ms>=?3 AND r.received_at_ms<=?4
          AND NOT EXISTS (SELECT 1 FROM saathum_checkouts c WHERE c.receiving_account_key=r.receiving_account_key
                AND (c.matched_message_hash=r.message_hash OR (r.bank_reference IS NOT NULL AND c.payer_reference=r.bank_reference)))
          AND NOT EXISTS (SELECT 1 FROM shop_orders s WHERE s.receiving_account_key=r.receiving_account_key
                AND (s.matched_message_hash=r.message_hash OR (r.bank_reference IS NOT NULL AND s.payer_reference=r.bank_reference)))
        ORDER BY r.received_at_ms DESC LIMIT 10`,
    ).bind(row.receiving_account_key, row.amount_paise, row.created_at, row.expires_at + LATE_SMS_GRACE_MS)
      .all<{ message_hash: string; amount_paise: number; bank_reference: string | null; received_at_ms: number }>().catch(() => null),
  ]);
  let problem: unknown = null;
  try { problem = row.problem_json ? JSON.parse(row.problem_json) : null; } catch { problem = null; }
  const shaped = await adminShape(env, row);
  const [shipment, productionEvents] = await Promise.all([describeShipment(env, row), loadFulfilmentEvents(env, id)]); // [AUMFE-POD-FULFIL-1] "What the partner gets"
  return json({
    order: {
      ...shaped, shipment, production_events: productionEvents,
      address: (() => { try { return JSON.parse(row.address_json); } catch { return null; } })(),
      subtotal_rupees: row.subtotal_rupees, discount_rupees: row.discount_rupees, coupon_code: row.coupon_code,
      gst_rupees: row.gst_rupees, gst_rate_pct: row.gst_rate_pct, pay_amount_paise: row.amount_paise,
      confirm_source: row.confirm_source, confirmed_at: row.confirmed_at, review_note: row.review_note, receipt_no: row.receipt_no,
      printrove_order_ref: row.printrove_order_ref, shipped_at: row.shipped_at, delivered_at: row.delivered_at,
      cancel_reason: row.cancel_reason, refund_utr: row.refund_utr, refunded_at: row.refunded_at,
      timeline: ev.results ?? [], problem,
      sms_candidates: (sms?.results ?? []).map((s) => ({ message_hash: s.message_hash, amount_paise: s.amount_paise, bank_reference: s.bank_reference, received_at: s.received_at_ms })),
    },
  }, 200, { "cache-control": "private, no-store" });
}

// ---------------------------------------------------------------------------
// POST confirm-payment / reject-payment
// ---------------------------------------------------------------------------
async function adminConfirmPayment(req: Request, env: Env, id: string): Promise<Response> {
  const a = await admin(req, env); if (a instanceof Response) return a;
  const row = await loadShopOrder(env, id);
  if (!row) return err(404, "not_found", "No such order.");
  const b = (await readBody(req)) ?? {};
  const messageHash = typeof b.message_hash === "string" && b.message_hash ? b.message_hash : null;
  if (b.message_hash !== undefined && b.message_hash !== null && (!messageHash || !/^[a-f0-9]{64}$/.test(messageHash))) return err(400, "invalid_message_hash", "That SMS reference is not valid.");
  const utr = b.utr === undefined || b.utr === null || b.utr === "" ? null : normalizeUtr(b.utr);
  if (b.utr !== undefined && b.utr !== null && b.utr !== "" && !utr) return err(400, "invalid_utr", "The UTR must be 12 digits.");
  const note = str(b.note, 500);
  if (row.pay_status === "confirmed") return json({ ok: true, already_confirmed: true, order: await adminShape(env, row) });
  if (row.pay_status !== "awaiting_payment" && row.pay_status !== "review_pending") return err(409, "not_confirmable", "This order can no longer be confirmed.", { status: row.pay_status });
  const db = metaDb(env);
  let bankReference: string | null = utr, payerVpa: string | null = null;
  if (messageHash) {
    const sms = await db.prepare(`SELECT bank_reference,payer_vpa,amount_paise,receiving_account_key FROM hdfc_sms_smoke_receipts WHERE message_hash=?1`).bind(messageHash)
      .first<{ bank_reference: string | null; payer_vpa: string | null; amount_paise: number; receiving_account_key: string }>();
    if (!sms || sms.receiving_account_key !== row.receiving_account_key) return err(404, "sms_not_found", "That SMS was not found.");
    if (sms.amount_paise !== row.amount_paise) return err(409, "sms_amount_mismatch", "That SMS is for a different amount.", { sms_amount_paise: sms.amount_paise, pay_amount_paise: row.amount_paise });
    bankReference = sms.bank_reference ?? utr; payerVpa = sms.payer_vpa;
  }
  if (bankReference) {
    // A bank reference may only ever confirm ONE thing: not another shop order, not an event booking.
    const taken = await db.prepare(
      `SELECT 1 AS x FROM shop_orders WHERE receiving_account_key=?1 AND payer_reference=?2 AND order_id<>?3
       UNION ALL SELECT 1 FROM saathum_checkouts WHERE receiving_account_key=?1 AND payer_reference=?2 LIMIT 1`,
    ).bind(row.receiving_account_key, bankReference, id).first();
    if (taken) return err(409, "reference_conflict", "That payment reference is already used by another order.");
  }
  const out = await confirmShopOrder(env, id, { via: "admin", bankReference, payerVpa, messageHash, adminUid: a.uid, note });
  await audit(env, a.uid, "shop_payment_confirm", id, { result: out, linked_sms: !!messageHash, utr: utr ? `…${utr.slice(-4)}` : null });
  await track(env, a.uid, "shop_admin_payment_confirm", APP, { order_id: id, result: out, linked_sms: !!messageHash });
  if (out !== "confirmed") return err(409, "not_confirmable", "This order could not be confirmed (someone else may have just confirmed it).");
  const after = (await loadShopOrder(env, id)) ?? row;
  return json({ ok: true, order: await adminShape(env, after) });
}

async function adminRejectPayment(req: Request, env: Env, id: string): Promise<Response> {
  const a = await admin(req, env); if (a instanceof Response) return a;
  const row = await loadShopOrder(env, id);
  if (!row) return err(404, "not_found", "No such order.");
  const b = await readBody(req);
  const reason = str(b?.reason, 500);
  if (!reason) return err(400, "reason_required", "Please give a reason.");
  const ok = await rejectShopOrder(env, id, a.uid, reason);
  await audit(env, a.uid, "shop_payment_reject", id, { ok });
  await track(env, a.uid, "shop_admin_payment_reject", APP, { order_id: id, ok });
  if (!ok) return err(409, "not_rejectable", "This order can no longer be rejected.", { status: row.pay_status });
  return json({ ok: true, order: await adminShape(env, (await loadShopOrder(env, id)) ?? row) });
}

// ---------------------------------------------------------------------------
// Fulfilment transitions
// ---------------------------------------------------------------------------
const EVENT_KIND: Record<ShopAction, string> = { "at-printer": "at_printer", shipped: "shipped", delivered: "delivered", cancel: "cancelled", refund: "refunded" };

async function transition(req: Request, env: Env, id: string, action: ShopAction): Promise<Response> {
  const a = await admin(req, env); if (a instanceof Response) return a;
  const row = await loadShopOrder(env, id);
  if (!row) return err(404, "not_found", "No such order.");
  const b = (await readBody(req)) ?? {};
  const notify = b.notify !== false;
  const now = Date.now();
  if (row.pay_status !== "confirmed") return err(409, "not_paid", "This order has not been paid yet.");
  const t = SHOP_TRANSITIONS[action];
  if (!canTransition(action, row.fulfil_status)) return err(409, "bad_transition", `An order that is "${row.fulfil_status}" can't be moved to "${t.to}".`, { from: row.fulfil_status, to: t.to });

  // Per-action input + the SET clause. ?1 = id, ?2 = now, then action fields.
  let set: string; const extra: unknown[] = []; let note: string | null = null;
  switch (action) {
    case "at-printer":
      set = `fulfil_status='at_printer', sent_to_printer_at=?2, printrove_order_ref=COALESCE(?3,printrove_order_ref)`;
      extra.push(str(b.printrove_order_ref, 80));
      break;
    case "shipped": {
      const courier = str(b.courier, 60), awb = str(b.awb, 60);
      if (!courier) return err(400, "courier_required", "Pick the courier.", { field: "courier" });
      if (!awb) return err(400, "awb_required", "Enter the AWB / tracking number.", { field: "awb" });
      let tracking: string | null = null;
      if (b.tracking_url !== undefined && b.tracking_url !== null && b.tracking_url !== "") {
        tracking = validHttpUrl(b.tracking_url);
        if (!tracking) return err(400, "invalid_tracking_url", "The tracking link must start with https://", { field: "tracking_url" });
      }
      set = `fulfil_status='shipped', shipped_at=?2, courier=?3, awb=?4, tracking_url=?5, eta_text=?6`;
      extra.push(courier, awb, tracking, str(b.eta_text, 80));
      note = `${courier} ${awb}`;
      break;
    }
    case "delivered":
      set = `fulfil_status='delivered', delivered_at=?2`;
      break;
    case "cancel": {
      const reason = str(b.reason, 300);
      if (!reason) return err(400, "reason_required", "Please give a reason.", { field: "reason" });
      set = `fulfil_status='cancelled', cancel_reason=?3`;
      extra.push(reason); note = reason;
      break;
    }
    case "refund": {
      const refundUtr = normalizeUtr(b.refund_utr);
      if (!refundUtr) return err(400, "refund_utr_must_be_12_digits", "Enter the 12-digit UTR of the refund you sent.", { field: "refund_utr" });
      set = `fulfil_status='refunded', refund_utr=?3, refunded_at=?2`;
      extra.push(refundUtr); note = str(b.note, 300) ?? `UTR …${refundUtr.slice(-4)}`;
      break;
    }
  }
  const binds: unknown[] = [id, now, ...extra];
  const res = await metaDb(env).prepare(
    `UPDATE shop_orders SET ${set}, updated_at=?2
      WHERE order_id=?1 AND pay_status='confirmed' AND fulfil_status IN (${t.from.map((f) => `'${f}'`).join(",")})`,
  ).bind(...binds).run();
  if (Number((res as any).meta?.changes ?? 0) !== 1) return err(409, "bad_transition", "Someone else just changed this order. Reload and try again.", { from: row.fulfil_status, to: t.to });

  const after = (await loadShopOrder(env, id)) ?? row;
  await appendShopEvent(env, id, EVENT_KIND[action], a.uid, note, now).catch((e) => trackException(env, e, { uid: a.uid, route: `admin2_shop_orders:${action}:event`, handled: true, app_name: APP }));
  await audit(env, a.uid, `shop_order_${EVENT_KIND[action]}`, id, { from: row.fulfil_status, to: t.to, notify });
  await track(env, a.uid, "shop_order_status_changed", APP, { order_id: id, buyer_uid: row.uid, from: row.fulfil_status, to: t.to, notify });
  // [AUMFE-POD-FULFIL-1] The buyer messages live in lib/shop_notify.ts notifyShopTransition so the print-partner path sends the same ones.
  if (notify) await notifyShopTransition(env, action, after);
  return json({ ok: true, order: await adminShape(env, after) });
}

// ---------------------------------------------------------------------------
// GET kpis
// ---------------------------------------------------------------------------
async function adminKpis(req: Request, env: Env): Promise<Response> {
  const a = await admin(req, env); if (a instanceof Response) return a;
  const now = Date.now();
  const today = istDayStartMs(now), yesterday = today - DAY_MS, last30 = today - 29 * DAY_MS;
  const r = await metaDb(env).prepare(
    `SELECT COALESCE(SUM(CASE WHEN confirmed_at>=?1 THEN 1 ELSE 0 END),0) AS orders_today,
            COALESCE(SUM(CASE WHEN confirmed_at>=?2 AND confirmed_at<?1 THEN 1 ELSE 0 END),0) AS orders_yesterday,
            COALESCE(SUM(CASE WHEN confirmed_at>=?3 AND fulfil_status NOT IN ('refunded','cancelled') THEN 1 ELSE 0 END),0) AS orders_30d,
            COALESCE(SUM(CASE WHEN confirmed_at>=?3 AND fulfil_status NOT IN ('refunded','cancelled') THEN amount_paise ELSE 0 END),0) AS revenue_30d_paise,
            COALESCE(SUM(CASE WHEN fulfil_status='new' THEN 1 ELSE 0 END),0) AS to_print,
            COALESCE(SUM(CASE WHEN fulfil_status='at_printer' THEN 1 ELSE 0 END),0) AS to_ship,
            COALESCE(SUM(CASE WHEN fulfil_status IN ('new','at_printer') AND confirmed_at<=?4 THEN 1 ELSE 0 END),0) AS stale_48h,
            COALESCE(SUM(CASE WHEN fulfil_status='shipped' AND shipped_at>=?5 THEN 1 ELSE 0 END),0) AS shipped_7d
       FROM shop_orders WHERE pay_status='confirmed'`,
  ).bind(today, yesterday, last30, now - SHOP_STALE_MS, now - 7 * DAY_MS).first<Record<string, number>>();
  // [AUMFE-POD-FULFIL-1] Orders tiles: paid + bank-confirmed and not sent yet / customer says paid but no bank credit yet.
  const m = await metaDb(env).prepare(
    `SELECT COALESCE(SUM(CASE WHEN pay_status='confirmed' AND confirm_source='sms_auto' AND fulfil_status='new' THEN 1 ELSE 0 END),0) AS paid_ready_bank,
            COALESCE(SUM(CASE WHEN pay_status IN ('awaiting_payment','review_pending') AND (paid_claimed_at IS NOT NULL OR utr IS NOT NULL) THEN 1 ELSE 0 END),0) AS waiting_bank
       FROM shop_orders`,
  ).first<Record<string, number>>();
  return json({
    orders_today: Number(r?.orders_today ?? 0), orders_yesterday: Number(r?.orders_yesterday ?? 0),
    revenue_30d_rupees: Math.round(Number(r?.revenue_30d_paise ?? 0) / 100), orders_30d: Number(r?.orders_30d ?? 0),
    to_print: Number(r?.to_print ?? 0), to_ship: Number(r?.to_ship ?? 0), stale_48h: Number(r?.stale_48h ?? 0),
    paid_ready_bank: Number(m?.paid_ready_bank ?? 0), waiting_bank: Number(m?.waiting_bank ?? 0), at_printer: Number(r?.to_ship ?? 0), shipped_7d: Number(r?.shipped_7d ?? 0),
  }, 200, { "cache-control": "private, no-store" });
}

// ---------------------------------------------------------------------------
// Route table -- spread into ADMIN2_ROUTES (routes/admin2.ts).
// ---------------------------------------------------------------------------
const ID = "([^/]+)";
const B = "/api/admin/v2/shop";
const guardId = (h: (req: Request, env: Env, id: string) => Promise<Response>) =>
  (req: Request, env: Env, [id]: string[]) => (SHOP_ORDER_ID_RE.test(id) ? h(req, env, id) : Promise.resolve(err(404, "not_found", "No such order.")));
const act = (action: ShopAction) => guardId((req, env, id) => transition(req, env, id, action));

export const ADMIN2_SHOP_ORDER_ROUTES: Admin2RouteDef[] = [
  { method: "GET", path: `${B}/orders`, handler: (req, env) => adminOrderList(req, env) },
  { method: "GET", path: `${B}/kpis`, handler: (req, env) => adminKpis(req, env) },
  { method: "GET", path: new RegExp(`^${B}/orders/${ID}$`), handler: guardId(adminOrderDetail) },
  { method: "POST", path: new RegExp(`^${B}/orders/${ID}/confirm-payment$`), handler: guardId(adminConfirmPayment) },
  { method: "POST", path: new RegExp(`^${B}/orders/${ID}/reject-payment$`), handler: guardId(adminRejectPayment) },
  { method: "POST", path: new RegExp(`^${B}/orders/${ID}/at-printer$`), handler: act("at-printer") },
  { method: "POST", path: new RegExp(`^${B}/orders/${ID}/shipped$`), handler: act("shipped") },
  { method: "POST", path: new RegExp(`^${B}/orders/${ID}/delivered$`), handler: act("delivered") },
  { method: "POST", path: new RegExp(`^${B}/orders/${ID}/cancel$`), handler: act("cancel") },
  { method: "POST", path: new RegExp(`^${B}/orders/${ID}/refund$`), handler: act("refund") },
];
