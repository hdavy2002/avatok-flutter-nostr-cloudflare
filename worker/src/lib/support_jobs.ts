// [HF-SUPPORT-1] Support background jobs. Run from the existing scheduled() handler (the */5 cron; there is no every-minute
// trigger and one must not be added, see wrangler.toml [triggers]), each step isolated so one failure never stops the rest:
//   - re-queue inbound mail whose queue send was lost; flush the admin-alert summaries
//   - un-snooze; waiting reminder after 5 days, then solved 7 days later; solved -> closed after 7 days
//   - SLA due dates re-computed when business hours / holidays change
//   - nightly (once per IST day, after 02:00 IST): retention (3 years, 8 for money categories) deleting rows AND R2 objects,
//     orphan upload sweep, small-table tidy
//   - email-outbox/ R2 body sweep: bodies older than 90 days whose outbox row is provider_accepted/delivered/failed/bounced
//     (the known gap left by SUPPORT-QUEUE-1)
import type { Env } from "../types";
import {
  addEvent, DAY_MS, firstResponseDue, HOUR_MS, loadSettings, getSetting, setSetting, RETENTION_MONEY_MS, RETENTION_NORMAL_MS, setTicketStatus,
  SOLVED_TO_CLOSED_MS, sha256Hex, WAITING_REMINDER_MS, WAITING_TO_SOLVED_MS, ticketCode, SUPPORT_R2_PREFIX, type TicketRow,
} from "./support_core";
import { recoverInbound } from "./support_inbound";
import { flushAlertSummaries } from "./support_alerts";
import { recipientEmailFor, sendWaitingReminder } from "./support_mail";
import { addMessage } from "./support_ops";
import { BRAND } from "./brand";

export const OUTBOX_RETENTION_MS = 90 * DAY_MS;
const IST_MS = 330 * 60_000;

export interface SupportJobsResult {
  inboundRequeued: number; summaries: number; unsnoozed: number; reminders: number; autoSolved: number; autoClosed: number; slaRecomputed: number;
  retention: { tickets: number; r2: number } | null; outboxSwept: number | null; errors: string[];
}

async function step<T>(res: SupportJobsResult, name: string, fn: () => Promise<T>): Promise<T | null> {
  try { return await fn(); } catch (e) { res.errors.push(`${name}:${String(e).slice(0, 160)}`); console.error(`[support-jobs] ${name} failed:`, String(e)); return null; }
}

export async function runSupportJobs(env: Env, now = Date.now()): Promise<SupportJobsResult> {
  const res: SupportJobsResult = { inboundRequeued: 0, summaries: 0, unsnoozed: 0, reminders: 0, autoSolved: 0, autoClosed: 0, slaRecomputed: 0, retention: null, outboxSwept: null, errors: [] };
  res.inboundRequeued = (await step(res, "inbound-recover", () => recoverInbound(env, 50, now))) ?? 0;
  res.summaries = (await step(res, "alert-summaries", () => flushAlertSummaries(env, now))) ?? 0;
  res.unsnoozed = (await step(res, "unsnooze", () => unsnoozeDue(env, now))) ?? 0;
  res.reminders = (await step(res, "waiting-reminder", () => sendWaitingReminders(env, now))) ?? 0;
  res.autoSolved = (await step(res, "waiting-to-solved", () => solveStaleWaiting(env, now))) ?? 0;
  res.autoClosed = (await step(res, "solved-to-closed", () => closeSolved(env, now))) ?? 0;
  res.slaRecomputed = (await step(res, "sla", () => recomputeSla(env, now))) ?? 0;

  // nightly work: once per IST day, from 02:00 IST
  const istNow = new Date(now + IST_MS);
  const day = istNow.toISOString().slice(0, 10);
  if (istNow.getUTCHours() >= 2) {
    if ((await getSetting(env, "retention_last_day")) !== day) {
      const r = await step(res, "retention", () => runRetention(env, now));
      if (r) { res.retention = r; if (r.done) await setSetting(env, "retention_last_day", day); }
    }
    res.outboxSwept = await step(res, "outbox-sweep", () => sweepEmailOutboxBodies(env, day, now));
  }
  return res;
}

