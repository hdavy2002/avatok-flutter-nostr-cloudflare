// [HF-SUPPORT-1] Support desk core: constants, pure rules (status, SLA, threading, spam, suppression) and the small
// D1 helpers every other support module shares. Contract: Specs/HF-SUPPORT-CONTRACT.md. Rulebook section 24.
//
// Queues carry IDs only (see lib/queue_guard.ts): nothing in here puts message content on a queue.
import type { Env } from "../types";
import { BRAND } from "./brand";
import { isAdminUid } from "./preview";
import { primaryVerifiedEmailFor } from "./identity";
import type { ParsedMail } from "./support_mime";

// ---------------------------------------------------------------------------------------------------------------------
// vocabulary
// ---------------------------------------------------------------------------------------------------------------------
export const CATEGORIES = {
  calls: "Calls", wallet: "Wallet & top-ups", withdraw: "Withdraw to UPI", bookings: "Bookings",
  influencer: "Influencer account", app: "App problem", report: "Report someone", other: "Other",
} as const;
export type Category = keyof typeof CATEGORIES;
export const isCategory = (v: unknown): v is Category => typeof v === "string" && Object.prototype.hasOwnProperty.call(CATEGORIES, v);

/** Money categories are kept 8 years; everything else 3 (rulebook 24.8). `refund` is not a picker category but old/future data may carry it. */
export const MONEY_CATEGORIES = new Set(["wallet", "withdraw", "refund", "calls"]);
export const isMoneyCategory = (c: string): boolean => MONEY_CATEGORIES.has(c);

export const STATUSES = ["new", "open", "waiting", "on_hold", "solved", "closed", "spam", "trash"] as const;
export type Status = (typeof STATUSES)[number];
export const isStatus = (v: unknown): v is Status => typeof v === "string" && (STATUSES as readonly string[]).includes(v);

export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const isPriority = (v: unknown): v is Priority => typeof v === "string" && (PRIORITIES as readonly string[]).includes(v);

export function defaultPriority(category: string): Priority {
  if (category === "report") return "urgent";
  if (category === "wallet" || category === "withdraw") return "high";
  return "normal";
}

/** What the customer sees: new/open/on_hold -> Open, waiting -> We replied, solved -> Solved, closed -> Closed. */
export function statusLabel(status: string): string {
  switch (status) {
    case "waiting": return "We replied";
    case "solved": return "Solved";
    case "closed": return "Closed";
    case "spam": case "trash": return "Closed";
    default: return "Open";
  }
}

export const ticketCode = (n: number): string => `HF-${n}`;
/** Strip Re:/Fwd:, "[HF-N]" tags and the ack's "Ticket HF-N received:" prefix from a subject. */
export function cleanTicketSubject(subject: string): string {
  return subject.replace(/^\s*((re|fwd?|aw)\s*:\s*)+/i, "").replace(/\[HF-\d+\]\s*/gi, "")
    .replace(/^\s*Ticket\s+HF-\d+\s+received\s*:\s*/i, "").replace(/^\s*((re|fwd?|aw)\s*:\s*)+/i, "").trim();
}
/** "HF-10234" | "10234" -> 10234, else null. */
export function parseTicketNumber(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const m = /^(?:HF-)?(\d{4,9})$/i.exec(String(v).trim());
  return m ? parseInt(m[1], 10) : null;
}

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;
export const REOPEN_WINDOW_MS = 7 * DAY_MS;            // solved -> customer may reopen
export const SOLVED_TO_CLOSED_MS = 7 * DAY_MS;
export const WAITING_REMINDER_MS = 5 * DAY_MS;
export const WAITING_TO_SOLVED_MS = 7 * DAY_MS;        // after the reminder
export const NUDGE_INTERVAL_MS = 30 * MINUTE_MS;
export const IDENTICAL_WINDOW_MS = 10 * MINUTE_MS;
export const MAX_TICKETS_PER_DAY = 5;
export const MAX_AUTOREPLIES_PER_HOUR = 3;
export const RETENTION_NORMAL_MS = 3 * 365 * DAY_MS;
export const RETENTION_MONEY_MS = 8 * 365 * DAY_MS;

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_MESSAGE_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_TEXT_CHARS = 8000;
export const MAX_SUBJECT_CHARS = 200;
export const MAX_CUSTOMER_MESSAGE_CHARS = 8000;

