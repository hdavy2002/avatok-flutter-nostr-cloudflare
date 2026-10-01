// [SAATHUM-UPI-3LAYER 2026-09-29] Layer 3 of the UPI confirmation: the admin review queue.
// (Specs/PLAN-SAATHUM-UPI-3LAYER.md, "API contract" -> Admin.)
//   GET  /api/admin/saathum/payments/review
//   POST /api/admin/saathum/checkout/:id/confirm   { message_hash?, note? }
//   POST /api/admin/saathum/checkout/:id/reject    { reason }
// Guarded by the same requireAdmin (ADMIN_UIDS) as the other /api/admin money routes. Confirm goes
// through confirmSaathumCheckout -- the SAME path as auto-match -- so the buyer gets the identical
// email + WhatsApp + receipt. Every decision stores the admin uid on the row (reviewed_by) and is
// tracked as an analytics event.
import type { Env } from "../types";
import { metaDb } from "../db/shard";
import { json } from "../util";
import { track } from "../hooks";
import { emailFor } from "../lib/identity";
import { UUID } from "../lib/hdfc_sms_smoke";
import { requireAdmin } from "./admin_money";
import { confirmSaathumCheckout, rejectSaathumCheckout } from "./saathum_checkout";
import { verifiedWhatsAppNumber } from "../lib/whatsapp_notify";
import { PAID_CLAIM_REVIEW_MS, externalReason } from "../lib/saathum_checkout_logic";
import { sourceLastSeen, SOURCE_STALE_MS, forwarderSilence, FORWARDER_DEVICE, type SourceHealthRow } from "../lib/saathum_upi3";
import { policy as hdfcPolicy } from "../lib/hdfc_sms_smoke";

const APP = "saathum";
const CORROBORATION_WINDOW_MS = 30 * 60_000;
const err = (error: string, status = 400, extra: Record<string, unknown> = {}) => json({ error, ...extra }, status);

type ReviewRow = {
  checkout_id: string; uid: string; listing_id: string; sankalp_json: string; amount_paise: number; status: string;
  reason_code: string | null; created_at: number; paid_claimed_at: number | null; utr: string | null; payer_reference: string | null;
  expires_at: number; title: string | null;
};

