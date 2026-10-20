// [HF-BOOK-APPROVE-BE] "You're open for calls" alert (rulebook HF-BOOK-3). Flag hfBookingApprovalEnabled (and hfBookingsEnabled).
//
//   Cron (every tick, ~5 min): for each LIVE influencer whose availability opens a window that started in the last 10 minutes (IST), send ONE push
//   and ONE WhatsApp (paced outbox, verified number only): "You're open for calls 6-9 pm today. Expect calls."
//   - Only on days the influencer opened and only at the start of a window. A "window" = a run of consecutive open times: the app's hourly chips
//     (09:00, 10:00, ...) join when they are <= 60 min apart; a 10-minute rule-based schedule joins when <= 10 min apart.
//   - Dedupe: hf_host_open_alerts PRIMARY KEY (host_uid, date, start_min), claimed BEFORE sending.
//   - Skips: not live, account closing, the influencer switched "Open-time alerts" off (hf_hosts.open_alerts=0).
//   - Never between 23:00 and 08:00 IST unless the window itself starts then (a late tick must not wake anyone).
//   Never throws.
import type { Env } from "../types";
import { BRAND } from "./brand";
import { readConfig } from "../routes/config";
import { track, trackException } from "../hooks";
import { IST_OFFSET_MS, istDateStr } from "./hf_ist";
import { isClosing } from "./hf_exit";
import { getHfBookingSchedule } from "./hf_booking_store";
import { materialize } from "../routes/hf_bookings_app";
import { sendHfPush } from "./hf_push";
import { verifiedWhatsAppNumber } from "./whatsapp_notify";

const APP = BRAND.slug;
const MIN = 60_000;
/** A window counts as "just started" for this long (two cron ticks, so one missed tick does not lose the alert). */
export const LOOKBACK_MIN = 10;
const MAX_HOSTS = 200;

export interface OpenWindow { fromMin: number; toMin: number }

/** Collapse a day's open start-minutes into windows (see header). */
export function openWindows(starts: Iterable<number>): OpenWindow[] {
  const mins = [...new Set(starts)].sort((a, b) => a - b);
  if (!mins.length) return [];
  const hourly = mins.every((m) => m % 60 === 0);
  const gap = hourly ? 60 : 10;
  const out: OpenWindow[] = [];
  let from = mins[0], prev = mins[0];
  for (let i = 1; i <= mins.length; i++) {
    const m = mins[i];
    if (m !== undefined && m - prev <= gap) { prev = m; continue; }
    out.push({ fromMin: from, toMin: prev + (hourly ? 60 : 10) });
    from = m; prev = m;
  }
  return out;
}

const clock = (min: number): { h: number; m: number; ap: "am" | "pm" } => {
  const t = ((min % 1440) + 1440) % 1440;
  const h24 = Math.floor(t / 60);
  return { h: h24 % 12 === 0 ? 12 : h24 % 12, m: t % 60, ap: h24 < 12 ? "am" : "pm" };
};
const one = (c: ReturnType<typeof clock>, withAp: boolean) => `${c.h}${c.m ? ":" + String(c.m).padStart(2, "0") : ""}${withAp ? " " + c.ap : ""}`;
/** "6-9 pm", "9 am-12 pm", "6:30-7 pm" */
export function windowLabel(w: OpenWindow): string {
  const a = clock(w.fromMin), b = clock(w.toMin);
  return a.ap === b.ap ? `${one(a, false)}–${one(b, true)}` : `${one(a, true)}–${one(b, true)}`;
}
export const openAlertText = (label: string) => `You're open for calls ${label} today. Expect calls.`;

const quietHour = (min: number) => { const h = Math.floor((((min % 1440) + 1440) % 1440) / 60); return h >= 23 || h < 8; };

export interface OpenAlertResult { scanned: number; sent: number; skipped: number; reason?: string }

