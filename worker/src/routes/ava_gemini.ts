// ava_gemini.ts — Ava chat (Cloudflare-native). Free/premium model 2026-06-18.
//   POST /api/ava/gemini   { message, context?, history?, images? }
//
// FREE: a basic TEXT chatbot on Workers-AI Gemma 4 (@cf/google/gemma-4-26b-a4b-it),
// rate-limited by a daily turn cap (lib/ai_gate). No coins, no AI tools.
// PREMIUM (AI Studio key OR top-up): unlocks attachments (file/image understanding)
// and uncapped chat. A FREE user who sends an attachment gets the upsell.
//
// Every turn flows through the gate (kill-switch → intent → llama-guard in/out).
// Workers-AI runs through the Cloudflare AI Gateway (when AI_GATEWAY_ID is set),
// tagged with the uid so spend is metered per user. Errors emit a PostHog event.
//
// LEAK FIX: Gemma 4 has a thinking mode — we keep it off, keep the system prompt
// plain, and strip any <think> block so raw reasoning never reaches the user.

import type { Env } from "../types";
import { json, aiText, CORS, thinkingCfg } from "../util";
import { requireUser, isFail } from "../authz";
import {
  runGated, intentGate, aiRunOpts,
  friendlyAiError,          // truthful provider-error wording (quota/safety)
  reserveFreeTextBudget, settleFreeTextBudget, releaseFreeTextBudget,
  safetyVerdict, estimateTokens, FREE_BUDGET_MESSAGE,
  type FreeTextBudgetDecision, type FreeTextBudgetReason,
} from "../lib/ai_gate";
import { isPremiumAI, premiumUpsell } from "../lib/premium";
import { trackUser } from "../hooks";
import { emailFor } from "../lib/identity";
import { runAgentLoop } from "../lib/composio";        // unified tool-calling loop (shared with Messenger @ava)
import { generateAvaImageSync } from "./ava_image";    // synchronous image gen → URL (rendered inline)
import { brainSearchLines } from "../lib/ava_memory";  // the ONE Cloudflare AI Search store per user
import { searchForUser } from "../lib/ava_search";     // sharded tenancy boundary (folder-filtered per user)
import { avaReason } from "../lib/ava_reason";         // the ONE reasoning gateway (AVA-CORE-3)
// [AI-BILLING-CORE-1] universal AIJob reserve/settle/release contract, flag-gated
// DARK behind aiWalletMeteringEnabled (routes/config.ts) — see worker/src/lib/
// ai_billing.ts for the full contract. While the flag is off every call below is
// a no-op pass-through, so wiring it in here changes nothing today.
import {
  reserveAiJob, settleAiJob, releaseAiJob, estimateInputTokensFromChars,
} from "../lib/ai_billing";

// Ava chat text model: Gemini 3 Flash (preview) as a Workers-AI THIRD-PARTY model
// ({author}/{model} id), called through env.AI.run so it flows via our CF AI
// Gateway (per-uid metering + caching). If the 3.x partner model is ever down we
// fall back to Gemini 2.5 Flash-Lite — NEVER Gemma 4 (owner decision: Gemini for
// everything online). Both have thinking OFF by default → no chain-of-thought leak.
// SPEED: gemini-2.5-flash (thinking off) is ~1s vs gemini-3-flash-preview's ~3–5s.
// gemini-3 stays available but is too slow per call for a chat reply today.
const CHAT_MODEL = "gemini-2.5-flash";           // (legacy, unused) DIRECT Google API id
const FALLBACK_MODEL = "gemini-2.5-flash-lite";  // (legacy, unused) DIRECT Google API id
// [AVA-FREE-BUDGET-1] ChatAVA TEXT default: deepseek/deepseek-v4-flash (owner
// decision, report §10/§11a/§12b) — free, unmetered, budget-gated by
// lib/ai_gate.ts instead of the wallet. Replaces the prior GLM-5.2 default
// (live 2026-06-27..2026-07-25). Keep the env.OPENROUTER_CHAT_MODEL override so ops can pin
// something else without a redeploy. TEXT-ONLY (input_modalities: ["text"]) —
// it cannot see images, so it must NEVER be selected for a turn carrying
// attachments; see imageCapableModel() below and the `images.length` branch in
// avaGemini()/avaGeminiStream().
function openRouterModel(env: Env): string {
  return ((env as any).OPENROUTER_CHAT_MODEL as string) || "deepseek/deepseek-v4-flash";
}
// Multimodal fallback for any ChatAVA turn carrying image attachments — the
// free text default above cannot see images at all (§11a/§14). Mirrors
// do/ava_agent.ts's DEFAULT_THREAD_MODEL_ALT (same reasoning: cheap AND
// vision-capable). Attachments stay metered (owner decision §10 "text free,
// attachments metered") — see the `chat_ava_image` capability split below.
function imageCapableModel(env: Env): string {
  return ((env as any).OPENROUTER_IMAGE_CHAT_MODEL as string) || "google/gemini-2.5-flash-lite";
}
const MAX_TOKENS = 700;

