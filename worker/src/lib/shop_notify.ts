// [SAATHUM-SHOP-API-ORDERS-1 2026-10-01] Shop order notifications: buyer WhatsApp (queued in whatsapp_outbox, drained by the
// paced cron in lib/whatsapp_notify.ts), buyer emails (enqueueEmail, deduped by outboxKey `shop-order-<kind>:<id>`),
// the receipt PDF, and the owner WhatsApp alerts. Every function here is best-effort: callers .catch() and trackException;
// nothing here may fail a payment confirmation. whatsapp_outbox.listing_id is NOT NULL, so shop rows use the literal 'shop'.
import { BRAND, brandUrl } from "./brand";
import type { Env } from "../types";
import { metaDb } from "../db/shard";
import { sha256Hex } from "../util";
import { track, trackException } from "../hooks";
import { emailFor } from "./identity";
import { escapeHtml } from "../cal/emails";
import { enqueueEmail } from "./email_outbox";
import { renderSaathumReceiptPdf } from "./me_receipt_pdf";
import { verifiedWhatsAppNumber, type NotifyKind } from "./whatsapp_notify";
import { sendAdminAlert } from "./saathum_upi3";
import { orderItems, shopReceiptMoney, SHOP_DEFAULT_REPORT_WINDOW_HOURS, type ShopOrderRow } from "./shop_orders_logic";
import type { Address } from "./saathum_checkout_logic";

const APP = "saathum";
export type ShopNotifyKind = Extract<NotifyKind, "shop_order_confirmed" | "shop_order_rejected" | "shop_order_printing" | "shop_order_shipped" | "shop_order_delivered" | "shop_order_refunded">;

const ordersUrl = () => brandUrl("/dashboard/orders");
const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;

// ---------------------------------------------------------------------------
// Shop policy (shop_settings 'policy'); defaults when unset / table missing.
// ---------------------------------------------------------------------------
export type ShopPolicy = { delivery_text: string; report_window_hours: number; print_partner: string; alerts_whatsapp: boolean };
export async function readShopPolicy(env: Env): Promise<ShopPolicy> {
  const d: ShopPolicy = { delivery_text: "5–8 days", report_window_hours: SHOP_DEFAULT_REPORT_WINDOW_HOURS, print_partner: "Printrove", alerts_whatsapp: true };
  try {
    const r = await metaDb(env).prepare(`SELECT value_json FROM shop_settings WHERE key='policy'`).first<{ value_json: string }>();
    if (!r) return d;
    const v = JSON.parse(r.value_json) as Partial<ShopPolicy>;
    return {
      delivery_text: typeof v.delivery_text === "string" && v.delivery_text.trim() ? v.delivery_text.trim() : d.delivery_text,
      report_window_hours: Number.isFinite(Number(v.report_window_hours)) && Number(v.report_window_hours) > 0 ? Number(v.report_window_hours) : d.report_window_hours,
      print_partner: typeof v.print_partner === "string" && v.print_partner.trim() ? v.print_partner.trim() : d.print_partner,
      alerts_whatsapp: v.alerts_whatsapp !== false,
    };
  } catch { return d; }
}

// ---------------------------------------------------------------------------
// WhatsApp copy
// ---------------------------------------------------------------------------
export function shopWhatsAppText(kind: ShopNotifyKind, row: ShopOrderRow, policy: Pick<ShopPolicy, "delivery_text" | "report_window_hours">): string {
  const no = row.order_no;
  const link = ordersUrl();
  switch (kind) {
    case "shop_order_confirmed":
      return `🙏 Payment received. Your order ${no} is confirmed.\nYour T-shirt is now being printed for you. Delivery usually takes ${policy.delivery_text}, and shipping is free.\nTrack it and get your receipt here: ${link}\n— ${BRAND.name}`;
    case "shop_order_rejected":
      // Soft tone: ask for the 12-digit UTR or a screenshot, never blame.
      return `🙏 Namaste. We're sorry — we couldn't find your payment for order ${no} yet, so it isn't confirmed.\n\nIf money has left your account, please don't worry. Just email ${BRAND.emails.support} with the 12-digit UPI transaction ID (UTR) from your UPI app or bank SMS, or a screenshot of the payment, and quote order ${no}. We'll set it right quickly.\n— ${BRAND.name}`;
    case "shop_order_printing":
      return `🙏 Good news — your order ${no} has gone to print.\nWe'll message you as soon as it ships.\nTrack it here: ${link}\n— ${BRAND.name}`;
    case "shop_order_shipped": {
      const lines = [`📦 Your order ${no} is on its way.`];
      if (row.courier) lines.push(`Courier: ${row.courier}`);
      if (row.awb) lines.push(`AWB: ${row.awb}`);
      if (row.eta_text) lines.push(`Expected: ${row.eta_text}`);
      if (row.tracking_url) lines.push(`Track your parcel: ${row.tracking_url}`);
      lines.push(`All your orders: ${link}`, `— ${BRAND.name}`);
      return lines.join("\n");
    }
    case "shop_order_delivered":
      return `🙏 Your order ${no} has been delivered. We hope you love it!\nIf we sent the wrong or a damaged item, tell us within ${policy.report_window_hours} hours with a photo, from ${link} ("Wrong item? Report it").\n— ${BRAND.name}`;
    case "shop_order_refunded":
      return `🙏 Your refund of ${rupees(row.amount_paise / 100)} for order ${no} has been sent to the UPI account you paid from${row.refund_utr ? ` (UTR ${row.refund_utr})` : ""}.\nIt can take a little while to show in your bank app. Details: ${link}\n— ${BRAND.name}`;
  }
}

