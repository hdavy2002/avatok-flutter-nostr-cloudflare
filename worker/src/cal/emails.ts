// Phase 5 — THE platform email matrix (PHASE-05 §Notifications). Cloudflare
// Email Service (Brevo fallback) via Q_EMAIL (consumer renders attachments),
// addresses resolved from Clerk (D1 stores only hashes). Phases 6/7 REUSE
// these templates — no phase invents its own email path. Every sender is
// best-effort: never blocks money/booking ops.
import type { Env } from "../types";
import { clerkEmail } from "../ledger";
import { buildIcs, icsB64, joinUrlFor, signJoinToken, signJoinTokenV2 } from "./ics";
import { commercialEmailKey, enqueueEmail, verifiedClerkEmail, type EmailDeliveryStatus, type EmailQueueStatus } from "../lib/email_outbox";

const inr = (tokens: number): string => `\u20b9${tokens}`;
const whenUtc = (ms: number): string => new Date(ms).toUTCString();
const OUTBOX_KIND = "commercial_email";
export const COMMERCIAL_CONFIRMATION_VERSION = "commercial-confirmation.v1";

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

function shell(title: string, bodyHtml: string, cta?: { label: string; url: string }): string {
  return `
  <div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px">
    <h2 style="margin:0 0 12px">${escapeHtml(title)}</h2>
    ${bodyHtml}
    ${cta ? `<p style="margin:20px 0"><a href="${escapeHtml(cta.url)}" style="background:#08C4C4;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">${escapeHtml(cta.label)}</a></p>` : ""}
    <p style="color:#999;font-size:12px;margin-top:20px">AvaTOK · times shown in UTC — the join page and app show your local time.</p>
  </div>`;
}

export interface BookingEmailCtx {
  bookingId: string; title: string; start: number; end: number;
  price: number;                      // coins
  creatorId: string; buyerId: string;
  creatorName: string; buyerName: string;
  orderId?: string | null;
}

export interface CommercialConfirmationCtx {
  orderId: string;
  listingId: string;
  bookingId: string | null;
  kind: "live_event" | "consult_1to1";
  title: string;
  start: number;
  end: number;
  price: number;
  creatorId: string;
  buyerId: string;
  creatorName?: string;
  buyerName?: string;
}

async function profileName(env: Env, uid: string, fallback: string): Promise<string> {
  try {
    const row = await env.DB_META.prepare(
      "SELECT name,handle FROM profiles WHERE npub=?1 OR clerk_user_id=?1 LIMIT 1",
    ).bind(uid).first<{ name: string | null; handle: string | null }>();
    return row?.name || row?.handle || fallback;
  } catch { return fallback; }
}

function webBase(env: Env): string {
  return String(env.WEB_BASE_URL || "https://avatok.ai").replace(/\/+$/, "");
}

/** The canonical room URL. Correct for the CREATOR (who is signed in on the app). */
function commercialDestination(env: Env, c: CommercialConfirmationCtx): string {
  const path = c.kind === "live_event"
    ? `/live/${encodeURIComponent(c.listingId)}`
    : `/session/${encodeURIComponent(c.bookingId ?? "")}`;
  return `${webBase(env)}${path}`;
}

/**
 * [JOIN-LINK-1] The BUYER's link. RULEBOOK-PAID-SESSIONS §7: "He clicks the link
 * in his confirmation email... He never logs into a dashboard."
 *
 * Until now this email carried the bare room URL above — which is exactly the
 * URL that has no idea who is opening it, so it met the customer with the
 * email-code gate on the way into a room he had already paid for. It now carries
 * a signed /j/<token> bound to HIS account and this entitlement, valid until the
 * session ends + 24 h; `/api/join-link/:token/session` turns it into a session.
 *
 * Falls back to the bare URL if signing throws — a confirmation email that is
 * slightly worse is far better than a confirmation email that never sends.
 */
