// Cloudflare Email Sending delivery-events consumer (Q "email-events" /
// "email-events-staging"). Closes the delivered_at gap left by §3 (accept-time
// only): Cloudflare delivers message.delivered / .deferred / .bounced /
// .complained / .rejected events onto this queue (event subscription, source
// Email Sending, domain avatok.ai — see Specs/PLAN-2026-09-11-EMAIL-CLOUDFLARE-
// PRIMARY-BREVO-FALLBACK.md §5). Idempotent on payload.eventId (Cloudflare
// event delivery is at-least-once); never moves email_outbox.delivery_status
// backwards (delivered beats deferred; bounced/complained/rejected are
// terminal). On complaint / hard bounce / provider-suppressed-rejection also
// records the address into email_suppressions so the Brevo FALLBACK lane
// (which has no bounce visibility of its own) does not happily re-mail it.
import type { Env } from "./types";

export interface EmailSendingEvent {
  type?: string;
  source?: { type?: string; zoneId?: string; domain?: string };
  payload?: {
    eventId?: string;
    messageId?: string;
    sender?: string;
    recipient?: string;
    subject?: string;
    terminal?: boolean;
    delivery?: { status?: string; smtpStatusCode?: string; smtpEnhancedStatusCode?: string; smtpResponse?: string };
    bounce?: { type?: string; classification?: string; reason?: string };
    rejection?: { reason?: string; party?: string; detail?: string };
  };
  metadata?: { accountId?: string; eventSubscriptionId?: string; eventSchemaVersion?: number; eventTimestamp?: string };
}

type EventKind = "delivered" | "deferred" | "bounced" | "complained" | "rejected";

function classify(type: string): EventKind | null {
  // "cf.email.sending.message.<kind>"
  const m = /\.message\.(delivered|deferred|bounced|complained|rejected)$/.exec(type);
  return (m?.[1] as EventKind | undefined) ?? null;
}

async function recordSuppression(
  env: Env,
  recipient: string | undefined,
  reason: "complaint" | "hard_bounce" | "rejected",
  detail: string,
  now: number,
): Promise<void> {
  const email = (recipient ?? "").trim().toLowerCase();
  if (!email) return;
  await env.DB_META.prepare(
    "INSERT OR IGNORE INTO email_suppressions (email, reason, source, detail, created_at) VALUES (?1,?2,'cloudflare',?3,?4)",
  ).bind(email, reason, detail.slice(0, 500), now).run();
}

export async function handleEmailEvent(evt: EmailSendingEvent, env: Env): Promise<void> {
  const kind = evt?.type ? classify(evt.type) : null;
  const payload = evt?.payload;
  if (!kind || !payload || !payload.eventId) {
    console.warn("[email-events] malformed or unknown event, dropping:", JSON.stringify(evt).slice(0, 500));
    return;
  }

  const ts = Date.parse(evt.metadata?.eventTimestamp ?? "") || Date.now();

  let claimed = false;
  try {
    // Idempotency — Cloudflare event delivery is at-least-once.
    const seen = await env.DB_META.prepare(
      "INSERT OR IGNORE INTO email_events_seen (event_id, seen_at) VALUES (?1,?2)",
    ).bind(payload.eventId, ts).run();
    if ((seen.meta?.changes ?? 0) === 0) return;
    claimed = true;

    const errorMessage = (
      payload.bounce?.reason || payload.rejection?.detail || payload.delivery?.smtpResponse || ""
    ).slice(0, 500);

    let row: { outbox_key: string; delivery_status: string | null } | null = null;
    if (payload.messageId) {
      row = await env.DB_META.prepare(
        "SELECT outbox_key, delivery_status FROM email_outbox WHERE provider='cloudflare' AND provider_message_id=?1 LIMIT 1",
      ).bind(payload.messageId).first<{ outbox_key: string; delivery_status: string | null }>();
    }
    if (!row) {
      // Web/recon sends (or a message this Worker never enqueued) have no
      // outbox row — still fine; the suppression step below is unconditional.
      console.log(`[email-events] no outbox row for messageId=${payload.messageId ?? "?"} type=${kind}`);
    } else {
      const current = row.delivery_status;
      const isSoftBounce = kind === "bounced" && payload.bounce?.type !== "hard" && !payload.terminal;

      if (kind === "delivered") {
        if (current !== "delivered" && current !== "bounced") {
          await env.DB_META.prepare(
            `UPDATE email_outbox SET delivery_status='delivered', delivered_at=?2,
               last_event='delivered', last_event_at=?2, error_message=NULL
             WHERE outbox_key=?1`,
          ).bind(row.outbox_key, ts).run();
        }
      } else if (kind === "deferred" || isSoftBounce) {
        if (current !== "delivered" && current !== "bounced") {
          await env.DB_META.prepare(
            "UPDATE email_outbox SET last_event=?2, last_event_at=?3 WHERE outbox_key=?1",
          ).bind(row.outbox_key, kind, ts).run();
        }
      } else {
        // Terminal: bounced (hard/terminal), complained, rejected.
        if (current === "delivered") {
          // Post-delivery complaint/late event — record it but don't regress state.
          await env.DB_META.prepare(
            "UPDATE email_outbox SET last_event=?2, last_event_at=?3 WHERE outbox_key=?1",
          ).bind(row.outbox_key, kind, ts).run();
        } else if (current !== "bounced") {
          // Bounced is final: a later complaint/rejection must not overwrite bounced_at.
          await env.DB_META.prepare(
            `UPDATE email_outbox SET state='failed', delivery_status='bounced', bounced_at=?2,
               last_event=?3, last_event_at=?2, error_message=?4, next_attempt_at=NULL
             WHERE outbox_key=?1`,
          ).bind(row.outbox_key, ts, kind, errorMessage).run();
        }
      }
    }

    // Suppression — unconditional on outbox-row presence (§5 step 4).
    if (kind === "complained") {
      await recordSuppression(env, payload.recipient, "complaint", errorMessage, ts);
    } else if (kind === "bounced" && payload.bounce?.type === "hard") {
      // Hard bounces only (§5 step 4). Cloudflare also emits a terminal
      // message.bounced when SOFT-bounce retries are exhausted (mailbox full,
      // greylisting) — those must not permanently block the Brevo fallback lane.
      await recordSuppression(env, payload.recipient, "hard_bounce", errorMessage, ts);
    } else if (kind === "rejected" && payload.rejection?.reason === "suppressed") {
      await recordSuppression(env, payload.recipient, "rejected", errorMessage, ts);
    }
  } catch (error) {
    // Release the idempotency marker so the redelivery actually re-processes the
    // event (otherwise a transient D1 failure after the marker insert would drop
    // it forever). Every write above is guarded/idempotent, so a replay is safe.
    if (claimed) {
      try {
        await env.DB_META.prepare("DELETE FROM email_events_seen WHERE event_id=?1").bind(payload.eventId).run();
      } catch { /* best-effort; the queue retry below still happens */ }
    }
    // Let the queue retry the batch message — index.ts's catch calls msg.retry().
    throw error;
  }
}
