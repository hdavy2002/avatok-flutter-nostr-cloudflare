// [HF-PRESENCE-NUDGE-1] While a LIVE host is showing offline, remind her about every 3 hours (WhatsApp, plus a push when she has the app)
// that she is offline and how to switch on. Only between 08:00 and 23:00 Asia/Kolkata. She can pause the reminders
// (PUT /api/hosts/me/presence/nudges). Rulebook HF-HOST-NUDGE-1. Flag hfPresenceNudgeEnabled (default off).
//
//  - Runs from the existing 5-minute cron (runHfCallsCron). Each host is claimed with one atomic UPDATE of nudge_last_at before anything is
//    sent, so two overlapping runs can never message the same host twice. A transient provider failure gives the claim back so the next
//    tick retries; a missing number / "not on WhatsApp" keeps it (nothing to retry for 3 h).
//  - WasenderAPI is an unofficial gateway: sends are paced (1 s apart) and a run stops at the first rate limit or after 3 provider errors.
//  - Never throws.
import type { Env } from "../types";
import { BRAND } from "./brand";
import { sendWhatsAppText } from "./whatsapp_send";
import { verifiedWhatsAppNumber } from "./whatsapp_notify";
import { pushPresenceNudge } from "./hf_push";
import { isClosing } from "./hf_exit";
import { IST_OFFSET_MS } from "./hf_ist";
import { readConfig } from "../routes/config";
import { track, trackException } from "../hooks";

const APP = BRAND.slug;
export const NUDGE_EVERY_MS = 3 * 3600_000;
export const NUDGE_FROM_HOUR_IST = 8;  // inclusive
export const NUDGE_UNTIL_HOUR_IST = 23; // exclusive: the last reminder goes out before 23:00
export const NUDGE_MAX_PER_RUN = 200;
const SEND_GAP_MS = 1000;
const MAX_PROVIDER_ERRORS = 3;
const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export async function hfPresenceNudgeOn(env: Env): Promise<boolean> {
  try { return ((await readConfig(env)) as unknown as Record<string, unknown>).hfPresenceNudgeEnabled === true; } catch { return false; }
}

/** True from 08:00 up to (not including) 23:00 on the Asia/Kolkata clock. */
export function inNudgeWindow(now: number): boolean {
  const h = new Date(now + IST_OFFSET_MS).getUTCHours();
  return h >= NUDGE_FROM_HOUR_IST && h < NUDGE_UNTIL_HOUR_IST;
}

export function presenceNudgeText(displayName: string | null | undefined): string {
  const name = (displayName ?? "").trim().replace(/\s+/g, " ").slice(0, 60) || "there";
  return `Hi ${name}, FYI — you're showing as offline on ${BRAND.name}, so callers can't reach you. Forgotten to switch on? Open the app › Host tab › turn the switch on. Reply STOP to pause these reminders.`;
}

export interface NudgeRunResult { scanned: number; ok: number; skipped: number; failed: number; reason?: string }

export async function runHfPresenceNudge(env: Env, now: number = Date.now(), o: { gapMs?: number } = {}): Promise<NudgeRunResult> {
  const out: NudgeRunResult = { scanned: 0, ok: 0, skipped: 0, failed: 0 };
  try {
    if (!(await hfPresenceNudgeOn(env))) return { ...out, reason: "flag_off" };
    if (!inNudgeWindow(now)) return { ...out, reason: "outside_hours" };
    const cut = now - NUDGE_EVERY_MS;
    const rows = (await env.DB_META.prepare(
      `SELECT uid, display_name, nudge_last_at FROM hf_hosts
        WHERE status='live' AND presence='offline' AND nudge_paused=0 AND (nudge_last_at IS NULL OR nudge_last_at < ?1)
        ORDER BY COALESCE(nudge_last_at, 0) LIMIT ?2`,
    ).bind(cut, NUDGE_MAX_PER_RUN).all<{ uid: string; display_name: string | null; nudge_last_at: number | null }>()).results ?? [];
    let providerErrors = 0;
    for (const h of rows) {
      out.scanned++;
      // Claim first. Re-checks every condition, so a host who switched on or paused a moment ago is left alone.
      const claim = await env.DB_META.prepare(
        `UPDATE hf_hosts SET nudge_last_at=?1 WHERE uid=?2 AND status='live' AND presence='offline' AND nudge_paused=0 AND (nudge_last_at IS NULL OR nudge_last_at < ?3)`,
      ).bind(now, h.uid, cut).run();
      if (!claim.meta?.changes) continue;
      let outcome: "ok" | "skipped" | "failed" = "skipped";
      let reason = "";
      let giveBack = false;
      let stop = false;
      let attempted = false;
      try {
        if (await isClosing(env, h.uid)) { reason = "account_closing"; }
        else {
          let waSent = false;
          const e164 = await verifiedWhatsAppNumber(env, h.uid);
          if (!e164) reason = "no_verified_whatsapp";
          else {
            attempted = true;
            const r = await sendWhatsAppText(env, e164, presenceNudgeText(h.display_name));
            if (r.ok) waSent = true;
            else if (r.reason === "not_on_whatsapp" || r.reason === "unconfigured") reason = r.reason;
            else {
              reason = r.reason; outcome = "failed"; giveBack = true; providerErrors++;
              if (r.reason === "rate_limited" || providerErrors >= MAX_PROVIDER_ERRORS) stop = true;
            }
          }
          const pushed = giveBack ? false : await pushPresenceNudge(env, undefined, h.uid);
          if (waSent || pushed) { outcome = "ok"; reason = waSent && pushed ? "whatsapp_push" : waSent ? "whatsapp" : "push"; }
        }
      } catch (e) {
        outcome = "failed"; reason = "exception"; giveBack = true; providerErrors++;
        if (providerErrors >= MAX_PROVIDER_ERRORS) stop = true;
        await trackException(env, e, { route: "hf_presence_nudge", uid: h.uid, handled: true, app_name: APP, extra: { area: "hf_presence_nudge" } });
      }
      if (giveBack) {
        // Transient failure: hand the slot back (only if nobody changed it since) so the next 5-minute tick retries.
        await env.DB_META.prepare("UPDATE hf_hosts SET nudge_last_at=?1 WHERE uid=?2 AND nudge_last_at=?3").bind(h.nudge_last_at, h.uid, now).run().catch(() => undefined);
      }
      out[outcome]++;
      void track(env, h.uid, "hf_presence_nudge_sent", APP, { area: "hf_presence_nudge", outcome, reason }).catch(() => undefined);
      if (stop) break;
      if (attempted) await sleep(o.gapMs ?? SEND_GAP_MS); // pace real WhatsApp sends only
    }
  } catch (e) {
    await trackException(env, e, { route: "hf_presence_nudge", handled: true, app_name: APP, extra: { area: "hf_presence_nudge" } });
  }
  return out;
}
