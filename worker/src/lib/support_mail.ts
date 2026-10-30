// [HF-SUPPORT-1] Outgoing support mail + customer nudges.
//
// Every email goes through enqueueEmail (R2 body + outbox row, queue carries ids only; lanes: staff replies PRIORITY,
// acknowledgements / reminders / test mail BULK). Every WhatsApp goes through enqueueWhatsApp. Nothing here calls a provider.
//
// Threading: subject "[HF-N] <subject>", Reply-To support+N@<brand domain>, a Message-ID we generate and store on the message
// row, In-Reply-To = the customer's latest Message-ID, References = the thread so far.
import type { Env } from "../types";
import { BRAND } from "./brand";
import { enqueueEmail, type EmailLane, type EmailQueueResult } from "./email_outbox";
import { enqueueWhatsApp } from "./whatsapp_queue";
import { verifiedWhatsAppNumber } from "./whatsapp_notify";
import { emailFor } from "./identity";
import { realEmailOrNull } from "./placeholder_email";
import {
  addEvent, cleanTicketSubject, escapeHtml, MINUTE_MS, NUDGE_INTERVAL_MS, newMessageId, replyToFor, supportFrom, supportSiteOrigin, ticketCode,
  textToHtml, type TicketRow, ACK_TEXT, AFTER_HOURS_TEXT,
} from "./support_core";
import { htmlToPlainText, bytesToBinary } from "./support_mime";

const tag = (n: number, subject: string): string => {
  const clean = cleanTicketSubject(subject) || "Your request";
  return `[${ticketCode(n)}] ${clean}`;
};
export const ticketSubject = tag;
/** Acknowledgement subject: the ticket number up front so it is the first thing the customer sees [HF-SUPPORT-ACK-SUBJECT-1]. */
export const ackSubject = (n: number, subject: string): string => `Ticket ${ticketCode(n)} received: ${cleanTicketSubject(subject) || "Your request"}`;

/** Recipient for a ticket: contact email, else the email typed at sign-up, else the account email (Clerk). Never a placeholder. */
export async function recipientEmailFor(env: Env, t: Pick<TicketRow, "uid" | "contact_id">): Promise<string | null> {
  try {
    const c = await env.DB_META.prepare("SELECT email FROM support_contacts WHERE id=?1").bind(t.contact_id).first<{ email: string | null }>();
    const e = realEmailOrNull(c?.email ?? null);
    if (e) return e;
  } catch { /* fall through */ }
  if (t.uid) {
    try {
      const r = await env.DB_META.prepare("SELECT email FROM hf_user_email WHERE uid=?1").bind(t.uid).first<{ email: string }>();
      const e = realEmailOrNull(r?.email ?? null);
      if (e) return e;
    } catch { /* fall through */ }
    return realEmailOrNull(await emailFor(env, t.uid).catch(() => null));
  }
  return null;
}

/** Message-IDs of the thread, oldest first (bounded), without angle brackets. */
async function threadIds(env: Env, number: number): Promise<{ last: string | null; all: string[] }> {
  try {
    const r = await env.DB_META.prepare(
      "SELECT message_id_header AS id FROM support_messages WHERE ticket_number=?1 AND message_id_header IS NOT NULL AND author_type IN ('customer','staff') ORDER BY created_at DESC LIMIT 12",
    ).bind(number).all<{ id: string }>();
    const ids = (r.results ?? []).map((x) => x.id).reverse();
    return { last: ids.length ? ids[ids.length - 1] : null, all: ids };
  } catch { return { last: null, all: [] }; }
}

export function threadHeaders(messageId: string, ids: { last: string | null; all: string[] }, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { "Message-ID": `<${messageId}>`, ...extra };
  if (ids.last) h["In-Reply-To"] = `<${ids.last}>`;
  if (ids.all.length) h["References"] = ids.all.map((i) => `<${i}>`).join(" ");
  return h;
}

// ---------------------------------------------------------------------------------------------------------------------
// templates (inline styles only; email clients)
// ---------------------------------------------------------------------------------------------------------------------
const WRAP_STYLE = "font-family:Nunito,Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#2b2118;max-width:620px";