export const DENIED_EXTENSIONS = new Set([
  "exe", "apk", "bat", "cmd", "com", "js", "mjs", "vbs", "scr", "msi", "jar", "ps1", "sh", "dll", "lnk", "reg", "hta", "cpl", "pif",
  "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "iso", "dmg", "html", "htm", "svg",
]);
const ALLOWED_TYPES = /^(image\/(png|jpe?g|gif|webp|heic|heif|bmp)|application\/pdf|text\/plain)$/i;
const ALLOWED_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "pdf", "txt"]);

export function fileExtension(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name.trim());
  return m ? m[1].toLowerCase() : "";
}

export type AttachmentVerdict = { ok: true } | { ok: false; reason: "blocked_type" | "too_large" | "empty" };

/** Images, PDFs and screenshots only; executables, scripts and archives are refused whatever their content-type says. */
export function checkAttachment(name: string, contentType: string, size: number): AttachmentVerdict {
  if (!size) return { ok: false, reason: "empty" };
  if (size > MAX_ATTACHMENT_BYTES) return { ok: false, reason: "too_large" };
  const ext = fileExtension(name);
  if (ext && DENIED_EXTENSIONS.has(ext)) return { ok: false, reason: "blocked_type" };
  const typeOk = ALLOWED_TYPES.test(contentType.split(";")[0].trim());
  if (!typeOk) return { ok: false, reason: "blocked_type" };
  if (ext && !ALLOWED_EXTENSIONS.has(ext)) return { ok: false, reason: "blocked_type" };
  return { ok: true };
}

export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  return base.replace(/[^\p{L}\p{M}\p{N}_.\- ]+/gu, "_").replace(/\s+/g, " ").trim().slice(0, 100) || "file";
}

// ---------------------------------------------------------------------------------------------------------------------
// brand-derived addresses (never hard-code the domain: Specs/brand.json is the only place)
// ---------------------------------------------------------------------------------------------------------------------
export const supportSiteOrigin = (): string => `https://support.${BRAND.domain}`;
export const supportFromAddress = (): string => BRAND.emails.support;
export const supportFrom = (): string => `${BRAND.emailFromName} Support <${BRAND.emails.support}>`;
/** support+10234@<brand domain> */
export const replyToFor = (n: number): { email: string; name: string } => ({ email: `support+${n}@${BRAND.domain}`, name: `${BRAND.emailFromName} Support` });
export const supportLocalPart = (): string => BRAND.emails.support.split("@")[0].toLowerCase();
/** Message-ID we stamp on outgoing mail: <hf-10234-<uuid>@domain> (angle brackets added by callers). */
export const newMessageId = (n: number): string => `hf-${n}-${crypto.randomUUID()}@${BRAND.domain}`;

// ---------------------------------------------------------------------------------------------------------------------
// small utils
// ---------------------------------------------------------------------------------------------------------------------
export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const clip = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, Math.max(0, n - 1)).trimEnd() + "…");
export const makePreview = (text: string): string => clip(text.replace(/\s+/g, " ").trim(), 160);
export const normaliseForHash = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim();

export function dayPath(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
}
export const inboundKey = (ms: number, id: string): string => `support/inbound/${dayPath(ms)}/${id}.eml`;
export const attachmentKey = (ticket: number | "pending", id: string, name: string): string => `support/att/${ticket}/${id}/${safeFileName(name)}`;
export const htmlKey = (ticket: number, messageId: string): string => `support/html/${ticket}/${messageId}.html`;
export const SUPPORT_R2_PREFIX = "support/";

export function maskWhatsApp(v: string | null | undefined): string | null {
  if (!v) return null;
  const d = v.replace(/\D/g, "");
  return d.length >= 4 ? `+${d.length > 10 ? d.slice(0, d.length - 10) : "91"} ••••• ${d.slice(-4)}` : null;
}