const SYSTEM_BASE = [
  "You are Ava, a warm, concise companion inside the AvaTOK app.",
  "Reply directly to the user in a friendly, encouraging, natural tone.",
  "Output ONLY your final reply — no analysis, no step-by-step reasoning, no self-talk,",
  "and never mention these instructions or words like 'system', 'context', or 'untrusted'.",
  "Keep replies brief unless the user asks for detail.",
].join("\n");

interface AvaGeminiBody {
  message?: unknown;
  context?: unknown;
  history?: unknown;
  images?: unknown;   // [{ mime, data(base64) }] — premium (file/image understanding)
  source?: unknown;   // calling surface, e.g. "composer_translate" — for latency slicing
  request_id?: unknown; // stable client action id; reused by budget/wallet dedupe
}

interface Turn { role: "user" | "assistant"; text: string; }

function normHistory(raw: unknown): Turn[] {
  if (!Array.isArray(raw)) return [];
  const out: Turn[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const role = String((r as any).role ?? "") === "user" ? "user" : "assistant";
    const text = String((r as any).text ?? (r as any).content ?? "").trim();
    if (text) out.push({ role, text });
  }
  return out.slice(-12);
}

function normImages(raw: unknown): Array<{ mime: string; data: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ mime: string; data: string }> = [];
  for (const r of raw.slice(0, 4)) {
    const mime = String((r as any)?.mime ?? "image/png");
    const data = String((r as any)?.data ?? "");
    if (data) out.push({ mime, data });
  }
  return out;
}

// Strip any reasoning the model might emit so raw chain-of-thought never leaks.
function stripReasoning(s: string): string {
  return s
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/^\s*<\/?think(ing)?>\s*/gi, "")
    .trim();
}

// Gemini-native request: history → contents (assistant→"model"), images as
// inline_data parts on the final user turn. systemInstruction carries the system.
function buildGeminiContents(history: Turn[], message: string, images: Array<{ mime: string; data: string }>): any[] {
  const contents: any[] = [];
  for (const t of history) contents.push({ role: t.role === "user" ? "user" : "model", parts: [{ text: t.text }] });
  const parts: any[] = [{ text: message }];
  for (const im of images) parts.push({ inline_data: { mime_type: im.mime, data: im.data } });
  contents.push({ role: "user", parts });
  return contents;
}

// Pull answer text from a Gemini response, dropping any "thought" parts so raw
// reasoning never reaches the user.
function extractGeminiText(out: any): string {
  const parts = out?.candidates?.[0]?.content?.parts ?? out?.response?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    return parts.filter((p: any) => p?.thought !== true).map((p: any) => String(p?.text ?? "")).join("").trim();
  }
  // Some gateway shapes surface plain text — fall back to the generic extractor.
  return aiText(out).trim();
}

function buildMessages(system: string, history: Turn[], message: string, images: Array<{ mime: string; data: string }>): any[] {
  const messages: any[] = [{ role: "system", content: system }];
  for (const t of history) messages.push({ role: t.role, content: t.text });
  if (images.length) {
    const content: any[] = [{ type: "text", text: message }];
    for (const im of images) content.push({ type: "image_url", image_url: { url: `data:${im.mime};base64,${im.data}` } });
    messages.push({ role: "user", content });
  } else {
    messages.push({ role: "user", content: message });
  }
  return messages;
}