/**
 * Queue ONE WhatsApp to the buyer. Idempotent through UNIQUE(checkout_id, kind, url_hash): `variant` distinguishes a
 * deliberate re-send (e.g. a corrected AWB) from a duplicate click. Buyers without a verified number are skipped.
 */
export async function queueShopWhatsApp(env: Env, kind: ShopNotifyKind, row: ShopOrderRow, variant = ""): Promise<"queued" | "duplicate" | "no_phone"> {
  const e164 = await verifiedWhatsAppNumber(env, row.uid);
  if (!e164) return "no_phone";
  const policy = await readShopPolicy(env);
  const text = shopWhatsAppText(kind, row, policy);
  const urlHash = (await sha256Hex(`shop:${kind}:${variant}`)).slice(0, 16);
  const now = Date.now();
  const res = await metaDb(env).prepare(
    `INSERT OR IGNORE INTO whatsapp_outbox
      (checkout_id, uid, listing_id, kind, url_hash, e164, message, status, attempts, created_at, updated_at)
     VALUES (?1,?2,'shop',?3,?4,?5,?6,'queued',0,?7,?7)`,
  ).bind(row.order_id, row.uid, kind, urlHash, e164, text, now).run();
  return res.meta?.changes ? "queued" : "duplicate";
}

/** Safe wrapper used by routes: never throws, reports to PostHog. */
export async function notifyShopWhatsApp(env: Env, kind: ShopNotifyKind, row: ShopOrderRow, variant = ""): Promise<void> {
  try {
    const r = await queueShopWhatsApp(env, kind, row, variant);
    await track(env, row.uid, "shop_whatsapp_queued", APP, { order_id: row.order_id, kind, result: r });
  } catch (err) {
    await trackException(env, err, { uid: row.uid, route: `shop_notify:whatsapp:${kind}`, handled: true, app_name: APP });
  }
}

/**
 * [AUMFE-POD-FULFIL-1] The buyer messages that follow a fulfilment transition, in ONE place so the admin's manual buttons
 * (routes/admin2_shop_orders.ts) and the automatic print-partner path (lib/pod_fulfil.ts) send byte-identical messages.
 * `cancel` has no buyer template (the refund message follows when the money goes back). Never throws.
 */
export type ShopTransitionNotify = "at-printer" | "shipped" | "delivered" | "refund" | "cancel";
export async function notifyShopTransition(env: Env, action: ShopTransitionNotify, after: ShopOrderRow): Promise<void> {
  if (action === "at-printer") await notifyShopWhatsApp(env, "shop_order_printing", after);
  else if (action === "shipped") { await notifyShopWhatsApp(env, "shop_order_shipped", after, after.awb ?? ""); await notifyShopEmail(env, "shipped", after); }
  else if (action === "delivered") await notifyShopWhatsApp(env, "shop_order_delivered", after);
  else if (action === "refund") { await notifyShopWhatsApp(env, "shop_order_refunded", after); await notifyShopEmail(env, "refunded", after); }
}