export async function adminSaathumReviewList(req: Request, env: Env): Promise<Response> {
  const a = await requireAdmin(req, env); if (a instanceof Response) return a;
  const db = metaDb(env);
  const now = Date.now();
  // review_pending rows, plus claimed rows past the 3-minute rule the cron has not persisted yet.
  const rows = await db.prepare(
    `SELECT c.checkout_id,c.uid,c.listing_id,c.sankalp_json,c.amount_paise,c.status,c.reason_code,c.created_at,c.paid_claimed_at,
            c.utr,c.payer_reference,c.expires_at,l.title
       FROM saathum_checkouts c LEFT JOIN listings l ON l.id=c.listing_id
      WHERE c.confirmed_at IS NULL AND (c.status='review_pending'
         OR (c.status='awaiting_payment' AND c.paid_claimed_at IS NOT NULL AND c.paid_claimed_at<=?1))
      ORDER BY COALESCE(c.paid_claimed_at,c.created_at) ASC LIMIT 100`,
  ).bind(now - PAID_CLAIM_REVIEW_MS).all<ReviewRow>();
  const checkouts = [];
  for (const r of rows.results ?? []) {
    let buyerName: string | null = null;
    try { buyerName = (JSON.parse(r.sankalp_json) as { name?: string }).name ?? null; } catch { /* keep null */ }
    const [email, whatsapp] = await Promise.all([
      emailFor(env, r.uid).catch(() => null),
      verifiedWhatsAppNumber(env, r.uid).catch(() => null),
    ]);
    checkouts.push({
      checkout_id: r.checkout_id, uid: r.uid, buyer_name: buyerName, whatsapp, email, listing_title: r.title,
      pay_amount_paise: r.amount_paise, status: "review_pending",
      reason_code: externalReason({ status: "review_pending", expires_at: r.expires_at, reason_code: r.reason_code, paid_claimed_at: r.paid_claimed_at }, now),
      created_at: r.created_at, paid_claimed_at: r.paid_claimed_at, utr: r.utr ?? r.payer_reference,
      needs_corroboration: false, // unconfirmed rows can never be forwarder-only confirmations (see confirmed_uncorroborated)
    });
  }
  // Bank SMS the automatic matcher could not place: accepted/needs-review evidence not linked to any checkout.
  const p = await hdfcPolicy(env).catch(() => null);
  // [SAATHUM-SHOP-API-ORDERS-1 2026-10-01] An SMS already claimed by a SHOP order is not "unmatched" either. If the shop
  // table is not migrated the query is re-run exactly as before (events only).
  const shopClaimed = ` AND NOT EXISTS (SELECT 1 FROM shop_orders s WHERE s.receiving_account_key=r.receiving_account_key
                AND (s.matched_message_hash=r.message_hash OR (r.bank_reference IS NOT NULL AND s.payer_reference=r.bank_reference)))`;
  type UnmatchedRow = { message_hash: string; amount_paise: number; payer_vpa: string | null; bank_reference: string | null; received_at_ms: number; source_device: string | null };
  const runUnmatched = (withShop: boolean) => db.prepare(
    `SELECT r.message_hash,r.amount_paise,r.payer_vpa,r.bank_reference,r.received_at_ms,
              (SELECT device_id FROM hdfc_sms_receipts x WHERE x.message_hash=r.message_hash) AS source_device
         FROM hdfc_sms_smoke_receipts r
        WHERE r.receiving_account_key=?1 AND r.disposition IN ('accepted','review_required') AND r.claimed_intent_id IS NULL
          AND r.received_at_ms>=?2
          AND NOT EXISTS (SELECT 1 FROM saathum_checkouts c WHERE c.receiving_account_key=r.receiving_account_key
                AND (c.matched_message_hash=r.message_hash OR (r.bank_reference IS NOT NULL AND c.payer_reference=r.bank_reference)))${withShop ? shopClaimed : ""}
        ORDER BY r.received_at_ms DESC LIMIT 100`,
  ).bind(p!.account, now - 3 * 86_400_000).all<UnmatchedRow>().catch(() => null);
  let unmatched = p ? await runUnmatched(true) : null;
  if (p && !unmatched) unmatched = await runUnmatched(false);
  // Shop orders waiting on the admin (review_pending, or "I've paid" past the 3-minute rule not yet persisted by the cron).
  const shopRows = await db.prepare(
    `SELECT order_id,order_no,uid,contact_name,amount_paise,reason_code,created_at,paid_claimed_at,utr,payer_reference,expires_at
       FROM shop_orders
      WHERE confirmed_at IS NULL AND (pay_status='review_pending'
         OR (pay_status='awaiting_payment' AND paid_claimed_at IS NOT NULL AND paid_claimed_at<=?1))
      ORDER BY COALESCE(paid_claimed_at,created_at) ASC LIMIT 100`,
  ).bind(now - PAID_CLAIM_REVIEW_MS).all<{
    order_id: string; order_no: string; uid: string; contact_name: string | null; amount_paise: number; reason_code: string | null;
    created_at: number; paid_claimed_at: number | null; utr: string | null; payer_reference: string | null; expires_at: number;
  }>().catch(() => null);
  const shop_orders = [];
  for (const r of shopRows?.results ?? []) {
    const [email, whatsapp] = await Promise.all([
      emailFor(env, r.uid).catch(() => null),
      verifiedWhatsAppNumber(env, r.uid).catch(() => null),
    ]);
    shop_orders.push({
      order_id: r.order_id, order_no: r.order_no, uid: r.uid, buyer_name: r.contact_name, whatsapp, email,
      pay_amount_paise: r.amount_paise, status: "review_pending",
      reason_code: externalReason({ status: "review_pending", expires_at: r.expires_at, reason_code: r.reason_code, paid_claimed_at: r.paid_claimed_at }, now),
      created_at: r.created_at, paid_claimed_at: r.paid_claimed_at, utr: r.utr ?? r.payer_reference,
    });
  }
  const src = await db.prepare(`SELECT device_id,source,last_heartbeat_at,last_sms_at,last_error,alerted_at,stale_alert_open FROM sms_source_health ORDER BY source`).all<SourceHealthRow>().catch(() => null);
  // [SAATHUM-UPI-3LAYER 2026-09-29] Corroboration warning (never a block): checkouts auto-confirmed ONLY by the
  // third-party SMS forwarder (matched evidence came from device 'forwarder') that neither the Google Messages
  // watcher nor the companion delivered within 30 min of the confirmation (matched by bank reference in the
  // raw hdfc_sms_receipts text). Last 7 days.
  const unc = await db.prepare(
    `SELECT c.checkout_id,c.uid,c.sankalp_json,c.amount_paise,c.payer_reference,c.confirmed_at,l.title
       FROM saathum_checkouts c
       JOIN hdfc_sms_receipts f ON f.message_hash=c.matched_message_hash AND f.device_id=?3
       LEFT JOIN listings l ON l.id=c.listing_id
      WHERE c.status='confirmed' AND c.confirm_source='sms_auto' AND c.confirmed_at>=?1 AND c.payer_reference IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM hdfc_sms_receipts o
              WHERE o.device_id<>?3 AND instr(o.message,c.payer_reference)>0
                AND o.created_at BETWEEN c.confirmed_at-?2 AND c.confirmed_at+?2)
      ORDER BY c.confirmed_at DESC LIMIT 100`,
  ).bind(now - 7 * 86_400_000, CORROBORATION_WINDOW_MS, FORWARDER_DEVICE)
    .all<{ checkout_id: string; uid: string; sankalp_json: string; amount_paise: number; payer_reference: string; confirmed_at: number; title: string | null }>().catch(() => null);
  const confirmed_uncorroborated = (unc?.results ?? []).map((u) => {
    let buyerName: string | null = null;
    try { buyerName = (JSON.parse(u.sankalp_json) as { name?: string }).name ?? null; } catch { /* keep null */ }
    return {
      checkout_id: u.checkout_id, uid: u.uid, buyer_name: buyerName, listing_title: u.title, pay_amount_paise: u.amount_paise,
      bank_reference: u.payer_reference, confirmed_at: u.confirmed_at, confirmed_via: "forwarder",
      needs_corroboration: true,
      // true for 30 min after confirmation: the watcher/companion may still deliver its copy.
      corroboration_window_open: now < u.confirmed_at + CORROBORATION_WINDOW_MS,
    };
  });
  const silence = await forwarderSilence(env, now).catch(() => null);
  return json({
    checkouts,
    shop_orders, // [SAATHUM-SHOP-API-ORDERS-1 2026-10-01]
    unmatched_sms: (unmatched?.results ?? []).map((u) => ({
      message_hash: u.message_hash, amount_paise: u.amount_paise, payer_vpa: u.payer_vpa, bank_reference: u.bank_reference,
      received_at_ms: u.received_at_ms, source_device: u.source_device,
    })),
    sources: (src?.results ?? []).map((s) => s.device_id === FORWARDER_DEVICE
      // The forwarder has no heartbeat: it is unhealthy only when silent for 24 h while the watcher saw HDFC credits.
      ? { device_id: s.device_id, source: s.source, last_heartbeat_at: null, last_sms_at: s.last_sms_at, healthy: !(silence?.silent ?? false), heartbeat: false, silent_24h_with_watcher_credits: silence?.silent ?? false }
      : {
        device_id: s.device_id, source: s.source, last_heartbeat_at: s.last_heartbeat_at, last_sms_at: s.last_sms_at,
        healthy: now - sourceLastSeen(s) <= SOURCE_STALE_MS,
      }),
    confirmed_uncorroborated,
  });
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try { const v = await req.json(); return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null; } catch { return null; }
}

