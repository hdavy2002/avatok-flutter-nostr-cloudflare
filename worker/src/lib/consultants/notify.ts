// [AUMFE-CONSULT-W3-1 2026-10-02] Real Consultants — WhatsApp + email to customer / consultant / admin.
// Confirmed, day-before, 15-minute, thank-you (with review link), review-approved. Every send is idempotent through the
// booking's *_sent_at columns (claimed with a guarded UPDATE first; only the thank-you is released again when no channel worked). Copy is built by small pure functions (notify.test.ts). Brand name and links come from BRAND / brandUrl.
import type { Env } from "../../types";
import { metaDb } from "../../db/shard";
import { track, trackException } from "../../hooks";
import { BRAND, brandUrl } from "../brand";
import { sendWhatsAppText } from "../whatsapp_send";
import { formatIst, verifiedWhatsAppNumber } from "../whatsapp_notify";
import { enqueueEmail, verifiedClerkEmail } from "../email_outbox";
import { emailFor, phoneFor } from "../identity";
import { sendAdminAlert } from "../saathum_upi3";
import { escapeHtml } from "../../cal/emails";
import { buildIcs, icsB64 } from "../../cal/ics";
import { consultantById, type ConsultantRow } from "./store";
import { DISCIPLINE_LABEL, type Discipline } from "./types";

const APP = "aumfe_consult";
const WA_PACE_MS = 1500; // WasenderAPI is an unofficial gateway: never burst

export interface BookingRow {
  id: string; ref: string; consultant_id: string; uid: string; discipline: Discipline;
  slot_start_ms: number; slot_end_ms: number; status: string;
  rate_rupees: number; total_rupees: number; fee_rupees: number; payout_rupees: number;
  intake_json: string; questions_json: string; confirmed_at: number | null;
  call_started_at: number | null; call_ended_at: number | null; customer_seconds: number; consultant_seconds: number;
  consultant_joined_at: number | null; customer_joined_at: number | null;
  settled_at: number | null; settle_outcome: string | null;
  confirm_sent_at: number | null; reminded_day_at: number | null; reminded_15_at: number | null; thanks_sent_at: number | null;
  review_token: string | null;
}

