// [SAATHUM-PREETI-LEADGATE-1 2026-09-30] "Forward our chat to you": once a conversation has been idle 30 minutes
// and has new messages since the last transcript, email it to the address the visitor (or signed-in user) gave.
// Called every cron tick from scheduled(). Idempotent per (conversation, through_id) through the email outbox key.
import type { Env } from "../../types";
import { track, trackException } from "../../hooks";
import { escapeHtml } from "../../cal/emails";
import { enqueueEmail } from "../email_outbox";
import { currentBrand, scrubFormerNames } from "./brand_runtime";
import type { BrandRuntime } from "./contracts";
import { getAgentConfig } from "./store";

const APP = "saathum";
const IDLE_MS = 30 * 60_000;
const MAX_PER_TICK = 20;
const MAX_MESSAGES = 100;
const LINK_RE = /(https?:\/\/[^\s<>"']+)/g;

/** Escape, then turn URLs into links and line breaks into <br>. */
function renderText(text: string): string {
  const esc = escapeHtml(text);
  return esc.replace(LINK_RE, (u) => `<a href="${u}">${u}</a>`).replace(/\n/g, "<br>");
}

function cardLinks(cardsJson: unknown): string[] {
  try {
    const a = JSON.parse(String(cardsJson ?? "[]"));
    if (!Array.isArray(a)) return [];
    return a.flatMap((c: any) => (c?.type === "event"
      ? [`<a href="${escapeHtml(String(c.read_more_url ?? ""))}">${escapeHtml(String(c.title ?? ""))}</a>`]
      : c?.type === "article" ? [`<a href="${escapeHtml(String(c.url ?? ""))}">${escapeHtml(String(c.title ?? ""))}</a>`] : []));
  } catch { return []; }
}

function buildHtml(brand: BrandRuntime, agent: string, visitorName: string | null, rows: any[]): string {
  const who = escapeHtml(visitorName?.trim() || "You");
  const items = rows.map((r) => {
    const label = r.role === "visitor" ? who : escapeHtml(agent);
    const links = cardLinks(r.cards_json);
    return `<p style="margin:0 0 12px"><strong>${label}</strong><br>${renderText(scrubFormerNames(String(r.text ?? ""), brand))}${links.length ? `<br>${links.join("<br>")}` : ""}</p>`;
  }).join("");
  return `
  <div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px;line-height:1.5">
    <h2 style="margin:0 0 16px">Your chat with ${escapeHtml(agent)}</h2>
    ${items}
    <p style="color:#999;font-size:12px;margin-top:20px">${escapeHtml(brand.name)} · <a href="${escapeHtml(brand.site)}">${escapeHtml(brand.domain)}</a></p>
  </div>`;
}

export async function runPreetiTranscriptEmails(env: Env): Promise<{ sent: number }> {
  const now = Date.now();
  const due = await env.DB_META.prepare(
    `SELECT id, name, email, mx FROM (
       SELECT c.id, c.name, c.email, c.transcript_sent_through_id AS t,
              (SELECT MAX(m.id) FROM ai_messages m WHERE m.conversation_id=c.id AND m.role IN ('visitor','preeti') AND m.blocked=0) AS mx
         FROM ai_conversations c
        WHERE c.email IS NOT NULL AND c.is_test=0 AND c.last_message_at < ?1
          AND c.last_message_at > COALESCE(c.transcript_sent_at, 0))
      WHERE mx IS NOT NULL AND mx > COALESCE(t, 0) ORDER BY mx LIMIT ?2`,
  ).bind(now - IDLE_MS, MAX_PER_TICK).all<{ id: string; name: string | null; email: string; mx: number }>();
  const list = due.results ?? [];
  if (!list.length) return { sent: 0 };
  const [brand, cfg] = await Promise.all([currentBrand(env), getAgentConfig(env)]);
  let sent = 0;
  for (const c of list) {
    try {
      const ms = await env.DB_META.prepare(
        `SELECT role, text, cards_json FROM ai_messages WHERE conversation_id=?1 AND role IN ('visitor','preeti') AND blocked=0 AND id<=?2
          ORDER BY id DESC LIMIT ?3`,
      ).bind(c.id, c.mx, MAX_MESSAGES).all<any>();
      const rows = (ms.results ?? []).reverse();
      if (!rows.length) continue;
      const r = await enqueueEmail(env, {
        to: c.email, subject: `Your chat with ${cfg.name} — ${brand.name}`, html: buildHtml(brand, cfg.name, c.name, rows),
        kind: "preeti_transcript", recipientId: c.id, messageVersion: "preeti-transcript.v1",
        outboxKey: `preeti-transcript:${c.id}:${c.mx}`,
      });
      if (r.status === "unavailable" || (r.status === "failed" && !r.durable)) {
        await trackException(env, new Error(`preeti_transcript_enqueue_${r.status}`), { route: "preeti.transcript", handled: true, app_name: APP, extra: { conversation_id: c.id } });
        continue; // retry next tick
      }
      if (r.status === "failed") await trackException(env, new Error("preeti_transcript_send_failed"), { route: "preeti.transcript", handled: true, app_name: APP, extra: { conversation_id: c.id } });
      await env.DB_META.prepare("UPDATE ai_conversations SET transcript_sent_through_id=?2, transcript_sent_at=?3 WHERE id=?1").bind(c.id, c.mx, now).run();
      if (r.status !== "failed") {
        sent++;
        await track(env, "system", "preeti_transcript_emailed", APP, { conversation_id: c.id, through_id: c.mx, messages: rows.length });
      }
    } catch (e) {
      await trackException(env, e, { route: "preeti.transcript", handled: true, app_name: APP, extra: { conversation_id: c.id } });
    }
  }
  return { sent };
}
