// [HF-TOPUP-NOTIFY-1] Tell the buyer, by WhatsApp and email, that his Google Play top-up reached his wallet. Rulebook HF-PAY-20.
//
//  - Called from processPlayPurchase ONLY when the ledger credit was newly applied (credit.applied), so one payment = one message, whichever
//    path credited it (app verify, Google's real-time notice, or the cron backstop).
//  - WhatsApp: a one-line confirmation from the Hello Fraands WasenderAPI session to the buyer's VERIFIED WhatsApp number.
//  - Email: a branded "Payment receipt" (not a tax invoice: no GSTIN yet, owner decision 2026-10-11) through the durable email outbox,
//    keyed `hf-topup:<orderId>` so a retry never sends twice.
//  - Never throws and never blocks the credit: a missing number / email is a "skipped" event, a provider error is a "failed" event.
import type { Env } from "../types";
import { BRAND } from "./brand";
import { sendWhatsAppText } from "./whatsapp_send";
import { verifiedWhatsAppNumber } from "./whatsapp_notify";
import { enqueueEmail } from "./email_outbox";
import { emailFor } from "./identity";
import { balanceSummary } from "./hf_token_ledger";
import { MICRO } from "./hf_token_math";
import { trackUser, trackException } from "../hooks";

const APP = BRAND.slug;

export interface TopupNotice {
  uid: string;
  orderId: string;
  /** What the buyer paid Google Play, GST included (paise). */
  paidPaise: number;
  /** What reached the wallet (paise). */
  creditPaise: number;
  /** The receipt number from hf_receipts (e.g. HF/R/2026-27/12), when it was issued. */
  receiptNumber?: string | null;
  at?: number;
}

/** "₹120" or "₹147.20" — whole rupees without decimals, otherwise two. */
export function rupeesText(paise: number): string {
  const p = Math.max(0, Math.round(Number(paise) || 0));
  const whole = p % 100 === 0;
  return `₹${(p / 100).toLocaleString("en-IN", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

export function topupWhatsAppText(n: TopupNotice, balancePaise: number | null): string {
  const bal = balancePaise == null ? "" : ` Your wallet balance is now ${rupeesText(balancePaise)}.`;
  return `${BRAND.name}: ${rupeesText(n.creditPaise)} has been added to your wallet. You paid ${rupeesText(n.paidPaise)} (includes 18% GST) via Google Play. Order ${n.orderId}.${bal}`;
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function istDateTime(ms: number): string {
  return new Date(ms).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) + " IST";
}

export function topupEmailSubject(n: TopupNotice): string {
  return `${BRAND.name} payment receipt — ${rupeesText(n.creditPaise)} added to your wallet`;
}

/** Branded email receipt. Email-safe: tables + inline styles, Nunito headings and Comfortaa text with system fallbacks, no scripts. */
export function topupEmailHtml(n: TopupNotice, balancePaise: number | null): string {
  const plum = "#46113E", mauve = "#785979", line = "#E8DCE7", cream = "#FFFDF7";
  const head = "font-family:Nunito,'Segoe UI',Roboto,Arial,sans-serif";
  const body = "font-family:Comfortaa,'Segoe UI',Roboto,Arial,sans-serif";
  const row = (label: string, value: string, strong = false) =>
    `<tr><td style="${body};font-size:16px;color:${strong ? plum : mauve};padding:12px 0;border-bottom:1px solid ${line}">${esc(label)}</td>` +
    `<td align="right" style="${body};font-size:16px;color:${plum};font-weight:${strong ? 700 : 400};padding:12px 0;border-bottom:1px solid ${line};white-space:nowrap">${value}</td></tr>`;
  const at = n.at ?? Date.now();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(topupEmailSubject(n))}</title></head>
<body style="margin:0;padding:0;background:${cream}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${cream}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#FFFFFF;border:1px solid ${line};border-radius:18px">
<tr><td style="padding:28px 28px 8px">
  <div style="${head};font-size:24px;font-weight:800;color:${plum}">${esc(BRAND.name)}</div>
  <div style="${body};font-size:15px;color:${mauve};margin-top:4px">Payment receipt</div>
</td></tr>
<tr><td style="padding:16px 28px 4px">
  <div style="${head};font-size:28px;font-weight:800;color:${plum}">${esc(rupeesText(n.creditPaise))} added to your wallet</div>
  <div style="${body};font-size:16px;color:${mauve};margin-top:8px">Thank you. Your money has reached your ${esc(BRAND.name)} wallet and is ready to use for calls.</div>
</td></tr>
<tr><td style="padding:8px 28px 8px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    ${n.receiptNumber ? row("Receipt number", esc(n.receiptNumber)) : ""}
    ${row("Date", esc(istDateTime(at)))}
    ${row("Amount paid (includes 18% GST)", esc(rupeesText(n.paidPaise)), true)}
    ${row("Added to your wallet", esc(rupeesText(n.creditPaise)), true)}
    ${row("Paid via", "Google Play")}
    ${row("Google Play order", esc(n.orderId))}
    ${balancePaise == null ? "" : row("Wallet balance now", esc(rupeesText(balancePaise)))}
  </table>
</td></tr>
<tr><td style="padding:16px 28px 28px">
  <div style="${body};font-size:15px;color:${mauve}">This is a payment receipt, not a tax invoice. Google Play also sends its own receipt for this payment. You can see all your receipts in the Wallet tab of the ${esc(BRAND.name)} app.</div>
  <div style="${body};font-size:15px;color:${mauve};margin-top:12px">Questions? Write to <a href="mailto:${esc(BRAND.emails.support)}" style="color:${plum}">${esc(BRAND.emails.support)}</a>.</div>
</td></tr>
</table>
<div style="${body};font-size:14px;color:${mauve};padding:16px">${esc(BRAND.name)} · ${esc(BRAND.webOrigin)}</div>
</td></tr></table></body></html>`;
}

