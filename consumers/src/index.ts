// avatok-consumers — one Worker consuming all 4 queues + cron cleanup.
import type { Env, ModerationMsg, PushMsg, EmailMsg, AnalyticsMsg, BrainMsg, DeletionMsg, WalletTxMsg, AgentMsg } from "./types";
import { handleModeration } from "./moderation";
import { handlePush } from "./fcm";
import { handleBrain } from "./brain";
import { handleDeletion } from "./deletion";
import { handleWalletTx } from "./wallet";
import { handleAgent } from "./agent";

export default {
  // Queue consumer — dispatch by queue name; ack on success, retry on transient error.
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    // Analytics: send the whole batch to PostHog in ONE /batch call (50× fewer HTTP calls).
    if (batch.queue === "analytics") { await captureBatch(batch, env); return; }

    let ok = 0, fail = 0;
    for (const msg of batch.messages) {
      try {
        switch (batch.queue) {
          case "moderation": await handleModeration(msg.body as ModerationMsg, env); break;
          case "push-notifications": await handlePush(msg.body as PushMsg, env); break;
          case "email": await sendEmail(msg.body as EmailMsg, env); break;
          case "brain-events": await handleBrain(msg.body as BrainMsg, env); break;
          case "account-deletions": await handleDeletion(msg.body as DeletionMsg, env); break;
          case "wallet-transactions": await handleWalletTx(msg.body as WalletTxMsg, env); break;
          case "agent-tasks": await handleAgent(msg.body as AgentMsg, env); break;
        }
        msg.ack(); ok++;
      } catch (e) {
        console.error(`[${batch.queue}] retry:`, String(e));
        msg.retry(); fail++;
      }
    }
    try { env.ANALYTICS?.writeDataPoint({ blobs: ["queue", batch.queue], doubles: [ok, fail], indexes: ["queue"] }); } catch { /* best-effort */ }
  },

  // Cron — reminders every 15m (lightweight); heavy cleanup only on the 6h tick.
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    await calendarReminders(env);
    if ((event as any).cron && (event as any).cron !== "0 */6 * * *") return; // 15m tick: reminders only

    const dayAgo = Date.now() - 86_400_000;
    // Public uploads stuck 'pending' >24h (failed/lost moderation) → reject.
    const r1 = await env.DB_MEDIA.prepare(
      "UPDATE user_media SET moderation_status='rejected' WHERE moderation_status='pending' AND created_at < ?1",
    ).bind(dayAgo).run();
    // Lift expired temp blocks.
    const r2 = await env.DB_META.prepare(
      "UPDATE account_status SET status='active', blocked_until=NULL WHERE status='temp_blocked' AND blocked_until IS NOT NULL AND blocked_until < ?1",
    ).bind(Date.now()).run();
    // Drop verification docs >90 days past decision (spec §3.7 retention).
    const r3 = await env.DB_META.prepare(
      "UPDATE verification_requests SET document_front_key=NULL, document_back_key=NULL, selfie_key=NULL, liveness_video_key=NULL WHERE reviewed_at IS NOT NULL AND reviewed_at < ?1",
    ).bind(Date.now() - 90 * 86_400_000).run();
    // AvaBrain: prune the short-TTL raw event buffer + expired facts. (Importance
    // decay is LAZY at read time — no full-table rewrite here.)
    const now = Date.now();
    await env.DB_BRAIN.prepare("DELETE FROM brain_events WHERE expires_at < ?1").bind(now).run();
    await env.DB_BRAIN.prepare("DELETE FROM brain_facts WHERE expires_at IS NOT NULL AND expires_at < ?1").bind(now).run();

    // Wallet (Phase 2): mark matured earning holds released in the D1 mirror.
    // (WalletDO releases authoritatively via its own alarm; this keeps D1 tidy.)
    try { if (env.DB_WALLET) await env.DB_WALLET.prepare("UPDATE earning_holds SET released=1 WHERE released=0 AND available_at<=?1").bind(now).run(); } catch { /* table may not exist */ }

    // Backstop (§10.5): process matured deletion requests whose enqueue was lost.
    // The row is self-contained (carries clerk_user_id + pubkey_hex).
    try {
      const due = await env.DB_META.prepare(
        "SELECT uid, clerk_user_id, pubkey_hex FROM deletion_requests WHERE status='pending' AND scheduled_at < ?1 LIMIT 20",
      ).bind(now).all();
      for (const r of (due.results ?? []) as any[]) {
        try { await handleDeletion({ uid: r.uid, clerk_user_id: r.clerk_user_id, pubkey_hex: r.pubkey_hex }, env); }
        catch (e) { console.error("[deletion-backstop]", String(e)); }
      }
    } catch { /* table may not exist pre-Phase-1 */ }
    try {
      env.ANALYTICS?.writeDataPoint({ blobs: ["cron"], doubles: [r1.meta?.changes ?? 0, r2.meta?.changes ?? 0, r3.meta?.changes ?? 0], indexes: ["cron"] });
    } catch { /* best-effort */ }

    // Workers AI daily budget alarm (Scale proposal Phase 0). bumpAiSpend()
    // counts every model call into ai_spend; alert ONCE per day when today's
    // calls exceed AI_DAILY_CALL_BUDGET (default 5000).
    try {
      const budget = Number(env.AI_DAILY_CALL_BUDGET || "5000");
      const day = new Date().toISOString().slice(0, 10);
      const row = await env.DB_MODERATION.prepare(
        "SELECT calls, ms, alerted FROM ai_spend WHERE day=?1",
      ).bind(day).first<{ calls: number; ms: number; alerted: number }>();
      if (row && row.calls > budget && !row.alerted) {
        await sendEmail({
          to: env.ALERT_EMAIL || "hdavy2005@gmail.com",
          subject: `[avatok] AI budget exceeded: ${row.calls} calls today (budget ${budget})`,
          html: `<p>Workers AI made <b>${row.calls}</b> model calls today (${day}), over the daily budget of ${budget}.</p>
                 <p>Total model time: ${(row.ms / 1000).toFixed(0)}s. Check the moderation/brain queues for a spike or abuse, and the ai_moderation / brain dashboards.</p>`,
        }, env);
        await env.DB_MODERATION.prepare("UPDATE ai_spend SET alerted=1 WHERE day=?1").bind(day).run();
        env.ANALYTICS?.writeDataPoint({ blobs: ["ai_budget_alert"], doubles: [row.calls, budget], indexes: ["ai_budget"] });
      }
    } catch { /* ai_spend table may not exist yet */ }
  },
};