// ---------------------------------------------------------------------------
// Owner alerts
// ---------------------------------------------------------------------------
export async function alertOwnerNewShopOrder(env: Env, row: ShopOrderRow): Promise<void> {
  try {
    if (!(await readShopPolicy(env)).alerts_whatsapp) return;
    const a = JSON.parse(row.address_json) as Partial<Address>;
    const n = orderItems(row).reduce((s, l) => s + l.qty, 0);
    await sendAdminAlert(env, `${BRAND.nameCompact} shop: new paid order ${row.order_no}\n${rupees(row.total_rupees)} - ${n} item${n === 1 ? "" : "s"} - ${a.city ?? ""}${a.state ? `, ${a.state}` : ""}\nOpen admin > Shop > Orders to send it to the printer.`);
  } catch (err) {
    await trackException(env, err, { uid: row.uid, route: "shop_notify:owner_alert", handled: true, app_name: APP });
  }
}

/** [AUMFE-POD-FULFIL-1] Owner WhatsApp when the print partner rejects an order or a status poll reports trouble. */
export async function alertOwnerFulfilmentProblem(env: Env, row: ShopOrderRow, message: string): Promise<void> {
  try {
    if (!(await readShopPolicy(env)).alerts_whatsapp) return;
    await sendAdminAlert(env, `${BRAND.nameCompact} shop: print partner problem on ${row.order_no}\n"${message.slice(0, 200)}"\nOpen admin > Shop > Orders to retry or handle it by hand.`);
  } catch (err) {
    await trackException(env, err, { uid: row.uid, route: "shop_notify:fulfilment_alert", handled: true, app_name: APP });
  }
}

export async function alertOwnerShopProblem(env: Env, row: ShopOrderRow, message: string): Promise<void> {
  try {
    if (!(await readShopPolicy(env)).alerts_whatsapp) return;
    await sendAdminAlert(env, `${BRAND.nameCompact} shop: problem reported on ${row.order_no}\n"${message.slice(0, 200)}"\nOpen admin > Shop > Orders to replace or refund.`);
  } catch (err) {
    await trackException(env, err, { uid: row.uid, route: "shop_notify:problem_alert", handled: true, app_name: APP });
  }
}

// ---------------------------------------------------------------------------
// Receipt PDF (shared by GET receipt.pdf and the confirmation email)
// ---------------------------------------------------------------------------
export async function renderShopReceipt(env: Env, row: ShopOrderRow, email: string | null): Promise<Uint8Array> {
  const address = JSON.parse(row.address_json) as Address;
  return renderSaathumReceiptPdf({
    receiptNo: row.receipt_no ?? row.order_id, issuedAt: row.confirmed_at ?? row.created_at,
    billedTo: {
      name: row.contact_name || address.name || null, email,
      address: [address.line1, address.line2, `${address.city}, ${address.state} ${address.pincode}`].filter(Boolean) as string[],
    },
    item: { title: `Shop order ${row.order_no}`, startsAt: null, durationMin: null },
    ...shopReceiptMoney(row),
    paidAt: row.confirmed_at, utr: row.utr, paymentId: row.order_id, orderId: row.order_no,
  });
}

const b64 = (bytes: Uint8Array): string => { let bin = ""; for (const x of bytes) bin += String.fromCharCode(x); return btoa(bin); };

// ---------------------------------------------------------------------------
// Emails (confirmed + receipt, rejected, shipped, refunded)
// ---------------------------------------------------------------------------
const wrap = (h2: string, body: string) => `
  <div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px">
    <h2 style="margin:0 0 12px">${h2}</h2>
    ${body}
    <p style="margin:20px 0"><a href="${ordersUrl()}" style="background:#08C4C4;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">My orders</a></p>
    <p style="color:#999;font-size:12px;margin-top:20px">${BRAND.name}</p>
  </div>`;

function itemsHtml(row: ShopOrderRow): string {
  return `<ul style="margin:0 0 8px;padding-left:20px">${orderItems(row).map((l) =>
    `<li>${escapeHtml(l.name)} — ${escapeHtml(l.colour)}, ${escapeHtml(l.size)} × ${l.qty}</li>`).join("")}</ul>`;
}