// ---------------------------------------------------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------------------------------------------------
export async function unsnoozeDue(env: Env, now: number): Promise<number> {
  const rows = (await env.DB_META.prepare("SELECT * FROM support_tickets WHERE status='on_hold' AND snooze_until IS NOT NULL AND snooze_until<=?1 LIMIT 200").bind(now).all<TicketRow>()).results ?? [];
  for (const t of rows) {
    await setTicketStatus(env, t, "open", "system", now);
    await env.DB_META.prepare("UPDATE support_tickets SET snooze_until=NULL,unread_staff=1 WHERE number=?1").bind(t.number).run();
    await addEvent(env, t.number, "system", "unsnoozed", null, now);
  }
  return rows.length;
}

/** Waiting 5 days with no answer: one reminder email (bulk lane). reminder_sent_at is set even when there is no address, so the 7-day clock still runs. */
export async function sendWaitingReminders(env: Env, now: number): Promise<number> {
  const rows = (await env.DB_META.prepare(
    "SELECT * FROM support_tickets WHERE status='waiting' AND reminder_sent_at IS NULL AND waiting_since IS NOT NULL AND waiting_since<=?1 LIMIT 100",
  ).bind(now - WAITING_REMINDER_MS).all<TicketRow>()).results ?? [];
  let sent = 0;
  for (const t of rows) {
    const claim = await env.DB_META.prepare("UPDATE support_tickets SET reminder_sent_at=?2 WHERE number=?1 AND reminder_sent_at IS NULL AND status='waiting'").bind(t.number, now).run();
    if ((claim.meta?.changes ?? 0) === 0) continue;
    const to = await recipientEmailFor(env, t).catch(() => null);
    if (to) { await sendWaitingReminder(env, t, to).catch(() => null); sent++; }
    await addEvent(env, t.number, "system", "reminder", { email: !!to }, now);
  }
  return sent;
}

/** 7 days after the reminder with no reply: solved (the customer can still reopen for 7 days). */
export async function solveStaleWaiting(env: Env, now: number): Promise<number> {
  const rows = (await env.DB_META.prepare(
    "SELECT * FROM support_tickets WHERE status='waiting' AND reminder_sent_at IS NOT NULL AND reminder_sent_at<=?1 LIMIT 100",
  ).bind(now - WAITING_TO_SOLVED_MS).all<TicketRow>()).results ?? [];
  for (const t of rows) {
    await setTicketStatus(env, t, "solved", "system", now);
    await addMessage(env, t.number, { authorType: "system", authorName: BRAND.name, text: `We have not heard back, so ${ticketCode(t.number)} was marked solved. Reply within 7 days to reopen it.`, now });
    await env.DB_META.prepare("UPDATE support_tickets SET unread_customer=1 WHERE number=?1").bind(t.number).run();
  }
  return rows.length;
}

export async function closeSolved(env: Env, now: number): Promise<number> {
  const rows = (await env.DB_META.prepare("SELECT * FROM support_tickets WHERE status='solved' AND solved_at IS NOT NULL AND solved_at<=?1 LIMIT 200").bind(now - SOLVED_TO_CLOSED_MS).all<TicketRow>()).results ?? [];
  for (const t of rows) await setTicketStatus(env, t, "closed", "system", now);
  return rows.length;
}

/** Re-compute first-response due dates when business hours/holidays change (hash gate), and fill any that are missing. */
export async function recomputeSla(env: Env, now: number): Promise<number> {
  const s = await loadSettings(env);
  const hash = (await sha256Hex(JSON.stringify([s.hours, s.holidays]))).slice(0, 16);
  const stored = await getSetting(env, "sla_hash");
  const rows = (await env.DB_META.prepare(
    `SELECT number,priority,created_at,first_response_due_at FROM support_tickets
      WHERE first_responded_at IS NULL AND status IN ('new','open','on_hold') AND (first_response_due_at IS NULL OR ?1<>?2) LIMIT 2000`,
  ).bind(stored ?? "", hash).all<{ number: number; priority: string; created_at: number; first_response_due_at: number | null }>()).results ?? [];
  let changed = 0;
  for (const r of rows) {
    const due = firstResponseDue(r.priority, r.created_at, s.hours, s.holidays);
    if (due !== r.first_response_due_at) {
      await env.DB_META.prepare("UPDATE support_tickets SET first_response_due_at=?2 WHERE number=?1").bind(r.number, due).run();
      changed++;
    }
  }
  if (stored !== hash && rows.length < 2000) await setSetting(env, "sla_hash", hash);
  void now;
  return changed;
}