// --- AvaCalendar reminders (§10.2): 1h + 30m before start, deduped by flags ---
async function calendarReminders(env: Env): Promise<void> {
  if (!env.Q_PUSH) return;
  const now = Date.now();
  const h1Lo = now + 30 * 60_000, h1Hi = now + 60 * 60_000;   // 1h band
  const m30Hi = now + 30 * 60_000;                             // 30m band (now..30m)
  try {
    const due60 = await env.DB_META.prepare(
      "SELECT id, owner_npub, title, start_at FROM calendar_events WHERE status='confirmed' AND reminded_60=0 AND start_at>?1 AND start_at<=?2 LIMIT 100",
    ).bind(h1Lo, h1Hi).all();
    for (const e of (due60.results ?? []) as any[]) {
      try { await env.Q_PUSH.send({ kind: "notify", to: e.owner_npub, fromName: "Reminder", title: "In ~1 hour", body: e.title, data: { deeplink: "/calendar" } }); } catch { /* best-effort */ }
      await env.DB_META.prepare("UPDATE calendar_events SET reminded_60=1 WHERE id=?1").bind(e.id).run();
    }
    const due30 = await env.DB_META.prepare(
      "SELECT id, owner_npub, title, start_at FROM calendar_events WHERE status='confirmed' AND reminded_30=0 AND start_at>?1 AND start_at<=?2 LIMIT 100",
    ).bind(now, m30Hi).all();
    for (const e of (due30.results ?? []) as any[]) {
      try { await env.Q_PUSH.send({ kind: "notify", to: e.owner_npub, fromName: "Reminder", title: "Starting soon", body: e.title, data: { deeplink: "/calendar" } }); } catch { /* best-effort */ }
      await env.DB_META.prepare("UPDATE calendar_events SET reminded_30=1, reminded_60=1 WHERE id=?1").bind(e.id).run();
    }
  } catch { /* tables may not exist pre-Phase-3 */ }
}

// --- email consumer (Brevo / Sendinblue transactional API) ---
// Parses an optional "Name <addr@host>" sender into Brevo's {name,email} shape.
function parseSender(from?: string): { name: string; email: string } {
  const def = { name: "AvaTok", email: "noreply@avatok.ai" };
  if (!from) return def;
  const m = from.match(/^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/);
  if (m) return { name: (m[1] || def.name).trim(), email: m[2].trim() };
  return { name: def.name, email: from.trim() };
}

async function sendEmail(msg: EmailMsg, env: Env): Promise<void> {
  if (!env.BREVO_API_KEY) { console.warn("BREVO_API_KEY unset; skipping email"); return; }
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": env.BREVO_API_KEY, "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender: parseSender(msg.from),
      to: [{ email: msg.to }],
      subject: msg.subject,
      htmlContent: msg.html,
    }),
  });
  if (!res.ok) throw new Error("Brevo send failed: " + res.status + " " + (await res.text()).slice(0, 200));
}

// --- analytics consumer (PostHog /batch; identity by uid only, never PII) ---
async function captureBatch(batch: MessageBatch, env: Env): Promise<void> {
  if (!env.POSTHOG_API_KEY) { for (const m of batch.messages) m.ack(); return; } // no-op until configured
  const events = batch.messages.map((m) => {
    const b = m.body as AnalyticsMsg;
    return {
      event: b.event,
      distinct_id: b.uid ?? "anonymous",
      properties: b.props ?? {},
      timestamp: new Date(b.ts ?? Date.now()).toISOString(),
    };
  });
  try {
    const res = await fetch(`${env.POSTHOG_HOST}/batch/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: env.POSTHOG_API_KEY, batch: events }),
    });
    if (!res.ok) throw new Error("PostHog batch failed: " + res.status);
    for (const m of batch.messages) m.ack();
  } catch (e) {
    console.error("[analytics] retry batch:", String(e));
    for (const m of batch.messages) m.retry();
  }
}
