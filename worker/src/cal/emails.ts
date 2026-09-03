// Phase 5 — THE platform email matrix (PHASE-05 §Notifications). Brevo via
// Q_EMAIL (consumer renders attachments), addresses resolved from Clerk
// (D1 stores only hashes). Phases 6/7 REUSE these templates — no phase invents
// its own email path. Every sender is best-effort: never blocks money/booking ops.
import type { Env } from "../types";
import { clerkEmail } from "../ledger";
import { buildIcs, icsB64, joinUrlFor, signJoinToken } from "./ics";

const inr = (tokens: number): string => `\u20b9${tokens}`;
const whenUtc = (ms: number): string => new Date(ms).toUTCString();
const OUTBOX_KIND = "commercial_email";

function shell(title: string, bodyHtml: string, cta?: { label: string; url: string }): string {
  return `
  <div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px">
    <h2 style="margin:0 0 12px">${title}</h2>
    ${bodyHtml}
    ${cta ? `<p style="margin:20px 0"><a href="${cta.url}" style="background:#08C4C4;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">${cta.label}</a></p>` : ""}
    <p style="color:#999;font-size:12px;margin-top:20px">AvaTOK · times shown in UTC — the join page and app show your local time.</p>
  </div>`;
}

async function claimEmailOutbox(env: Env, key: string, payload: Record<string, unknown>): Promise<boolean> {
  try {
    const now = Date.now();
    const row = await env.DB_META.prepare("SELECT state FROM email_outbox WHERE outbox_key=?1 LIMIT 1").bind(key).first<{ state: string }>();
    if (row?.state === "sent") return false;
    if (!row) {
      await env.DB_META.prepare(
        "INSERT INTO email_outbox (outbox_key, kind, state, payload_json, created_at, updated_at) VALUES (?1,?2,'pending',?3,?4,?4)",
      ).bind(key, OUTBOX_KIND, JSON.stringify(payload), now).run();
    }
    const locked = await env.DB_META.prepare(
      "UPDATE email_outbox SET state='sending', updated_at=?2 WHERE outbox_key=?1 AND state IN ('pending','failed')",
    ).bind(key, now).run();
    return (locked.meta?.changes ?? 0) > 0 || !row;
  } catch {
    return true;
  }
}

async function finishEmailOutbox(env: Env, key: string, state: "sent" | "failed", error?: string): Promise<void> {
  try {
    await env.DB_META.prepare(
      "UPDATE email_outbox SET state=?2, error_message=?3, sent_at=CASE WHEN ?2='sent' THEN ?4 ELSE sent_at END, updated_at=?4 WHERE outbox_key=?1",
    ).bind(key, state, error?.slice(0, 500) ?? null, Date.now()).run();
  } catch { /* best-effort */ }
}

export interface BookingEmailCtx {
  bookingId: string; title: string; start: number; end: number;
  price: number;                      // coins
  creatorId: string; buyerId: string;
  creatorName: string; buyerName: string;
}

