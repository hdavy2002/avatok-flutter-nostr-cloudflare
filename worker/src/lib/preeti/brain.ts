// [AUMFE-PREETI-BRAIN-1 2026-10-02] Preeti on the SHARED BRAIN (same customer memory, tradition library and catalogue as
// Pandit ji and Meera). Everything here is ADMIN-PREVIEW ONLY: chat.ts turns it on with `guides` = signed-in uid that
// lib/preview.ts canSeeGuides() lets through. Anonymous visitors (no uid) are never previewers and never reach this file.
//
//   tools   search_catalog / search_tradition are the SAME tool objects Pandit ji and Meera use (lib/guides/brain.ts,
//           imported, not copied); suggest_guide and remember are Preeti's own thin wrappers.
//   memory  one agent_memory session per active stretch of conversation (agent "preeti", channel "chat"): started on the
//           first guide turn, closed + summarised when the chat goes idle (next turn, or the 5-minute cron sweep).
//           Memory consent is enforced inside agent_memory (remember / endSession / summarise all check hasConsent).
import type { Env } from "../../types";
import { track, trackException } from "../../hooks";
import { buildBriefing, endSession, startSession } from "../agent_memory";
import { sharedGuideTools } from "../guides/brain";
import type { GuideCard, GuideToolCtx } from "../guides/types";
import { rememberTool } from "../voice_agents/memory_tools";
import type { VoiceTool } from "../voice_agents/types";
import { absUrl } from "./cards";
import type { PreetiCard } from "./contracts";
import { latestConvForUid } from "./store";
import type { ToolCtx } from "./tools";

const APP = "saathum";
export const PREETI_AGENT = "preeti";
/** A chat quiet for this long is "idle": its memory session is closed and summarised. */
export const IDLE_MS = 30 * 60_000;
/** Most tool-made cards (items + guide hand-offs) one reply may show. */
export const MAX_TOOL_CARDS = 4;

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
const SHARED_NAMES = ["search_catalog", "search_tradition"] as const;
const sharedTool = (name: string): VoiceTool | undefined => sharedGuideTools().find((t) => t.decl.name === name);

const SUGGEST_GUIDE_DECL = {
  name: "suggest_guide",
  description:
    "Hand the customer to a guide for a reading. Shows a card for Pandit ji (free text astrology chat) or Meera (paid voice guide, per minute from the wallet). " +
    "Use it when the customer wants a kundli, horoscope, palmistry, numerology or any personal reading. You never give the reading yourself.",
  parameters: { type: "OBJECT", properties: {
    guide: { type: "STRING", enum: ["pandit", "meera"], description: "pandit = free text chat, meera = paid voice call." },
    reason: { type: "STRING", description: "One short line on why this guide fits this customer." },
  }, required: ["guide"] },
};

const REMEMBER_DECL = {
  name: "remember",
  description:
    "Save ONE short durable fact the customer told you about themselves (name they like, family, goal, worry, language). Call it quietly while you keep talking; never announce it. " +
    "Never birth details, card numbers, passwords or health details.",
  parameters: { type: "OBJECT", properties: { fact: { type: "STRING", description: "The fact in third person, under 160 characters." } }, required: ["fact"] },
};

/** True when this turn has a live memory session (signed-in previewer). */
const memoryOn = (ctx: ToolCtx): boolean => !!ctx.guides && !!ctx.uid && !!ctx.memorySessionId;

/** Function declarations the shared-brain adds for THIS turn (empty unless guides). */
export function guideDeclarations(ctx: ToolCtx): unknown[] {
  if (!ctx.guides) return [];
  const out: unknown[] = SHARED_NAMES.map((n) => sharedTool(n)?.decl).filter(Boolean);
  out.push(SUGGEST_GUIDE_DECL);
  if (memoryOn(ctx)) out.push(REMEMBER_DECL);
  return out;
}

export const GUIDE_TOOL_NAMES = new Set<string>([...SHARED_NAMES, "suggest_guide", "remember"]);

/** Catalogue hit -> the card Preeti's chat renders. */
export function itemCard(ctx: ToolCtx, c: GuideCard): PreetiCard {
  return {
    type: "item", kind: c.kind, id: c.subject_id, title: c.title, image: c.image_url ? absUrl(ctx.brand, c.image_url) : null,
    price_rupees: c.price_inr, deity: c.deity, read_more_url: absUrl(ctx.brand, c.url),
  };
}

