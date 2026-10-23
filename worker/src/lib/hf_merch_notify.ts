// [HF-MERCH-CORE-1 2026-10-23] Every message and telemetry event of the merch shop, in ONE place (spec sections 6 and 9).
// Reuses the existing senders: whatsapp_outbox (paced drain in lib/whatsapp_notify.ts), enqueueEmail, sendAdminAlert, sendHfPush, renderShopReceipt.
// Everything here is best-effort and NEVER throws into a payment or an admin action; failures go to trackException.
import type { Env } from "../types";
import { metaDb } from "../db/shard";
import { sha256Hex } from "../util";
import { trackUser, trackException } from "../hooks";
import { BRAND, brandUrl } from "./brand";
import { emailFor } from "./identity";
import { escapeHtml } from "../cal/emails";
import { enqueueEmail } from "./email_outbox";
import { verifiedWhatsAppNumber } from "./whatsapp_notify";
import { sendAdminAlert } from "./saathum_upi3";
import { sendHfPush } from "./hf_push";
import { renderShopReceipt } from "./shop_notify";
import { rupeesText } from "./hf_merch_math";
import { parseJson, type MerchSnapshot } from "./hf_merch_types";
import type { ShopOrderRow } from "./shop_orders_logic";

export const MERCH_APP = BRAND.slug;
export const fanOrderUrl = (orderId: string) => brandUrl(`/dashboard/orders?order=${orderId}`);
export const sellerOrdersUrl = () => brandUrl("/dashboard/merch");

export const snapOf = (row: Pick<ShopOrderRow, "merch_json">): Partial<MerchSnapshot> => parseJson<Partial<MerchSnapshot>>(row.merch_json, {});

/** PostHog event with the person's email (spec section 9). Never throws. */
export async function merchTrack(env: Env, uid: string, event: string, props: Record<string, unknown> = {}): Promise<void> {
  try {
    const email = uid && uid !== "system" ? await emailFor(env, uid).catch(() => null) : null;
    await trackUser(env, uid || "system", email, event, MERCH_APP, props);
  } catch { /* telemetry is best-effort */ }
}