async function buyerDestination(env: Env, c: CommercialConfirmationCtx): Promise<string> {
  try {
    const token = await signJoinTokenV2(env, {
      bookingId: c.bookingId ?? null,
      listingId: c.listingId,
      accountId: c.buyerId,
      kind: c.kind,
      expMs: c.end + 24 * 60 * 60 * 1000,
    });
    return `${webBase(env)}/j/${token}`;
  } catch {
    return commercialDestination(env, c);
  }
}

/**
 * Confirmation for every commercial entitlement, including live tickets that
 * intentionally have no bookings row. The same canonical destination is used
 * by the app, browser and ICS attachment.
 */
export async function queueCommercialConfirmation(env: Env, c: CommercialConfirmationCtx, opts?: { recipients?: Array<"buyer" | "creator">; messageVersion?: string }): Promise<{
  buyer: EmailDeliveryStatus | "unavailable";
  creator: EmailDeliveryStatus | "unavailable";
  status: EmailDeliveryStatus | "unavailable";
}> {
  const creatorName = c.creatorName ?? await profileName(env, c.creatorId, "the creator");
  const buyerName = c.buyerName ?? await profileName(env, c.buyerId, "the customer");
  const messageVersion = opts?.messageVersion ?? COMMERCIAL_CONFIRMATION_VERSION;
  const destination = commercialDestination(env, c);
  // [JOIN-LINK-1] Two links, on purpose: the creator's calendar entry and button
  // point at the canonical room; the buyer's point at his own signed join link,
  // including inside the .ics (a calendar reminder is the other place he clicks
  // through from, and it must not drop him on a login screen either).
  const buyerUrl = await buyerDestination(env, c);
  const icsFor = (url: string) => ({
    name: c.kind === "live_event" ? "live-event.ics" : "appointment.ics",
    content: icsB64(buildIcs({
      uid: c.orderId,
      title: c.title,
      start: c.start,
      end: c.end,
      url,
    })),
  });
  const ics = icsFor(destination);
  const buyerBody = `<p style="margin:0 0 8px;font-weight:600">${escapeHtml(c.title)}</p>
    <p style="margin:0 0 8px">${whenUtc(c.start)} → ${whenUtc(c.end)}</p>
    <p style="margin:0 0 8px">With: ${escapeHtml(creatorName)}${c.price > 0 ? ` · ${inr(c.price)}` : " · free"}</p>
    <p style="margin:0 0 8px">Your access is ready. The button below takes you straight in \u2014 no password, no sign-in.</p>`;
  const creatorBody = `<p style="margin:0 0 8px;font-weight:600">${escapeHtml(c.title)}</p>
    <p style="margin:0 0 8px">${whenUtc(c.start)} → ${whenUtc(c.end)}</p>
    <p style="margin:0 0 8px">Customer: ${escapeHtml(buyerName)}</p>
    <p style="margin:0 0 8px">Open the event or appointment from the button below.</p>`;
  const recipients = opts?.recipients ?? ["buyer", "creator"];
  const [buyer, creator] = await Promise.all([
    recipients.includes("buyer") ? queueEmail(env, c.buyerId, `Confirmation: ${c.title}`, shell(c.kind === "live_event" ? "Live event ticket confirmed" : "Appointment confirmed", buyerBody, { label: "Join your session", url: buyerUrl }), icsFor(buyerUrl), {
      outboxKey: commercialEmailKey(c.orderId, c.buyerId, messageVersion),
      orderId: c.orderId, messageVersion, verified: true,
    }) : Promise.resolve("unavailable" as const),
    recipients.includes("creator") ? queueEmail(env, c.creatorId, `New customer: ${c.title}`, shell(c.kind === "live_event" ? "New live event ticket" : "New appointment", creatorBody, { label: "Open session", url: destination }), ics, {
      outboxKey: commercialEmailKey(c.orderId, c.creatorId, messageVersion),
      orderId: c.orderId, messageVersion, verified: true,
    }) : Promise.resolve("unavailable" as const),
  ]);
  const statuses = [buyer, creator];
  const aggregate = statuses.includes("failed") ? "failed"
    : statuses.includes("bounced") ? "bounced"
      : statuses.includes("unavailable") ? "unavailable"
      : statuses.includes("sending") ? "sending"
        : statuses.includes("provider_accepted") || statuses.includes("delivered") ? "provider_accepted" : "queued";
  return { buyer, creator, status: aggregate };
}