export async function sendShopEmail(env: Env, kind: "confirmed" | "rejected" | "shipped" | "refunded", row: ShopOrderRow): Promise<void> {
  const to = await emailFor(env, row.uid).catch(() => null);
  if (!to) { await track(env, row.uid, "shop_order_email", APP, { ok: false, kind, reason: "no_email" }); return; }
  const no = escapeHtml(row.order_no);
  let subject: string, html: string, attachments: { name: string; content: string }[] | undefined;
  if (kind === "confirmed") {
    const policy = await readShopPolicy(env);
    subject = `Order confirmed — ${row.order_no}`;
    html = wrap("Order confirmed 🙏", `<p style="margin:0 0 8px;font-weight:600">Order ${no}</p>${itemsHtml(row)}
      <p style="margin:0 0 8px">Thank you. Your T-shirt is now being printed for you. Delivery usually takes ${escapeHtml(policy.delivery_text)}, and shipping is free.</p>
      <p style="margin:0 0 8px;color:#999;font-size:12px">Your payment receipt is attached. Receipt no. ${escapeHtml(row.receipt_no ?? "")}</p>`);
    const pdf = await renderShopReceipt(env, row, to);
    attachments = [{ name: `${row.receipt_no ?? "receipt"}.pdf`, content: b64(pdf) }];
  } else if (kind === "rejected") {
    subject = `About your payment for order ${row.order_no}`;
    html = wrap("We couldn’t find your payment yet", `<p style="margin:0 0 8px">Namaste. We’re sorry — we weren’t able to match a payment to order <b>${no}</b>, so it isn’t confirmed yet.</p>
      <p style="margin:0 0 8px">If money has left your account, please don’t worry. Simply write to <a href="mailto:${BRAND.emails.support}">${BRAND.emails.support}</a> with either:</p>
      <ul style="margin:0 0 8px;padding-left:20px"><li>the <b>12-digit UPI transaction ID (UTR)</b> — in your UPI app’s payment history or your bank SMS, or</li><li>a <b>screenshot</b> of the payment.</li></ul>
      <p style="margin:0 0 8px">Please mention order <b>${no}</b>. We’ll check it and set it right quickly.</p>
      <p style="margin:0 0 8px">With warm regards,<br>Team ${BRAND.name}</p>`);
  } else if (kind === "shipped") {
    subject = `Your order ${row.order_no} has shipped`;
    html = wrap("Your order is on its way 📦", `<p style="margin:0 0 8px;font-weight:600">Order ${no}</p>${itemsHtml(row)}
      ${row.courier ? `<p style="margin:0 0 4px">Courier: ${escapeHtml(row.courier)}</p>` : ""}
      ${row.awb ? `<p style="margin:0 0 4px">AWB: ${escapeHtml(row.awb)}</p>` : ""}
      ${row.eta_text ? `<p style="margin:0 0 4px">Expected: ${escapeHtml(row.eta_text)}</p>` : ""}
      ${row.tracking_url ? `<p style="margin:8px 0"><a href="${escapeHtml(row.tracking_url)}">Track your parcel</a></p>` : ""}`);
  } else {
    subject = `Your refund for order ${row.order_no}`;
    html = wrap("Your refund has been sent 🙏", `<p style="margin:0 0 8px;font-weight:600">Order ${no}</p>
      <p style="margin:0 0 8px">We have refunded ${rupees(row.amount_paise / 100)} to the UPI account you paid from${row.refund_utr ? ` (UTR ${escapeHtml(row.refund_utr)})` : ""}. It can take a little while to show in your bank app.</p>
      <p style="margin:0 0 8px">Questions? Write to <a href="mailto:${BRAND.emails.support}">${BRAND.emails.support}</a>.</p>`);
  }
  const result = await enqueueEmail(env, {
    to, subject, html, kind: `shop_order_${kind}`, orderId: row.order_id, recipientId: row.uid,
    messageVersion: `shop-order-${kind}.v1`, outboxKey: `shop-order-${kind}:${row.order_id}`,
    ...(attachments ? { attachments } : {}),
  });
  const ok = result.status !== "unavailable" && result.status !== "failed";
  if (ok && kind === "confirmed") await metaDb(env).prepare(`UPDATE shop_orders SET email_sent_at=?2 WHERE order_id=?1`).bind(row.order_id, Date.now()).run().catch(() => {});
  await track(env, row.uid, "shop_order_email", APP, { ok, kind, order_id: row.order_id });
}

/** Safe wrapper used by routes: never throws. */
export async function notifyShopEmail(env: Env, kind: "confirmed" | "rejected" | "shipped" | "refunded", row: ShopOrderRow): Promise<void> {
  try { await sendShopEmail(env, kind, row); }
  catch (err) { await trackException(env, err, { uid: row.uid, route: `shop_notify:email:${kind}`, handled: true, app_name: APP }); }
}
