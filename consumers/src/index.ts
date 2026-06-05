// avatok-consumers — one Worker consuming all 4 queues + cron cleanup.
import type { Env, ModerationMsg, PushMsg, EmailMsg, AnalyticsMsg, BrainMsg, DeletionMsg } from "./types";
import { handleModeration } from "./moderation";
import { handlePush } from "./fcm";
import { handleBrain } from "./brain";
import { handleDeletion } from "./deletion";

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
        }
        msg.ack(); ok++;
      } catch (e) {
        console.error(`[${batch.queue}] retry:`, String(e));
        msg.retry(); fail++;
      }
    }
    try { env.ANALYTICS?.writeDataPoint({ blobs: ["queue", batch.queue], doubles: [ok, fail], indexes: ["queue"] }); } catch { /* best-effort */ }
  },

  // Cron — lightweight cleanup (heavy work would re-queue). Runs every 6h.
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
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

    // Backstop (§10.5): process matured deletion requests whose enqueue was lost.
    // The row is self-contained (carries clerk_user_id + pubkey_hex).
    try {
      const due = await env.DB_META.prepare(
        "SELECT npub, clerk_user_id, pubkey_hex FROM deletion_requests WHERE status='pending' AND scheduled_at < ?1 LIMIT 20",
      ).bind(now).all();
      for (const r of (due.results ?? []) as any[]) {
        try { await handleDeletion({ npub: r.npub, clerk_user_id: r.clerk_user_id, pubkey_hex: r.pubkey_hex }, env); }
        catch (e) { console.error("[deletion-backstop]", String(e)); }
      }
    } catch { /* table may not exist pre-Phase-1 */ }
    try {
      env.ANALYTICS?.writeDataPoint({ blobs: ["cron"], doubles: [r1.meta?.changes ?? 0, r2.meta?.changes ?? 0, r3.meta?.changes ?? 0], indexes: ["cron"] });
    } catch { /* best-effort */ }
  },
};

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

// --- analytics consumer (PostHog /batch; identity by npub only, never PII) ---
async function captureBatch(batch: MessageBatch, env: Env): Promise<void> {
  if (!env.POSTHOG_API_KEY) { for (const m of batch.messages) m.ack(); return; } // no-op until configured
  const events = batch.messages.map((m) => {
    const b = m.body as AnalyticsMsg;
    return {
      event: b.event,
      distinct_id: b.npub ?? "anonymous",
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
