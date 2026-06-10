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

const GTOKEN = "https://oauth2.googleapis.com/token";
const GCAL = "https://www.googleapis.com/calendar/v3";

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
    return primary?.email_address ?? null;
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
    <p style="margin:20px 0"><a href="${o.joinUrl}" style="background:#08C4C4;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">${tier === "24h" ? "View booking" : "Join now"}</a></p>
    <p style="color:#999;font-size:12px;margin-top:20px">AvaTOK · times shown in UTC — the join page and app show your local time.</p>
  </div>`;
  return { subject, html };
}

// ---------------------------------------------------------------------------
// 1. Reminder ladder
// ---------------------------------------------------------------------------
type SendEmail = (msg: EmailMsg, env: Env) => Promise<void>;

interface DueBooking { id: string; creator_id: string; buyer_id: string; starts_at: number; title: string | null; }

async function dueRows(env: Env, flagCol: string, lo: number, hi: number): Promise<DueBooking[]> {
  const rs = await env.DB_META.prepare(
    `SELECT b.id, b.creator_id, b.buyer_id, b.starts_at,
            (SELECT title FROM calendar_events e WHERE e.booking_id=b.id LIMIT 1) AS title
       FROM bookings b WHERE b.status='confirmed' AND b.${flagCol}=0 AND b.starts_at>?1 AND b.starts_at<=?2 LIMIT 100`,
  ).bind(lo, hi).all();
  return (rs.results ?? []) as unknown as DueBooking[];
}

export async function bookingReminderLadder(env: Env, sendEmail: SendEmail): Promise<void> {
  const now = Date.now();
  const H = 3_600_000, M = 60_000;

  // T-24h — email "Tomorrow: …" (band 23h..24h; the 15-min cron sweeps it).
  for (const b of await dueRows(env, "reminder24_sent", now + 23 * H, now + 24 * H)) {
    await remind(env, sendEmail, b, "24h", false);
    await env.DB_META.prepare("UPDATE bookings SET reminder24_sent=1 WHERE id=?1").bind(b.id).run();
  }
  // T-60m — email + push, both parties, with join link.
  for (const b of await dueRows(env, "reminder_sent", now + 45 * M, now + 60 * M)) {
    await remind(env, sendEmail, b, "60m", true);
    await env.DB_META.prepare("UPDATE bookings SET reminder_sent=1, reminder24_sent=1 WHERE id=?1").bind(b.id).run();
  }
  // T-10m — push only ("Starting soon — tap to join").
  for (const b of await dueRows(env, "reminder10_sent", now, now + 10 * M)) {
    for (const uid of [b.creator_id, b.buyer_id]) {
      try { await env.Q_PUSH?.send({ kind: "notify", to: uid, fromName: "Reminder", title: "Starting soon", body: `${b.title ?? "Your session"} — tap to join`, data: { deeplink: "/booking", booking_id: b.id } }); } catch { /* best-effort */ }
    }
    await env.DB_META.prepare("UPDATE bookings SET reminder10_sent=1, reminder_sent=1, reminder24_sent=1 WHERE id=?1").bind(b.id).run();
  }

  // Legacy calendar_events-only rows (no bookings row): keep the old push T-60.
  try {
    const due60 = await env.DB_META.prepare(
      `SELECT id, owner_uid, owner_npub, title FROM calendar_events
        WHERE status='confirmed' AND reminded_60=0 AND start_at>?1 AND start_at<=?2
          AND booking_id NOT IN (SELECT id FROM bookings) LIMIT 100`,
    ).bind(now + 45 * M, now + 60 * M).all();
    for (const e of (due60.results ?? []) as any[]) {
      const to = e.owner_uid || e.owner_npub;
      try { await env.Q_PUSH?.send({ kind: "notify", to, fromName: "Reminder", title: "In ~1 hour", body: e.title, data: { deeplink: "/calendar" } }); } catch { /* best-effort */ }
      await env.DB_META.prepare("UPDATE calendar_events SET reminded_60=1 WHERE id=?1").bind(e.id).run();
    }
  } catch { /* legacy table shape */ }
}

async function remind(env: Env, sendEmail: SendEmail, b: DueBooking, tier: "24h" | "60m", push: boolean): Promise<void> {
  const title = b.title ?? "Your AvaTOK session";
  const joinUrl = `https://avatok.ai/j/${await signJoinToken(env, b.id, b.starts_at + 86_400_000)}`;
  const pairs: [string, string][] = [[b.creator_id, b.buyer_id], [b.buyer_id, b.creator_id]];
  for (const [uid, otherUid] of pairs) {
    const otherName = await nameOf(env, otherUid);
    const { subject, html } = reminderHtml(tier, { title, start: b.starts_at, otherName, joinUrl });
    const email = await clerkEmail(env, uid);
    if (email) { try { await sendEmail({ to: email, subject, html }, env); } catch { /* best-effort */ } }
    if (push) {
      try { await env.Q_PUSH?.send({ kind: "notify", to: uid, fromName: "Reminder", title: tier === "60m" ? "In ~1 hour" : "Tomorrow", body: title, data: { deeplink: "/booking", booking_id: b.id, join_url: joinUrl } }); } catch { /* best-effort */ }
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Gcal inbound-sync cron fallback (15-min tick), ≤50 accounts per run,
//    oldest-synced first. Loop-guard: skips events we exported (avatok marker).
// ---------------------------------------------------------------------------
async function gcalAccessToken(env: Env, uid: string, refreshEnc: string, cached: { access_token: string | null; access_expires_at: number | null }): Promise<string | null> {
  if (cached.access_token && (cached.access_expires_at ?? 0) > Date.now()) return cached.access_token;
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
  // AES-GCM decrypt with key = SHA-256(GCAL_TOKEN_KEY) — mirrors avatok-api cal/gcal.ts.
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.GCAL_TOKEN_KEY || "dev-gcal-key"));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  let refresh: string;
  try {
    const all = Uint8Array.from(atob(refreshEnc), (c) => c.charCodeAt(0));
    refresh = new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12) }, key, all.slice(12)));
  } catch { return null; }
  const r = await fetch(GTOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ refresh_token: refresh, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, grant_type: "refresh_token" }),
  });
  if (!r.ok) return null;
  const t = (await r.json()) as { access_token: string; expires_in: number };
  await env.DB_META.prepare("UPDATE gcal_accounts SET access_token=?2, access_expires_at=?3 WHERE user_id=?1")
    .bind(uid, t.access_token, Date.now() + (t.expires_in - 60) * 1000).run();
  return t.access_token;
}