export function wrapReplyHtml(bodyHtml: string, signatureHtml: string, n: number): string {
  const sig = signatureHtml.trim() ? `<div style="margin-top:20px;padding-top:14px;border-top:1px solid #eadfce">${signatureHtml}</div>` : "";
  return `<div style="${WRAP_STYLE}">${bodyHtml}${sig}<p style="margin-top:22px;font-size:12px;color:#8a7b6a">Reply to this email to answer. Ticket ${ticketCode(n)}.</p></div>`;
}

export function ackEmailHtml(n: number, afterHours: boolean, unknownSender: boolean): string {
  const lines = [`<p>${escapeHtml(ACK_TEXT(n))}</p>`];
  if (afterHours) lines.push(`<p>${escapeHtml(AFTER_HOURS_TEXT)}</p>`);
  if (unknownSender) {
    lines.push(`<p>To see this ticket, add photos and get faster help, verify your email and WhatsApp number at <a href="${supportSiteOrigin()}">${escapeHtml(supportSiteOrigin().replace("https://", ""))}</a>. Your earlier emails will be attached to your account.</p>`);
  } else {
    lines.push(`<p>You can reply to this email to add more details.</p>`);
  }
  return `<div style="${WRAP_STYLE}">${lines.join("")}<p style="font-size:12px;color:#8a7b6a">${escapeHtml(BRAND.name)} support</p></div>`;
}

export function reminderEmailHtml(n: number, subject: string): string {
  return `<div style="${WRAP_STYLE}"><p>We are still waiting to hear back from you about <b>${escapeHtml(subject)}</b> (${ticketCode(n)}).</p>` +
    `<p>If it is sorted, you do not need to do anything. If you still need help, just reply to this email and we will pick it up. If we do not hear from you, we will mark it solved in a few days.</p></div>`;
}

// ---------------------------------------------------------------------------------------------------------------------
// signatures
// ---------------------------------------------------------------------------------------------------------------------
/** The signature a staff member's replies carry: their personal one if they chose "personal" and wrote one, else the team one. */
export async function signatureFor(env: Env, staffUid: string | null): Promise<string> {
  try {
    if (staffUid) {
      const me = await env.DB_META.prepare("SELECT html,use_for FROM support_signatures WHERE scope_key=?1").bind(`me:${staffUid}`).first<{ html: string; use_for: string }>();
      if (me && me.use_for === "personal" && me.html.trim()) return me.html;
    }
    const team = await env.DB_META.prepare("SELECT html FROM support_signatures WHERE scope_key='team'").first<{ html: string }>();
    return team?.html ?? "";
  } catch { return ""; }
}

// ---------------------------------------------------------------------------------------------------------------------
// sending
// ---------------------------------------------------------------------------------------------------------------------
export interface OutgoingMail {
  to: string;
  ticket: Pick<TicketRow, "number" | "subject">;
  html: string;
  kind: "support_reply" | "support_ack" | "support_reminder" | "support_test";
  lane: EmailLane;
  messageId: string;
  outboxKey: string;
  autoSubmitted?: boolean;
  attachments?: { name: string; content: string }[];
  /** [HF-DESK-CW-3] extra recipients; stored as X-HF-Cc / X-HF-Bcc in headers_json, turned into real Cc/Bcc by the consumer. */
  cc?: string[];
  bcc?: string[];
  /** Subject override; default "[HF-N] <ticket subject>". */
  subject?: string;
  /** Thread headers; fetched from the ticket when omitted. */
  ids?: { last: string | null; all: string[] };
}

export async function sendTicketEmail(env: Env, m: OutgoingMail): Promise<EmailQueueResult> {
  const ids = m.ids ?? await threadIds(env, m.ticket.number);
  const headers = threadHeaders(m.messageId, ids, {
    "X-HF-Ticket": String(m.ticket.number),
    ...(m.autoSubmitted ? { "Auto-Submitted": "auto-generated", "X-Auto-Response-Suppress": "All" } : {}),
    ...(m.cc?.length ? { "X-HF-Cc": m.cc.join(",") } : {}),
    ...(m.bcc?.length ? { "X-HF-Bcc": m.bcc.join(",") } : {}),
  });
  return enqueueEmail(env, {
    to: m.to,
    subject: m.subject ?? tag(m.ticket.number, m.ticket.subject),
    html: m.html,
    outboxKey: m.outboxKey,
    kind: m.kind,
    from: supportFrom(),
    replyTo: await replyToFor(env, m.ticket.number),
    headers,
    attachments: m.attachments,
  }, { lane: m.lane });
}

