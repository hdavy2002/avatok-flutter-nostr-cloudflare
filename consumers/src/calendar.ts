// Phase 5 — AvaCalendar/AvaBooking cron work on avatok-consumers.
//
// 1. Reminder ladder (A5): T-24h email, T-60m email+push ("Within 1 hour …
//    here is the link to join"), T-10m push ("Starting soon"). All tiers are
//    idempotent (flag columns) and clock-skew safe (server time only).
//    Canonical source = `bookings`; legacy `calendar_events`-only rows (pre-
//    Phase-5) still get the old push-only T-60.
// 2. Google Calendar inbound-sync fallback: every 15-min tick imports busy
//    events for connected accounts (webhook channel is the fast path; this is
//    the guarantee). Self-contained token refresh — reads the same
//    gcal_accounts rows avatok-api writes.
import type { Env, EmailMsg } from "./types";
import { notifyUser } from "./notify";

const GTOKEN = "https://oauth2.googleapis.com/token";
const GCAL = "https://www.googleapis.com/calendar/v3";
const DAY = 86_400_000;
const FULL_RECONCILE_MS = DAY;
const SYNC_HORIZON_DAYS = 90;

// ---------------------------------------------------------------------------
// shared helpers (compact mirrors of avatok-api's cal/ modules)
// ---------------------------------------------------------------------------
async function clerkEmail(env: Env, uid: string): Promise<string | null> {
  if (!env.CLERK_SECRET_KEY) return null;
  try {
    const r = await fetch(`https://api.clerk.com/v1/users/${uid}`, { headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}` } });
    if (!r.ok) return null;
    const u = (await r.json()) as any;
    const primary = (u.email_addresses ?? []).find((e: any) => e.id === u.primary_email_address_id) ?? (u.email_addresses ?? [])[0];
    return primary?.verification?.status === "verified" ? (primary.email_address ?? null) : null;
  } catch { return null; }
}

const b64u = (buf: Uint8Array): string =>
  btoa(String.fromCharCode(...buf)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function signJoinToken(env: Env, bookingId: string, expMs: number): Promise<string> {
  const secret = env.JOIN_LINK_SECRET || "dev-join-secret";
  const payload = b64u(new TextEncoder().encode(JSON.stringify({ b: bookingId, exp: expMs })));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  return `${payload}.${b64u(sig)}`;
}

/**
 * [JOIN-LINK-1] v2 join token — mirrors worker/src/cal/ics.ts `signJoinTokenV2`
 * (the consumers bundle deliberately keeps its own copy of the HMAC helpers; see
 * `signJoinToken` above). Binds the link to ONE account and ONE entitlement so a
 * reminder email, like the confirmation, opens the room without a login.
 */
async function signJoinTokenV2(env: Env, c: {
  bookingId: string | null; listingId: string; accountId: string;
  kind: "live_event" | "consult_1to1"; expMs: number;
}): Promise<string> {
  const secret = env.JOIN_LINK_SECRET || "dev-join-secret";
  const payload = b64u(new TextEncoder().encode(JSON.stringify({
    v: 2, b: c.bookingId, l: c.listingId, u: c.accountId, k: c.kind, exp: c.expMs,
  })));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  return `${payload}.${b64u(sig)}`;
}

async function nameOf(env: Env, uid: string): Promise<string> {
  try {
    const r = await env.DB_META.prepare("SELECT name, handle FROM profiles WHERE npub=?1 OR clerk_user_id=?1").bind(uid).first<any>();
    return r?.name || r?.handle || "an AvaTOK user";
  } catch { return "an AvaTOK user"; }
}

function reminderHtml(tier: "24h" | "60m", o: { title: string; start: number; otherName: string; joinUrl: string }): { subject: string; html: string } {
  const head = tier === "24h" ? "Tomorrow on AvaTOK" : "Starting within the hour";
  const line = tier === "24h"
    ? `${new Date(o.start).toUTCString()} with ${o.otherName}.`
    : `Within 1 hour you have a session with ${o.otherName} — here is the link to join.`;
  const subject = tier === "24h" ? `Tomorrow: ${o.title}` : `Within 1 hour: ${o.title}`;
  const html = `
  <div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px">
    <h2 style="margin:0 0 12px">${head}</h2>
    <p style="margin:0 0 8px;font-weight:600">${o.title}</p>
    <p style="margin:0 0 8px">${line}</p>
    <p style="margin:0 0 8px">${tier === "24h" ? "Your invite is ready whenever you need it." : "The same invite lives in your calendar attachment."}</p>
    <p style="margin:20px 0"><a href="${o.joinUrl}" style="background:#08C4C4;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">${tier === "24h" ? "View booking" : "Join now"}</a></p>
    <p style="color:#999;font-size:12px;margin-top:20px">AvaTOK · times shown in UTC — the join page and app show your local time.</p>
  </div>`;
  return { subject, html };
}

// ---------------------------------------------------------------------------
// 1. Reminder ladder
// ---------------------------------------------------------------------------
type SendEmail = (msg: EmailMsg, env: Env) => Promise<void>;

interface DueBooking { id: string; creator_id: string; buyer_id: string; listing_id?: string | null; kind?: string | null; starts_at: number; title: string | null; }

async function dueRows(env: Env, flagCol: string, lo: number, hi: number, cursor = ""): Promise<DueBooking[]> {
  const rs = await env.DB_META.prepare(
    `SELECT b.id, b.creator_id, b.buyer_id, b.listing_id, b.kind, b.starts_at,
            (SELECT title FROM calendar_events e WHERE e.booking_id=b.id LIMIT 1) AS title
       FROM bookings b WHERE b.status='confirmed' AND b.${flagCol}=0
         AND b.starts_at>?1 AND b.starts_at<=?2 AND b.id>?3
       ORDER BY b.id ASC LIMIT 100`,
  ).bind(lo, hi, cursor).all();
  return (rs.results ?? []) as unknown as DueBooking[];
}

async function processDueBookings(
  env: Env,
  flagCol: string,
  lo: number,
  hi: number,
  process: (booking: DueBooking) => Promise<void>,
): Promise<void> {
  let cursor = "";
  for (;;) {
    const page = await dueRows(env, flagCol, lo, hi, cursor);
    for (const booking of page) {
      try {
        await process(booking);
      } catch (error) {
        // Keep this booking's flag at 0 and continue the bounded page. The next
        // cron tick will retry it through the catch-up window; stable email and
        // notification keys make any earlier recipient success idempotent.
        console.error(`[reminders:${flagCol}] booking ${booking.id}:`, String(error));
      }
    }
    if (page.length < 100) break;
    const next = page[page.length - 1]?.id;
    if (!next || next === cursor) break;
    cursor = next;
  }
}

export async function bookingReminderLadder(env: Env, sendEmail: SendEmail): Promise<void> {
  const now = Date.now();
  const H = 3_600_000, M = 60_000;

  // T-24h — email "Tomorrow: …". The wider future-only band catches a delayed
  // cron without sending a reminder for a session that has already started.
  await processDueBookings(env, "reminder24_sent", now + 20 * H, now + 26 * H, async (b) => {
    // Consultations are commercial sessions too: both parties receive the
    // durable T-24h mail with the canonical /session/:bookingId destination.
    // Other booking rows retain the legacy signed invite path below.
    await remind(env, sendEmail, b, "24h", false);
    await env.DB_META.prepare("UPDATE bookings SET reminder24_sent=1 WHERE id=?1").bind(b.id).run();
  });
  // Live tickets have no bookings row. Their email identity is the stable
  // listing/entitlement/account tuple, so a retry cannot invent a booking or
  // resend a successful recipient's mail.
  await liveTicketReminderSweep(env, sendEmail, "24h", now + 20 * H, now + 26 * H, false);
  // T-60m — email + push, both parties, with join link. Catch up a delayed
  // 15-minute tick while keeping the session safely in the future.
  await processDueBookings(env, "reminder_sent", now + 30 * M, now + 90 * M, async (b) => {
    await remind(env, sendEmail, b, "60m", true);
    await env.DB_META.prepare("UPDATE bookings SET reminder_sent=1 WHERE id=?1").bind(b.id).run();
  });
  await liveTicketReminderSweep(env, sendEmail, "60m", now + 30 * M, now + 90 * M, true);
  // T-10m — push only ("Starting soon — tap to join"). A small past window lets
  // a delayed tick still help someone joining just after the scheduled start.
  await processDueBookings(env, "reminder10_sent", now - 5 * M, now + 10 * M, async (b) => {
    if (b.kind === "consult_1to1") {
      for (const uid of [b.creator_id, b.buyer_id]) {
        await pushReminder(env, uid, `commercial-notification:commercial_join_window:${b.id}:10m:${uid}`, "Starting soon", `${b.title ?? "Your consultation"} is ready to join.`, {
          type: "commercial_join_window", ...(b.listing_id ? { listing_id: b.listing_id } : {}), booking_id: b.id, deeplink: `/session/${b.id}`,
        });
      }
    } else {
      const legacyUrl = `/j/${await signJoinToken(env, b.id, b.starts_at + 86_400_000)}`;
      for (const uid of [b.creator_id, b.buyer_id]) {
        await pushReminder(env, uid, `commercial-notification:commercial_join_window:${b.id}:10m:${uid}`, "Starting soon", `${b.title ?? "Your session"} — tap to join`, { type: "commercial_join_window", booking_id: b.id, deeplink: legacyUrl });
      }
    }
    await env.DB_META.prepare("UPDATE bookings SET reminder10_sent=1 WHERE id=?1").bind(b.id).run();
  });
  await liveTicketReminderSweep(env, sendEmail, "10m", now - 5 * M, now + 10 * M, true);

  // Legacy calendar_events-only rows (no bookings row): keep the old push T-60.
  let due60: { results?: unknown[] } | null = null;
  try {
    due60 = await env.DB_META.prepare(
      `SELECT id, owner_uid, owner_npub, title FROM calendar_events
        WHERE status='confirmed' AND reminded_60=0 AND start_at>?1 AND start_at<=?2
          AND booking_id NOT IN (SELECT id FROM bookings) LIMIT 100`,
    ).bind(now + 45 * M, now + 60 * M).all();
  } catch { /* legacy table shape */ }
  for (const e of (due60?.results ?? []) as any[]) {
    const to = e.owner_uid || e.owner_npub;
    await pushReminder(env, to, `calendar-reminder:${e.id}:60m`, "In ~1 hour", e.title, { deeplink: "/calendar" });
    await env.DB_META.prepare("UPDATE calendar_events SET reminded_60=1 WHERE id=?1").bind(e.id).run();
  }
}

async function remind(env: Env, sendEmail: SendEmail, b: DueBooking, tier: "24h" | "60m", push: boolean): Promise<void> {
  const title = b.title ?? "Your AvaTOK session";
  // Commercial consultations resolve through the authenticated session
  // destination. Legacy calendar bookings keep their signed /j invitation;
  // that path is still required for genuinely old rows.
  // [JOIN-LINK-1] The link is per-recipient now. The CREATOR gets the canonical
  // room URL (he transmits from the app and is signed in there anyway,
  // RULEBOOK §7); the BUYER gets his own signed /j/ link, because the bare
  // /session/:id he used to be sent stopped him at the email-code gate on the
  // way into a session he had already paid for.
  const creatorUrl = b.kind === "consult_1to1"
    ? `https://avatok.ai/session/${encodeURIComponent(b.id)}`
    : `https://avatok.ai/j/${await signJoinToken(env, b.id, b.starts_at + 86_400_000)}`;
  const buyerUrl = b.kind === "consult_1to1" && b.listing_id
    ? `https://avatok.ai/j/${await signJoinTokenV2(env, {
      bookingId: b.id, listingId: b.listing_id, accountId: b.buyer_id,
      kind: "consult_1to1", expMs: b.starts_at + 86_400_000,
    })}`
    : creatorUrl;
  const pairs: [string, string][] = [[b.creator_id, b.buyer_id], [b.buyer_id, b.creator_id]];
  for (const [uid, otherUid] of pairs) {
    const otherName = await nameOf(env, otherUid);
    const joinUrl = uid === b.buyer_id ? buyerUrl : creatorUrl;
    const { subject, html } = reminderHtml(tier, { title, start: b.starts_at, otherName, joinUrl });
    const email = await clerkEmail(env, uid);
    if (email) {
      await sendEmail({
        to: email, subject, html,
        kind: "commercial_reminder", orderId: b.id, recipientId: uid,
        messageVersion: `commercial-booking-reminder-${tier}.v1`,
        outboxKey: `commercial-reminder:booking:${b.id}:${uid}:${tier}:v1`,
      }, env);
    }
    if (push) {
      await pushReminder(env, uid, `commercial-notification:commercial_join_window:${b.id}:${tier}:${uid}`, tier === "60m" ? "In ~1 hour" : "Tomorrow", title, {
        ...(b.kind === "consult_1to1" ? { type: "commercial_join_window", booking_id: b.id, ...(b.listing_id ? { listing_id: b.listing_id } : {}), deeplink: `/session/${encodeURIComponent(b.id)}` } : { deeplink: "/calendar" }),
      });
    }
  }
}

type DueLiveTicket = {
  entitlement_id: string;
  account_id: string;
  listing_id: string;
  booking_id?: string | null;
  starts_at: number;
  title: string | null;
  creator_id: string;
  session_id?: string | null;
};

async function pushReminder(
  env: Env,
  uid: string | null | undefined,
  id: string,
  title: string,
  body: string,
  data: Record<string, unknown>,
): Promise<void> {
  if (!uid) return;
  // requirePush makes a missing device or provider rejection reach the cron
  // caller. The cadence marker is written only after this hand-off succeeds.
  try {
    await notifyUser(env, uid, { type: "commercial", title, body, data }, { id, requirePush: true });
  } catch (error) {
    // Email is the recovery path for attendees without the app. Permanent push
    // unavailability (zero/stale tokens, missing config, or a permanent 4xx)
    // must not keep a booking reminder pending forever. Provider throttling and
    // 5xx errors remain retryable and stop the cadence marker from advancing.
    if (String(error).includes("push delivery unavailable")) return;
    throw error;
  }
}

async function liveTicketReminderSweep(
  env: Env,
  sendEmail: SendEmail,
  tier: "24h" | "60m" | "10m",
  lo: number,
  hi: number,
  push: boolean,
): Promise<void> {
  let cursor = "";
  const pageSize = 100;
  const seen = new Set<string>();
  let failures = 0;
  try {
    for (;;) {
      const rows = await env.DB_META.prepare(
        `SELECT e.entitlement_id,e.account_id,e.listing_id,e.booking_id,e.starts_at,
                l.title,l.creator_id,
                (SELECT s.commercial_session_id FROM commercial_sessions s
                  WHERE s.listing_id=e.listing_id AND s.kind='live_event'
                  ORDER BY s.session_version DESC LIMIT 1) AS session_id
           FROM commercial_entitlements e JOIN listings l ON l.id=e.listing_id
          WHERE e.kind='live_event' AND e.role IN ('viewer','buyer')
            AND e.state IN ('reserved','held','active','consumed')
            AND e.starts_at>?1 AND e.starts_at<=?2 AND e.entitlement_id>?3
          ORDER BY e.entitlement_id ASC LIMIT ?4`,
      ).bind(lo, hi, cursor, pageSize).all<DueLiveTicket>();
      const page = rows.results ?? [];
      for (const row of page) {
        const eventKey = `${row.listing_id}:${row.starts_at}`;
        const recipients = [...new Set([row.account_id, row.creator_id].filter(Boolean))];
        for (const uid of recipients) {
          const key = `${eventKey}:${uid}:${tier}`;
          if (seen.has(key)) continue;
          seen.add(key);
          try {
            const title = row.title ?? "Your live event";
            // [JOIN-LINK-1] Two URLs, and they are not interchangeable.
            // `roomUrl` is the canonical room and stays the PUSH deeplink — the
            // app parses /live/:id (deep_links.dart) and has no /j/ handler, so
            // signing that link would break tap-to-join in the app. `joinUrl` is
            // what goes in the EMAIL: for a ticket holder it is his own signed
            // link, so the browser lets him in without a sign-in.
            const roomUrl = `https://avatok.ai/live/${encodeURIComponent(row.listing_id)}`;
            const joinUrl = uid === row.creator_id
              ? roomUrl
              : `https://avatok.ai/j/${await signJoinTokenV2(env, {
                bookingId: row.booking_id ?? null, listingId: row.listing_id, accountId: uid,
                kind: "live_event", expMs: row.starts_at + 86_400_000,
              })}`;
            if (tier !== "10m") {
              const otherName = uid === row.creator_id ? "your attendees" : "the host";
              const { subject, html } = reminderHtml(tier, { title, start: row.starts_at, otherName, joinUrl });
              const email = await clerkEmail(env, uid);
              if (email) {
                await sendEmail({
                  to: email, subject, html,
                  kind: "commercial_reminder", orderId: null, recipientId: uid,
                  messageVersion: `commercial-live-ticket-reminder-${tier}.v1`,
                  outboxKey: `commercial-reminder:live:${row.listing_id}:${row.starts_at}:${uid}:${tier}:v1`,
                }, env);
              }
            }
            if (push) {
              await pushReminder(env, uid, `commercial-notification:live_join_window:${row.listing_id}:${row.starts_at}:${tier}:${uid}`, tier === "10m" ? "Starting soon" : "Live event reminder", tier === "10m" ? `${title} starts in 10 minutes — tap to join` : title, {
                type: "commercial_join_window", listing_id: row.listing_id,
                ...(row.booking_id ? { booking_id: row.booking_id } : {}),
                ...(row.session_id ? { session_id: row.session_id } : {}),
                deeplink: roomUrl,
              });
            }
          } catch (error) {
            // One recipient's transient provider failure must not prevent the
            // remaining live ticket audience from receiving its reminder.
            failures++;
            console.error(`[reminders:${tier}] live recipient ${uid}:`, String(error));
          }
        }
      }
      if (page.length < pageSize) break;
      const next = page[page.length - 1]?.entitlement_id;
      if (!next || next === cursor) break;
      cursor = next;
    }
  } catch (error) {
    // Older shards may not have the commercial projection yet. Keep the cron
    // alive, but do not hide failures once the table exists: a failed send must
    // leave the sweep eligible for the next tick.
    if (!String(error).includes("no such table") && !String(error).includes("no such column")) throw error;
  }
  if (failures > 0) console.warn(`[reminders:${tier}] ${failures} live recipient(s) remain eligible for retry`);
}

// ---------------------------------------------------------------------------
// 2. Gcal inbound-sync cron fallback (15-min tick), ≤50 accounts per run.
// The Worker owns OAuth/selection and the same per-calendar state is read here
// so polling remains a durable recovery path when a push channel is missed.
// ---------------------------------------------------------------------------
function localDateEpoch(date: string, timezone: string): number | null {
  const [year, month, day] = date.split("-").map(Number); if (!year || !month || !day) return null;
  const wall = Date.UTC(year, month - 1, day); const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const asWall = (epoch: number) => { const parts: Record<string, number> = {}; for (const p of formatter.formatToParts(new Date(epoch))) if (p.type !== "literal") parts[p.type] = Number(p.value); return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second); };
  let epoch = wall; for (let i = 0; i < 4; i++) epoch += wall - asWall(epoch); return asWall(epoch) === wall ? epoch : null;
}
function eventRange(event: any, timezone: string): { starts: number; ends: number } | null {
  if (event.start?.dateTime && event.end?.dateTime) { const starts = Date.parse(event.start.dateTime), ends = Date.parse(event.end.dateTime); return starts > 0 && ends > starts ? { starts, ends } : null; }
  if (event.start?.date && event.end?.date) { const starts = localDateEpoch(event.start.date, timezone), ends = localDateEpoch(event.end.date, timezone); return starts !== null && ends !== null && ends > starts ? { starts, ends } : null; }
  return null;
}
async function gcalAccessToken(env: Env, uid: string, refreshEnc: string, cached: { access_token: string | null; access_expires_at: number | null }): Promise<string | null> {
  if (cached.access_token && (cached.access_expires_at ?? 0) > Date.now() + 30_000) return cached.access_token;
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GCAL_TOKEN_KEY) return null;
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.GCAL_TOKEN_KEY)); const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  let refresh: string; try { const all = Uint8Array.from(atob(refreshEnc), (c) => c.charCodeAt(0)); if (all.length <= 12) return null; refresh = new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12) }, key, all.slice(12))); } catch { return null; }
  const response = await fetch(GTOKEN, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ refresh_token: refresh, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, grant_type: "refresh_token" }) }); if (!response.ok) return null;
  const token = await response.json() as { access_token?: string; expires_in?: number }; if (!token.access_token || !token.expires_in) return null; await env.DB_META.prepare("UPDATE gcal_accounts SET access_token=?2,access_expires_at=?3,last_error=NULL WHERE user_id=?1").bind(uid, token.access_token, Date.now() + Math.max(60, token.expires_in - 60) * 1000).run(); return token.access_token;
}
async function renewWatch(env: Env, uid: string, row: any, token: string): Promise<void> {
  if (row.channel_id && (row.channel_expires_at ?? 0) > Date.now() + DAY) return;
  const channelId = crypto.randomUUID(); const raw = new TextEncoder().encode(`${uid}.${row.calendar_id}.${channelId}`); const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.GCAL_TOKEN_KEY!), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, raw)); const channelToken = `${uid}.${row.calendar_id}.${btoa(String.fromCharCode(...sig))}`.slice(0, 256);
  const response = await fetch(`${GCAL}/calendars/${encodeURIComponent(row.calendar_id)}/events/watch`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ id: channelId, type: "web_hook", address: "https://api.avatok.ai/webhooks/gcal", token: channelToken, expiration: Date.now() + 6 * DAY }) }); if (!response.ok) throw new Error(`watch renewal failed (${response.status})`); const data = await response.json() as { id?: string; resourceId?: string; expiration?: string | number }; if (!data.id || !data.resourceId) throw new Error("watch renewal returned no channel id"); await env.DB_META.prepare("UPDATE gcal_calendars SET channel_id=?3,resource_id=?4,channel_token=?5,channel_expires_at=?6,updated_at=?7 WHERE user_id=?1 AND calendar_id=?2").bind(uid, row.calendar_id, data.id, data.resourceId, channelToken, Number(data.expiration) || Date.now() + 6 * DAY, Date.now()).run();
}
async function syncCalendar(env: Env, uid: string, row: any, token: string): Promise<void> {
  let watchError: unknown = null; try { await renewWatch(env, uid, row, token); } catch (error) { watchError = error; } let pageToken: string | undefined; const periodicFull = !row.last_full_sync_at || Date.now() - row.last_full_sync_at > FULL_RECONCILE_MS; const syncRequestToken = periodicFull ? null : row.sync_token; const fullSync = !syncRequestToken; const seen = new Set<string>(); let finalSyncToken: string | null = null;
  const initialTimeMin = new Date().toISOString(); const initialTimeMax = new Date(Date.now() + SYNC_HORIZON_DAYS * DAY).toISOString();
  for (let page = 0; page < 100; page++) { const u = new URL(`${GCAL}/calendars/${encodeURIComponent(row.calendar_id)}/events`); u.searchParams.set("singleEvents", "true"); u.searchParams.set("showDeleted", "true"); u.searchParams.set("maxResults", "250"); u.searchParams.set("timeZone", row.timezone || "UTC"); if (syncRequestToken) u.searchParams.set("syncToken", syncRequestToken); else { u.searchParams.set("timeMin", initialTimeMin); u.searchParams.set("timeMax", initialTimeMax); } if (pageToken) u.searchParams.set("pageToken", pageToken);
    const response = await fetch(u, { headers: { Authorization: `Bearer ${token}` } }); if (response.status === 410) { await env.DB_META.prepare("UPDATE gcal_calendars SET sync_token=NULL,channel_id=NULL,resource_id=NULL,channel_token=NULL,channel_expires_at=NULL WHERE user_id=?1 AND calendar_id=?2").bind(uid, row.calendar_id).run(); return syncCalendar(env, uid, { ...row, sync_token: null, channel_id: null }, token); } if (!response.ok) throw new Error(`event sync failed (${response.status})`); const data = await response.json() as any;
    for (const ev of data.items ?? []) { const ref = `gcal:${row.calendar_id}:${ev.id}`; if (ev.id) seen.add(ref); if (ev.extendedProperties?.private?.avatok === "1") { await env.DB_META.prepare("UPDATE calendar_blocks SET status='cancelled' WHERE user_id=?1 AND source_app='gcal' AND source_ref=?2").bind(uid, ref).run(); continue; } if (ev.status === "cancelled" || ev.transparency === "transparent") { await env.DB_META.prepare("UPDATE calendar_blocks SET status='cancelled' WHERE user_id=?1 AND source_app='gcal' AND source_ref=?2").bind(uid, ref).run(); continue; } const range = eventRange(ev, row.timezone || "UTC"); if (!range) { await env.DB_META.prepare("UPDATE calendar_blocks SET status='cancelled' WHERE user_id=?1 AND source_app='gcal' AND source_ref=?2").bind(uid, ref).run(); continue; } await env.DB_META.prepare("INSERT INTO calendar_blocks(id,user_id,source_app,source_ref,starts_at,ends_at,title,status,created_at) VALUES(?1,?2,'gcal',?3,?4,?5,'Google Calendar','busy',?6) ON CONFLICT(id) DO UPDATE SET starts_at=?4,ends_at=?5,title='Google Calendar',status='busy'").bind(`gcalblk:${uid}:${row.calendar_id}:${ev.id}`, uid, ref, range.starts, range.ends, Date.now()).run(); }
    pageToken = data.nextPageToken; if (!pageToken) { finalSyncToken = data.nextSyncToken ?? null; break; }
  }
  if (!finalSyncToken) throw new Error("event sync did not return a final sync token"); if (fullSync) { const existing = await env.DB_META.prepare("SELECT id,source_ref FROM calendar_blocks WHERE user_id=?1 AND source_app='gcal' AND status='busy' AND source_ref LIKE ?2").bind(uid, `gcal:${row.calendar_id}:%`).all<{ id: string; source_ref: string }>(); for (const block of (existing.results ?? [])) if (!seen.has(block.source_ref)) await env.DB_META.prepare("UPDATE calendar_blocks SET status='cancelled' WHERE id=?1").bind(block.id).run(); } const syncedAt = Date.now(); await env.DB_META.prepare("UPDATE gcal_calendars SET sync_token=?3,last_sync_at=?4,last_success_at=?4,last_full_sync_at=CASE WHEN ?5=1 THEN ?4 ELSE last_full_sync_at END,last_error=?6,updated_at=?4 WHERE user_id=?1 AND calendar_id=?2").bind(uid, row.calendar_id, finalSyncToken, syncedAt, fullSync ? 1 : 0, watchError ? String(watchError).slice(0, 500) : null).run();
}
export async function gcalSyncSweep(env: Env): Promise<void> { let accounts: any[]; try { accounts = ((await env.DB_META.prepare("SELECT user_id,refresh_token_enc,access_token,access_expires_at,sync_token FROM gcal_accounts ORDER BY COALESCE(last_sync_at,0) ASC LIMIT 50").all()).results ?? []) as any[]; } catch { return; } for (const account of accounts) { try { const token = await gcalAccessToken(env, account.user_id, account.refresh_token_enc, account); if (!token) continue; let calendars = ((await env.DB_META.prepare("SELECT * FROM gcal_calendars WHERE user_id=?1 AND selected=1 ORDER BY primary_calendar DESC,calendar_id").bind(account.user_id).all()).results ?? []) as any[]; if (!calendars.length) { await env.DB_META.prepare("INSERT OR IGNORE INTO gcal_calendars(user_id,calendar_id,summary,timezone,primary_calendar,selected,destination,sync_token,updated_at) VALUES(?1,'primary','Google Calendar','UTC',1,1,1,?2,?3)").bind(account.user_id, account.sync_token ?? null, Date.now()).run(); calendars = ((await env.DB_META.prepare("SELECT * FROM gcal_calendars WHERE user_id=?1 AND selected=1").bind(account.user_id).all()).results ?? []) as any[]; } for (const row of calendars) { try { await syncCalendar(env, account.user_id, row, token); } catch (error) { await env.DB_META.prepare("UPDATE gcal_calendars SET last_sync_at=?3,last_error=?4,updated_at=?3 WHERE user_id=?1 AND calendar_id=?2").bind(account.user_id, row.calendar_id, Date.now(), String(error).slice(0, 500)).run(); console.error("[gcal-sync]", account.user_id, row.calendar_id, String(error)); } } } catch (error) { console.error("[gcal-sync]", account.user_id, String(error)); } } }