async function queueEmail(env: Env, uid: string, subject: string, html: string, ics?: { name: string; content: string }): Promise<void> {
  try {
    const email = await clerkEmail(env, uid);
    if (!email) return;
    const key = `mail:${uid}:${subject}:${ics?.name ?? ""}:${ics?.content ?? ""}:${html}`;
    if (!(await claimEmailOutbox(env, key, { uid, email, subject, html, ics: ics?.name ?? null }))) return;
    try {
      await env.Q_EMAIL.send({ to: email, subject, html, ...(ics ? { attachments: [{ name: ics.name, content: ics.content }] } : {}) });
      await finishEmailOutbox(env, key, "sent");
    } catch (e) {
      await finishEmailOutbox(env, key, "failed", String(e));
      throw e;
    }
  } catch { /* best-effort */ }
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
    <p style="margin:0 0 8px;font-weight:600">${c.title}</p>
    <p style="margin:0 0 8px">${whenUtc(c.start)} → ${whenUtc(c.end)}</p>
    <p style="margin:0 0 8px">With: ${other}${c.price > 0 ? ` · ${inr(c.price)}` : " · free"}</p>
    <p style="margin:0 0 8px">Open the invite from the button below or in the app.</p>`;
  await Promise.all([
    queueEmail(env, c.buyerId, `Booking ${verb}: ${c.title}`, shell(`You have a booking ✅`, body(c.creatorName), cta), ics),
    queueEmail(env, c.creatorId, `Booking ${verb}: ${c.title}`, shell(`New booking ${verb}`, body(c.buyerName), cta), ics),
  ]);
}

/** Cancelled (either side) → both, who cancelled + refund wording per rules. */
export async function emailBookingCancelled(env: Env, c: BookingEmailCtx & { cancelledBy: "creator" | "buyer"; refundNote?: string }): Promise<void> {
  const ics = { name: "cancel.ics", content: icsB64(buildIcs({ uid: c.bookingId, title: c.title, start: c.start, end: c.end, method: "CANCEL", sequence: 99 })) };
  const who = c.cancelledBy === "creator" ? c.creatorName : c.buyerName;
  const body = `
    <p style="margin:0 0 8px;font-weight:600">${c.title}</p>
    <p style="margin:0 0 8px">${whenUtc(c.start)}</p>
    <p style="margin:0 0 8px">Cancelled by ${who}.</p>
    ${c.refundNote ? `<p style="margin:0 0 8px">${c.refundNote}</p>` : "<p style=\"margin:0 0 8px\">Any refund is handled automatically by the policy snapshot.</p>"}`;
  await Promise.all([
    queueEmail(env, c.buyerId, `Cancelled: ${c.title}`, shell("Booking cancelled", body), ics),
    queueEmail(env, c.creatorId, `Cancelled: ${c.title}`, shell("Booking cancelled", body), ics),
  ]);
}

/** Refund issued (any rule) — buyer always; creator variant for no-show wording (Phase 7 reuses). */
export async function emailRefundIssued(env: Env, uid: string, o: { title: string; amount: number; reason: string; detail?: string }): Promise<void> {
  await queueEmail(env, uid, `Refund issued: ${o.title}`,
    shell("Refund issued", `<p style="margin:0 0 8px;font-weight:600">${o.title}</p><p style="margin:0 0 8px">Refunded: <b>${inr(o.amount)}</b></p><p style="margin:0 0 8px">Reason: ${o.reason}</p>${o.detail ? `<p style="margin:0 0 8px">${o.detail}</p>` : ""}`));
}

/** Settlement paid → creator (Phase 7 hooks in). */
export async function emailSettlementPaid(env: Env, uid: string, o: { title: string; gross: number; fee: number; net: number; receiptId?: string }): Promise<void> {
  await queueEmail(env, uid, `Settlement paid: ${o.title}`,
    shell("Settlement paid", `<p style="margin:0 0 8px;font-weight:600">${o.title}</p><p style="margin:0 0 8px">Gross ${inr(o.gross)} · fee ${inr(o.fee)} · <b>net ${inr(o.net)}</b> to your AvaWallet.</p>${o.receiptId ? `<p style="margin:0 0 8px">Receipt: ${o.receiptId}</p>` : ""}`));
}

/** Payout sent/failed → creator (Phase 3 Wise status hooks in). */
export async function emailPayoutStatus(env: Env, uid: string, o: { amount: number; status: "sent" | "failed"; detail?: string }): Promise<void> {
  await queueEmail(env, uid, `Payout ${o.status}: ${inr(o.amount)}`,
    shell(o.status === "sent" ? "Payout sent 🎉" : "Payout failed",
      `<p style="margin:0 0 8px">Amount: <b>${inr(o.amount)}</b></p>${o.detail ? `<p style="margin:0 0 8px">${o.detail}</p>` : ""}`));
}

/** Reminder emails (T-24h "Tomorrow:" and T-60m "Within 1 hour") — used by the
 *  consumers cron; exported here so the matrix lives in ONE module. */
export function reminderEmailHtml(tier: "24h" | "60m", o: { title: string; start: number; otherName: string; joinUrl: string }): { subject: string; html: string } {
  if (tier === "24h") {
    return {
      subject: `Tomorrow: ${o.title}`,
      html: shell("Tomorrow on AvaTOK", `<p style="margin:0 0 8px;font-weight:600">${o.title}</p><p style="margin:0 0 8px">${whenUtc(o.start)} with ${o.otherName}.</p><p style="margin:0 0 8px">Your invite is ready whenever you need it.</p>`, { label: "View booking", url: o.joinUrl }),
    };
  }
  return {
    subject: `Within 1 hour: ${o.title}`,
    html: shell("Starting within the hour", `<p style="margin:0 0 8px;font-weight:600">${o.title}</p><p style="margin:0 0 8px">Within 1 hour you have a session with ${o.otherName} — here is the link to join.</p><p style="margin:0 0 8px">The same invite lives in your calendar attachment.</p>`, { label: "Join now", url: o.joinUrl }),
  };
}
