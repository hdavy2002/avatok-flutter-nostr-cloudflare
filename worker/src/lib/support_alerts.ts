// [HF-SUPPORT-1] Admin WhatsApp alerts: one per new ticket and per customer reply, to support_settings.alert_whatsapp.
//
// Burst control (rulebook 24.5): a D1 window counter (support_alert_window, one row per minute) counts the alerts wanted. The first 10
// in a minute go out individually; from the 11th on, nothing individual is sent and ONE summary for that minute is queued after the
// minute ends. URGENT tickets bypass the counter and always alert individually.
//
// There is no every-minute cron (a "* * * * *" trigger halted every cron on 2026-10-10: see wrangler.toml [triggers]), so summaries are
// flushed by (a) the next alert that arrives, (b) the inbound consumer after each batch, and (c) the */5 cron. Worst case a summary lags by <5 min.
import type { Env } from "../types";
import { BRAND } from "./brand";
import { enqueueWhatsApp } from "./whatsapp_queue";
import { CATEGORIES, clip, getSetting, MINUTE_MS, supportSiteOrigin, ticketCode } from "./support_core";

export const ALERT_INDIVIDUAL_LIMIT = 10;

export type AlertKind = "new" | "reply";
export interface AlertTicket { number: number; subject: string; category: string; priority: string }
export type AlertOutcome = "sent" | "summarised" | "no_number" | "failed";

const label = (c: string): string => (CATEGORIES as Record<string, string>)[c] ?? c;

function individualText(kind: AlertKind, t: AlertTicket): string {
  const head = kind === "new" ? `New ${BRAND.name} ticket ${ticketCode(t.number)}` : `Customer replied on ${ticketCode(t.number)}`;
  const urgent = t.priority === "urgent" ? "URGENT: " : "";
  return `${urgent}${head} (${label(t.category)}): ${clip(t.subject.replace(/\s+/g, " "), 70)}\n${supportSiteOrigin()}`;
}

/** `ref` makes the alert idempotent (a ticket number for "new", a message id for "reply"): a queue/consumer retry never double-alerts. */
export async function alertAdmin(env: Env, kind: AlertKind, t: AlertTicket, ref: string, now = Date.now()): Promise<AlertOutcome> {
  const to = await getSetting(env, "alert_whatsapp");
  if (!to) return "no_number";
  const send = async (lane: "priority" | "normal"): Promise<AlertOutcome> => {
    const r = await enqueueWhatsApp(env, { to, text: individualText(kind, t), kind: "support_alert", lane, key: `support-alert:${kind}:${ref}` });
    return r.status === "invalid" || r.status === "failed" ? "failed" : "sent";
  };
  if (t.priority === "urgent") return send("priority");

  const minute = Math.floor(now / MINUTE_MS);
  let n = 0;
  try {
    const row = await env.DB_META.prepare(
      `INSERT INTO support_alert_window (minute,n,new_n,reply_n) VALUES (?1,1,?2,?3)
       ON CONFLICT(minute) DO UPDATE SET n=n+1, new_n=new_n+?2, reply_n=reply_n+?3 RETURNING n`,
    ).bind(minute, kind === "new" ? 1 : 0, kind === "reply" ? 1 : 0).first<{ n: number }>();
    n = Number(row?.n ?? 1);
  } catch { n = 1; } // counter unavailable: alert individually rather than lose the alert
  const out = n <= ALERT_INDIVIDUAL_LIMIT ? await send("normal") : "summarised";
  await flushAlertSummaries(env, now).catch(() => 0);
  return out;
}

/** Queue one summary per finished minute that had more than 10 alerts. Returns how many summaries were queued. */
export async function flushAlertSummaries(env: Env, now = Date.now()): Promise<number> {
  const to = await getSetting(env, "alert_whatsapp");
  const current = Math.floor(now / MINUTE_MS);
  let rows: Array<{ minute: number; n: number; new_n: number; reply_n: number }> = [];
  try {
    rows = (await env.DB_META.prepare(
      "SELECT minute,n,new_n,reply_n FROM support_alert_window WHERE n>?1 AND summarised=0 AND minute<?2 ORDER BY minute LIMIT 20",
    ).bind(ALERT_INDIVIDUAL_LIMIT, current).all<{ minute: number; n: number; new_n: number; reply_n: number }>()).results ?? [];
  } catch { return 0; }
  let queued = 0;
  for (const r of rows) {
    const claim = await env.DB_META.prepare("UPDATE support_alert_window SET summarised=1 WHERE minute=?1 AND summarised=0").bind(r.minute).run();
    if ((claim.meta?.changes ?? 0) === 0) continue;
    if (!to) continue;
    const extra = r.n - ALERT_INDIVIDUAL_LIMIT;
    const res = await enqueueWhatsApp(env, {
      to, kind: "support_alert_summary", lane: "normal", key: `support-alert:sum:${r.minute}`,
      text: `${BRAND.name} support: busy minute. ${extra} more update${extra === 1 ? "" : "s"} were not sent one by one (${r.new_n} new ticket${r.new_n === 1 ? "" : "s"} and ${r.reply_n} customer repl${r.reply_n === 1 ? "y" : "ies"} in total that minute).\n${supportSiteOrigin()}`,
    });
    if (res.status !== "invalid" && res.status !== "failed") queued++;
  }
  try { await env.DB_META.prepare("DELETE FROM support_alert_window WHERE minute<?1").bind(current - 2 * 24 * 60).run(); } catch { /* tidy only */ }
  return queued;
}