/** Wallet balance in rupees as the app shows it (each token's value in call time). Null when it cannot be read. */
async function balancePaiseFor(env: Env, uid: string): Promise<number | null> {
  try {
    const s = await balanceSummary(env, uid);
    return Math.round((s.totalMicro / MICRO) * 100);
  } catch {
    return null;
  }
}

export interface TopupNotifyResult { whatsapp: "sent" | "skipped" | "failed"; email: "queued" | "skipped" | "failed"; whatsappReason?: string; emailReason?: string }

export async function notifyTopupCredited(env: Env, n: TopupNotice): Promise<TopupNotifyResult> {
  const out: TopupNotifyResult = { whatsapp: "skipped", email: "skipped" };
  let email: string | null = null;
  try {
    email = await emailFor(env, n.uid).catch(() => null);
    const balance = await balancePaiseFor(env, n.uid);

    // WhatsApp
    try {
      const e164 = await verifiedWhatsAppNumber(env, n.uid);
      if (!e164) { out.whatsappReason = "no_verified_whatsapp"; }
      else {
        const r = await sendWhatsAppText(env, e164, topupWhatsAppText(n, balance));
        if (r.ok) out.whatsapp = "sent";
        else { out.whatsapp = r.reason === "not_on_whatsapp" || r.reason === "unconfigured" ? "skipped" : "failed"; out.whatsappReason = r.reason; }
      }
    } catch (e) {
      out.whatsapp = "failed"; out.whatsappReason = "exception";
      await trackException(env, e, { route: "hf_topup_notify.whatsapp", handled: true, app_name: APP, extra: { area: "hf_topup_notify", order_id: n.orderId } });
    }

    // Email
    try {
      if (!email) { out.emailReason = "no_email"; }
      else {
        const q = await enqueueEmail(env, {
          to: email, subject: topupEmailSubject(n), html: topupEmailHtml(n, balance),
          outboxKey: `hf-topup:${n.orderId}`, kind: "hf_topup_receipt", orderId: n.orderId, recipientId: n.uid,
          replyTo: { email: BRAND.emails.support, name: BRAND.name },
        });
        if (q.status === "failed" || q.status === "bounced" || q.status === "unavailable") { out.email = "failed"; out.emailReason = `outbox_${q.status}`; }
        else out.email = "queued";
      }
    } catch (e) {
      out.email = "failed"; out.emailReason = "exception";
      await trackException(env, e, { route: "hf_topup_notify.email", handled: true, app_name: APP, extra: { area: "hf_topup_notify", order_id: n.orderId } });
    }
  } catch (e) {
    await trackException(env, e, { route: "hf_topup_notify", handled: true, app_name: APP, extra: { area: "hf_topup_notify", order_id: n.orderId } });
  }
  try {
    const props = { area: "hf_topup_notify", order_id: n.orderId, paid_paise: n.paidPaise, credit_paise: n.creditPaise };
    await trackUser(env, n.uid, email, "hf_topup_whatsapp_receipt", APP, { ...props, result: out.whatsapp, reason: out.whatsappReason ?? null });
    await trackUser(env, n.uid, email, "hf_topup_email_receipt", APP, { ...props, result: out.email, reason: out.emailReason ?? null });
  } catch { /* telemetry is best-effort */ }
  return out;
}