// ---------------------------------------------------------------- pure helpers + copy
const clean = (s: unknown, max = 40): string => String(s ?? "").replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** The customer's own name out of the stored intake (each discipline keeps it in a different place). */
export function customerNameFromIntake(intakeJson: string | null | undefined): string | null {
  try {
    const i = JSON.parse(String(intakeJson || "{}")) as Record<string, any>;
    const n = clean(i?.birth?.name ?? i?.birth_name ?? i?.name ?? "", 60);
    return n || null;
  } catch { return null; }
}
export const firstNameOf = (full: string | null): string => { const p = clean(full).split(" ")[0]; return p ? p[0].toUpperCase() + p.slice(1) : ""; };
/** "Firstname L." or the first name alone; never the full name. */
export function reviewDisplayName(full: string | null, firstOnly: boolean): string {
  const parts = clean(full).split(" ").filter(Boolean);
  if (!parts.length) return "A customer";
  const first = firstNameOf(full);
  if (firstOnly || parts.length === 1) return first;
  return `${first} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

export const joinUrlFor = (bookingId: string): string => brandUrl("/guides/session/" + bookingId);
export const deskUrlFor = (bookingId: string): string => brandUrl("/desk/bookings/" + bookingId);
export const reviewUrlFor = (token: string): string => brandUrl("/guides/review/" + token);

export const discLabel = (d: Discipline | string): string => (DISCIPLINE_LABEL as Record<string, { en: string }>)[d]?.en ?? String(d);
const hello = (name: string): string => (name ? `Namaste ${name}!` : "Namaste!");

export function confirmedCustomerText(a: { name: string; consultant: string; discipline: string; when: string; joinUrl: string; ref: string }): string {
  return `${hello(a.name)} Your ${a.discipline} session with ${a.consultant} is confirmed for ${a.when}.\n\nJoin here (opens 10 minutes early):\n${a.joinUrl}\n\nBooking ${a.ref}. We look forward to seeing you.\n— ${BRAND.name}`;
}
export function confirmedConsultantText(a: { customer: string; discipline: string; when: string; deskUrl: string; ref: string }): string {
  return `${hello("")} New booking: ${a.customer || "a customer"} for ${a.discipline} on ${a.when}.\n\nTheir file will be ready on your desk:\n${a.deskUrl}\n\nBooking ${a.ref}.\n— ${BRAND.name}`;
}
export function confirmedAdminText(a: { ref: string; consultant: string; discipline: string; when: string; total: number }): string {
  return `${BRAND.name}: new consultation ${a.ref} — ${a.discipline} with ${a.consultant}, ${a.when}. Paid ₹${a.total}.`;
}
export function reminderText(a: { kind: "day" | "15"; role: "customer" | "consultant"; name: string; other: string; discipline: string; when: string; url: string }): string {
  const lead = a.kind === "day" ? "Tomorrow" : "In about 15 minutes";
  if (a.role === "customer") {
    return `${hello(a.name)} ${lead}: your ${a.discipline} session with ${a.other} (${a.when}).\n\n${a.kind === "15" ? "Join now" : "Your join link"}:\n${a.url}\n— ${BRAND.name}`;
  }
  return `${hello("")} ${lead}: ${a.discipline} session with ${a.other || "your customer"} (${a.when}).\n\nOpen the desk:\n${a.url}\n— ${BRAND.name}`;
}
export function thanksText(a: { name: string; consultant: string; reviewUrl: string }): string {
  return `${hello(a.name)} Thank you for your session with ${a.consultant}. We hope it brought you clarity.\n\nIf you have a minute, a short review helps others find the right guide:\n${a.reviewUrl}\n— ${BRAND.name}`;
}
export function reviewApprovedText(a: { who: string; stars: number }): string {
  return `${hello("")} A ${a.stars}-star review from ${a.who} is now live on your page. Thank you for the good work.\n— ${BRAND.name}`;
}
export function noShowConsultantAdminText(a: { ref: string; consultant: string; when: string; total: number }): string {
  return `${BRAND.name}: CONSULTANT NO-SHOW ${a.ref} — ${a.consultant} did not join the ${a.when} session. Customer paid ₹${a.total}. No automatic refund: please refund by hand and call the consultant. Strike added.`;
}
export function reviewNeededAdminText(a: { ref: string; consultant: string; when: string; seconds: number }): string {
  return `${BRAND.name}: consultation ${a.ref} (${a.consultant}, ${a.when}) had both people join but only ${Math.round(a.seconds / 60)} min together. Nobody was paid or struck — please review it.`;
}
export function moneyPendingAdminText(a: { ref: string; consultant: string; payout: number }): string {
  return `${BRAND.name}: ${a.consultant} completed ${a.ref} but has no linked account, so ₹${a.payout} could not be credited. Please attach an account or pay by hand.`;
}

function shell(title: string, lines: string[], cta?: { label: string; url: string }): string {
  return `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px">
<h2 style="margin:0 0 12px">${escapeHtml(title)}</h2>
${lines.map((l) => `<p style="margin:0 0 10px;line-height:1.5">${escapeHtml(l)}</p>`).join("\n")}
${cta ? `<p style="margin:20px 0"><a href="${escapeHtml(cta.url)}" style="background:#08C4C4;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">${escapeHtml(cta.label)}</a></p>` : ""}
<p style="color:#777;font-size:13px;margin-top:20px">${escapeHtml(BRAND.name)} · times in IST</p></div>`;
}
export const emailHtml = shell;

// ---------------------------------------------------------------- senders
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waSend(env: Env, uid: string, e164: string | null, kind: string, text: string): Promise<boolean> {
  if (!e164) { void track(env, uid, "consult_notify", APP, { kind, channel: "whatsapp", ok: false, reason: "no_number" }); return false; }
  const r = await sendWhatsAppText(env, e164, text);
  void track(env, uid, "consult_notify", APP, { kind, channel: "whatsapp", ok: r.ok, ...(r.ok ? {} : { reason: r.reason }) });
  if (!r.ok && r.reason === "provider_error") await trackException(env, new Error(`consult_wa_failed:${r.detail}`), { uid, route: "consult.notify", handled: true, app_name: APP });
  return r.ok;
}
async function mailSend(env: Env, uid: string, to: string | null, kind: string, key: string, subject: string, html: string, ics?: { name: string; content: string }): Promise<boolean> {
  if (!to) { void track(env, uid, "consult_notify", APP, { kind, channel: "email", ok: false, reason: "no_email" }); return false; }
  try {
    const r = await enqueueEmail(env, {
      to, subject, html, outboxKey: key, kind: "consult_email", recipientId: uid,
      ...(ics ? { attachments: [ics] } : {}),
    });
    const ok = r.status !== "failed" && r.status !== "unavailable";
    void track(env, uid, "consult_notify", APP, { kind, channel: "email", ok });
    return ok;
  } catch (e) {
    await trackException(env, e, { uid, route: "consult.notify.email", handled: true, app_name: APP });
    void track(env, uid, "consult_notify", APP, { kind, channel: "email", ok: false, reason: "exception" });
    return false;
  }
}

type Col = "confirm_sent_at" | "reminded_day_at" | "reminded_15_at" | "thanks_sent_at";
async function claim(env: Env, id: string, col: Col): Promise<boolean> {
  const r = await metaDb(env).prepare(`UPDATE consult_bookings SET ${col} = ?2 WHERE id = ?1 AND ${col} IS NULL`).bind(id, Date.now()).run();
  return Number(r.meta?.changes ?? 0) === 1;
}
async function release(env: Env, id: string, col: Col): Promise<void> {
  try { await metaDb(env).prepare(`UPDATE consult_bookings SET ${col} = NULL WHERE id = ?1`).bind(id).run(); } catch { /* cron will see it as sent; acceptable */ }
}

interface Ctx { b: BookingRow; c: ConsultantRow; custName: string; custWa: string | null; custEmail: string | null; conWa: string | null; conEmail: string | null }
async function loadCtx(env: Env, id: string): Promise<Ctx | null> {
  const b = await metaDb(env).prepare("SELECT * FROM consult_bookings WHERE id = ?1").bind(id).first<BookingRow>();
  if (!b) return null;
  const c = await consultantById(env, b.consultant_id);
  if (!c) return null;
  const [custWa, custEmail, conWa, conEmail] = await Promise.all([
    verifiedWhatsAppNumber(env, b.uid).catch(() => null),
    verifiedClerkEmail(env, b.uid).catch(() => null),
    c.uid ? verifiedWhatsAppNumber(env, c.uid).then((v) => v ?? phoneFor(env, c.uid!)).catch(() => null) : Promise.resolve(null),
    c.uid ? emailFor(env, c.uid).catch(() => null) : Promise.resolve(null),
  ]);
  return { b, c, custName: firstNameOf(customerNameFromIntake(b.intake_json)), custWa, custEmail, conWa, conEmail };
}

/** Payment confirmed (called by W1 via waitUntil + retried by cron). Idempotent through confirm_sent_at. */
export async function notifyBookingConfirmed(env: Env, bookingId: string): Promise<void> {
  try {
    const x = await loadCtx(env, bookingId);
    if (!x || !(await claim(env, bookingId, "confirm_sent_at"))) return;
    const { b, c } = x;
    const when = formatIst(b.slot_start_ms), disc = discLabel(b.discipline);
    const join = joinUrlFor(b.id);
    const ics = icsB64(buildIcs({ uid: `consult-${b.id}`, title: `${disc} with ${c.name}`, start: b.slot_start_ms, end: b.slot_end_ms, url: join, description: `${BRAND.name} booking ${b.ref}` }));
    const res: boolean[] = [];
    res.push(await waSend(env, b.uid, x.custWa, "confirmed_customer", confirmedCustomerText({ name: x.custName, consultant: c.name, discipline: disc, when, joinUrl: join, ref: b.ref })));
    res.push(await mailSend(env, b.uid, x.custEmail, "confirmed_customer", `consult:${b.id}:confirmed:customer`,
      `Your ${disc} session is confirmed`, shell("Your session is confirmed", [`${disc} with ${c.name}`, when, `Booking ${b.ref}`, "The join link opens 10 minutes before your time."], { label: "Open your session", url: join }),
      { name: `${b.ref}.ics`, content: ics }));
    await sleep(WA_PACE_MS);
    if (c.uid) {
      const desk = deskUrlFor(b.id);
      await waSend(env, c.uid, x.conWa, "confirmed_consultant", confirmedConsultantText({ customer: x.custName, discipline: disc, when, deskUrl: desk, ref: b.ref }));
      await mailSend(env, c.uid, x.conEmail, "confirmed_consultant", `consult:${b.id}:confirmed:consultant`,
        `New booking: ${disc}, ${when}`, shell("New booking", [`${x.custName || "A customer"} · ${disc}`, when, `Booking ${b.ref}`], { label: "Open on your desk", url: desk }));
      await sleep(WA_PACE_MS);
    }
    await sendAdminAlert(env, confirmedAdminText({ ref: b.ref, consultant: c.name, discipline: disc, when, total: b.total_rupees }));
    // A customer who cannot be reached is logged (consult_notify ok=false); no retry loop, so the consultant/admin never get duplicates.
    void res;
  } catch (e) {
    await trackException(env, e, { route: "consult.notifyConfirmed", handled: true, app_name: APP, extra: { booking: bookingId } });
  }
}

async function sendReminder(env: Env, id: string, kind: "day" | "15"): Promise<boolean> {
  const col: Col = kind === "day" ? "reminded_day_at" : "reminded_15_at";
  const x = await loadCtx(env, id);
  if (!x || !(await claim(env, id, col))) return false;
  const { b, c } = x;
  const when = formatIst(b.slot_start_ms), disc = discLabel(b.discipline);
  const ok: boolean[] = [];
  ok.push(await waSend(env, b.uid, x.custWa, `remind_${kind}_customer`, reminderText({ kind, role: "customer", name: x.custName, other: c.name, discipline: disc, when, url: joinUrlFor(b.id) })));
  if (kind === "day") {
    ok.push(await mailSend(env, b.uid, x.custEmail, "remind_day_customer", `consult:${b.id}:remind_day:customer`,
      `Tomorrow: your ${disc} session`, shell("See you tomorrow", [`${disc} with ${c.name}`, when], { label: "Your join link", url: joinUrlFor(b.id) })));
  }
  await sleep(WA_PACE_MS);
  if (c.uid) {
    await waSend(env, c.uid, x.conWa, `remind_${kind}_consultant`, reminderText({ kind, role: "consultant", name: "", other: x.custName, discipline: disc, when, url: deskUrlFor(b.id) }));
    if (kind === "day") {
      await mailSend(env, c.uid, x.conEmail, "remind_day_consultant", `consult:${b.id}:remind_day:consultant`,
        `Tomorrow: ${disc} session`, shell("Session tomorrow", [`${x.custName || "A customer"} · ${disc}`, when], { label: "Open on your desk", url: deskUrlFor(b.id) }));
    }
    await sleep(WA_PACE_MS);
  }
  void ok; // unreachable customer is logged by waSend/mailSend; never re-sent (the consultant would get duplicates)
  return true;
}

/** Thank-you with the review link (completed sessions only). */
export async function sendThanks(env: Env, bookingId: string): Promise<boolean> {
  const x = await loadCtx(env, bookingId);
  if (!x || x.b.status !== "completed" || !x.b.review_token || !(await claim(env, bookingId, "thanks_sent_at"))) return false;
  const { b, c } = x;
  const url = reviewUrlFor(b.review_token!);
  const ok: boolean[] = [];
  ok.push(await waSend(env, b.uid, x.custWa, "thanks", thanksText({ name: x.custName, consultant: c.name, reviewUrl: url })));
  ok.push(await mailSend(env, b.uid, x.custEmail, "thanks", `consult:${b.id}:thanks`, `Thank you for your session with ${c.name}`,
    shell("Thank you", [`We hope your session with ${c.name} brought you clarity.`, "A short review helps others find the right guide."], { label: "Leave a review", url })));
  if (!ok.some(Boolean)) await release(env, bookingId, "thanks_sent_at");
  return true;
}

/** Lane W4 calls this when an admin approves a review: tells the consultant. */
export async function notifyReviewApproved(env: Env, reviewId: string): Promise<void> {
  try {
    const r = await metaDb(env).prepare("SELECT consultant_id, stars, display_name, seed FROM consult_reviews WHERE id = ?1").bind(reviewId).first<{ consultant_id: string; stars: number; display_name: string; seed: number }>();
    if (!r || r.seed) return;
    const c = await consultantById(env, r.consultant_id);
    if (!c?.uid) return;
    const [wa, mail] = await Promise.all([
      verifiedWhatsAppNumber(env, c.uid).then((v) => v ?? phoneFor(env, c.uid!)).catch(() => null),
      emailFor(env, c.uid).catch(() => null),
    ]);
    await waSend(env, c.uid, wa, "review_approved", reviewApprovedText({ who: r.display_name, stars: r.stars }));
    await mailSend(env, c.uid, mail, "review_approved", `consult:review:${reviewId}:approved`, "A new review is live on your page",
      shell("A new review is live", [`${r.display_name} gave you ${r.stars} stars.`], { label: "See your page", url: brandUrl("/guides/" + c.slug) }));
  } catch (e) {
    await trackException(env, e, { route: "consult.notifyReviewApproved", handled: true, app_name: APP });
  }
}

/** Cron: day-before (20–28 h ahead) and 15-minute (10–20 min ahead) reminders, plus retries of confirmations / thank-yous. */
export async function runConsultReminders(env: Env): Promise<number> {
  const db = metaDb(env), now = Date.now();
  let n = 0;
  const ids = async (sql: string, ...bind: unknown[]): Promise<string[]> =>
    ((await db.prepare(sql).bind(...bind).all<{ id: string }>()).results ?? []).map((r) => r.id);
  try {
    for (const id of await ids("SELECT id FROM consult_bookings WHERE status IN ('confirmed','in_call') AND confirm_sent_at IS NULL AND confirmed_at IS NOT NULL AND confirmed_at <= ?1 AND slot_end_ms > ?2 LIMIT 10", now - 2 * 60_000, now)) {
      await notifyBookingConfirmed(env, id); n++;
    }
    for (const id of await ids("SELECT id FROM consult_bookings WHERE status = 'confirmed' AND reminded_day_at IS NULL AND slot_start_ms BETWEEN ?1 AND ?2 ORDER BY slot_start_ms LIMIT 15", now + 20 * 3_600_000, now + 28 * 3_600_000)) {
      if (await sendReminder(env, id, "day")) n++;
    }
    for (const id of await ids("SELECT id FROM consult_bookings WHERE status = 'confirmed' AND reminded_15_at IS NULL AND slot_start_ms BETWEEN ?1 AND ?2 ORDER BY slot_start_ms LIMIT 15", now + 10 * 60_000, now + 20 * 60_000)) {
      if (await sendReminder(env, id, "15")) n++;
    }
    for (const id of await ids("SELECT id FROM consult_bookings WHERE status = 'completed' AND thanks_sent_at IS NULL AND review_token IS NOT NULL AND settled_at >= ?1 LIMIT 10", now - 24 * 3_600_000)) {
      if (await sendThanks(env, id)) n++;
    }
  } catch (e) {
    await trackException(env, e, { route: "consult.reminders", handled: true, app_name: APP });
  }
  return n;
}
