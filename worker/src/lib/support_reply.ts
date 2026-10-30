// [HF-SUPPORT-1] A staff reply: store it (in-app message + R2 HTML), email it (priority lane, threaded, signature appended server-side),
// move the ticket's status, and nudge the customer on WhatsApp (throttled to once per 30 min). Nothing here puts content on a queue.
import type { Env } from "../types";
import {
  addEvent, htmlKey, newMessageId, sanitizeHtml, setTicketStatus, textToHtml, type StaffCtx, type Status, type TicketRow,
} from "./support_core";
import { addMessage, checkAttachmentIds } from "./support_ops";
import { emailAttachmentsFor, nudgeCustomer, recipientEmailFor, sendTicketEmail, signatureFor, wrapReplyHtml } from "./support_mail";
import { htmlToPlainText } from "./support_mime";

const REPLY_STATUSES: readonly Status[] = ["waiting", "open", "on_hold", "solved"];

export interface StaffReplyInput {
  html?: unknown; text?: unknown; attachmentIds?: unknown; setStatus?: unknown;
  /** [HF-DESK-CW-3] override the ticket's recipient, and extra Cc / Bcc (validated addresses, at most 10 each). */
  to?: unknown; cc?: unknown; bcc?: unknown;
}

const EMAIL_RE = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/;
/** "a@x.com, b@y.com" or ["a@x.com"] -> clean lower-case list; null when anything in it is not an address. */
export function emailList(v: unknown): string[] | null {
  if (v === undefined || v === null || v === "") return [];
  const raw = Array.isArray(v) ? v.map(String) : String(v).split(/[,;]/);
  const out = [...new Set(raw.map((x) => x.trim().toLowerCase()).filter(Boolean))];
  if (out.length > 10 || out.some((x) => !EMAIL_RE.test(x))) return null;
  return out;
}
export interface DeliveryState { status: string; queued: boolean; durable: boolean; outboxKey: string }

export type StaffReplyResult =
  | { ok: true; messageId: string; delivery: DeliveryState | null; emailSkipped?: "no_email"; nudge: string; status: Status }
  | { ok: false; error: "empty_reply" | "ticket_closed" | "invalid_status" | "bad_attachment" | "attachments_too_large" | "invalid_recipients" };

export async function postStaffReply(env: Env, staff: StaffCtx, t: TicketRow, input: StaffReplyInput, now = Date.now()): Promise<StaffReplyResult> {
  if (t.status === "closed" || t.status === "spam" || t.status === "trash") return { ok: false, error: "ticket_closed" };
  let target: Status = "waiting";
  if (input.setStatus !== undefined && input.setStatus !== null && input.setStatus !== "") {
    if (!REPLY_STATUSES.includes(input.setStatus as Status)) return { ok: false, error: "invalid_status" };
    target = input.setStatus as Status;
  }
  const rawHtml = typeof input.html === "string" ? input.html : "";
  const rawText = typeof input.text === "string" ? input.text : "";
  const bodyHtml = sanitizeHtml(rawHtml.trim() ? rawHtml : textToHtml(rawText));
  const text = (rawText.trim() ? rawText : htmlToPlainText(bodyHtml)).trim();
  if (!text) return { ok: false, error: "empty_reply" };
  const toList = emailList(input.to);
  const ccList = emailList(input.cc);
  const bccList = emailList(input.bcc);
  if (!toList || !ccList || !bccList) return { ok: false, error: "invalid_recipients" };
  const att = await checkAttachmentIds(env, input.attachmentIds, staff.uid);
  if (!att.ok) return { ok: false, error: att.error };

  const signature = sanitizeHtml(await signatureFor(env, staff.uid));
  const fullHtml = signature.trim() ? `${bodyHtml}<div class="hf-signature">${signature}</div>` : bodyHtml;
  const rowId = crypto.randomUUID();
  const messageHeaderId = newMessageId(t.number);
  const key = htmlKey(t.number, rowId);
  await env.BACKUP_R2.put(key, fullHtml, { httpMetadata: { contentType: "text/html; charset=utf-8" } });

  // The first "To" replaces the ticket's recipient; any further "To" addresses are sent as Cc.
  const to = toList[0] ?? await recipientEmailFor(env, t);
  const cc = [...new Set([...toList.slice(1), ...ccList])].filter((x) => x !== to);
  const bcc = bccList.filter((x) => x !== to && !cc.includes(x));
  const ids = await (async () => {
    // thread headers must be read BEFORE this message is inserted (In-Reply-To = the customer's latest message)
    const r = await env.DB_META.prepare(
      "SELECT message_id_header AS id FROM support_messages WHERE ticket_number=?1 AND message_id_header IS NOT NULL AND author_type IN ('customer','staff') ORDER BY created_at DESC LIMIT 12",
    ).bind(t.number).all<{ id: string }>().catch(() => ({ results: [] as { id: string }[] }));
    const list = (r.results ?? []).map((x) => x.id).reverse();
    return { last: list.length ? list[list.length - 1] : null, all: list };
  })();

  await addMessage(env, t.number, {
    id: rowId, authorType: "staff", authorUid: staff.uid, authorName: staff.name ?? staff.email ?? "Support", text, htmlKey: key,
    messageIdHeader: messageHeaderId, inReplyTo: ids.last, now, attachmentIds: att.ids, uploaderUid: staff.uid,
  });
  await setTicketStatus(env, t, target, staff.uid, now);
  if (!t.assignee_uid) await env.DB_META.prepare("UPDATE support_tickets SET assignee_uid=?2 WHERE number=?1 AND assignee_uid IS NULL").bind(t.number, staff.uid).run().catch(() => undefined);
  await env.DB_META.prepare("UPDATE support_tickets SET unread_staff=0 WHERE number=?1").bind(t.number).run().catch(() => undefined);
  await addEvent(env, t.number, staff.uid, "reply", { messageId: rowId, attachments: att.ids.length }, now);

  let delivery: DeliveryState | null = null;
  let emailSkipped: "no_email" | undefined;
  if (to) {
    const attachments = att.ids.length ? await emailAttachmentsFor(env, att.ids) : undefined;
    const r = await sendTicketEmail(env, {
      to, ticket: t, html: wrapReplyHtml(bodyHtml, signature, t.number), kind: "support_reply", lane: "priority",
      messageId: messageHeaderId, outboxKey: `support-reply:${rowId}`, attachments, ids, cc, bcc,
    });
    delivery = { status: r.status, queued: r.queued, durable: r.durable, outboxKey: r.outboxKey };
  } else emailSkipped = "no_email"; // an app user with no address on file still gets the in-app message + WhatsApp nudge
  const nudge = await nudgeCustomer(env, t, now).catch(() => "no_whatsapp" as const);
  return { ok: true, messageId: rowId, delivery, ...(emailSkipped ? { emailSkipped } : {}), nudge, status: target };
}