export async function adminSaathumCheckoutConfirm(req: Request, env: Env, id: string): Promise<Response> {
  const a = await requireAdmin(req, env); if (a instanceof Response) return a;
  if (!UUID.test(id)) return err("not_found", 404);
  const b = (await readBody(req)) ?? {};
  const messageHash = typeof b.message_hash === "string" && b.message_hash ? b.message_hash : null;
  const note = typeof b.note === "string" && b.note.trim() ? b.note.trim().slice(0, 500) : null;
  if (b.message_hash !== undefined && b.message_hash !== null && (!messageHash || !/^[a-f0-9]{64}$/.test(messageHash))) return err("invalid_message_hash");
  const db = metaDb(env);
  const row = await db.prepare(`SELECT checkout_id,uid,status,amount_paise,receiving_account_key,confirmed_at,reason_code FROM saathum_checkouts WHERE checkout_id=?1`).bind(id)
    .first<{ checkout_id: string; uid: string; status: string; amount_paise: number; receiving_account_key: string; confirmed_at: number | null; reason_code: string | null }>();
  if (!row) return err("not_found", 404);
  if (row.status === "confirmed") return json({ ok: true, checkout_id: id, status: "confirmed", already_confirmed: true });
  if (row.status !== "awaiting_payment" && row.status !== "review_pending") return err("not_confirmable", 409, { status: row.status });

  let bankReference: string | null = null, payerVpa: string | null = null;
  if (messageHash) {
    const sms = await db.prepare(
      `SELECT bank_reference,payer_vpa,amount_paise,receiving_account_key FROM hdfc_sms_smoke_receipts WHERE message_hash=?1`,
    ).bind(messageHash).first<{ bank_reference: string | null; payer_vpa: string | null; amount_paise: number; receiving_account_key: string }>();
    if (!sms || sms.receiving_account_key !== row.receiving_account_key) return err("sms_not_found", 404);
    if (sms.amount_paise !== row.amount_paise) return err("sms_amount_mismatch", 409, { sms_amount_paise: sms.amount_paise, pay_amount_paise: row.amount_paise });
    bankReference = sms.bank_reference; payerVpa = sms.payer_vpa;
    if (bankReference) {
      const taken = await db.prepare(`SELECT checkout_id FROM saathum_checkouts WHERE receiving_account_key=?1 AND payer_reference=?2 AND checkout_id<>?3`)
        .bind(row.receiving_account_key, bankReference, id).first();
      if (taken) return err("reference_conflict", 409);
    }
  }
  const out = await confirmSaathumCheckout(env, id, { via: "admin", bankReference, payerVpa, messageHash, adminUid: a.uid, note });
  console.log("[saathum-admin] confirm", JSON.stringify({ admin: a.uid, checkout_id: id, result: out }));
  await track(env, a.uid, "saathum_admin_payment_confirm", APP, { checkout_id: id, result: out, linked_sms: !!messageHash });
  if (out === "lost") return err("not_confirmable", 409);
  const after = await db.prepare(`SELECT status,reason_code,confirmed_at,receipt_no FROM saathum_checkouts WHERE checkout_id=?1`).bind(id)
    .first<{ status: string; reason_code: string | null; confirmed_at: number | null; receipt_no: string | null }>();
  if (out === "failed") return err("provisioning_failed", 502, { status: after?.status, reason_code: after?.reason_code });
  return json({ ok: true, checkout_id: id, status: after?.status ?? "confirmed", confirmed_at: after?.confirmed_at ?? null, receipt_no: after?.receipt_no ?? null, reviewed_by: a.uid });
}

export async function adminSaathumCheckoutReject(req: Request, env: Env, id: string): Promise<Response> {
  const a = await requireAdmin(req, env); if (a instanceof Response) return a;
  if (!UUID.test(id)) return err("not_found", 404);
  const b = await readBody(req);
  const reason = typeof b?.reason === "string" ? b.reason.trim().slice(0, 500) : "";
  if (!reason) return err("reason_required");
  const exists = await metaDb(env).prepare(`SELECT status FROM saathum_checkouts WHERE checkout_id=?1`).bind(id).first<{ status: string }>();
  if (!exists) return err("not_found", 404);
  const ok = await rejectSaathumCheckout(env, id, a.uid, reason);
  console.log("[saathum-admin] reject", JSON.stringify({ admin: a.uid, checkout_id: id, ok }));
  await track(env, a.uid, "saathum_admin_payment_reject", APP, { checkout_id: id, ok });
  if (!ok) return err("not_rejectable", 409, { status: exists.status });
  return json({ ok: true, checkout_id: id, status: "cancelled", reason_code: "rejected", reviewed_by: a.uid });
}
