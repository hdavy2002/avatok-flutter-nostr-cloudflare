// [SAATHUM-WEATHER-NOTICE-1 2026-09-29] Admin 2 — "Send weather delay notice" for one event.
// OWNER DECISION (2026-09-29): Saa Thum's crew films havans/pujas at remote Himalayan temples; snow or
// landslides sometimes cut the network so the video (and prasad courier) is late. One admin click
// tells every CONFIRMED buyer of the event, by WhatsApp (whatsapp_outbox, paced cron drain) and email
// (email_outbox, sender "Saa Thum Support" = the mail worker's default sender).
//
//   GET  /api/admin/v2/events/:id/weather-delay   -> {recipients}          (count for the confirm step)
//   POST /api/admin/v2/events/:id/weather-delay   -> {recipients, whatsapp_queued, skipped_no_phone, emails_queued}
//
// Buyers = the same query the live-link / video-ready notifications use (saathum_checkouts.status='confirmed').
// Dedupe: one message per buyer per event per IST day, on BOTH channels (WhatsApp: outbox UNIQUE key with a
// day-based url_hash; email: outboxKey includes the day and an existing row is skipped). Registered by one
// spread line in routes/admin2.ts ADMIN2_ROUTES. No migration: whatsapp_outbox.kind has no CHECK constraint.
import { BRAND } from "../lib/brand";
import type { Env } from "../types";
import { json } from "../util";
import type { Admin2RouteDef } from "./admin2";
import { requireAdmin } from "./admin_money";
import { track, trackException } from "../hooks";
import { emailFor } from "../lib/identity";
import { escapeHtml } from "../cal/emails";
import { enqueueEmail } from "../lib/email_outbox";
import { bookingRef, sendSaathumWeatherDelayWhatsApp, weatherDelayText } from "../lib/whatsapp_notify";

const APP = "saathum";
const IST_OFFSET_MS = 330 * 60_000;
const ID = "([^/]+)";

type Buyer = { checkout_id: string; uid: string; commercial_order_id: string | null; sankalp_json: string | null };

const istDayKey = (ms: number) => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);

function buyerName(json_: string | null): string {
  try {
    const n = (JSON.parse(json_ ?? "{}") as { name?: unknown }).name;
    return typeof n === "string" ? n.trim().slice(0, 80) : "";
  } catch { return ""; }
}

async function loadEvent(env: Env, id: string) {
  const listing = await env.DB_META.prepare("SELECT id, title FROM listings WHERE id=?1")
    .bind(id).first<{ id: string; title: string }>().catch(() => null);
  if (!listing) return null;
  const rows = await env.DB_META.prepare(
    `SELECT checkout_id, uid, commercial_order_id, sankalp_json FROM saathum_checkouts
      WHERE listing_id=?1 AND status='confirmed' LIMIT 2000`,
  ).bind(id).all<Buyer>();
  return { listing, buyers: rows.results ?? [] };
}

async function guard(req: Request, env: Env): Promise<Response | null> {
  const a = await requireAdmin(req, env);
  if (a instanceof Response) {
    return a.status === 403
      ? json({ error: "admin_only", message: "Admins only." }, 403)
      : json({ error: "unauthorized", message: "Please sign in again." }, a.status);
  }
  return null;
}

export async function adminWeatherDelayCount(req: Request, env: Env, id: string): Promise<Response> {
  const denied = await guard(req, env); if (denied) return denied;
  const ev = await loadEvent(env, id);
  if (!ev) return json({ error: "not_found", message: "Event not found." }, 404);
  return json({ recipients: ev.buyers.length });
}