/** Failure -> $exception with the area, so a broken merch step is visible in PostHog. */
export async function merchFail(env: Env, e: unknown, route: string, uid?: string, extra: Record<string, unknown> = {}): Promise<void> {
  try { await trackException(env, e, { uid, route: `hf_merch:${route}`, handled: true, app_name: MERCH_APP, extra: { area: "hf_merch", ...extra } }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// WhatsApp (buyer): queued in whatsapp_outbox, one row per (order, kind, variant)
// ---------------------------------------------------------------------------
export type MerchWaKind = "merch_order_placed" | "merch_order_approved" | "merch_order_rejected";

export function merchWhatsAppText(kind: MerchWaKind, row: Pick<ShopOrderRow, "order_id" | "order_no" | "reject_reason" | "pay_method">, snap: Partial<MerchSnapshot>): string {
  const no = row.order_no;
  const link = fanOrderUrl(row.order_id);
  const what = snap.title ? `${snap.title}${snap.size ? `, size ${snap.size}` : ""}` : "your order";
  switch (kind) {
    case "merch_order_placed":
      return `🙏 Order ${no} placed. We have your payment for ${what}.\nWe check every order before it goes to print, and we will message you at each step.\nTrack it here: ${link}\n— ${BRAND.name}`;
    case "merch_order_approved":
      return `🙏 Good news. Your order ${no} (${what}) is approved and is being prepared for printing.\nTrack it here: ${link}\n— ${BRAND.name}`;
    case "merch_order_rejected": {
      const how = row.pay_method === "wallet" ? `has been put back into your ${BRAND.name} wallet` : "is being sent back to the account you paid from";
      return `🙏 We are sorry. We could not take your order ${no} (${what}).${row.reject_reason ? `\nReason: ${row.reject_reason}` : ""}\nYour money ${how}.\nDetails: ${link}\n— ${BRAND.name}`;
    }
  }
}

export async function queueMerchWhatsApp(env: Env, kind: MerchWaKind, row: ShopOrderRow): Promise<"queued" | "duplicate" | "no_phone"> {
  const e164 = await verifiedWhatsAppNumber(env, row.uid);
  if (!e164) return "no_phone";
  const text = merchWhatsAppText(kind, row, snapOf(row));
  const urlHash = (await sha256Hex(`merch:${kind}`)).slice(0, 16);
  const now = Date.now();
  const res = await metaDb(env).prepare(
    `INSERT OR IGNORE INTO whatsapp_outbox (checkout_id, uid, listing_id, kind, url_hash, e164, message, status, attempts, created_at, updated_at)
     VALUES (?1,?2,'shop',?3,?4,?5,?6,'queued',0,?7,?7)`,
  ).bind(row.order_id, row.uid, kind, urlHash, e164, text, now).run();
  return res.meta?.changes ? "queued" : "duplicate";
}

export async function merchWhatsApp(env: Env, kind: MerchWaKind, row: ShopOrderRow): Promise<void> {
  try {
    const r = await queueMerchWhatsApp(env, kind, row);
    await merchTrack(env, row.uid, "merch_whatsapp_queued", { order_id: row.order_id, kind, result: r });
  } catch (e) { await merchFail(env, e, `whatsapp:${kind}`, row.uid); }
}

// ---------------------------------------------------------------------------
// Email (buyer)
// ---------------------------------------------------------------------------
const b64 = (u: Uint8Array): string => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const wrap = (title: string, inner: string): string =>
  `<div style="font-family:Nunito,Arial,sans-serif;max-width:520px;margin:0 auto;padding:16px;color:#46113e"><h2 style="margin:0 0 12px">${escapeHtml(title)}</h2>${inner}<p style="margin:16px 0 0;color:#8a6a85;font-size:12px">${escapeHtml(BRAND.name)}</p></div>`;

export type MerchEmailKind = "placed" | "approved" | "rejected";
export async function sendMerchEmail(env: Env, kind: MerchEmailKind, row: ShopOrderRow): Promise<void> {
  const to = await emailFor(env, row.uid).catch(() => null);
  if (!to) { await merchTrack(env, row.uid, "merch_email", { ok: false, kind, reason: "no_email", order_id: row.order_id }); return; }
  const snap = snapOf(row);
  const no = escapeHtml(row.order_no);
  const item = `<p style="margin:0 0 8px">${escapeHtml(String(snap.title ?? ""))}${snap.colour ? ` · ${escapeHtml(String(snap.colour))}` : ""}${snap.size ? ` · ${escapeHtml(String(snap.size))}` : ""} · Qty ${Number(snap.qty ?? 1)}</p>`;
  let subject: string, html: string, attachments: { name: string; content: string }[] | undefined;
  if (kind === "placed") {
    subject = `Order placed — ${row.order_no}`;
    html = wrap("Order placed 🙏", `<p style="margin:0 0 8px;font-weight:600">Order ${no}</p>${item}
      <p style="margin:0 0 8px">Thank you. We have your payment of ${escapeHtml(rupeesText(row.amount_paise))}. We check each order before it goes to print and will write to you at every step.</p>
      <p style="margin:0 0 8px"><a href="${escapeHtml(fanOrderUrl(row.order_id))}">Track your order</a></p>
      <p style="margin:0;color:#8a6a85;font-size:12px">Your receipt is attached. Receipt no. ${escapeHtml(row.receipt_no ?? "")}</p>`);
    const pdf = await renderShopReceipt(env, row, to);
    attachments = [{ name: `${row.receipt_no ?? "receipt"}.pdf`, content: b64(pdf) }];
  } else if (kind === "approved") {
    subject = `Your order ${row.order_no} is approved`;
    html = wrap("Your order is approved", `<p style="margin:0 0 8px;font-weight:600">Order ${no}</p>${item}<p style="margin:0 0 8px">It is being prepared for printing. We will write again when it ships.</p>
      <p style="margin:0"><a href="${escapeHtml(fanOrderUrl(row.order_id))}">Track your order</a></p>`);
  } else {
    const how = row.pay_method === "wallet" ? `put back into your ${escapeHtml(BRAND.name)} wallet` : "sent back to the account you paid from. It can take a few days to show in your bank app";
    subject = `About your order ${row.order_no}`;
    html = wrap("We could not take your order", `<p style="margin:0 0 8px;font-weight:600">Order ${no}</p>${item}
      <p style="margin:0 0 8px">We are sorry. ${row.reject_reason ? `Reason: ${escapeHtml(row.reject_reason)}. ` : ""}Your ${escapeHtml(rupeesText(row.amount_paise))} has been ${how}.</p>
      <p style="margin:0">Questions? Write to <a href="mailto:${BRAND.emails.support}">${BRAND.emails.support}</a>.</p>`);
  }
  const result = await enqueueEmail(env, {
    to, subject, html, kind: `merch_order_${kind}`, orderId: row.order_id, recipientId: row.uid,
    messageVersion: `merch-order-${kind}.v1`, outboxKey: `merch-order-${kind}:${row.order_id}`, ...(attachments ? { attachments } : {}),
  });
  const ok = result.status !== "unavailable" && result.status !== "failed";
  if (ok && kind === "placed") await metaDb(env).prepare(`UPDATE shop_orders SET email_sent_at=?2 WHERE order_id=?1`).bind(row.order_id, Date.now()).run().catch(() => {});
  await merchTrack(env, row.uid, "merch_email", { ok, kind, order_id: row.order_id });
}
export async function merchEmail(env: Env, kind: MerchEmailKind, row: ShopOrderRow): Promise<void> {
  try { await sendMerchEmail(env, kind, row); } catch (e) { await merchFail(env, e, `email:${kind}`, row.uid); }
}

// ---------------------------------------------------------------------------
// Push (fan + influencer) and the owner alert
// ---------------------------------------------------------------------------
export async function merchPush(env: Env, uid: string, kind: "merch_order" | "merch_update", title: string, body: string, path: string): Promise<void> {
  try { await sendHfPush(env, uid, { kind, title, body, path }); } catch (e) { await merchFail(env, e, "push", uid); }
}

/** Paid: fan WhatsApp + email receipt, influencer push "New order: <title>, size L — you earn Rs X", owner WhatsApp. */
export async function notifyMerchPaid(env: Env, row: ShopOrderRow): Promise<void> {
  const snap = snapOf(row);
  await merchWhatsApp(env, "merch_order_placed", row);
  await merchEmail(env, "placed", row);
  if (row.seller_uid) {
    await merchPush(env, row.seller_uid, "merch_order", `New order: ${snap.title ?? "your merch"}`, `Size ${snap.size ?? ""} — you earn ${rupeesText(snap.money?.influencerPaise ?? 0)}.`, "/dashboard/merch");
  }
  await merchPush(env, row.uid, "merch_update", `Order ${row.order_no} placed`, "We will tell you when it is approved and shipped.", `/dashboard/orders?order=${row.order_id}`);
  try {
    await sendAdminAlert(env, `${BRAND.nameCompact} merch: new paid order ${row.order_no}\n${snap.title ?? ""} ${snap.size ?? ""} x${snap.qty ?? 1} - ${rupeesText(row.amount_paise)} (${row.pay_method ?? ""})\nOpen admin > Merch to approve it.`);
  } catch (e) { await merchFail(env, e, "owner_alert", row.uid); }
}

export async function notifyMerchApproved(env: Env, row: ShopOrderRow): Promise<void> {
  await merchWhatsApp(env, "merch_order_approved", row);
  await merchEmail(env, "approved", row);
  await merchPush(env, row.uid, "merch_update", `Order ${row.order_no} approved`, "It is being prepared for printing.", `/dashboard/orders?order=${row.order_id}`);
  if (row.seller_uid) await merchPush(env, row.seller_uid, "merch_update", "Order approved", `${snapOf(row).title ?? "An order"} is on its way to print.`, "/dashboard/merch");
}

export async function notifyMerchRejected(env: Env, row: ShopOrderRow): Promise<void> {
  await merchWhatsApp(env, "merch_order_rejected", row);
  await merchEmail(env, "rejected", row);
  await merchPush(env, row.uid, "merch_update", `Order ${row.order_no} cancelled`, "Your money is being returned.", `/dashboard/orders?order=${row.order_id}`);
  if (row.seller_uid) await merchPush(env, row.seller_uid, "merch_update", "An order was cancelled", `${snapOf(row).title ?? "An order"} was cancelled and refunded.`, "/dashboard/merch");
}

/** Shipped / delivered: the fan already gets the shop WhatsApp + email (notifyShopTransition); the push for fan + influencer is added here. */
export async function notifyMerchStatusPush(env: Env, row: ShopOrderRow, step: "shipped" | "delivered"): Promise<void> {
  const title = step === "shipped" ? `Order ${row.order_no} shipped` : `Order ${row.order_no} delivered`;
  await merchPush(env, row.uid, "merch_update", title, step === "shipped" ? "Your parcel is on its way." : "We hope you love it.", `/dashboard/orders?order=${row.order_id}`);
  if (row.seller_uid) {
    const earn = snapOf(row).money?.influencerPaise ?? 0;
    await merchPush(env, row.seller_uid, "merch_update", step === "shipped" ? "An order shipped" : "An order was delivered",
      step === "delivered" ? `You earned ${rupeesText(earn)}. It becomes withdrawable after ${snapOf(row).holdDays ?? 7} days.` : `${snapOf(row).title ?? "An order"} is on its way to the buyer.`, "/dashboard/merch");
  }
}

/** A refund that needs a person (Cashfree refund API failed or is not available). */
export async function alertOwnerMerchRefund(env: Env, row: ShopOrderRow, message: string): Promise<void> {
  try { await sendAdminAlert(env, `${BRAND.nameCompact} merch: refund needs you on ${row.order_no}\n${rupeesText(row.amount_paise)} via ${row.pay_method ?? "?"}. ${message.slice(0, 160)}\nOpen admin > Merch > Orders and mark the refund done once it is sent.`); }
  catch (e) { await merchFail(env, e, "owner_refund_alert", row.uid); }
}