async function queueEmail(env: Env, uid: string, subject: string, html: string, ics?: { name: string; content: string }, opts?: { outboxKey?: string; orderId?: string | null; messageVersion?: string; verified?: boolean }): Promise<EmailQueueStatus> {
  try {
    const email = opts?.verified ? await verifiedClerkEmail(env, uid) : await clerkEmail(env, uid);
    if (!email) return "unavailable";
    const key = opts?.outboxKey ?? `mail:${uid}:${subject}:${ics?.name ?? ""}:${ics?.content ?? ""}:${html}`;
    const result = await enqueueEmail(env, {
      to: email, subject, html, outboxKey: key, kind: OUTBOX_KIND,
      orderId: opts?.orderId ?? null, recipientId: uid,
      messageVersion: opts?.messageVersion ?? "email.v1",
      ...(ics ? { attachments: [{ name: ics.name, content: ics.content }] } : {}),
    });
    return result.status;
  } catch { return "failed"; }
}

async function joinCta(env: Env, bookingId: string, start: number): Promise<{ label: string; url: string }> {
  // Token valid until 24h after start — covers reschedules + late joins.
  const token = await signJoinToken(env, bookingId, start + 86_400_000);
  return { label: "Open in AvaTOK", url: joinUrlFor(token) };
}

/** Booking confirmed → buyer + creator, with ICS attachment + join link. */
export async function emailBookingConfirmed(env: Env, c: BookingEmailCtx, opts?: { sequence?: number; resched?: boolean }): Promise<void> {
  const cta = await joinCta(env, c.bookingId, c.start);
  const ics = { name: "booking.ics", content: icsB64(buildIcs({ uid: c.bookingId, title: c.title, start: c.start, end: c.end, url: cta.url, sequence: opts?.sequence ?? 0 })) };
  const verb = opts?.resched ? "rescheduled" : "confirmed";
  const body = (other: string) => `
    <p style="margin:0 0 8px;font-weight:600">${escapeHtml(c.title)}</p>
    <p style="margin:0 0 8px">${whenUtc(c.start)} → ${whenUtc(c.end)}</p>
    <p style="margin:0 0 8px">With: ${escapeHtml(other)}${c.price > 0 ? ` · ${inr(c.price)}` : " · free"}</p>
    <p style="margin:0 0 8px">Open the invite from the button below or in the app.</p>`;
  await Promise.all([
    queueEmail(env, c.buyerId, `Booking ${verb}: ${c.title}`, shell(`You have a booking ✅`, body(c.creatorName), cta), ics, {
      outboxKey: c.orderId ? commercialEmailKey(c.orderId, c.buyerId, `booking-${opts?.resched ? "rescheduled" : "confirmed"}.v1`) : undefined,
      orderId: c.orderId, messageVersion: `booking-${opts?.resched ? "rescheduled" : "confirmed"}.v1`,
    }),
    queueEmail(env, c.creatorId, `Booking ${verb}: ${c.title}`, shell(`New booking ${verb}`, body(c.buyerName), cta), ics, {
      outboxKey: c.orderId ? commercialEmailKey(c.orderId, c.creatorId, `booking-${opts?.resched ? "rescheduled" : "confirmed"}.v1`) : undefined,
      orderId: c.orderId, messageVersion: `booking-${opts?.resched ? "rescheduled" : "confirmed"}.v1`,
    }),
  ]);
}