export async function adminWeatherDelaySend(req: Request, env: Env, id: string): Promise<Response> {
  const denied = await guard(req, env); if (denied) return denied;
  const ev = await loadEvent(env, id);
  if (!ev) return json({ error: "not_found", message: "Event not found." }, 404);
  const title = ev.listing.title || "your booking";
  const day = istDayKey(Date.now());

  const wa = await sendSaathumWeatherDelayWhatsApp(
    env, id, title, day,
    ev.buyers.map((b) => ({ checkout_id: b.checkout_id, uid: b.uid, name: buyerName(b.sankalp_json) })),
  );

  let emails = 0;
  for (const b of ev.buyers) {
    try {
      const to = await emailFor(env, b.uid).catch(() => null);
      if (!to) continue;
      const outboxKey = `saathum-weather-delay:${b.checkout_id}:${day}`;
      // A same-day repeat click must never re-send: skip when this day's outbox row already exists.
      const seen = await env.DB_META.prepare("SELECT 1 AS x FROM email_outbox WHERE outbox_key=?1 LIMIT 1")
        .bind(outboxKey).first<{ x: number }>().catch(() => null);
      if (seen) continue;
      const text = weatherDelayText(buyerName(b.sankalp_json), title, bookingRef(b.checkout_id));
      const html = `
  <div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px">
    <h2 style="margin:0 0 12px">An update on your video 🙏</h2>
    <p style="margin:0 0 8px;font-weight:600">${escapeHtml(title)}</p>
    <p style="margin:0 0 8px">${escapeHtml(text)}</p>
    <p style="color:#999;font-size:12px;margin-top:20px">${BRAND.name} Support</p>
  </div>`;
      const r = await enqueueEmail(env, {
        to, subject: `An update on your ${title} video`, html,
        kind: "saathum_weather_delay", orderId: b.commercial_order_id, recipientId: b.uid,
        messageVersion: "saathum-weather-delay.v1", outboxKey,
        from: `${BRAND.name} Support <${BRAND.emails.noreply}>`,
      });
      if (r.status !== "unavailable" && r.status !== "failed") emails++;
    } catch (err) {
      await trackException(env, err, { uid: b.uid, route: "admin2_weather_notice:email", handled: true, app_name: APP });
    }
  }

  const out = { recipients: ev.buyers.length, whatsapp_queued: wa.queued, skipped_no_phone: wa.skipped_no_phone, emails_queued: emails };
  await track(env, "system", "saathum_weather_delay_notice", APP, { listing_id: id, ...out });
  // [SAATHUM-PREETI-1] Tell Preeti (the site AI agent) about the delay so she can answer buyers. One active
  // weather_notice row per event; a repeat click while it is still active does not add another.
  try {
    const now = Date.now();
    const active = await env.DB_META.prepare(
      "SELECT 1 AS x FROM ai_incidents WHERE listing_id=?1 AND source='weather_notice' AND (expires_at IS NULL OR expires_at>?2) LIMIT 1",
    ).bind(id, now).first();
    if (!active) {
      await env.DB_META.prepare(
        "INSERT INTO ai_incidents (id, listing_id, message, starts_at, expires_at, source, created_by, created_at) VALUES (?1,?2,?3,?4,?5,'weather_notice','system',?4)",
      ).bind(
        `i_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`, id,
        `Snow and landslides have cut the network at the temple for ${title}. The havan is being performed as planned, and the crew will send the video as soon as they are back in the studio. The video and the prasad courier may be a little late.`.slice(0, 500),
        now, now + 3 * 86_400_000,
      ).run();
    }
  } catch (err) {
    await trackException(env, err, { route: "admin2_weather_notice:ai_incident", handled: true, app_name: APP, extra: { listing_id: id } });
  }
  return json(out);
}

export const ADMIN2_WEATHER_NOTICE_ROUTES: Admin2RouteDef[] = [
  { method: "GET", path: new RegExp(`^/api/admin/v2/events/${ID}/weather-delay$`), handler: (req, env, [id]) => adminWeatherDelayCount(req, env, id) },
  { method: "POST", path: new RegExp(`^/api/admin/v2/events/${ID}/weather-delay$`), handler: (req, env, [id]) => adminWeatherDelaySend(req, env, id) },
];