// PREMIUM memory: pull the most relevant chunks from the user's OWN AI Search
// instance and return them as context. Best-effort — any failure (no instance
// yet, API hiccup) returns "" so chat is never blocked. Per-user instance =
// strict isolation.
async function retrieveMemory(env: Env, uid: string, query: string): Promise<string> {
  try {
    // Folder-filtered search over the user's shard (lib/ava_search.ts). Strict
    // isolation: a query can only ever return this user's own docs.
    const r: any = await searchForUser(env, uid, query);
    const rows: any[] = r?.data ?? r?.results ?? r?.chunks ?? [];
    if (!Array.isArray(rows) || !rows.length) return "";
    const text = rows
      .map((c: any) => String(c?.content ?? c?.text ?? (Array.isArray(c?.content) ? c.content.map((x: any) => x?.text ?? "").join(" ") : "")))
      .filter(Boolean).slice(0, 5).join("\n---\n");
    return text.slice(0, 4000);
  } catch { return ""; }
}

/// ChatAVA reply via the ONE reasoning gateway (AVA-CORE-3; model pinned via
/// legacyModel = `model`, resolved by the caller — [AVA-FREE-BUDGET-1]:
/// deepseek/deepseek-v4-flash for text, imageCapableModel() when the turn
/// carries attachments (deepseek cannot see images). Throws on a hard failure
/// so the caller's gate surfaces a truthful reason (quota/safety).
async function generate(env: Env, uid: string, email: string | null, system: string, history: Turn[], message: string, images: Array<{ mime: string; data: string }>, model: string, steer?: string): Promise<string> {
  const sys = steer ? `${system}\n${steer}` : system;
  const key = (env as any).OPENROUTER_API_KEY as string | undefined;
  if (!key) return "Ava is temporarily unavailable.";
  let raw: string;
  try {
    raw = await avaReason(env, {
      role: "chatava", capability: "chat", trigger: "user_message",
      uid, email, appName: "avaai",
      messages: buildMessages(sys, history, message, images),
      maxTokens: MAX_TOKENS,
      temperature: 0.7,
      legacyModel: model, // behavior-preserving pin (see openRouterModel note)
    });
  } catch (e: any) {
    const reason = String(e?.message ?? e).slice(0, 200);
    trackUser(env, uid, email, "ava_model_error", "avaai", { route: "chat", provider: "openrouter", model, reason });
    throw e instanceof Error ? e : new Error(reason);
  }
  const t = stripReasoning(raw);
  return t || "I couldn't reach my thoughts just now — try again?";
}

