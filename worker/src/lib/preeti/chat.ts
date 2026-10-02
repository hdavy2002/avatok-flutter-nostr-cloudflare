// [SAATHUM-PREETI-1 2026-09-30] The chat turn pipeline: persist -> budget gate -> (grounding) -> Gemini tool loop
// -> filtered SSE (PreetiStreamEvent) -> persist + spend + telemetry. Exports streamPreetiTurn (SSE Response) and
// askPreetiOnce (non-streamed, used by the admin brand-change check).
import type { Env } from "../../types";
import { CORS } from "../../util";
import { track, trackException } from "../../hooks";
import { canSeeGuides } from "../preview";
import { closePreetiSession, openMemory, type ActiveSession } from "./brain";
import { currentBrand, fillPlaceholders, scrubFormerNames } from "./brand_runtime";
import { resolveArticleCard, resolveEventCard, ritualIndex } from "./cards";
import type { PageCtx, PreetiCard, PreetiStreamEvent } from "./contracts";
import { OVER_BUDGET_REPLY, OVER_BUDGET_REPLY_HI } from "./core_rules";
import { IDENTITY_ASK_MODEL, identityAskText, looksHinglish } from "./leadgate";
import { StreamFilter, type FilterOut } from "./filter";
import { costMicroUsd, groundNotes, preetiModel, recordGeneration, runModelTurn, shouldGround } from "./gemini";
import { buildSystemPrompt } from "./prompt";
import { budgetState, recordSpend } from "./spend";
import {
  activePrompt, createConversation, getAgentConfig, getConv, getPromptBody, insertMessage, modelHistory, pendingVisitorMessages, updateConversation, type ConvRow,
} from "./store";
import { handoverUrl, type ToolCtx } from "./tools";
import { ensurePreetiStore } from "./knowledge";

const APP = "saathum";
export const MAX_MESSAGE_CHARS = 2000;
const FALLBACK_TEXT = "Sorry, I could not answer that just now. Please try asking again in a moment 🙏";

export interface TurnArgs {
  conversationId: string; message: string; page: PageCtx; uid?: string | null; visitorId?: string | null;
  promptOverrideId?: string; isTest?: boolean;
  /** [SAATHUM-PREETI-LEADGATE-1] anonymous visitor: no email + WhatsApp on file -> fixed ask, no model call. */
  requireIdentity?: boolean;
  /** answer the unanswered visitor message(s) already stored (after identification); `message` is ignored. */
  answerPending?: boolean;
  /** the route created the conversation for this message: emit the `session` event first. */
  announceSession?: boolean;
}
type Send = (ev: PreetiStreamEvent) => Promise<void>;

function pageOf(p: PageCtx | undefined): PageCtx {
  const kind = p && ["home", "article", "event", "other"].includes(p.kind) ? p.kind : "other";
  return { path: String(p?.path ?? "/").slice(0, 200), kind, ref: p?.ref ? String(p.ref).slice(0, 80) : undefined };
}

