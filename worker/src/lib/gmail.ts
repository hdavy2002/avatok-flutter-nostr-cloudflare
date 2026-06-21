// gmail.ts — structured Gmail helpers over Composio for the in-chat email UI
// (AvaTOK "Ava inbox": list of 5 → view → reply, plus spam/delete). Used by BOTH
// routes/ava_email.ts (per-card actions) AND the in-thread Ava turn
// (do/ava_agent.ts, which posts the inbox cards as an Ava bubble), so the shape
// the Flutter EmailCard / EmailViewer renders is produced in ONE place.
//
// Composio Gmail slugs + arg names are verified live against
// backend.composio.dev/api/v3 (gmail toolkit). Bytes/content are fetched per the
// user's own connected Gmail (premium + OAuth); we never store mail server-side.

import type { Env } from "../types";
import { executeTool } from "./composio";

export interface InboxEmail {
  id: string;        // Gmail messageId
  threadId: string;  // Gmail threadId (needed to reply in-thread)
  from: string;      // display name ("Maya Rivera") or address if none
  addr: string;      // sender email address (reply recipient)
  subject: string;
  snippet: string;   // short preview shown on the card
  time: string;      // compact label (HH:MM today / "Yesterday" / MM-DD)
  flag?: string;     // "Action" → coral pill, when the message is IMPORTANT
  accent: string;    // CSS var token for the monogram tile (matches the design)
  unread?: boolean;
}

// Monogram tile palette — mirrors the design-system accents (kit-data.js).
const ACCENTS = ["var(--blue)", "var(--lime)", "var(--mint)", "var(--coral)", "var(--lilac)"];
export function accentFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return ACCENTS[h % ACCENTS.length];
}

// "Maya Rivera <maya@hey.com>" → {name, addr}; a bare address → name=addr.
export function parseSender(raw: string): { name: string; addr: string } {
  const s = String(raw || "").trim();
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) {
    const name = m[1].trim();
    const addr = m[2].trim();
    return { name: name || addr, addr };
  }
  return { name: s, addr: s };
}

// Composio returns either an epoch (ms or s) or an ISO string for the timestamp.
function shortTime(ts: unknown): string {
  if (ts == null || ts === "") return "";
  let d: Date;
  const n = Number(ts);
  if (Number.isFinite(n) && n > 1e11) d = new Date(n);           // epoch ms
  else if (Number.isFinite(n) && n > 1e9) d = new Date(n * 1000); // epoch s
  else d = new Date(String(ts));
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toISOString().slice(11, 16); // HH:MM
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return "Yesterday";
  return d.toISOString().slice(5, 10); // MM-DD
}

// Gmail full-message bodies come back as HTML (`messageText`). Strip to readable
// plain text so the in-chat viewer doesn't render raw tags. (Verified against a
// live fetch — messageText is HTML, preview.body is a short clean snippet.)
export function htmlToText(html: string): string {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<\/(p|div|tr|h[1-6]|li|table)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Result-shape helpers — Composio wraps tool output under `data` (sometimes not).
export function toolOk(r: any): boolean { return !(r && (r.successful === false || r.error)); }
export function toolErr(r: any): string {
  return String(r?.error ?? r?.message ?? "tool reported failure").slice(0, 200);
}

// Fetch the latest INBOX emails (metadata + snippet — fast). Body is fetched
// lazily on "View" via getMessageBody so the list stays light.
export async function fetchInbox(env: Env, uid: string, max = 5): Promise<InboxEmail[]> {
  const r = await executeTool(env, uid, "GMAIL_FETCH_EMAILS", {
    user_id: "me", max_results: max, label_ids: ["INBOX"], verbose: true,
  });
  if (!toolOk(r)) throw new Error(toolErr(r));
  const msgs: any[] = r?.data?.messages ?? r?.data?.emails ?? r?.messages ?? [];
  return msgs.slice(0, max).map((m: any) => {
    const { name, addr } = parseSender(m?.sender ?? m?.from ?? "");
    const labels: string[] = Array.isArray(m?.labelIds) ? m.labelIds.map(String) : [];
    const snippet = String(m?.preview?.body ?? m?.snippet ?? m?.messageText ?? "")
      .replace(/\s+/g, " ").trim().slice(0, 240);
    const email: InboxEmail = {
      id: String(m?.messageId ?? m?.id ?? ""),
      threadId: String(m?.threadId ?? ""),
      from: name, addr, subject: String(m?.subject ?? "(no subject)"), snippet,
      time: shortTime(m?.messageTimestamp ?? m?.internalDate ?? m?.date),
      accent: accentFor(addr || name || "?"),
      unread: labels.includes("UNREAD"),
    };
    if (labels.includes("IMPORTANT")) email.flag = "Action";
    return email;
  });
}

// Full message body for the "View" overlay.
export async function getMessageBody(
  env: Env, uid: string, id: string,
): Promise<{ body: string; subject?: string; from?: string; addr?: string }> {
  const r = await executeTool(env, uid, "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", {
    user_id: "me", message_id: id, format: "full",
  });
  if (!toolOk(r)) throw new Error(toolErr(r));
  const d = r?.data ?? r ?? {};
  // Prefer the full message stripped to text; fall back to the clean preview.
  const rawHtml = String(d?.messageText ?? "");
  const stripped = /<[a-z!/]/i.test(rawHtml) ? htmlToText(rawHtml) : rawHtml.trim();
  const body = (stripped || String(d?.preview?.body ?? d?.body ?? d?.snippet ?? "")).trim();
  const { name, addr } = parseSender(d?.sender ?? "");
  return {
    body,
    subject: d?.subject ? String(d.subject) : undefined,
    from: name || undefined,
    addr: addr || undefined,
  };
}

// Spam = add the SPAM label + drop INBOX (Gmail's "Report spam").
export function markSpam(env: Env, uid: string, id: string): Promise<any> {
  return executeTool(env, uid, "GMAIL_ADD_LABEL_TO_EMAIL", {
    user_id: "me", message_id: id, add_label_ids: ["SPAM"], remove_label_ids: ["INBOX"],
  });
}

// Delete = move to Trash (reversible; matches the design's "Delete").
export function trashMessage(env: Env, uid: string, id: string): Promise<any> {
  return executeTool(env, uid, "GMAIL_MOVE_TO_TRASH", { user_id: "me", message_id: id });
}

// Reply in-thread to the sender.
export function replyThread(
  env: Env, uid: string, a: { threadId: string; to: string; body: string },
): Promise<any> {
  return executeTool(env, uid, "GMAIL_REPLY_TO_THREAD", {
    user_id: "me", thread_id: a.threadId, recipient_email: a.to, message_body: a.body,
  });
}