/** Allow-list-ish sanitiser for staff-written reply HTML (shown in the app/web and mailed). Strips scripts, handlers and dangerous URLs. */
export function sanitizeHtml(html: string): string {
  let h = html.slice(0, 120_000);
  h = h.replace(/<!--[\s\S]*?-->/g, "");
  h = h.replace(/<\s*(script|style|iframe|object|embed|link|meta|form|input|button|textarea|select|base|svg|math)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, "");
  h = h.replace(/<\s*\/?\s*(script|style|iframe|object|embed|link|meta|form|input|button|textarea|select|base|svg|math)\b[^>]*>/gi, "");
  h = h.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  h = h.replace(/\s+(href|src|xlink:href|action|formaction)\s*=\s*("|')\s*(javascript|vbscript|data):[^"']*\2/gi, ' $1="#"');
  h = h.replace(/\s+(href|src)\s*=\s*(javascript|vbscript|data):[^\s>]*/gi, ' $1="#"');
  h = h.replace(/\s+style\s*=\s*("[^"]*(expression|javascript:|url\()[^"]*"|'[^']*(expression|javascript:|url\()[^']*')/gi, "");
  return h;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
export const textToHtml = (text: string): string => escapeHtml(text).replace(/\r?\n/g, "<br>");

/** Remove quoted history ("On ... wrote:", "> ..." lines, Outlook "From:" blocks) from an email reply so the thread stays readable. */
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*On .{5,200}wrote:\s*$/i.test(line) || (/^\s*On .{5,200}$/i.test(line) && /wrote:\s*$/i.test(lines[i + 1] ?? ""))) break;
    if (/^\s*-{2,}\s*(Original Message|Forwarded message)\s*-{2,}\s*$/i.test(line)) break;
    if (/^\s*_{10,}\s*$/.test(line) && /^\s*From:/i.test(lines[i + 1] ?? "")) break;
    if (/^\s*From:\s.+/i.test(line) && /^\s*(Sent|Date):/i.test(lines[i + 1] ?? "")) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  const cleaned = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return cleaned || text.trim(); // never return nothing for a message that was only a quote
}

// ---------------------------------------------------------------------------------------------------------------------
// settings and business hours
// ---------------------------------------------------------------------------------------------------------------------
export interface BusinessHours { utcOffsetMin: number; days: number[]; start: string; end: string; tz?: string }
export const DEFAULT_HOURS: BusinessHours = { tz: "Asia/Kolkata", utcOffsetMin: 330, days: [1, 2, 3, 4, 5, 6], start: "10:00", end: "19:00" };

/** Desk automation: a new ticket in `category` goes to `assigneeUid` and/or gets `priority`. */
export interface AutomationRule { id: string; category: string; assigneeUid: string | null; priority: string | null }
export interface SupportSettings { alertWhatsapp: string | null; hours: BusinessHours; holidays: string[]; holidayLabels: Array<{ date: string; label: string }>; automations: AutomationRule[] }

const parseJson = <T,>(s: string | null | undefined, fallback: T): T => { try { return s ? (JSON.parse(s) as T) : fallback; } catch { return fallback; } };

export async function getSetting(env: Env, key: string): Promise<string | null> {
  try {
    const r = await env.DB_META.prepare("SELECT value FROM support_settings WHERE key=?1").bind(key).first<{ value: string }>();
    return r?.value ?? null;
  } catch { return null; }
}
export async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB_META.prepare(
    "INSERT INTO support_settings (key,value,updated_at) VALUES (?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
  ).bind(key, value, Date.now()).run();
}

export async function loadSettings(env: Env): Promise<SupportSettings> {
  let rows: Array<{ key: string; value: string }> = [];
  try { rows = (await env.DB_META.prepare("SELECT key,value FROM support_settings").all<{ key: string; value: string }>()).results ?? []; } catch { /* defaults */ }
  const m = new Map(rows.map((r) => [r.key, r.value]));
  const hours = { ...DEFAULT_HOURS, ...parseJson<Partial<BusinessHours>>(m.get("business_hours"), {}) };
  // holidays are stored as "YYYY-MM-DD" strings or { date, label } objects
  const rawHolidays = parseJson<unknown[]>(m.get("holidays"), []);
  const holidayLabels = (Array.isArray(rawHolidays) ? rawHolidays : [])
    .map((x) => (typeof x === "string" ? { date: x, label: "" } : { date: String((x as { date?: unknown })?.date ?? ""), label: String((x as { label?: unknown })?.label ?? "") }))
    .filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.date));
  const rawRules = parseJson<unknown[]>(m.get("automations"), []);
  const automations = (Array.isArray(rawRules) ? rawRules : []).flatMap((r): AutomationRule[] => {
    const o = (r ?? {}) as Record<string, unknown>;
    if (typeof o.category !== "string") return [];
    return [{ id: String(o.id ?? o.category), category: o.category, assigneeUid: typeof o.assigneeUid === "string" && o.assigneeUid ? o.assigneeUid : null, priority: typeof o.priority === "string" && o.priority ? o.priority : null }];
  });
  return {
    alertWhatsapp: m.get("alert_whatsapp") || null,
    hours,
    holidays: holidayLabels.map((h) => h.date),
    holidayLabels,
    automations,
  };
}

const hm = (v: string): number => { const [h, m] = v.split(":").map((x) => parseInt(x, 10)); return (h || 0) * 60 + (m || 0); };