export function guideCard(ctx: ToolCtx, guide: "pandit" | "meera"): PreetiCard {
  return guide === "pandit"
    ? { type: "guide", guide, name: "Pandit ji", blurb: "Free text chat for astrology and your questions.", free: true, url: `${ctx.brand.site}/pandit` }
    : { type: "guide", guide, name: "Meera", blurb: "Talk by voice, paid per minute from your wallet.", free: false, url: `${ctx.brand.site}/talk?guide=astrology` };
}

/** Show a tool-made card once per turn and log the recommendation (no shared ai_recommendations logger exists yet). */
function show(ctx: ToolCtx, card: PreetiCard, itemId: string, kind: string): void {
  const seen = (ctx.shown ??= new Set<string>());
  const key = `${kind}:${itemId}`;
  if (seen.has(key) || seen.size >= MAX_TOOL_CARDS) return;
  seen.add(key);
  ctx.showCard?.(card);
  void track(ctx.env, ctx.uid ?? "anon", "preeti_recommendation_shown", APP, {
    item_id: itemId, kind, uid: ctx.uid, conversation_id: ctx.conv.id, signed_in: !!ctx.uid, is_test: !!ctx.conv.is_test,
  });
}

export const GUIDE_TOOL_SUMMARY: Record<string, (r: any) => string> = {
  search_catalog: (r) => `${r?.items?.length ?? 0} items`,
  search_tradition: (r) => `${r?.passages?.length ?? 0} passages`,
  suggest_guide: (r) => (r?.shown ? `guide ${r.guide}` : "no guide"),
  remember: (r) => (r?.saved ? "saved" : `not saved (${r?.reason ?? "?"})`),
};

/** Run one shared-brain tool. Throws are caught by runTool (telemetry + a polite failure result). */
export async function runGuideTool(ctx: ToolCtx, name: string, args: any): Promise<unknown> {
  if (!ctx.guides || !ctx.uid) return { error: "unknown_tool" };
  if (name === "suggest_guide") {
    const g = args?.guide === "pandit" || args?.guide === "meera" ? (args.guide as "pandit" | "meera") : null;
    if (!g) return { shown: false, error: "guide_must_be_pandit_or_meera" };
    show(ctx, guideCard(ctx, g), g, "guide");
    await track(ctx.env, ctx.uid, "preeti_guide_suggested", APP, { guide: g, reason: clip(args?.reason, 120), conversation_id: ctx.conv.id });
    return {
      shown: true, guide: g, free: g === "pandit",
      instruction: g === "pandit"
        ? "A card for Pandit ji (free, text) is now shown. Say in one or two warm sentences that he can do the reading for free by text; do not write a link."
        : "A card for Meera (paid voice call, per minute from the wallet) is now shown. Say in one or two warm sentences that she can do the reading by voice, charged per minute from the wallet; do not quote a price or write a link.",
    };
  }
  if (name === "remember") {
    if (!memoryOn(ctx)) return { saved: false, reason: "no_session" };
    const r = (await rememberTool.run({ env: ctx.env, uid: ctx.uid, sessionId: ctx.memorySessionId!, agentId: PREETI_AGENT }, args ?? {})) as { saved?: boolean; reason?: string; detail?: string };
    await track(ctx.env, ctx.uid, "preeti_memory_remember", APP, { saved: !!r?.saved, reason: r?.reason ?? null, detail: r?.detail ?? null, conversation_id: ctx.conv.id });
    return r;
  }
  const tool = sharedTool(name);
  if (!tool) return { error: "unknown_tool" };
  const gctx: GuideToolCtx = {
    env: ctx.env, uid: ctx.uid, sessionId: ctx.memorySessionId ?? ctx.conv.id, agentId: PREETI_AGENT,
    showGuideCard: (c) => show(ctx, itemCard(ctx, c), c.subject_id, c.kind),
  };
  return await tool.run(gctx, args ?? {});
}

// ---------------------------------------------------------------------------
// Memory sessions
// ---------------------------------------------------------------------------
export interface ActiveSession { id: string; started_at: number }

async function activeSession(env: Env, uid: string): Promise<ActiveSession | null> {
  return await env.DB_META.prepare(
    `SELECT id, started_at FROM agent_sessions WHERE uid=?1 AND agent=?2 AND status='active' ORDER BY started_at DESC LIMIT 1`,
  ).bind(uid, PREETI_AGENT).first<ActiveSession>();
}

