// outlook.ts — structured Outlook helpers over Composio for the in-chat email UI.
// Mirrors lib/gmail.ts exactly (same InboxEmail shape, same list→view→reply +
// spam/delete verbs) so the Flutter EmailCard / EmailViewer render Outlook mail
// UNCHANGED. Used by routes/ava_email.ts (per-card actions) AND do/ava_agent.ts
// (which posts the inbox cards as an Ava bubble when only Outlook is connected).
//
// Composio Outlook slugs + arg/result shapes verified live against
// backend.composio.dev/api/v3 (toolkit_slug=outlook — NOTE this account's
// catalog uses the DOUBLE-prefixed "OUTLOOK_OUTLOOK_*" slugs):
//   OUTLOOK_OUTLOOK_LIST_MESSAGES  { user_id, folder, top, orderby }
//   OUTLOOK_OUTLOOK_GET_MESSAGE    { user_id, message_id }
//   OUTLOOK_OUTLOOK_REPLY_EMAIL    { user_id, message_id, comment }
//   OUTLOOK_OUTLOOK_MOVE_MESSAGE   { user_id, message_id, destination_id }
// Results pass the Microsoft Graph response through under data.response_data
// (list → { value: [messages…] }; message = Graph shape: id, subject,
// from.emailAddress.{name,address}, bodyPreview, receivedDateTime, isRead,
// importance, body.{contentType,content}).
//
// PROVIDER ROUTING WITHOUT A CLIENT CHANGE: every Outlook id we hand the client
// is prefixed "ol:" (Graph message ids never contain ":"), and — because Graph
// replies by MESSAGE id, not thread id — threadId is set to the same "ol:<id>".
// The Flutter app echoes ids/threadIds back verbatim, so the /api/ava/email/*
// routes strip the prefix and dispatch to these helpers; bare (Gmail) ids keep
// their existing byte-identical path.

import type { Env } from "../types";
import { executeTool } from "./composio";
import {
  type InboxEmail, accentFor, htmlToText, shortTime, toolOk, toolErr,
} from "./gmail";

// "ol:" marks an Outlook message id in the shared email envelope.
export const OUTLOOK_ID_PREFIX = "ol:";
export function isOutlookId(id: string): boolean {
  return String(id || "").startsWith(OUTLOOK_ID_PREFIX);
}
export function stripOutlookId(id: string): string {
  const s = String(id || "");
  return s.startsWith(OUTLOOK_ID_PREFIX) ? s.slice(OUTLOOK_ID_PREFIX.length) : s;
}

// Graph sender ({emailAddress:{name,address}}) → {name, addr}; addr fallback.
function graphSender(m: any): { name: string; addr: string } {
  const ea = m?.from?.emailAddress ?? m?.sender?.emailAddress ?? {};
  const addr = String(ea?.address ?? "").trim();
  const name = String(ea?.name ?? "").trim() || addr;
  return { name, addr };
}

// The Graph message list lives under data.response_data.value (defensive).
function graphList(r: any): any[] {
  const d = r?.data?.response_data ?? r?.data ?? r ?? {};
  return Array.isArray(d?.value) ? d.value : Array.isArray(d?.messages) ? d.messages : [];
}

// Fetch the latest Inbox emails (metadata + bodyPreview — fast). Body is fetched
// lazily on "View" via getOutlookMessageBody so the list stays light.
export async function fetchOutlookInbox(env: Env, uid: string, max = 5): Promise<InboxEmail[]> {
  const r = await executeTool(env, uid, "OUTLOOK_OUTLOOK_LIST_MESSAGES", {
    user_id: "me", folder: "Inbox", top: max, orderby: ["receivedDateTime desc"],
  });
  if (!toolOk(r)) throw new Error(toolErr(r));
  return graphList(r).slice(0, max).map((m: any) => {
    const { name, addr } = graphSender(m);
    const bare = String(m?.id ?? "");
    const snippet = String(m?.bodyPreview ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
    const email: InboxEmail = {
      id: OUTLOOK_ID_PREFIX + bare,
      // Graph replies target the MESSAGE id — carry it as the threadId so the
      // client's reply({threadId}) round-trips to OUTLOOK_OUTLOOK_REPLY_EMAIL.
      threadId: OUTLOOK_ID_PREFIX + bare,
      from: name, addr, subject: String(m?.subject ?? "(no subject)"), snippet,
      time: shortTime(m?.receivedDateTime ?? m?.sentDateTime),
      accent: accentFor(addr || name || "?"),
      unread: m?.isRead === false,
    };
    if (String(m?.importance ?? "").toLowerCase() === "high") email.flag = "Action";
    return email;
  });
}

// Full message body for the "View" overlay. `id` arrives WITHOUT the ol: prefix
// (the route strips it before dispatch).
export async function getOutlookMessageBody(
  env: Env, uid: string, id: string,
): Promise<{ body: string; subject?: string; from?: string; addr?: string }> {
  const r = await executeTool(env, uid, "OUTLOOK_OUTLOOK_GET_MESSAGE", {
    user_id: "me", message_id: id,
  });
  if (!toolOk(r)) throw new Error(toolErr(r));
  const d = r?.data?.response_data ?? r?.data ?? r ?? {};
  const raw = String(d?.body?.content ?? "");
  const isHtml = String(d?.body?.contentType ?? "").toLowerCase() === "html" || /<[a-z!/]/i.test(raw);
  const stripped = isHtml ? htmlToText(raw) : raw.trim();
  const body = (stripped || String(d?.bodyPreview ?? "")).trim();
  const { name, addr } = graphSender(d);
  return {
    body,
    subject: d?.subject ? String(d.subject) : undefined,
    from: name || undefined,
    addr: addr || undefined,
  };
}

// Spam = move to the Junk Email well-known folder (Outlook's "Report junk").
export function markOutlookSpam(env: Env, uid: string, id: string): Promise<any> {
  return executeTool(env, uid, "OUTLOOK_OUTLOOK_MOVE_MESSAGE", {
    user_id: "me", message_id: id, destination_id: "junkemail",
  });
}

// Delete = move to Deleted Items (reversible; matches the design's "Delete").
export function trashOutlookMessage(env: Env, uid: string, id: string): Promise<any> {
  return executeTool(env, uid, "OUTLOOK_OUTLOOK_MOVE_MESSAGE", {
    user_id: "me", message_id: id, destination_id: "deleteditems",
  });
}

// Reply to the sender. Graph auto-addresses the original sender, so `to` is
// accepted for signature parity with gmail.ts replyThread but not needed.
export function replyOutlookThread(
  env: Env, uid: string, a: { threadId: string; to: string; body: string },
): Promise<any> {
  return executeTool(env, uid, "OUTLOOK_OUTLOOK_REPLY_EMAIL", {
    user_id: "me", message_id: stripOutlookId(a.threadId), comment: a.body,
  });
}