export async function gcalSyncSweep(env: Env): Promise<void> {
  let accounts: any[];
  try {
    accounts = ((await env.DB_META.prepare(
      "SELECT user_id, refresh_token_enc, access_token, access_expires_at, sync_token FROM gcal_accounts ORDER BY COALESCE(last_sync_at,0) ASC LIMIT 50",
    ).all()).results ?? []) as any[];
  } catch { return; } // table not migrated yet
  for (const a of accounts) {
    try {
      const tok = await gcalAccessToken(env, a.user_id, a.refresh_token_enc, a);
      if (!tok) continue;
      let pageToken: string | undefined;
      let syncToken: string | null = a.sync_token;
      for (let page = 0; page < 5; page++) {
        const u = new URL(`${GCAL}/calendars/primary/events`);
        u.searchParams.set("singleEvents", "true");
        u.searchParams.set("maxResults", "250");
        if (pageToken) u.searchParams.set("pageToken", pageToken);
        else if (syncToken) u.searchParams.set("syncToken", syncToken);
        else {
          u.searchParams.set("timeMin", new Date().toISOString());
          u.searchParams.set("timeMax", new Date(Date.now() + 60 * 86_400_000).toISOString());
        }
        const r = await fetch(u, { headers: { Authorization: `Bearer ${tok}` } });
        if (r.status === 410) { await env.DB_META.prepare("UPDATE gcal_accounts SET sync_token=NULL WHERE user_id=?1").bind(a.user_id).run(); syncToken = null; pageToken = undefined; continue; }
        if (!r.ok) break;
        const data = (await r.json()) as any;
        for (const ev of data.items ?? []) {
          if (ev.extendedProperties?.private?.avatok === "1") continue; // ours — no echo loop
          const refId = `gcal:${ev.id}`;
          if (ev.status === "cancelled") {
            await env.DB_META.prepare("UPDATE calendar_blocks SET status='cancelled' WHERE user_id=?1 AND source_app='gcal' AND source_ref=?2").bind(a.user_id, refId).run();
            continue;
          }
          if (ev.transparency === "transparent") continue;
          const s = Date.parse(ev.start?.dateTime ?? (ev.start?.date ? ev.start.date + "T00:00:00Z" : ""));
          const e = Date.parse(ev.end?.dateTime ?? (ev.end?.date ? ev.end.date + "T00:00:00Z" : ""));
          if (!(s > 0 && e > s)) continue;
          await env.DB_META.prepare(
            `INSERT INTO calendar_blocks (id, user_id, source_app, source_ref, starts_at, ends_at, title, status, created_at)
             VALUES (?1,?2,'gcal',?3,?4,?5,?6,'busy',?7)
             ON CONFLICT(id) DO UPDATE SET starts_at=?4, ends_at=?5, title=?6, status='busy'`,
          ).bind(`gcalblk:${a.user_id}:${ev.id}`, a.user_id, refId, s, e, ev.summary ?? "Google Calendar", Date.now()).run();
        }
        pageToken = data.nextPageToken;
        if (!pageToken) {
          if (data.nextSyncToken) await env.DB_META.prepare("UPDATE gcal_accounts SET sync_token=?2, last_sync_at=?3 WHERE user_id=?1").bind(a.user_id, data.nextSyncToken, Date.now()).run();
          else await env.DB_META.prepare("UPDATE gcal_accounts SET last_sync_at=?2 WHERE user_id=?1").bind(a.user_id, Date.now()).run();
          break;
        }
      }
    } catch (e) { console.error("[gcal-sync]", a.user_id, String(e)); }
  }
}