// ---------------------------------------------------------------------------------------------------------------------
// retention
// ---------------------------------------------------------------------------------------------------------------------
async function deleteR2Prefix(bucket: R2Bucket, prefix: string): Promise<number> {
  let cursor: string | undefined, count = 0;
  do {
    const list = await bucket.list({ prefix, cursor, limit: 1000 });
    const keys = list.objects.map((o) => o.key);
    if (keys.length) { await bucket.delete(keys); count += keys.length; }
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  return count;
}

/** Delete tickets (rows + R2 objects). R2 first: if it fails the rows stay so the next night retries. */
export async function purgeTickets(env: Env, numbers: number[]): Promise<{ tickets: number; r2: number }> {
  let r2 = 0, tickets = 0;
  for (const number of numbers) {
    try {
      r2 += await deleteR2Prefix(env.BACKUP_R2, `${SUPPORT_R2_PREFIX}att/${number}/`);
      r2 += await deleteR2Prefix(env.BACKUP_R2, `${SUPPORT_R2_PREFIX}html/${number}/`);
      const raws = (await env.DB_META.prepare("SELECT DISTINCT raw_r2_key AS k FROM support_messages WHERE ticket_number=?1 AND raw_r2_key IS NOT NULL").bind(number).all<{ k: string }>()).results ?? [];
      const keys = raws.map((x) => x.k).filter((k) => k.startsWith(`${SUPPORT_R2_PREFIX}inbound/`));
      if (keys.length) { await env.BACKUP_R2.delete(keys); r2 += keys.length; }
      await env.DB_META.batch([
        env.DB_META.prepare("DELETE FROM support_inbound WHERE ticket_number=?1").bind(number),
        env.DB_META.prepare("DELETE FROM support_attachments WHERE ticket_number=?1").bind(number),
        env.DB_META.prepare("DELETE FROM support_messages WHERE ticket_number=?1").bind(number),
        env.DB_META.prepare("DELETE FROM support_events WHERE ticket_number=?1").bind(number),
        env.DB_META.prepare("DELETE FROM support_viewers WHERE ticket_number=?1").bind(number),
        env.DB_META.prepare("DELETE FROM support_tickets WHERE number=?1").bind(number),
      ]);
      await env.DB_META.prepare("DELETE FROM support_fts WHERE number=?1").bind(number).run().catch(() => undefined);
      tickets++;
    } catch (e) { console.error(`[support-retention] ${number} kept for retry:`, String(e)); }
  }
  return { tickets, r2 };
}

/** 3 years (8 for money categories) after the last activity, for finished tickets only. Bounded per night; reports done=false to continue next tick. */
export async function runRetention(env: Env, now: number): Promise<{ tickets: number; r2: number; done: boolean }> {
  const rows = (await env.DB_META.prepare(
    `SELECT number FROM support_tickets
      WHERE status IN ('closed','solved','spam','trash')
        AND ((money=0 AND updated_at<?1) OR (money=1 AND updated_at<?2)) ORDER BY updated_at LIMIT 100`,
  ).bind(now - RETENTION_NORMAL_MS, now - RETENTION_MONEY_MS).all<{ number: number }>()).results ?? [];
  const out = await purgeTickets(env, rows.map((r) => r.number));
  // contacts nobody refers to any more
  await env.DB_META.prepare("DELETE FROM support_contacts WHERE id NOT IN (SELECT DISTINCT contact_id FROM support_tickets)").run().catch(() => undefined);
  // dropped / duplicate / spam inbound mail that never became a ticket: the .eml goes after 30 days
  const stale = (await env.DB_META.prepare("SELECT id,r2_key FROM support_inbound WHERE ticket_number IS NULL AND status IN ('dropped','duplicate','spam','failed') AND created_at<?1 LIMIT 200").bind(now - 30 * DAY_MS).all<{ id: string; r2_key: string }>()).results ?? [];
  if (stale.length) {
    await env.BACKUP_R2.delete(stale.map((x) => x.r2_key));
    for (const s of stale) await env.DB_META.prepare("DELETE FROM support_inbound WHERE id=?1").bind(s.id).run();
    out.r2 += stale.length;
  }
  // uploads that never became part of a message, and tidy tables
  const orphans = (await env.DB_META.prepare("SELECT id,r2_key FROM support_attachments WHERE ticket_number IS NULL AND purpose='ticket' AND created_at<?1 LIMIT 200").bind(now - DAY_MS).all<{ id: string; r2_key: string }>()).results ?? [];
  if (orphans.length) {
    await env.BACKUP_R2.delete(orphans.map((x) => x.r2_key));
    for (const o of orphans) await env.DB_META.prepare("DELETE FROM support_attachments WHERE id=?1").bind(o.id).run();
    out.r2 += orphans.length;
  }
  await env.DB_META.prepare("DELETE FROM support_autoreply_log WHERE created_at<?1").bind(now - 2 * DAY_MS).run().catch(() => undefined);
  await env.DB_META.prepare("DELETE FROM support_viewers WHERE seen_at<?1").bind(now - HOUR_MS).run().catch(() => undefined);
  return { tickets: out.tickets, r2: out.r2, done: rows.length < 100 && stale.length < 200 && orphans.length < 200 };
}

// ---------------------------------------------------------------------------------------------------------------------
// email-outbox/ R2 bodies (SUPPORT-QUEUE-1 gap)
// ---------------------------------------------------------------------------------------------------------------------
const OUTBOX_DONE = new Set(["provider_accepted", "delivered", "failed", "bounced"]);

/**
 * Walk email-outbox/YYYY/MM/DD/<outboxId>/... in key order (= date order) and delete bodies older than 90 days whose row is in a final state
 * (or has no row at all). Resumable: the cursor is kept in support_settings.outbox_sweep so each cron tick does a bounded slice; a new IST day starts over.
 * Returns objects deleted this tick, or null when today's sweep already finished.
 */
export async function sweepEmailOutboxBodies(env: Env, day: string, now: number, budget = 1000): Promise<number | null> {
  const raw = await getSetting(env, "outbox_sweep");
  let state: { day: string; cursor: string | null; done: boolean } = { day, cursor: null, done: false };
  try { const parsed = raw ? JSON.parse(raw) : null; if (parsed && parsed.day === day) state = parsed; } catch { /* start over */ }
  if (state.done) return null;
  const cutoff = new Date(now - OUTBOX_RETENTION_MS).toISOString().slice(0, 10).replace(/-/g, "/"); // YYYY/MM/DD
  let deleted = 0, seen = 0;
  let cursor: string | undefined = state.cursor ?? undefined;
  let finished = false;
  while (seen < budget) {
    const list = await env.BACKUP_R2.list({ prefix: "email-outbox/", cursor, limit: 200 });
    const doomed: string[] = [];
    for (const obj of list.objects) {
      seen++;
      const m = /^email-outbox\/(\d{4}\/\d{2}\/\d{2})\/([^/]+)\//.exec(obj.key);
      if (!m) continue;
      if (m[1] >= cutoff) { finished = true; break; } // keys are date-ordered: everything after this is newer than 90 days
      const row = await env.DB_META.prepare("SELECT delivery_status FROM email_outbox WHERE outbox_id=?1").bind(m[2]).first<{ delivery_status: string | null }>().catch(() => undefined);
      if (row === undefined) continue;        // lookup failed: leave it
      if (row === null || OUTBOX_DONE.has(String(row.delivery_status))) doomed.push(obj.key);
    }
    if (doomed.length) { await env.BACKUP_R2.delete(doomed); deleted += doomed.length; }
    if (finished || !list.truncated) { finished = true; break; }
    cursor = list.cursor;
  }
  await setSetting(env, "outbox_sweep", JSON.stringify({ day, cursor: finished ? null : (cursor ?? null), done: finished }));
  return deleted;
}