async function runTurn(env: Env, a: TurnArgs, send: Send): Promise<{ conv: ConvRow | null }> {
  const t0 = Date.now();
  const traceId = crypto.randomUUID();
  const isTest = !!a.isTest;
  const page = pageOf(a.page);
  const uid = a.uid ?? null;

  let conv = await getConv(env, a.conversationId);
  if (!conv && isTest) conv = await createConversation(env, { id: a.conversationId || undefined, visitorId: a.visitorId ?? "admin-test", page: page.path, isTest: true, uid: null });
  if (!conv) { await send({ type: "error", code: "not_found", message: "Conversation not found." }); return { conv: null }; }

  let message = String(a.message ?? "").trim().slice(0, MAX_MESSAGE_CHARS);
  let historyBefore: number | undefined;
  if (a.answerPending) {
    const pending = await pendingVisitorMessages(env, conv.id);
    if (!pending.length) { await send({ type: "error", code: "nothing_pending", message: "Nothing to answer." }); return { conv }; }
    message = pending.map((p) => p.text).join("\n").slice(0, MAX_MESSAGE_CHARS * 2);
    historyBefore = pending[0].id;
  }
  if (!message) { await send({ type: "error", code: "empty", message: "Empty message." }); return { conv }; }

  // [SAATHUM-PREETI-LEADGATE-1] Anonymous visitor without email + WhatsApp: store the message, answer with the fixed
  // ask (no Gemini call, no spend), then tell the widget to show its form.
  if (a.requireIdentity && !isTest && !(conv.email && conv.e164)) {
    if (!a.answerPending) {
      await insertMessage(env, conv.id, { role: "visitor", text: message });
      await updateConversation(env, conv.id, { last_page: page.path });
      const ask = identityAskText(message);
      await send({ type: "delta", text: ask });
      const askId = await insertMessage(env, conv.id, { role: "preeti", text: ask, model: IDENTITY_ASK_MODEL });
      await send({ type: "identity_required" });
      await send({ type: "done", message_id: askId });
      await track(env, "anon", "preeti_identity_asked", APP, { conversation_id: conv.id, lang: looksHinglish(message) ? "hi" : "en", page_kind: page.kind });
      await track(env, "anon", "preeti_turn", APP, { conversation_id: conv.id, outcome: "identity_asked", is_test: false, latency_ms: Date.now() - t0 }, traceId);
    } else {
      await send({ type: "identity_required" });
      await send({ type: "done", message_id: 0 });
    }
    return { conv };
  }

  // [SAATHUM-PREETI-FAST-2] Every read below is independent; run them together instead of ~10 serial
  // D1/KV round trips (≈4s of silence before the first word on 2026-09-30).
  const brand = await currentBrand(env); // in-isolate cache: normally instant
  const convRow = conv;
  // [AUMFE-PREETI-BRAIN-1] Shared brain (hand-offs, recommendations, memory) is admin-preview only: a signed-in previewer.
  // No uid is never a previewer, even if guidesPublic is on, so anonymous visitors always get today's Preeti.
  const guidesCheck = async (): Promise<boolean> => {
    if (!uid) return false;
    try { return await canSeeGuides(env, uid); } catch (e) {
      await trackException(env, e, { route: "preeti.guides_gate", handled: true, app_name: APP, extra: { conversation_id: convRow.id } });
      return false;
    }
  };
  const [cfg, rawHistory, budget, model0, persona, articles, guides] = await Promise.all([
    getAgentConfig(env),
    modelHistory(env, convRow.id, 20, historyBefore), // history BEFORE saving this turn
    budgetState(env),
    preetiModel(env),
    a.promptOverrideId
      ? getPromptBody(env, a.promptOverrideId).then(async (b) => b ?? (await activePrompt(env)).body)
      : activePrompt(env).then((p) => p.body),
    ritualIndex(brand),
    guidesCheck(),
  ]);
  const history = rawHistory.map((h) => ({ role: h.role, text: scrubFormerNames(h.text, brand) }));
  // Saving the visitor turn runs alongside the model call; awaited before Preeti's reply is stored,
  // so message ids keep conversation order.
  const saved = Promise.all([
    a.answerPending ? Promise.resolve(0) : insertMessage(env, convRow.id, { role: "visitor", text: message }),
    updateConversation(env, convRow.id, { last_page: page.path }),
  ]);

  const support = handoverUrl(cfg, brand, cfg.name, conv.id);
  const finishFixed = async (text: string, code: string) => {
    await saved;
    await send({ type: "delta", text });
    const id = await insertMessage(env, conv!.id, { role: "preeti", text, blocked: false });
    await send({ type: "done", message_id: id });
    await track(env, uid ?? "anon", "preeti_turn", APP, { conversation_id: conv!.id, outcome: code, is_test: isTest, latency_ms: Date.now() - t0 }, traceId);
  };

  // Budget gate BEFORE any Gemini call.
  if (budget.over) {
    await finishFixed(fillPlaceholders(looksHinglish(message) ? OVER_BUDGET_REPLY_HI : OVER_BUDGET_REPLY, brand, cfg.name), "over_budget");
    return { conv };
  }
  if (!(env.GEMINI_API_KEY ?? "").trim()) {
    await saved;
    await send({ type: "error", code: "ai_unavailable", message: "The assistant is unavailable right now." });
    return { conv };
  }

  const filter = new StreamFilter(brand);
  const cards: PreetiCard[] = [];
  const toolRows: { name: string; summary: string }[] = [];
  let handover = false;
  const toolCtx: ToolCtx = { env, brand, agentName: cfg.name, cfg, conv, uid, traceId, guides };

  // [AUMFE-PREETI-BRAIN-1] Customer memory: signed-in previewer, real (non-test) chat only. One session per active stretch of
  // chat; an idle gap closes + summarises the old one after this reply. Consent is enforced inside agent_memory.
  let briefing = "";
  let stale: ActiveSession | null = null;
  if (guides && uid && !isTest) {
    const m = await openMemory(env, uid, conv.id, conv.last_message_at);
    toolCtx.memorySessionId = m.sessionId; briefing = m.briefing; stale = m.stale;
  }
  const closeStale = async () => { if (stale && uid) { const s = stale; stale = null; await closePreetiSession(env, uid, conv!.id, s, "idle_turn", conv!.last_message_at); } };
  let markerCards = 0;

  // Serialise async emission (cards need D1) behind a promise chain so ordering is preserved.
  let chain: Promise<void> = Promise.resolve();
  const emit = (outs: FilterOut[]) => {
    for (const o of outs) {
      chain = chain.then(async () => {
        if (o.kind === "text") { await send({ type: "delta", text: o.text }); return; }
        if (markerCards >= 2) return;
        const card = o.card === "event" ? await resolveEventCard(env, brand, o.ref) : await resolveArticleCard(brand, o.ref);
        if (card) { markerCards++; cards.push(card); await send({ type: "card", card }); }
      }).catch((e) => trackException(env, e, { route: "preeti.emit", handled: true, app_name: APP, extra: { conversation_id: conv!.id } }));
    }
  };

  // [AUMFE-PREETI-BRAIN-1] cards made by tools (catalogue items, guide hand-offs), kept in order behind the text chain.
  toolCtx.showCard = (card) => {
    chain = chain.then(async () => { cards.push(card); await send({ type: "card", card }); })
      .catch((e) => trackException(env, e, { route: "preeti.tool_card", handled: true, app_name: APP, extra: { conversation_id: conv!.id } }));
  };

  let usage = { inTok: 0, outTok: 0 }; let blocked = false; let model = "";
  let toolsUsed: string[] = []; let rounds = 0; let grounded = false; let failed: string | null = null;
  try {
    model = model0;
    const system = buildSystemPrompt({
      brand, agentName: cfg.name, persona, page, signedIn: !!uid,
      firstName: conv.name ? conv.name.trim().split(/\s+/)[0] : null, hasPhone: !!conv.e164, now: Date.now(), articles,
      guides, briefing,
    });

    let notes = "";
    const groundUsage = { inTok: 0, outTok: 0 };
    if (shouldGround(message)) {
      try {
        const store = cfg.store_name || (await ensurePreetiStore(env));
        const recent = history.slice(-4).map((h) => `${h.role === "visitor" ? "User" : "Assistant"}: ${h.text.slice(0, 200)}`).join("\n");
        const g = await groundNotes(env, model, store, message, recent);
        notes = scrubFormerNames(g.notes, brand); groundUsage.inTok = g.usage.inTok; groundUsage.outTok = g.usage.outTok; grounded = !!notes;
      } catch (e) {
        // A timeout is expected under load: answer without notes, no exception noise.
        const timedOut = (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError";
        if (!timedOut) await trackException(env, e, { route: "preeti.ground", handled: true, app_name: APP, extra: { conversation_id: conv.id } });
      }
    }

    const res = await runModelTurn({
      env, ctx: toolCtx, brand, agentName: cfg.name, model, system, history, userText: message, notes,
      onText: (t) => emit(filter.push(t)),
      onTool: (name, _args, summary) => { toolRows.push({ name, summary }); if (name === "handover_to_human") handover = true; },
    });
    usage = { inTok: res.usage.inTok + groundUsage.inTok, outTok: res.usage.outTok + groundUsage.outTok };
    blocked = res.blocked; toolsUsed = res.toolsUsed; rounds = res.rounds;
  } catch (e) {
    failed = String((e as Error)?.message ?? e).slice(0, 200);
    await trackException(env, e, { route: "preeti.turn", handled: true, app_name: APP, extra: { conversation_id: conv.id, model } });
  }
  emit(filter.finish());
  await chain;
  await saved;

  let text = filter.clean.trim();
  if (!text) {
    if (failed && !blocked) { await send({ type: "error", code: "ai_unavailable", message: "The assistant is unavailable right now." }); }
    else { text = FALLBACK_TEXT; await send({ type: "delta", text }); blocked = true; }
  }
  if (failed && !text) {
    // Failure with nothing said: still record the visitor turn's cost (may be tiny) and stop.
    const cost = costMicroUsd(model || "x", usage);
    if (cost > 0) await recordSpend(env, cost);
    await closeStale();
    return { conv };
  }

  // [SAATHUM-PREETI-LEADGATE-1] The handover link appears ONLY when the model called handover_to_human (customer asked for a human).
  if (handover || toolCtx.handoverUrl) await send({ type: "handover", url: toolCtx.handoverUrl ?? support });

  const cost = costMicroUsd(model, usage);
  for (const r of toolRows) await insertMessage(env, conv.id, { role: "tool", text: "", tool_name: r.name, tool_summary: r.summary });
  const messageId = await insertMessage(env, conv.id, {
    role: "preeti", text, cards, model, input_tokens: usage.inTok, output_tokens: usage.outTok, cost_micro_usd: cost, blocked,
  });

  const meta = filter.meta;
  const checkedBooking = toolRows.some((r) => r.name === "check_booking");
  if (meta || checkedBooking) {
    const fresh = (await getConv(env, conv.id)) ?? conv;
    const badges = new Set(fresh.badges);
    if (meta && meta.lead >= 2) badges.add("hot_lead");
    if (meta?.mood === "angry") badges.add("angry");
    if (checkedBooking) badges.add("booking_check"); // [SAATHUM-PREETI-1 review] inbox filter value
    await updateConversation(env, conv.id, { lead_score: Math.max(fresh.lead_score, meta?.lead ?? 0), badges: [...badges] });
  }
  await recordSpend(env, cost);
  await recordGeneration(env, { uid, traceId, model, usage, costUsdMicro: cost, span: "preeti_turn", latencyMs: Date.now() - t0, conversationId: conv.id, isTest });
  await track(env, uid ?? "anon", "preeti_turn", APP, {
    conversation_id: conv.id, outcome: failed ? "partial_error" : blocked ? "blocked" : "ok", model, input_tokens: usage.inTok, output_tokens: usage.outTok,
    cost_micro_usd: cost, tools: toolsUsed.join(","), tool_rounds: rounds, grounded, cards: cards.length, lead: meta?.lead ?? null,
    mood: meta?.mood ?? null, lang: meta?.lang ?? null, page_kind: page.kind, signed_in: !!uid, is_test: isTest, handover: !!(handover || toolCtx.handoverUrl),
    guides, memory: !!toolCtx.memorySessionId,
    latency_ms: Date.now() - t0,
  }, traceId);
  await send({ type: "done", message_id: messageId });
  await closeStale(); // after `done`: the customer is not kept waiting for the idle-session summary
  return { conv };
}

const enc = new TextEncoder();

/** SSE Response. The turn runs under ctx.waitUntil so it is persisted even if the client disconnects. */
export async function streamPreetiTurn(env: Env, ctx: ExecutionContext | undefined, a: TurnArgs): Promise<Response> {
  const ts = new TransformStream<Uint8Array, Uint8Array>();
  const writer = ts.writable.getWriter();
  let clientGone = false;
  const send: Send = async (ev) => {
    if (clientGone) return;
    try { await writer.write(enc.encode(`data: ${JSON.stringify(ev)}\n\n`)); }
    catch { clientGone = true; /* browser closed the stream: expected, the turn still completes and is saved */ }
  };
  // [SAATHUM-PREETI-1 review] Admin 2 handlers get no ExecutionContext (test chat): the open
  // stream keeps the isolate alive while the turn writes to it, so run it unregistered then.
  const turn = (async () => {
    let convId = a.conversationId;
    try {
      if (a.announceSession) await send({ type: "session", conversation_id: a.conversationId });
      const r = await runTurn(env, a, send);
      convId = r.conv?.id ?? convId;
    } catch (e) {
      await trackException(env, e, { route: "preeti.stream", handled: true, app_name: APP, extra: { conversation_id: a.conversationId } });
      await send({ type: "error", code: "internal", message: "Something went wrong. Please try again." });
    } finally {
      try { await writer.close(); } catch { clientGone = true; /* already closed by the client */ }
    }
  })();
  if (ctx) ctx.waitUntil(turn);
  return new Response(ts.readable, {
    headers: {
      ...CORS,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
      "x-preeti-conversation": a.conversationId,
      "access-control-expose-headers": "x-preeti-conversation",
    },
  });
}

/** Non-streamed single question (brand-change check, tests). Uses a throw-away is_test conversation. */
export async function askPreetiOnce(env: Env, question: string, opts?: { promptOverrideId?: string }): Promise<string> {
  const id = crypto.randomUUID();
  await createConversation(env, { id, visitorId: "brand-check", isTest: true, page: "/" });
  let out = "";
  try {
    await runTurn(env, { conversationId: id, message: question, page: { path: "/", kind: "home" }, isTest: true, promptOverrideId: opts?.promptOverrideId }, async (ev) => {
      if (ev.type === "delta") out += ev.text;
    });
  } finally {
    try {
      await env.DB_META.prepare("DELETE FROM ai_messages WHERE conversation_id=?1").bind(id).run();
      await env.DB_META.prepare("DELETE FROM ai_conversations WHERE id=?1").bind(id).run();
    } catch (e) { await trackException(env, e, { route: "preeti.ask_cleanup", handled: true, app_name: APP }); }
  }
  return out.trim();
}