/** Local (shop) clock parts for an instant. */
function localParts(ms: number, hours: BusinessHours): { dayStartLocal: number; dow: number; date: string; minutes: number } {
  const local = ms + hours.utcOffsetMin * MINUTE_MS;
  const dayStartLocal = Math.floor(local / DAY_MS) * DAY_MS;
  const d = new Date(dayStartLocal);
  return { dayStartLocal, dow: d.getUTCDay(), date: d.toISOString().slice(0, 10), minutes: Math.floor((local - dayStartLocal) / MINUTE_MS) };
}

export function isBusinessTime(ms: number, hours: BusinessHours = DEFAULT_HOURS, holidays: string[] = []): boolean {
  const p = localParts(ms, hours);
  if (!hours.days.includes(p.dow) || holidays.includes(p.date)) return false;
  return p.minutes >= hm(hours.start) && p.minutes < hm(hours.end);
}

/** First instant >= ms that is inside business hours. */
export function nextBusinessOpen(ms: number, hours: BusinessHours = DEFAULT_HOURS, holidays: string[] = []): number {
  let cursor = ms;
  for (let i = 0; i < 400; i++) {
    const p = localParts(cursor, hours);
    const open = p.dayStartLocal + hm(hours.start) * MINUTE_MS - hours.utcOffsetMin * MINUTE_MS;
    const close = p.dayStartLocal + hm(hours.end) * MINUTE_MS - hours.utcOffsetMin * MINUTE_MS;
    const workDay = hours.days.includes(p.dow) && !holidays.includes(p.date);
    if (workDay && cursor < close) return Math.max(cursor, open);
    cursor = p.dayStartLocal + DAY_MS - hours.utcOffsetMin * MINUTE_MS; // next local midnight
  }
  return ms;
}

/** Add `durMs` of OPEN time to `startMs` ("24 hours counted in business hours only"). */
export function addBusinessMs(startMs: number, durMs: number, hours: BusinessHours = DEFAULT_HOURS, holidays: string[] = []): number {
  let cursor = nextBusinessOpen(startMs, hours, holidays);
  let remaining = durMs;
  for (let i = 0; i < 1000 && remaining > 0; i++) {
    const p = localParts(cursor, hours);
    const close = p.dayStartLocal + hm(hours.end) * MINUTE_MS - hours.utcOffsetMin * MINUTE_MS;
    const room = close - cursor;
    if (remaining <= room) return cursor + remaining;
    remaining -= room;
    cursor = nextBusinessOpen(close, hours, holidays);
  }
  return cursor;
}

/** First reply due: 24 business hours (urgent: 2). */
export function firstResponseDue(priority: string, fromMs: number, hours: BusinessHours = DEFAULT_HOURS, holidays: string[] = []): number {
  return addBusinessMs(fromMs, (priority === "urgent" ? 2 : 24) * HOUR_MS, hours, holidays);
}

export type SlaState = "ok" | "amber" | "red";
export function slaState(dueAt: number | null, respondedAt: number | null, createdAt: number, now: number): SlaState {
  if (!dueAt || respondedAt) return "ok";
  if (now >= dueAt) return "red";
  const window = Math.max(HOUR_MS, dueAt - createdAt);
  return dueAt - now <= Math.min(6 * HOUR_MS, window * 0.25) ? "amber" : "ok";
}

