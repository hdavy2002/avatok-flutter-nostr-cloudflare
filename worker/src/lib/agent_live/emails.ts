// [AGENT-LIVE-1] Booking confirmation + platform-failure refund email for AI
// voice agent sessions (BUILD SPEC §9 "checkout + money + join", R2 §2). Mirrors
// the existing outbox pattern in worker/src/cal/emails.ts (`enqueueEmail` /
// `verifiedClerkEmail` from lib/email_outbox.ts, `clerkEmail` from ledger.ts)
// rather than importing that file's private `shell()`/`queueEmail()` helpers,
// which are not exported. Content and shape intentionally mirror them.
import type { Env } from "../../types";
import { clerkEmail } from "../../ledger";
import { buildIcs, icsB64, signJoinTokenV2 } from "../../cal/ics";
import { enqueueEmail, verifiedClerkEmail, type EmailQueueStatus } from "../email_outbox";

const inr = (tokens: number): string => `₹${tokens}`;
const OUTBOX_KIND = "agent_live_email";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] ?? char));
}

function shell(title: string, bodyHtml: string, cta?: { label: string; url: string }): string {
  return `
  <div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px">
    <h2 style="margin:0 0 12px">${escapeHtml(title)}</h2>
    ${bodyHtml}
    ${cta ? `<p style="margin:20px 0"><a href="${escapeHtml(cta.url)}" style="background:#08C4C4;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">${escapeHtml(cta.label)}</a></p>` : ""}
    <p style="color:#999;font-size:12px;margin-top:20px">AvaTOK · AI voice agent session · times shown in your timezone.</p>
  </div>`;
}

function webBase(env: Env): string {
  return String(env.WEB_BASE_URL || "https://avatok.ai").replace(/\/+$/, "");
}

function fmtInTz(ms: number, tz: string | null | undefined): string {
  try {
    return new Intl.DateTimeFormat("en-IN", {
      timeZone: tz || "UTC", weekday: "short", day: "2-digit", month: "short",
      hour: "2-digit", minute: "2-digit",
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toUTCString();
  }
}

async function queueEmail(env: Env, uid: string, subject: string, html: string, opts: { outboxKey: string; orderId?: string | null; ics?: { name: string; content: string } }): Promise<EmailQueueStatus> {
  try {
    const email = await verifiedClerkEmail(env, uid) ?? await clerkEmail(env, uid);
    if (!email) return "unavailable";
    const result = await enqueueEmail(env, {
      to: email, subject, html, outboxKey: opts.outboxKey, kind: OUTBOX_KIND,
      orderId: opts.orderId ?? null, recipientId: uid, messageVersion: "agent-live-email.v1",
      ...(opts.ics ? { attachments: [{ name: opts.ics.name, content: opts.ics.content }] } : {}),
    });
    return result.status;
  } catch { return "failed"; }
}

export interface AgentConfirmationCtx {
  bookingId: string;
  agentId: string;
  buyerUid: string;
  agentTitle: string;
  startsAt: number;
  endsAt: number;
  minutes: number;
  amount: number;
  buyerTz: string | null;
  instant: boolean;
}

/**
 * Booking confirmation, sent right after `agentBook` commits `booked`
 * (BUILD SPEC §9 "D provision"). Carries the buyer's own signed `/j/` link
 * (M9 — `kind:'agent'`), the same mechanism the consult/live lanes use, so the
 * buyer never has to sign into a dashboard to open the talk room.
 */
export async function queueAgentConfirmation(env: Env, c: AgentConfirmationCtx): Promise<EmailQueueStatus> {
  let joinUrl = `${webBase(env)}/talk/${encodeURIComponent(c.bookingId)}`;
  try {
    const token = await signJoinTokenV2(env, {
      bookingId: c.bookingId, listingId: c.agentId, accountId: c.buyerUid,
      kind: "agent", expMs: c.endsAt + 24 * 60 * 60 * 1000,
    });
    joinUrl = `${webBase(env)}/j/${token}`;
  } catch { /* fall back to the bare (login-gated) talk path */ }

  const when = fmtInTz(c.startsAt, c.buyerTz);
  const body = `
    <p style="margin:0 0 8px;font-weight:600">${escapeHtml(c.agentTitle)}</p>
    <p style="margin:0 0 8px">${c.instant ? "Starting now" : when} · ${c.minutes} min · ${inr(c.amount)}</p>
    <p style="margin:0 0 8px">${c.instant ? "Your session is ready — the button below takes you straight in." : "The button below takes you straight in when it's time — no password, no sign-in."}</p>`;
  const ics = {
    name: "agent-session.ics",
    content: icsB64(buildIcs({
      uid: `agentlive:${c.bookingId}`, title: `AI session: ${c.agentTitle}`,
      start: c.startsAt, end: c.endsAt, url: joinUrl,
    })),
  };
  return queueEmail(env, c.buyerUid, `Your session with ${c.agentTitle}`,
    shell("Your AI voice session is confirmed", body, { label: c.instant ? "Talk now" : "Open your session", url: joinUrl }),
    { outboxKey: `agentlive-confirm:${c.bookingId}`, orderId: `agl_${c.bookingId}`, ics });
}

export interface AgentRefundEmailCtx {
  bookingId: string;
  buyerUid: string;
  agentTitle: string;
  amount: number;
  reason: string;
}

/** Platform-failure full refund (D7 `refunded_platform_failure`). */
export async function queueAgentRefundEmail(env: Env, c: AgentRefundEmailCtx): Promise<EmailQueueStatus> {
  const body = `
    <p style="margin:0 0 8px;font-weight:600">${escapeHtml(c.agentTitle)}</p>
    <p style="margin:0 0 8px">Refunded in full: <b>${inr(c.amount)}</b></p>
    <p style="margin:0 0 8px">Your session could not be delivered (${escapeHtml(c.reason)}). Sorry about that — nothing further to do; the tokens are back in your AvaWallet.</p>`;
  return queueEmail(env, c.buyerUid, `Refund issued: ${c.agentTitle}`,
    shell("Refund issued", body),
    { outboxKey: `agentlive-refund:${c.bookingId}`, orderId: `agl_${c.bookingId}` });
}