/** Auto-acknowledgement (bulk lane). The in-app note is a system message written when the ticket is created. */
export async function sendAck(env: Env, t: Pick<TicketRow, "number" | "subject">, to: string, opts: { afterHours: boolean; unknownSender: boolean }): Promise<EmailQueueResult> {
  return sendTicketEmail(env, {
    to, ticket: t, html: ackEmailHtml(t.number, opts.afterHours, opts.unknownSender), kind: "support_ack", lane: "bulk",
    messageId: newMessageId(t.number), outboxKey: `support-ack:${t.number}`, autoSubmitted: true,
    // Own conversation in the customer's inbox: no In-Reply-To/References, so Gmail does not fold the ack under the
    // customer's original subject and hide the ticket number. Replies still route by Reply-To support+N and the subject.
    subject: ackSubject(t.number, t.subject), ids: { last: null, all: [] },
  });
}

export async function sendWaitingReminder(env: Env, t: Pick<TicketRow, "number" | "subject">, to: string): Promise<EmailQueueResult> {
  return sendTicketEmail(env, {
    to, ticket: t, html: reminderEmailHtml(t.number, t.subject), kind: "support_reminder", lane: "bulk",
    messageId: newMessageId(t.number), outboxKey: `support-reminder:${t.number}`, autoSubmitted: true,
  });
}

/** Read stored attachment objects and base64 them for the email outbox (R2 text objects, as email_outbox expects). */
export async function emailAttachmentsFor(env: Env, attachmentIds: string[]): Promise<{ name: string; content: string }[]> {
  const out: { name: string; content: string }[] = [];
  for (const id of attachmentIds) {
    const row = await env.DB_META.prepare("SELECT r2_key,name FROM support_attachments WHERE id=?1").bind(id).first<{ r2_key: string; name: string }>();
    if (!row) continue;
    const obj = await env.BACKUP_R2.get(row.r2_key);
    if (!obj) continue;
    const bytes = new Uint8Array(await obj.arrayBuffer());
    out.push({ name: row.name, content: btoa(bytesToBinary(bytes)) });
  }
  return out;
}

/**
 * Customer WhatsApp nudge: "<Brand> support replied to HF-10234. Open the app to read." No message content, at most once per
 * ticket per 30 minutes (throttle = tickets.last_nudge_at claimed with a compare-and-set, so two replies in a row send one).
 * Only for a verified WhatsApp number; email-only guests are not nudged.
 */
export async function nudgeCustomer(env: Env, t: Pick<TicketRow, "number" | "uid">, now = Date.now()): Promise<"sent" | "throttled" | "no_whatsapp"> {
  if (!t.uid) return "no_whatsapp";
  const claim = await env.DB_META.prepare(
    "UPDATE support_tickets SET last_nudge_at=?2 WHERE number=?1 AND (last_nudge_at IS NULL OR last_nudge_at<=?3)",
  ).bind(t.number, now, now - NUDGE_INTERVAL_MS).run();
  if ((claim.meta?.changes ?? 0) === 0) return "throttled";
  const e164 = await verifiedWhatsAppNumber(env, t.uid).catch(() => null);
  if (!e164) return "no_whatsapp";
  const r = await enqueueWhatsApp(env, {
    to: e164, kind: "support_nudge", lane: "normal",
    text: `${BRAND.name} support replied to ${ticketCode(t.number)}. Open the app to read.`,
    key: `support-nudge:${t.number}:${Math.floor(now / NUDGE_INTERVAL_MS)}`,
  });
  await addEvent(env, t.number, "system", "nudge", { status: r.status }, now);
  return r.status === "invalid" || r.status === "failed" ? "no_whatsapp" : "sent";
}

export { textToHtml, htmlToPlainText, MINUTE_MS };