export async function runHfOpenWindowAlerts(env: Env, now = Date.now()): Promise<OpenAlertResult> {
  const out: OpenAlertResult = { scanned: 0, sent: 0, skipped: 0 };
  try {
    const cfg = (await readConfig(env)) as unknown as Record<string, unknown>;
    if (cfg.hfBookingApprovalEnabled !== true || cfg.hfBookingsEnabled !== true) return { ...out, reason: "flag_off" };
    const date = istDateStr(now);
    const nowMin = Math.floor(((now + IST_OFFSET_MS) % 86_400_000) / MIN);
    // Cheap prefilter: hosts whose stored schedule mentions today's date (app-made) or that use weekly rules.
    const hosts = (await env.DB_META.prepare(
      `SELECT h.uid FROM hf_hosts h JOIN hf_availability_schedules s ON s.host_uid=h.uid
        WHERE h.status='live' AND h.open_alerts=1 AND (s.exceptions_json LIKE ?1 OR s.rules_json NOT IN ('[]',''))
        ORDER BY h.uid LIMIT ?2`,
    ).bind(`%"date":"${date}"%`, MAX_HOSTS).all<{ uid: string }>()).results ?? [];
    for (const h of hosts) {
      out.scanned++;
      try {
        const schedule = await getHfBookingSchedule(env, h.uid);
        const starts = materialize(schedule, now).get(date);
        if (!starts?.size) { out.skipped++; continue; }
        for (const w of openWindows(starts)) {
          if (w.fromMin > nowMin || w.fromMin <= nowMin - LOOKBACK_MIN) continue; // not a window that just started
          if (quietHour(nowMin) && !quietHour(w.fromMin)) { out.skipped++; continue; }
          if (await isClosing(env, h.uid)) { out.skipped++; continue; }
          const claim = await env.DB_META.prepare("INSERT OR IGNORE INTO hf_host_open_alerts (host_uid,date,start_min,sent_at) VALUES (?1,?2,?3,?4)")
            .bind(h.uid, date, w.fromMin, now).run();
          if (!claim.meta?.changes) continue; // already sent for this window
          const text = openAlertText(windowLabel(w));
          const pushed = await sendHfPush(env, h.uid, { kind: "open_window", title: "You're open for calls", body: "Expect calls. " + windowLabel(w) + " today.", path: "/inf/availability" }).catch(() => false);
          void track(env, h.uid, "hf_open_alert_sent", APP, { channel: "push", result: pushed ? "queued" : "skipped", date, start_min: w.fromMin }).catch(() => undefined);
          let wa = "no_verified_whatsapp";
          const e164 = await verifiedWhatsAppNumber(env, h.uid).catch(() => null);
          if (e164) {
            const r = await env.DB_META.prepare(
              `INSERT OR IGNORE INTO whatsapp_outbox (checkout_id, uid, listing_id, kind, url_hash, e164, message, status, attempts, created_at, updated_at)
               VALUES (?1,?2,?3,?4,?5,?6,?7,'queued',0,?8,?8)`,
            ).bind(`hfo:${date}:${h.uid}`, h.uid, h.uid, "hf_open_alert", `w${w.fromMin}`, e164, `${BRAND.name}: ${text}`, now).run();
            wa = r.meta?.changes ? "queued" : "duplicate";
          }
          void track(env, h.uid, "hf_open_alert_sent", APP, { channel: "whatsapp", result: wa, date, start_min: w.fromMin }).catch(() => undefined);
          out.sent++;
        }
      } catch (e) {
        await trackException(env, e, { route: "hf_open_alerts", uid: h.uid, handled: true, app_name: APP, extra: { area: "hf_open_alerts" } }).catch(() => undefined);
      }
    }
  } catch (e) {
    if (!/no such (column|table)/i.test(String((e as Error)?.message ?? e))) await trackException(env, e, { route: "hf_open_alerts", handled: true, app_name: APP, extra: { area: "hf_open_alerts" } }).catch(() => undefined);
  }
  return out;
}