export const ACK_TEXT = (n: number): string => `Your ticket ${ticketCode(n)} is open. Someone from ${BRAND.name} will respond back soon.`;
export const AFTER_HOURS_TEXT = "Our team works 10 am–7 pm IST, Monday to Saturday. We'll reply within 24 hours.";
export function ackMessage(n: number, now: number, s: SupportSettings): string {
  return isBusinessTime(now, s.hours, s.holidays) ? ACK_TEXT(n) : `${ACK_TEXT(n)} ${AFTER_HOURS_TEXT}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// status rules (pure)
// ---------------------------------------------------------------------------------------------------------------------
export type CustomerMessageAction =
  | { action: "append"; status: Status; reopened: boolean }
  | { action: "new_linked" }           // closed (or solved past the window): open a NEW ticket linked to this one
  | { action: "ignore" };              // spam: dropped

/**
 * What a customer message on an existing ticket does.
 * - waiting -> open; on_hold -> open; new/open stay.
 * - solved <= 7 days -> reopened (open); solved > 7 days (the close job has not run yet) or closed -> a new linked ticket.
 * - trash -> back to new; spam -> ignored.
 */
export function statusOnCustomerMessage(status: string, solvedAt: number | null, now: number): CustomerMessageAction {
  switch (status) {
    case "new": return { action: "append", status: "new", reopened: false };
    case "open": return { action: "append", status: "open", reopened: false };
    case "waiting": case "on_hold": return { action: "append", status: "open", reopened: false };
    case "solved": return solvedAt !== null && now - solvedAt <= REOPEN_WINDOW_MS
      ? { action: "append", status: "open", reopened: true }
      : { action: "new_linked" };
    case "closed": return { action: "new_linked" };
    case "trash": return { action: "append", status: "new", reopened: false };
    case "spam": return { action: "ignore" };
    default: return { action: "append", status: "open", reopened: false };
  }
}

export const canCustomerReopen = (status: string, solvedAt: number | null, now: number): boolean =>
  status === "solved" && solvedAt !== null && now - solvedAt <= REOPEN_WINDOW_MS;

// ---------------------------------------------------------------------------------------------------------------------
// threading
// ---------------------------------------------------------------------------------------------------------------------
export interface ThreadHints { recipients: string[]; subject: string; inReplyTo: string | null; references: string[] }
export type ThreadSource = "recipient" | "subject" | "in_reply_to" | "references";

/** support+10234@domain (any of the recipient addresses). */
export function ticketFromRecipients(recipients: string[]): number | null {
  const local = supportLocalPart();
  const domain = BRAND.domain.toLowerCase();
  for (const raw of recipients) {
    const m = /^([^@+\s]+)\+(\d{4,9})@(.+)$/.exec(raw.trim().toLowerCase().replace(/^<|>$/g, ""));
    if (m && m[1] === local && m[3] === domain) return parseInt(m[2], 10);
  }
  return null;
}

/** "[HF-10234]" anywhere in the subject (Re:/Fwd: and extra tags are fine). */
export function ticketFromSubject(subject: string): number | null {
  // "[HF-10234] ..." on replies, "Ticket HF-10234 received: ..." on the acknowledgement [HF-SUPPORT-ACK-SUBJECT-1]
  const m = /\[HF-(\d{4,9})\]/i.exec(subject) ?? /\bTicket\s+HF-(\d{4,9})\b/i.exec(subject);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Resolve which ticket an inbound mail belongs to: support+N recipient, then [HF-N] in the subject, then In-Reply-To
 * (then References) against stored Message-IDs. `lookupMessageId` is injected so this stays testable without a database.
 */
export async function resolveThread(
  hints: ThreadHints,
  lookupMessageId: (id: string) => Promise<number | null>,
): Promise<{ number: number; source: ThreadSource } | null> {
  const fromRecipient = ticketFromRecipients(hints.recipients);
  if (fromRecipient) return { number: fromRecipient, source: "recipient" };
  const fromSubject = ticketFromSubject(hints.subject);
  if (fromSubject) return { number: fromSubject, source: "subject" };
  if (hints.inReplyTo) {
    const n = await lookupMessageId(hints.inReplyTo);
    if (n) return { number: n, source: "in_reply_to" };
  }
  for (const ref of [...hints.references].reverse()) {
    const n = await lookupMessageId(ref);
    if (n) return { number: n, source: "references" };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// loop / auto-reply / spam detection (pure)
// ---------------------------------------------------------------------------------------------------------------------
const NO_REPLY_LOCAL = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|mailer-daemon|postmaster|bounce[s]?|bounces?\+.*|notifications?|notify|alerts?|automated|auto[-_.]?reply|daemon)$/i;

export function isNoReplyAddress(email: string): boolean {
  const local = email.split("@")[0] ?? "";
  return NO_REPLY_LOCAL.test(local) || /^(bounce|bounces|mailer-daemon|no-?reply)\b/i.test(local);
}

export interface MailClass {
  /** Out-of-office, vacation or any machine-generated reply. */
  autoReply: boolean;
  /** Mailing list / bulk. */
  list: boolean;
  /** Delivery status notification or mail from a daemon / empty return path. */
  bounce: boolean;
  /** Mail we sent ourselves coming back (loop). */
  loop: boolean;
  noReplySender: boolean;
}

export function classifyMail(mail: ParsedMail, envelopeFrom: string | null): MailClass {
  const h = (n: string): string => (mail.headers.get(n)?.[0] ?? "").trim().toLowerCase();
  const autoSubmitted = h("auto-submitted");
  const precedence = h("precedence");
  const from = mail.from?.email ?? envelopeFrom ?? "";
  const contentType = h("content-type");
  const subject = mail.subject.toLowerCase();
  const returnPathEmpty = mail.headers.has("return-path") && /^<\s*>$/.test(h("return-path"));
  const autoReply =
    (autoSubmitted !== "" && autoSubmitted !== "no") ||
    ["auto_reply", "auto-reply", "junk", "bulk"].includes(precedence) ||
    mail.headers.has("x-autoreply") || mail.headers.has("x-autorespond") ||
    (h("x-auto-response-suppress") !== "" && /all|oof|autoreply/.test(h("x-auto-response-suppress"))) ||
    /^(automatic reply|auto(matic)? ?reply|out of office|autoreply|auto-reply)\b/.test(subject);
  const list = mail.headers.has("list-id") || mail.headers.has("list-unsubscribe") || precedence === "list";
  const bounce = returnPathEmpty || /multipart\/report|delivery-status/.test(contentType) ||
    /^(mailer-daemon|postmaster)@/i.test(from) || /^(undeliverable|delivery status notification|mail delivery (failed|subsystem)|returned mail)/.test(subject);
  const ownDomain = BRAND.domain.toLowerCase();
  const loop = mail.headers.has("x-hf-ticket") || mail.headers.has("x-saathum-outbox-key") ||
    from === BRAND.emails.support.toLowerCase() || from === BRAND.emails.noreply.toLowerCase() ||
    (from.endsWith("@" + ownDomain) && /^(support|no-reply|noreply)(\+\d+)?@/.test(from));
  return { autoReply, list, bounce, loop, noReplySender: isNoReplyAddress(from) };
}

/** Whether the mail may be answered automatically (the ack). Spam handled by the caller. */
export const mayAutoReply = (c: MailClass): boolean => !c.autoReply && !c.list && !c.bounce && !c.loop && !c.noReplySender;

const SPAM_WORDS = /\b(viagra|casino|lottery|winner|bitcoin|crypto (investment|giveaway)|loan offer|click here|act now|100% free|earn \$|work from home|seo services|cheap (pills|meds)|nigerian|inheritance|unsubscribe)\b/i;

export interface SpamVerdict { score: number; reasons: string[]; isSpam: boolean }
export const SPAM_THRESHOLD = 5;

/** Spam score from SPF/DKIM/DMARC results, scanner headers and simple content heuristics. >= 5 is spam. */
export function spamScore(mail: ParsedMail): SpamVerdict {
  let score = 0;
  const reasons: string[] = [];
  const add = (n: number, why: string) => { score += n; reasons.push(why); };
  const auth = (mail.headers.get("authentication-results") ?? []).join(" ").toLowerCase();
  if (/\bspf=(fail|softfail)\b/.test(auth)) add(2, "spf_fail");
  if (/\bdkim=fail\b/.test(auth)) add(2, "dkim_fail");
  if (/\bdmarc=fail\b/.test(auth)) add(3, "dmarc_fail");
  const spamStatus = (mail.headers.get("x-spam-status")?.[0] ?? "").toLowerCase();
  const spamFlag = (mail.headers.get("x-spam-flag")?.[0] ?? "").toLowerCase();
  if (spamStatus.startsWith("yes") || spamFlag === "yes") add(5, "scanner_flag");
  const body = `${mail.subject}\n${mail.text}`;
  if (SPAM_WORDS.test(body)) add(2, "spam_words");
  const links = (body.match(/https?:\/\//gi) ?? []).length + (mail.html.match(/<a\s/gi) ?? []).length;
  if (links >= 8) add(2, "many_links");
  else if (links >= 4 && mail.text.trim().length < 200) add(1, "links_short_text");
  const letters = mail.subject.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 12 && letters === letters.toUpperCase()) add(1, "shouting_subject");
  if (!mail.text.trim() && !mail.html.trim() && mail.attachments.length === 0) add(2, "empty");
  if (!mail.from) add(3, "no_from");
  return { score, reasons, isSpam: score >= SPAM_THRESHOLD };
}

// ---------------------------------------------------------------------------------------------------------------------
// D1 helpers
// ---------------------------------------------------------------------------------------------------------------------
export interface TicketRow {
  number: number; uid: string | null; contact_id: number; subject: string; category: string; priority: string; status: string;
  assignee_uid: string | null; channel: string; preview: string; last_customer_at: number | null; last_staff_at: number | null;
  first_response_due_at: number | null; first_responded_at: number | null; waiting_since: number | null; reminder_sent_at: number | null;
  solved_at: number | null; closed_at: number | null; snooze_until: number | null; merged_into: number | null; linked_from: number | null;
  money: number; unread_customer: number; unread_staff: number; last_nudge_at: number | null; meta_json: string | null;
  created_at: number; updated_at: number;
}

export async function getTicket(env: Env, number: number): Promise<TicketRow | null> {
  return (await env.DB_META.prepare("SELECT * FROM support_tickets WHERE number=?1").bind(number).first<TicketRow>()) ?? null;
}

/** Atomic: UPDATE ... RETURNING hands every caller a different number, even concurrently. Never reused. */
export async function allocateTicketNumber(env: Env): Promise<number> {
  const r = await env.DB_META.prepare("UPDATE support_counter SET n=n+1 WHERE id=1 RETURNING n").first<{ n: number }>();
  if (!r || !Number.isFinite(Number(r.n))) throw new Error("support_counter missing: apply 2026-10-29-hf-support-seed.sql");
  return Number(r.n);
}

export async function addEvent(env: Env, number: number, actor: string, type: string, data?: unknown, now = Date.now()): Promise<void> {
  try {
    await env.DB_META.prepare("INSERT INTO support_events (ticket_number,actor,type,data_json,created_at) VALUES (?1,?2,?3,?4,?5)")
      .bind(number, actor, type, data === undefined ? null : JSON.stringify(data).slice(0, 2000), now).run();
  } catch { /* the audit trail never blocks the action */ }
}

export interface ContactInput { email?: string | null; uid?: string | null; name?: string | null; whatsapp?: string | null }

/** Find-or-create the contact. Email and uid both identify; when a guest later verifies, the email row gets the uid. */
export async function upsertContact(env: Env, c: ContactInput, now = Date.now()): Promise<number> {
  const email = c.email ? c.email.trim().toLowerCase() : null;
  const uid = c.uid ?? null;
  let row: { id: number; uid: string | null; email: string | null } | null = null;
  if (uid) row = await env.DB_META.prepare("SELECT id,uid,email FROM support_contacts WHERE uid=?1").bind(uid).first<{ id: number; uid: string | null; email: string | null }>() ?? null;
  if (!row && email) row = await env.DB_META.prepare("SELECT id,uid,email FROM support_contacts WHERE email=?1").bind(email).first<{ id: number; uid: string | null; email: string | null }>() ?? null;
  if (row) {
    await env.DB_META.prepare(
      "UPDATE support_contacts SET uid=COALESCE(uid,?2), email=COALESCE(email,?3), name=COALESCE(NULLIF(name,''),?4), whatsapp=COALESCE(whatsapp,?5) WHERE id=?1",
    ).bind(row.id, row.uid ? null : uid, row.email ? null : email, c.name?.trim() || null, c.whatsapp ?? null).run().catch(() => undefined);
    return row.id;
  }
  const ins = await env.DB_META.prepare("INSERT INTO support_contacts (email,uid,whatsapp,name,created_at) VALUES (?1,?2,?3,?4,?5) RETURNING id")
    .bind(email, uid, c.whatsapp ?? null, c.name?.trim() || null, now).first<{ id: number }>();
  if (!ins) throw new Error("contact insert failed");
  return Number(ins.id);
}

/** An account's email on file for HF (typed at sign-up), used to attach email-borne tickets to the account. */
export async function accountUidForEmail(env: Env, email: string): Promise<string | null> {
  const e = email.trim().toLowerCase();
  try {
    const r = await env.DB_META.prepare("SELECT uid FROM hf_user_email WHERE lower(email)=?1 LIMIT 1").bind(e).first<{ uid: string }>();
    if (r?.uid) return r.uid;
  } catch { /* table may not exist in tests */ }
  try {
    const h = await sha256Hex(e);
    const r = await env.DB_META.prepare("SELECT uid FROM users WHERE email_hash=?1 LIMIT 1").bind(h).first<{ uid: string }>();
    if (r?.uid) return r.uid;
  } catch { /* ignore */ }
  return null;
}

/** All emails that belong to an account's tickets: the contact's plus the one on file. */
export async function emailsOfTicketOwner(env: Env, t: TicketRow): Promise<string[]> {
  const out = new Set<string>();
  const c = await env.DB_META.prepare("SELECT email FROM support_contacts WHERE id=?1").bind(t.contact_id).first<{ email: string | null }>().catch(() => null);
  if (c?.email) out.add(c.email.toLowerCase());
  if (t.uid) {
    try {
      const r = await env.DB_META.prepare("SELECT email FROM hf_user_email WHERE uid=?1").bind(t.uid).first<{ email: string }>();
      if (r?.email) out.add(r.email.toLowerCase());
    } catch { /* ignore */ }
  }
  return [...out];
}

/** Keep the FTS5 index in step. Best-effort: if the FTS table was not applied, search simply falls back to LIKE. */
export async function reindexTicket(env: Env, number: number): Promise<void> {
  try {
    const t = await env.DB_META.prepare(
      `SELECT t.number, t.subject, t.preview, COALESCE(c.email,'') || ' ' || COALESCE(c.name,'') AS contact
         FROM support_tickets t LEFT JOIN support_contacts c ON c.id=t.contact_id WHERE t.number=?1`,
    ).bind(number).first<{ number: number; subject: string; preview: string; contact: string }>();
    await env.DB_META.prepare("DELETE FROM support_fts WHERE number=?1").bind(number).run();
    if (t) await env.DB_META.prepare("INSERT INTO support_fts (number,subject,preview,contact) VALUES (?1,?2,?3,?4)").bind(t.number, t.subject, t.preview, t.contact).run();
  } catch { /* no FTS5 table: LIKE search is the fallback */ }
}

export interface StatusPatch { status: Status; now: number; actor: string }

/** Move a ticket to a status with the right timestamps. Returns false if it was already there. */
export async function setTicketStatus(env: Env, t: Pick<TicketRow, "number" | "status">, to: Status, actor: string, now = Date.now()): Promise<boolean> {
  if (t.status === to) return false;
  const sets: string[] = ["status=?2", "updated_at=?3"];
  if (to === "solved") sets.push("solved_at=?3");
  if (to === "closed") sets.push("closed_at=?3");
  if (to === "waiting") sets.push("waiting_since=?3", "reminder_sent_at=NULL");
  if (to !== "waiting") sets.push("waiting_since=NULL");
  if (to === "open" || to === "new" || to === "on_hold") sets.push("solved_at=NULL", "closed_at=NULL");
  if (to !== "on_hold") sets.push("snooze_until=NULL");
  await env.DB_META.prepare(`UPDATE support_tickets SET ${sets.join(",")} WHERE number=?1`).bind(t.number, to, now).run();
  await addEvent(env, t.number, actor, "status", { from: t.status, to }, now);
  return true;
}

// ---------------------------------------------------------------------------------------------------------------------
// staff and roles
// ---------------------------------------------------------------------------------------------------------------------
export type StaffRole = "admin" | "agent" | "viewer";
export interface StaffCtx { uid: string; role: StaffRole; email: string | null; name: string | null }

const STAFF_MEMO_MS = 60_000;
const STAFF_MEMO = new Map<string, { at: number; staff: StaffCtx | null }>();
export function clearStaffMemo(): void { STAFF_MEMO.clear(); }

/**
 * Who is this signed-in account on the desk? 1) a support_staff row for the uid, 2) an existing isAdminUid admin,
 * 3) a support_staff row matching the account's VERIFIED email (the owner's seed row), which gets the uid stored.
 * null = not staff. Memoised 60 s per isolate so a customer hitting an admin URL costs one lookup, not one per call.
 */
export async function resolveStaff(env: Env, uid: string): Promise<StaffCtx | null> {
  if (!uid) return null;
  const hit = STAFF_MEMO.get(uid);
  if (hit && Date.now() - hit.at < STAFF_MEMO_MS) return hit.staff;
  let staff: StaffCtx | null = null;
  try {
    const row = await env.DB_META.prepare("SELECT email,uid,name,role FROM support_staff WHERE uid=?1").bind(uid).first<{ email: string; uid: string; name: string | null; role: string }>();
    if (row) staff = { uid, role: normaliseRole(row.role), email: row.email, name: row.name };
    else if (isAdminUid(env, uid)) staff = { uid, role: "admin", email: null, name: null };
    else {
      const email = (await primaryVerifiedEmailFor(env, uid).catch(() => null))?.toLowerCase() ?? null;
      if (email) {
        const byEmail = await env.DB_META.prepare("SELECT email,uid,name,role FROM support_staff WHERE email=?1 AND (uid IS NULL OR uid=?2)").bind(email, uid).first<{ email: string; uid: string | null; name: string | null; role: string }>();
        if (byEmail) {
          if (!byEmail.uid) await env.DB_META.prepare("UPDATE support_staff SET uid=?2 WHERE email=?1 AND uid IS NULL").bind(email, uid).run().catch(() => undefined);
          staff = { uid, role: normaliseRole(byEmail.role), email, name: byEmail.name };
        }
      }
    }
  } catch { staff = isAdminUid(env, uid) ? { uid, role: "admin", email: null, name: null } : null; }
  if (STAFF_MEMO.size > 500) STAFF_MEMO.clear();
  STAFF_MEMO.set(uid, { at: Date.now(), staff });
  return staff;
}
const normaliseRole = (r: string): StaffRole => (r === "admin" || r === "agent" || r === "viewer" ? r : "viewer");
export const canWrite = (s: StaffCtx): boolean => s.role === "admin" || s.role === "agent";
export const isDeskAdmin = (s: StaffCtx): boolean => s.role === "admin";
