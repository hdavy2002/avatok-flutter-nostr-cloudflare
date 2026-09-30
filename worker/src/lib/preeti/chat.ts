// [SAATHUM-PREETI-1 2026-09-30] The chat turn pipeline: persist -> budget gate -> (grounding) -> Gemini tool loop
// -> filtered SSE (PreetiStreamEvent) -> persist + spend + telemetry. Exports streamPreetiTurn (SSE Response) and
// askPreetiOnce (non-streamed, used by the admin brand-change check).
import type { Env } from "../../types";
import { CORS } from "../../util";
import { track, trackException } from "../../hooks";
import { currentBrand, fillPlaceholders, scrubFormerNames } from "./brand_runtime";
import { resolveArticleCard, resolveEventCard, ritualIndex } from "./cards";
import type { PageCtx, PreetiCard, PreetiStreamEvent } from "./contracts";
import { OVER_BUDGET_REPLY } from "./core_rules";
import { StreamFilter, type FilterOut } from "./filter";
import { costMicroUsd, groundNotes, preetiModel, recordGeneration, runModelTurn, shouldGround } from "./gemini";
import { buildSystemPrompt } from "./prompt";
import { budgetState, recordSpend } from "./spend";
import {
  activePrompt, createConversation, getAgentConfig, getConv, getPromptBody, insertMessage, modelHistory, updateConversation, type ConvRow,
} from "./store";
import { handoverUrl, type ToolCtx } from "./tools";
import { ensurePreetiStore } from "./knowledge";

const APP = "saathum";
export const MAX_MESSAGE_CHARS = 2000;
const FALLBACK_TEXT = "Sorry, I could not answer that just now. Please try asking again, or tap “Talk to a human” and our team will help you on WhatsApp.";

export interface TurnArgs {
  conversationId: string; message: string; page: PageCtx; uid?: string | null; visitorId?: string | null;
  promptOverrideId?: string; isTest?: boolean;
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

  const [cfg, brand] = await Promise.all([getAgentConfig(env), currentBrand(env)]);
  const message = String(a.message ?? "").trim().slice(0, MAX_MESSAGE_CHARS);
  if (!message) { await send({ type: "error", code: "empty", message: "Empty message." }); return { conv }; }

  // History BEFORE saving this turn, former names scrubbed.
  const history = (await modelHistory(env, conv.id, 20)).map((h) => ({ role: h.role, text: scrubFormerNames(h.text, brand) }));
  await insertMessage(env, conv.id, { role: "visitor", text: message });
  await updateConversation(env, conv.id, { last_page: page.path });

  const support = handoverUrl(cfg, brand, cfg.name, conv.id);
  const finishFixed = async (text: string, code: string) => {
    await send({ type: "delta", text });
    await send({ type: "handover", url: support });
    const id = await insertMessage(env, conv!.id, { role: "preeti", text, blocked: false });
    await send({ type: "done", message_id: id });
    await track(env, uid ?? "anon", "preeti_turn", APP, { conversation_id: conv!.id, outcome: code, is_test: isTest, latency_ms: Date.now() - t0 }, traceId);
  };

  // Budget gate BEFORE any Gemini call.
  const budget = await budgetState(env);
  if (budget.over) {
    await finishFixed(fillPlaceholders(OVER_BUDGET_REPLY, brand, cfg.name), "over_budget");
    return { conv };
  }
  if (!(env.GEMINI_API_KEY ?? "").trim()) {
    await send({ type: "error", code: "ai_unavailable", message: "The assistant is unavailable right now." });
    return { conv };
  }

  const filter = new StreamFilter(brand);
  const cards: PreetiCard[] = [];
  const toolRows: { name: string; summary: string }[] = [];
  let handover = false;
  const toolCtx: ToolCtx = { env, brand, agentName: cfg.name, cfg, conv, uid, traceId };

  // Serialise async emission (cards need D1) behind a promise chain so ordering is preserved.
  let chain: Promise<void> = Promise.resolve();
  const emit = (outs: FilterOut[]) => {
    for (const o of outs) {
      chain = chain.then(async () => {
        if (o.kind === "text") { await send({ type: "delta", text: o.text }); return; }
        if (cards.length >= 2) return;
        const card = o.card === "event" ? await resolveEventCard(env, brand, o.ref) : await resolveArticleCard(brand, o.ref);
        if (card) { cards.push(card); await send({ type: "card", card }); }
      }).catch((e) => trackException(env, e, { route: "preeti.emit", handled: true, app_name: APP, extra: { conversation_id: conv!.id } }));
    }
  };

  let usage = { inTok: 0, outTok: 0 }; let blocked = false; let model = "";
  let toolsUsed: string[] = []; let rounds = 0; let grounded = false; let failed: string | null = null;
  try {
    model = await preetiModel(env);
    const persona = a.promptOverrideId ? (await getPromptBody(env, a.promptOverrideId)) ?? (await activePrompt(env)).body : (await activePrompt(env)).body;
    const articles = await ritualIndex(brand);
    const system = buildSystemPrompt({
      brand, agentName: cfg.name, persona, page, signedIn: !!uid,
      firstName: conv.name ? conv.name.trim().split(/\s+/)[0] : null, hasPhone: !!conv.e164, now: Date.now(), articles,
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

  let text = filter.clean.trim();
  if (!text) {
    if (failed && !blocked) { await send({ type: "error", code: "ai_unavailable", message: "The assistant is unavailable right now." }); }
    else { text = FALLBACK_TEXT; await send({ type: "delta", text }); blocked = true; }
  }
  if (failed && !text) {
    // Failure with nothing said: still record the visitor turn's cost (may be tiny) and stop.
    const cost = costMicroUsd(model || "x", usage);
    if (cost > 0) await recordSpend(env, cost);
    return { conv };
  }

  if (handover || toolCtx.handoverUrl) await send({ type: "handover", url: toolCtx.handoverUrl ?? support });
  else if (filter.meta?.mood === "angry" && !blocked) {
    // Angry customer: offer the human hand-off link without auto-notifying ops (the model can call the tool itself).
    await send({ type: "handover", url: support });
  }

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
    latency_ms: Date.now() - t0,
  }, traceId);
  await send({ type: "done", message_id: messageId });
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