/** "Customer: ..." / "Preeti: ..." lines of the stretch [fromMs, toMs]. */
async function transcriptBetween(env: Env, conversationId: string, fromMs: number, toMs: number): Promise<{ text: string; messages: number }> {
  const rs = await env.DB_META.prepare(
    `SELECT role, text FROM ai_messages WHERE conversation_id=?1 AND role IN ('visitor','preeti') AND blocked=0
        AND created_at>=?2 AND created_at<=?3 ORDER BY id ASC LIMIT 200`,
  ).bind(conversationId, fromMs, toMs).all<{ role: string; text: string }>();
  const rows = rs.results ?? [];
  return { text: rows.map((r) => `${r.role === "visitor" ? "Customer" : "Preeti"}: ${r.text}`).join("\n"), messages: rows.length };
}

/** End + summarise one Preeti memory session. Never throws; reports through telemetry. */
export async function closePreetiSession(
  env: Env, uid: string, conversationId: string, sess: ActiveSession, reason: "idle_turn" | "sweep", endMs: number,
  ctx?: { waitUntil(p: Promise<unknown>): void },
): Promise<void> {
  try {
    const t = await transcriptBetween(env, conversationId, sess.started_at, endMs);
    const ok = await endSession(env, uid, sess.id, t.text, { ctx });
    void track(env, uid, "preeti_memory_session_closed", APP, { session_id: sess.id, conversation_id: conversationId, reason, messages: t.messages, ok });
  } catch (e) {
    await trackException(env, e, { uid, route: "preeti.memory.close", handled: true, app_name: APP, extra: { session_id: sess.id, reason } });
    void track(env, uid, "preeti_memory_session_closed", APP, { session_id: sess.id, conversation_id: conversationId, reason, ok: false });
  }
}

export interface MemoryOpen { sessionId: string | null; briefing: string; stale: ActiveSession | null }

/**
 * Called once per guide turn for a signed-in previewer: reuse the active session, or (after an idle gap) mark the old one
 * stale for the caller to close AFTER the reply, and start a fresh one. The briefing is built in parallel.
 */
export async function openMemory(env: Env, uid: string, conversationId: string, lastMessageAt: number, now = Date.now()): Promise<MemoryOpen> {
  try {
    const cur = await activeSession(env, uid);
    const stale = cur && now - lastMessageAt > IDLE_MS ? cur : null;
    const reuse = cur && !stale ? cur : null;
    const [sessionId, briefing] = await Promise.all([
      reuse ? Promise.resolve(reuse.id) : startSession(env, uid, PREETI_AGENT, "chat"),
      buildBriefing(env, uid, PREETI_AGENT),
    ]);
    if (!reuse) void track(env, uid, "preeti_memory_session_started", APP, { session_id: sessionId, conversation_id: conversationId, rotated: !!stale, briefing_chars: briefing.length });
    return { sessionId, briefing, stale };
  } catch (e) {
    await trackException(env, e, { uid, route: "preeti.memory.open", handled: true, app_name: APP, extra: { conversation_id: conversationId } });
    return { sessionId: null, briefing: "", stale: null };
  }
}

/**
 * Cron sweep (cheap: one query when nothing is open): close Preeti memory sessions whose chat has been quiet
 * for IDLE_MS. Safe to call every tick.
 */
export async function closeIdlePreetiSessions(env: Env, now = Date.now()): Promise<number> {
  let closed = 0;
  try {
    const rs = await env.DB_META.prepare(
      `SELECT id, uid, started_at FROM agent_sessions WHERE agent=?1 AND status='active' AND started_at<?2 ORDER BY started_at ASC LIMIT 25`,
    ).bind(PREETI_AGENT, now - IDLE_MS).all<{ id: string; uid: string; started_at: number }>();
    for (const s of rs.results ?? []) {
      const conv = await latestConvForUid(env, s.uid);
      const last = conv?.last_message_at ?? s.started_at;
      if (now - last < IDLE_MS) continue;
      await closePreetiSession(env, s.uid, conv?.id ?? "", { id: s.id, started_at: s.started_at }, "sweep", last);
      closed++;
    }
    if (rs.results?.length) void track(env, "system", "preeti_memory_sweep", APP, { scanned: rs.results.length, closed });
  } catch (e) {
    await trackException(env, e, { route: "preeti.memory.sweep", handled: true, app_name: APP });
  }
  return closed;
}
