// avatok-consumers — one Worker consuming all 4 queues + cron cleanup.
import type { Env, ModerationMsg, PushMsg, EmailMsg, AnalyticsMsg, BrainMsg, DeletionMsg, WalletTxMsg, AgentMsg, ArchiveMsg, MktAudioMsg, AutoReplyMsg, AutoDigestMsg } from "./types";
import { handleMktAudio } from "./mkt_audio";
import { handleAutoReply, handleAutoDigest, sweepAutoDigest } from "./auto_reply"; // STREAM F — away auto-responder job + away digest (+ schedule-end sweep)
import { sweepAbandonedLiveness } from "./liveness_sweep"; // STREAM H — abandoned-liveness sweep (ported from worker/routes/liveness_audit)
import { handleModeration } from "./moderation";
import { handlePush } from "./fcm";
import { handleBrain, purgeChurnedBrains } from "./brain";
import { handleArchive } from "./archive";
import { handleDeletion } from "./deletion";
import { handleWalletTx } from "./wallet";
import { handleAgent } from "./agent";
import { reconWallet } from "./recon";
import { storageSnapshots, storageBilling } from "./storage";
import { bookingReminderLadder, gcalSyncSweep } from "./calendar";
import { moneySweep } from "./money_sweep";

export default {
  // Queue consumer — dispatch by queue name; ack on success, retry on transient error.
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    // Staging queues are suffixed "-staging" (e.g. wallet-transactions-staging);
    // normalize so the same dispatch table serves prod AND staging.
    const q = batch.queue.replace(/-staging$/, "");
    // Analytics: send the whole batch to PostHog in ONE /batch call (50× fewer HTTP calls).
    if (q === "analytics") { await captureBatch(batch, env); return; }

    let ok = 0, fail = 0;
    for (const msg of batch.messages) {
      try {
        switch (q) {
          case "moderation": await handleModeration(msg.body as ModerationMsg, env); break;
          case "push-notifications": await handlePush(msg.body as PushMsg, env); break;
          case "email": await sendEmail(msg.body as EmailMsg, env); break;
          case "brain-events": await handleBrain(msg.body as BrainMsg, env); break;
          case "account-deletions": await handleDeletion(msg.body as DeletionMsg, env); break;
          case "wallet-transactions": await handleWalletTx(msg.body as WalletTxMsg, env); break;
          case "agent-tasks": await handleAgent(msg.body as AgentMsg, env); break;
          case "chat-archive": await handleArchive(msg.body as ArchiveMsg, env); break;
          case "mkt-audio": await handleMktAudio(msg.body as MktAudioMsg, env); break;
          case "auto-reply": { // STREAM F — reply jobs + away-digest jobs share this queue
            const body = msg.body as AutoReplyMsg | AutoDigestMsg;
            if ((body as AutoDigestMsg).kind === "digest") await handleAutoDigest(body as AutoDigestMsg, env);
            else await handleAutoReply(body as AutoReplyMsg, env);
            break;
          }
        }
        msg.ack(); ok++;
      } catch (e) {
        console.error(`[${batch.queue}] retry:`, String(e));
        msg.retry(); fail++;
      }
    }
    try { env.ANALYTICS?.writeDataPoint({ blobs: ["queue", batch.queue], doubles: [ok, fail], indexes: ["queue"] }); } catch { /* best-effort */ }
  },

  // Cron — money sweep every minute (Phase 7); reminders every 15m
  // (lightweight); heavy cleanup only on the 6h tick.
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    // Phase 7: refund/settlement SWEEP — catches missed DO alarms + settles
    // ended sessions (enqueue-only; the engine in avatok-api is idempotent, so
    // the system is alarm-precise AND cron-safe).
    // [MONEY-SWEEP-GATE-1] Only sweep when wallet top-ups are live. At launch
    // Stripe is TEST + top-ups are off, so the sweep's 6 D1 reads/min × (prod +
    // staging) buy nothing. Flip WALLET_TOPUP_ENABLED="1" when real money is on.
    if (env.WALLET_TOPUP_ENABLED === "1") {
      try {
        const n = await moneySweep(env);
        if (n) env.ANALYTICS?.writeDataPoint({ blobs: ["money_sweep"], doubles: [n], indexes: ["money"] });
      } catch (e) { console.error("[money-sweep]", String(e)); }
    }
    if ((event as any).cron === "* * * * *") return; // minute tick: sweep only

    // Phase 5: T-24h / T-60m / T-10m reminder ladder + gcal inbound-sync fallback.
    try { await bookingReminderLadder(env, sendEmail); } catch (e) { console.error("[reminders]", String(e)); }
    try { await gcalSyncSweep(env); } catch (e) { console.error("[gcal]", String(e)); }

    // STREAM H [LIVE-GATE-1] — mark verification attempts stuck 'pending' >15 min as
    // 'abandoned' (+ one liveness_audit row each). Idempotent + bounded (200/run), so
    // it's safe on every 15-min tick. Ported into consumers (liveness_sweep.ts) since
    // the worker's routes/liveness_audit.ts can't be imported across the package split.
    try {
      const { swept } = await sweepAbandonedLiveness(env);
      if (swept) env.ANALYTICS?.writeDataPoint({ blobs: ["liveness_abandon_sweep"], doubles: [swept], indexes: ["cron"] });
    } catch (e) { console.error("[liveness-sweep]", String(e)); }

    // STREAM F (AUTOREP-4) — schedule-end / hours-expiry away-digest sweep. Finds
    // users whose responder window just CLOSED (no PUT fired the transition) and who
    // auto-replied to someone today, then enqueues ONE digest job each (kind:"digest"
    // on the auto-reply queue). Idempotent via a per-window KV marker; bounded.
    try {
      const { fired, scanned } = await sweepAutoDigest(env);
      if (fired) env.ANALYTICS?.writeDataPoint({ blobs: ["auto_digest_sweep"], doubles: [fired, scanned], indexes: ["cron"] });
    } catch (e) { console.error("[auto-digest-sweep]", String(e)); }

    if ((event as any).cron && (event as any).cron !== "0 */6 * * *") return; // 15m tick: reminders + sweeps only

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
    // [BRAIN-CHURN-1] Reclaim Vectorize + DB_BRAIN storage for users with no durable
    // brain activity in 90 days (else storage only ever grows). Bounded; self-dedups.
    try {
      const purged = await purgeChurnedBrains(env, 90, 200);
      if (purged) env.ANALYTICS?.writeDataPoint({ blobs: ["brain_churn_purge"], doubles: [purged], indexes: ["cron"] });
    } catch (e) { console.error("[brain-churn]", String(e)); }

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

    // Wallet reconciliation (Phase 2, A2) — nightly, on the midnight 6h tick.
    // Every wallet_accounts bucket and every recently-active user's WalletDO is
    // checked against the double-entry ledger; mismatches email ALERT_EMAIL.
    if (new Date().getUTCHours() === 0) {
      try { await reconWallet(env); } catch (e) { console.error("[recon]", String(e)); }
      // AvaStorage (Phase 4): daily usage snapshot (trend mini-bars) + the
      // monthly 20-coins/GB over-quota billing run on the 1st (idempotent op_id).
      try { await storageSnapshots(env); } catch (e) { console.error("[storage-snap]", String(e)); }
      if (new Date().getUTCDate() === 1) {
        try {
          const r = await storageBilling(env);
          env.ANALYTICS?.writeDataPoint({ blobs: ["storage_billing"], doubles: [r.charged, r.locked], indexes: ["storage"] });
        } catch (e) { console.error("[storage-billing]", String(e)); }
      }
    }
  },
};

// (Phase 5: the old 1h/30m calendarReminders moved to src/calendar.ts as the
// T-24h/T-60m/T-10m bookingReminderLadder — emails+push, idempotent flags.)

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
      // Reply-To lets a server-sent "invite a friend" mail route replies back to
      // the inviter, while the verified `sender` stays noreply@avatok.ai.
      ...(msg.replyTo?.email ? { replyTo: { email: msg.replyTo.email, ...(msg.replyTo.name ? { name: msg.replyTo.name } : {}) } } : {}),
      subject: msg.subject,
      htmlContent: msg.html,
      // Phase 5: ICS attachments (base64) — Brevo "attachment" shape.
      ...(msg.attachments?.length ? { attachment: msg.attachments.map((a) => ({ name: a.name, content: a.content })) } : {}),
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