/** Cancelled (either side) → both, who cancelled + refund wording per rules. */
export async function emailBookingCancelled(env: Env, c: BookingEmailCtx & { cancelledBy: "creator" | "buyer"; refundNote?: string }): Promise<void> {
  const ics = { name: "cancel.ics", content: icsB64(buildIcs({ uid: c.bookingId, title: c.title, start: c.start, end: c.end, method: "CANCEL", sequence: 99 })) };
  const who = c.cancelledBy === "creator" ? c.creatorName : c.buyerName;
  const body = `
    <p style="margin:0 0 8px;font-weight:600">${escapeHtml(c.title)}</p>
    <p style="margin:0 0 8px">${whenUtc(c.start)}</p>
    <p style="margin:0 0 8px">Cancelled by ${escapeHtml(who)}.</p>
    ${c.refundNote ? `<p style="margin:0 0 8px">${escapeHtml(c.refundNote)}</p>` : "<p style=\"margin:0 0 8px\">Any refund is handled automatically by the policy snapshot.</p>"}`;
  await Promise.all([
    queueEmail(env, c.buyerId, `Cancelled: ${c.title}`, shell("Booking cancelled", body), ics),
    queueEmail(env, c.creatorId, `Cancelled: ${c.title}`, shell("Booking cancelled", body), ics),
  ]);
}

/** Refund issued (any rule) — buyer always; creator variant for no-show wording (Phase 7 reuses). */
export async function emailRefundIssued(env: Env, uid: string, o: { title: string; amount: number; reason: string; detail?: string }): Promise<void> {
  await queueEmail(env, uid, `Refund issued: ${o.title}`,
    shell("Refund issued", `<p style="margin:0 0 8px;font-weight:600">${escapeHtml(o.title)}</p><p style="margin:0 0 8px">Refunded: <b>${inr(o.amount)}</b></p><p style="margin:0 0 8px">Reason: ${escapeHtml(o.reason)}</p>${o.detail ? `<p style="margin:0 0 8px">${escapeHtml(o.detail)}</p>` : ""}`));
}

/** Settlement paid → creator (Phase 7 hooks in). */
export async function emailSettlementPaid(env: Env, uid: string, o: { title: string; gross: number; fee: number; net: number; receiptId?: string }): Promise<void> {
  await queueEmail(env, uid, `Settlement paid: ${o.title}`,
    shell("Settlement paid", `<p style="margin:0 0 8px;font-weight:600">${escapeHtml(o.title)}</p><p style="margin:0 0 8px">Gross ${inr(o.gross)} · fee ${inr(o.fee)} · <b>net ${inr(o.net)}</b> to your AvaWallet.</p>${o.receiptId ? `<p style="margin:0 0 8px">Receipt: ${escapeHtml(o.receiptId)}</p>` : ""}`));
}

/** Payout sent/failed → creator (Phase 3 Wise status hooks in). */
export async function emailPayoutStatus(env: Env, uid: string, o: { amount: number; status: "sent" | "failed"; detail?: string }): Promise<void> {
  await queueEmail(env, uid, `Payout ${o.status}: ${inr(o.amount)}`,
    shell(o.status === "sent" ? "Payout sent 🎉" : "Payout failed",
      `<p style="margin:0 0 8px">Amount: <b>${inr(o.amount)}</b></p>${o.detail ? `<p style="margin:0 0 8px">${escapeHtml(o.detail)}</p>` : ""}`));
}

/** Reminder emails (T-24h "Tomorrow:" and T-60m "Within 1 hour") — used by the
 *  consumers cron; exported here so the matrix lives in ONE module. */
export function reminderEmailHtml(tier: "24h" | "60m", o: { title: string; start: number; otherName: string; joinUrl: string }): { subject: string; html: string } {
  if (tier === "24h") {
    return {
      subject: `Tomorrow: ${o.title}`,
      html: shell("Tomorrow on AvaTOK", `<p style="margin:0 0 8px;font-weight:600">${escapeHtml(o.title)}</p><p style="margin:0 0 8px">${whenUtc(o.start)} with ${escapeHtml(o.otherName)}.</p><p style="margin:0 0 8px">Your invite is ready whenever you need it.</p>`, { label: "View booking", url: o.joinUrl }),
    };
  }
  return {
    subject: `Within 1 hour: ${o.title}`,
    html: shell("Starting within the hour", `<p style="margin:0 0 8px;font-weight:600">${escapeHtml(o.title)}</p><p style="margin:0 0 8px">Within 1 hour you have a session with ${escapeHtml(o.otherName)} — here is the link to join.</p><p style="margin:0 0 8px">The same invite lives in your calendar attachment.</p>`, { label: "Join now", url: o.joinUrl }),
  };
}