/// Streaming ChatAVA reply (SSE) via avaReason's OpenRouter streaming passthrough.
/// Calls [onDelta] for each chunk. `model` is caller-resolved — see generate()'s
/// [AVA-FREE-BUDGET-1] doc comment above.
async function streamGenerate(env: Env, system: string, history: Turn[], message: string,
    images: Array<{ mime: string; data: string }>, model: string, onDelta: (t: string) => void): Promise<void> {
  const key = (env as any).OPENROUTER_API_KEY as string | undefined;
  if (!key) throw new Error("openrouter key missing");
  const res = await avaReason(env, {
    role: "chatava", capability: "chat", trigger: "user_message",
    appName: "avaai",
    messages: buildMessages(system, history, message, images),
    maxTokens: MAX_TOKENS,
    temperature: 0.7,
    legacyModel: model,
    stream: true,
  });
  if (!res.ok || !res.body) {
    const e = await res.text().catch(() => "");
    throw new Error(`openrouter ${res.status}: ${e.slice(0, 160)}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith("data:")) continue;
      const data = s.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        const j = JSON.parse(data);
        const d = j?.choices?.[0]?.delta?.content;
        if (d) onDelta(String(d));
      } catch { /* partial/keep-alive line */ }
    }
  }
}

export async function avaGemini(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  let b: AvaGeminiBody;
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  const message = String(b.message ?? "").trim();
  if (!message) return json({ error: "message required" }, 400);
  const context = String(b.context ?? "").trim();
  const history = normHistory(b.history);
  const images = normImages(b.images);
  // Calling surface (composer_translate / composer_rewrite / composer_reply_ideas /
  // composer_grammar / chat / …) so latency can be sliced by WHICH feature is slow.
  const source = String(b.source ?? "chat").slice(0, 40);
  // [AI-BUDGET-AUTH-2] The client's request_id is TELEMETRY ONLY. It must never
  // become the budget or wallet idempotency key: `ai_daily_budget.request_id` is
  // a PRIMARY KEY whose duplicate branch returns ok, so a client pinning one id
  // would bypass the daily input/output/cost budget AND the turn cap outright —
  // unlimited free AI. It also seeded the money ids (`${opId}:reserve`,
  // `aijob:${opId}`), letting one reservation ref be reused across distinct
  // metered jobs. Always mint the authority id server-side.
  const clientTraceId = String(b.request_id ?? "").trim().slice(0, 160);
  const opId = crypto.randomUUID();
  const t0 = Date.now();

  // Resolve the email (for telemetry) in parallel with the premium check so it
  // never adds latency to the turn. emailFor is KV-cached → ~free after the first.
  const tSetup0 = Date.now();
  const [email, premiumRes] = await Promise.all([
    emailFor(env, ctx.uid),
    isPremiumAI(req, env, ctx.uid, b),
  ]);
  const setupMs = Date.now() - tSetup0; // auth-adjacent setup (email + premium check)
  // Premium status (BYO key OR topped-up). Used to gate attachments + uncap chat.
  const { premium, via } = premiumRes;

  // Per-turn latency breakdown so we can answer "why was translate slow?":
  //   setup_ms  = email + premium resolve
  //   gen_ms    = the model + gate (filled in after runGated)
  //   tool_calls/steps = how many agentic round-trips the master-brain loop took
  //     (a composer translate should be ZERO tool calls — non-zero here means the
  //      agent is doing unnecessary memory/app work and adding round-trips).
  let toolCalls = 0;
  const toolNames: string[] = [];

  trackUser(env, ctx.uid, email, "ava_chat_request", "avaai", {
    request_id: opId, client_trace_id: clientTraceId || null,
    source, msg_len: message.length, history_len: history.length, images: images.length,
    has_context: !!context, premium, premium_via: via, setup_ms: setupMs,
  });

  // Attachments = file/image understanding = a premium AI tool. Free users get the upsell.
  if (images.length && !premium) {
    trackUser(env, ctx.uid, email, "ava_chat_upsell", "avaai", { feature: "file_understanding", images: images.length });
    return premiumUpsell(env, ctx.uid, "file_understanding");
  }

  // [AVA-FREE-BUDGET-1] ChatAVA text runs on deepseek/deepseek-v4-flash (free,
  // budget-gated by ai_gate.ts — see openRouterModel() above). AvaBrain memory
  // is still injected so Ava "remembers" the user; Composio app tools + inline
  // image-gen are NOT used in the companion (they remain on the @ava agentic
  // loop). Memory search runs once up-front (not agentic).
  //
  // Attachments = file/image understanding = a DIFFERENT, METERED capability
  // (`chat_ava_image`, owner decision §10 "text free, attachments metered") —
  // deepseek cannot see images at all, so an image turn also routes to
  // imageCapableModel() instead. `capability`/`chatModel` below are resolved
  // ONCE and reused for the reserve/gate/settle calls so all three agree.
  const memory = await brainSearchLines(env, ctx.uid, message, 6).then((l) => l.join("\n")).catch(() => "");
  const system = [
    SYSTEM_BASE,
    context ? `Persona/style for this chat: ${context}` : "",
    memory ? `Things you remember about this user (use only if relevant):\n${memory}` : "",
  ].filter(Boolean).join("\n\n");
  const generatedImages: string[] = [];
  const hasImages = premium && images.length > 0;
  const capability = hasImages ? "chat_ava_image" : "chat_ava";
  const chatModel = hasImages ? imageCapableModel(env) : openRouterModel(env);
  const runChat = (steer?: string): Promise<string> =>
    generate(env, ctx.uid, email, system, history, message, premium ? images : [], chatModel, steer);

  // [AI-BILLING-CORE-1] Reserve the worst-case wallet amount BEFORE the provider
  // call (§H3 steps 1-4). opId comes from the client action and is stable
  // across a transport retry. While aiWalletMeteringEnabled is off, OR capability is free
  // (chat_ava — ai_billing.isFreeCapability), this is a no-op that always
  // admits — see ai_billing.ts.
  const historyChars = history.reduce((n, t) => n + t.text.length, 0);
  const promptChars = system.length + message.length + historyChars;
  const reservation = await reserveAiJob(env, {
    uid: ctx.uid, opId, capability, modality: "text", model: chatModel,
    maxInputTokens: estimateInputTokensFromChars(promptChars), maxOutputTokens: MAX_TOKENS, email,
  });
  if (!reservation.ok) {
    trackUser(env, ctx.uid, email, "ava_chat_blocked", "avaai", {
      request_id: opId, source, route: "chat", reason: "insufficient_tokens", premium, needed: reservation.needed, balance: reservation.balance,
    });
    return json({
      error: reservation.error, needed: reservation.needed, balance: reservation.balance,
      timings: { total_ms: Date.now() - t0, setup_ms: setupMs, gen_ms: 0, tool_calls: 0 },
    }, 402);
  }

  const tGen0 = Date.now();
  let result;
  try {
    result = await runGated(env, {
      uid: ctx.uid, tier: "ourkeys", userText: message,
      generate: runChat,
      // Premium users (key or top-up) are uncapped; free users keep the daily cap.
      skipQuota: premium,
      // [AVA-FREE-BUDGET-1] budget-gates the turn BEFORE guard/model calls when
      // capability is free; a no-op for chat_ava_image (metered, wallet-gated
      // above instead).
      capability,
      inputTokens: estimateTokens(system + message + history.map((t) => t.text).join("\n")),
      requestId: opId,
      maxOutputTokens: MAX_TOKENS,
    });
  } catch (e: any) {
    // Provider call failed before any billable usage — full unbilled release.
    await releaseAiJob(env, reservation, { uid: ctx.uid, opId, capability, reason: "provider_error" });
    const cls = friendlyAiError(e);
    trackUser(env, ctx.uid, email, "ai_error", "avaai", {
      request_id: opId, source, route: "chat", reason: cls.kind, detail: String(e?.message ?? e).slice(0, 200),
      premium, premium_via: via, latency_ms: Date.now() - t0, setup_ms: setupMs,
      gen_ms: Date.now() - tGen0, tool_calls: toolCalls, images: images.length,
    });
    // Surface a truthful reason (quota/safety) as a normal answer the UI shows,
    // instead of a bare 502 the client renders as "couldn't generate a response".
    if (cls.message) {
      return json({ answer: cls.message, blocked: true, reason: cls.kind,
        timings: { total_ms: Date.now() - t0, setup_ms: setupMs, gen_ms: Date.now() - tGen0, tool_calls: toolCalls } }, 200);
    }
    return json({ error: "ai upstream failed", detail: String(e?.message ?? e).slice(0, 300) }, 502);
  }
  const genMs = Date.now() - tGen0; // model + gate (incl. any agentic tool round-trips)
  const totalMs = Date.now() - t0;
  const timings = { total_ms: totalMs, setup_ms: setupMs, gen_ms: genMs, tool_calls: toolCalls };

  if (result.blocked) {
    // Blocked by the gate (daily cap / disabled / moderation / free-budget —
    // input_too_large / daily_ai_budget_exhausted) BEFORE the model ran — no
    // billable usage occurred, so this is a full release, not a settle. NEVER
    // a wallet/paywall reason for the free-budget cases (§55/Part I §7).
    await releaseAiJob(env, reservation, { uid: ctx.uid, opId, capability, reason: result.reason ?? "blocked" });
    if (result.reason === "daily_cap") trackUser(env, ctx.uid, email, "free_chat_cap_hit", "avaai", {});
    if (result.reason === "input_too_large" || result.reason === "daily_ai_budget_exhausted") {
      trackUser(env, ctx.uid, email, "ai_free_budget_blocked", "avaai", { source, route: "chat", reason: result.reason, capability });
    }
    trackUser(env, ctx.uid, email, "ava_chat_blocked", "avaai", {
      request_id: opId, source, route: "chat", reason: result.reason, premium, latency_ms: totalMs,
      setup_ms: setupMs, gen_ms: genMs, tool_calls: toolCalls,
      ...(result.remaining != null ? { remaining: result.remaining } : {}),
    });
    return json({ answer: result.answer, blocked: true, reason: result.reason, timings, ...(result.remaining != null ? { remaining: result.remaining } : {}) },
      result.reason === "ai_disabled" ? 503 : 200);
  }

  // [AI-BILLING-CORE-1] Settle against usage. avaReason()/runGated() do not
  // currently surface the provider's real token counts to this call site (a
  // follow-up would thread OpenRouter's usage block through the shared
  // ava_reason gateway), so this settles from a conservative chars/4 estimate
  // of the real prompt/answer text. Exact (nothing charged) while the flag is
  // off, or while capability is free (chat_ava); an approximation only once
  // metering is enabled for a metered capability (chat_ava_image).
  await settleAiJob(env, reservation, {
    opId, uid: ctx.uid, capability, modality: "text",
    modelRequested: chatModel, modelActual: chatModel,
    usage: { inputTokens: estimateInputTokensFromChars(promptChars), outputTokens: Math.ceil((result.answer ?? "").length / 4) },
  });

  trackUser(env, ctx.uid, email, "ava_chat_completed", "avaai", {
    request_id: opId, source, route: "chat", tier: premium ? "premium" : "free", premium, premium_via: via,
    answer_len: (result.answer ?? "").length, in_images: images.length, gen_images: generatedImages.length,
    latency_ms: totalMs, setup_ms: setupMs, gen_ms: genMs,
    tool_calls: toolCalls, tools: toolNames.join(",") || "none",
    ...(result.remaining != null ? { remaining: result.remaining } : {}),
  });
  return json({
    answer: result.answer, blocked: false, tier: premium ? "premium" : "free", premium, timings,
    ...(generatedImages.length ? { images: generatedImages } : {}),
    ...(result.remaining != null ? { remaining: result.remaining } : {}),
  });
}

// POST /api/ava/gemini/stream — streaming companion chat (SSE). Pipes Gemini's
// streamGenerateContent tokens to the client as `data: {"delta":"…"}` so the UI
// types the answer out LIVE (feels far faster). Same model + system as avaGemini.
// Input moderation runs before the provider stream opens. Buffered routes also
// guard output; this live-token route does not pretend a post-hoc classifier
// can retract deltas already displayed.
export async function avaGeminiStream(req: Request, env: Env): Promise<Response> {
  const t0 = Date.now();
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  let b: AvaGeminiBody;
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const message = String(b.message ?? "").trim();
  if (!message) return json({ error: "message required" }, 400);
  const context = String(b.context ?? "").trim();
  const history = normHistory(b.history);
  const images = normImages(b.images);
  const source = String(b.source ?? "chat_stream").slice(0, 40);
  if (!(env as any).OPENROUTER_API_KEY) return json({ error: "unavailable" }, 502);

  // [AVA-FREE-BUDGET-1] ChatAVA over SSE on deepseek/deepseek-v4-flash (free) —
  // see openRouterModel()'s doc comment above. AvaBrain memory is injected
  // up-front so Ava remembers the user; Composio app tools + inline image-gen
  // are not used in the companion (they remain on the @ava agentic loop).
  // Attachments stay premium → free users get the upsell; attachments are ALSO
  // a different, metered capability (chat_ava_image) that never uses the free
  // text model (it cannot see images) — same split as the non-streaming handler.
  const [email, { premium }] = await Promise.all([
    emailFor(env, ctx.uid),
    isPremiumAI(req, env, ctx.uid, b),
  ]);
  if (images.length && !premium) return premiumUpsell(env, ctx.uid, "file_understanding");

  const memory = await brainSearchLines(env, ctx.uid, message, 6).then((l) => l.join("\n")).catch(() => "");
  const system = [
    SYSTEM_BASE,
    context ? `Persona/style for this chat: ${context}` : "",
    memory ? `Things you remember about this user (use only if relevant):\n${memory}` : "",
  ].filter(Boolean).join("\n\n");

  const hasImages = premium && images.length > 0;
  const capability = hasImages ? "chat_ava_image" : "chat_ava";
  const chatModel = hasImages ? imageCapableModel(env) : openRouterModel(env);
  const historyChars = history.reduce((n, t) => n + t.text.length, 0);
  const promptChars = system.length + message.length + historyChars;
  // [AI-BUDGET-AUTH-2] The client's request_id is TELEMETRY ONLY. It must never
  // become the budget or wallet idempotency key: `ai_daily_budget.request_id` is
  // a PRIMARY KEY whose duplicate branch returns ok, so a client pinning one id
  // would bypass the daily input/output/cost budget AND the turn cap outright —
  // unlimited free AI. It also seeded the money ids (`${opId}:reserve`,
  // `aijob:${opId}`), letting one reservation ref be reused across distinct
  // metered jobs. Always mint the authority id server-side.
  const clientTraceId = String(b.request_id ?? "").trim().slice(0, 160);
  const opId = crypto.randomUUID();
  const setupMs = Date.now() - t0;
  trackUser(env, ctx.uid, email, "ava_chat_request", "avaai", {
    request_id: opId, client_trace_id: clientTraceId || null, source, route: "chat_stream", capability, model: chatModel,
    premium, input_chars: promptChars, setup_ms: setupMs,
  });

  // Streaming bypasses runGated, so reserve the same atomic free-lane budget
  // here with the transport request id. The reservation also admits the daily
  // turn cap; there is no raceable KV check on this path.
  const inputTokens = estimateTokens(system + message + history.map((t) => t.text).join("\n"));
  let freeBudget: FreeTextBudgetDecision | undefined;
  if (!hasImages) {
    freeBudget = await reserveFreeTextBudget(env, ctx.uid, inputTokens, {
      requestId: opId,
      maxOutputTokens: MAX_TOKENS,
      skipTurnLimit: premium,
    });
    if (!freeBudget.allowed) {
      const reason = freeBudget.reason as FreeTextBudgetReason;
      trackUser(env, ctx.uid, email, "ai_free_budget_blocked", "avaai", {
        request_id: opId, source, route: "chat_stream", reason, capability,
      });
      const enc0 = new TextEncoder();
      const out0 = new ReadableStream({
        start(controller) {
          controller.enqueue(enc0.encode(`data: ${JSON.stringify({ delta: FREE_BUDGET_MESSAGE[reason], blocked: true, reason })}\n\n`));
          controller.enqueue(enc0.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(out0, {
        headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", ...CORS },
      });
    }
  }

  // Restore real input moderation on the streaming lane. Only a classifier
  // call that actually ran is included in the free platform-cost settlement.
  const inputSafety = await safetyVerdict(env, message);
  const moderationInputTokens = inputSafety.providerCalled ? estimateTokens(message) : 0;
  if (!inputSafety.safe) {
    if (freeBudget) {
      await settleFreeTextBudget(env, ctx.uid, freeBudget, {
        inputTokens: moderationInputTokens,
        outputTokens: 0,
      });
    }
    trackUser(env, ctx.uid, email, "ava_chat_blocked", "avaai", {
      request_id: opId, source, route: "chat_stream", reason: "input_unsafe",
    });
    const enc0 = new TextEncoder();
    const out0 = new ReadableStream({
      start(controller) {
        controller.enqueue(enc0.encode(`data: ${JSON.stringify({ delta: "I can't help with that one. Let's keep things safe — ask me something else?", blocked: true, reason: "input_unsafe" })}\n\n`));
        controller.enqueue(enc0.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(out0, {
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", ...CORS },
    });
  }

  // [AI-BILLING-CORE-1] Same reserve-before-call contract as the non-streaming
  // handler above. A stream that can't be reserved never opens — the client
  // gets a normal 402 instead of an SSE stream. No-op while the flag is off,
  // or while capability is free (chat_ava).
  const reservation = await reserveAiJob(env, {
    uid: ctx.uid, opId, capability, modality: "text", model: chatModel,
    maxInputTokens: estimateInputTokensFromChars(promptChars), maxOutputTokens: MAX_TOKENS,
  });
  if (!reservation.ok) {
    if (freeBudget) await releaseFreeTextBudget(env, ctx.uid, freeBudget);
    return json({ error: reservation.error, needed: reservation.needed, balance: reservation.balance }, 402);
  }

  const enc = new TextEncoder();
  const out = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        try { controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`)); } catch { /* closed */ }
      };
      let streamedAny = false;
      let streamedChars = 0;
      let ttftMs: number | undefined;
      let providerError: unknown;
      try {
        await streamGenerate(env, system, history, message, premium ? images : [], chatModel,
          (t) => {
            if (!t) return;
            if (!streamedAny) {
              ttftMs = Date.now() - t0;
              trackUser(env, ctx.uid, email, "ava_chat_first_token", "avaai", {
                request_id: opId, source, route: "chat_stream", ttft_ms: ttftMs,
                setup_ms: setupMs, model: chatModel,
              });
            }
            streamedAny = true;
            streamedChars += t.length;
            send({ delta: t });
          });
      } catch (e) {
        providerError = e;
        // On a hard failure before any token streamed, send a truthful reason
        // (quota/safety) so the chat bubble isn't a bare "couldn't generate".
        if (!streamedAny) {
          const cls = friendlyAiError(e);
          if (cls.message) { try { send({ delta: cls.message }); } catch { /* closed */ } }
        }
      }
      // [AI-BILLING-CORE-1] settle from what was actually streamed (chars/4
      // estimate — see the non-streaming handler's comment on avaReason not
      // surfacing real usage yet); a hard failure with nothing streamed is a
      // full unbilled release instead. No-op wallet-wise for the free lane.
      if (streamedAny) {
        await settleAiJob(env, reservation, {
          opId, uid: ctx.uid, capability, modality: "text",
          modelRequested: chatModel, modelActual: chatModel,
          usage: { inputTokens: estimateInputTokensFromChars(promptChars), outputTokens: Math.ceil(streamedChars / 4) },
        }).catch(() => {});
        // Streaming never runs through runGated, so settle its generation plus
        // the input classifier call here directly.
        if (!hasImages) {
          await settleFreeTextBudget(env, ctx.uid, freeBudget!, {
            inputTokens: inputTokens + moderationInputTokens,
            outputTokens: Math.ceil(streamedChars / 4),
          });
        }
      } else {
        await releaseAiJob(env, reservation, { uid: ctx.uid, opId, capability, reason: "provider_error" }).catch(() => {});
        if (freeBudget) {
          if (moderationInputTokens) {
            await settleFreeTextBudget(env, ctx.uid, freeBudget, {
              inputTokens: moderationInputTokens,
              outputTokens: 0,
            });
          } else {
            await releaseFreeTextBudget(env, ctx.uid, freeBudget);
          }
        }
      }
      const totalMs = Date.now() - t0;
      const providerMs = Math.max(0, totalMs - setupMs);
      trackUser(env, ctx.uid, email, providerError ? "ai_error" : "ava_chat_completed", "avaai", {
        request_id: opId, source, route: "chat_stream", capability, model: chatModel,
        premium, streamed: streamedAny, output_chars: streamedChars,
        ttft_ms: ttftMs, total_ms: totalMs, setup_ms: setupMs, provider_ms: providerMs,
        ...(providerError ? { detail: String((providerError as any)?.message ?? providerError).slice(0, 200) } : {}),
      });
      send({ done: true, timings: {
        total_ms: totalMs, setup_ms: setupMs, provider_ms: providerMs, ttft_ms: ttftMs,
      } });
      try { controller.enqueue(enc.encode("data: [DONE]\n\n")); } catch { /* ignore */ }
      controller.close();
    },
  });
  return new Response(out, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", ...CORS },
  });
}
