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
import { runGated, intentGate, aiRunOpts } from "../lib/ai_gate";
import { isPremiumAI, premiumUpsell } from "../lib/premium";
import { trackUser } from "../hooks";
import { emailFor } from "../lib/identity";
import { runAgentLoop } from "../lib/composio";        // unified tool-calling loop (shared with Messenger @ava)
import { generateAvaImageSync } from "./ava_image";    // synchronous image gen → URL (rendered inline)
import { brainSearchLines } from "../lib/ava_memory";  // the ONE Cloudflare AI Search store per user
import { searchForUser } from "../lib/ava_search";     // sharded tenancy boundary (folder-filtered per user)

// Ava chat text model: Gemini 3 Flash (preview) as a Workers-AI THIRD-PARTY model
// ({author}/{model} id), called through env.AI.run so it flows via our CF AI
// Gateway (per-uid metering + caching). If the 3.x partner model is ever down we
// fall back to Gemini 2.5 Flash-Lite — NEVER Gemma 4 (owner decision: Gemini for
// everything online). Both have thinking OFF by default → no chain-of-thought leak.
// SPEED: gemini-2.5-flash (thinking off) is ~1s vs gemini-3-flash-preview's ~3–5s.
// gemini-3 stays available but is too slow per call for a chat reply today.
const CHAT_MODEL = "gemini-2.5-flash";           // DIRECT Google API id (fast, thinking off)
const FALLBACK_MODEL = "gemini-2.5-flash-lite";  // DIRECT Google API id
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

async function generate(env: Env, uid: string, email: string | null, system: string, history: Turn[], message: string, images: Array<{ mime: string; data: string }>, steer?: string): Promise<string> {
  const sys = steer ? `${system}\n${steer}` : system;
  const key = (env as any).GEMINI_API_KEY;
  if (!key) return "Ava is temporarily unavailable.";
  const body = {
    systemInstruction: { parts: [{ text: sys }] },
    contents: buildGeminiContents(history, message, images),
    generationConfig: { maxOutputTokens: MAX_TOKENS, temperature: 0.7 },
  };
  // DIRECT Google API (gemini-3-flash-preview is NOT a valid Workers-AI partner
  // id — it 7003s and wasted a round-trip per turn). One real call; fall back to
  // gemini-2.5 only on a hard failure. NEVER Gemma.
  let fellBackReason = "";
  for (const model of [CHAT_MODEL, FALLBACK_MODEL]) {
    try {
      // Thinking off (per-model) → ~1s replies instead of ~4–5s of silent g3 reasoning.
      const mbody = { ...body, generationConfig: { ...body.generationConfig, ...thinkingCfg(model) } };
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify(mbody),
        },
      );
      const out: any = await res.json().catch(() => ({}));
      if (res.ok) {
        const t = stripReasoning(extractGeminiText(out));
        if (t) return t;
        fellBackReason = "empty";
      } else {
        fellBackReason = `${res.status}: ${String(out?.error?.message ?? "").slice(0, 120)}`;
      }
    } catch (e: any) {
      fellBackReason = String(e?.message ?? e).slice(0, 160);
    }
    if (model === CHAT_MODEL) {
      trackUser(env, uid, email, "ava_model_fallback", "avaai", {
        route: "chat", from: CHAT_MODEL, to: FALLBACK_MODEL, reason: fellBackReason,
      });
    }
  }
  return "I couldn't reach my thoughts just now — try again?";
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
    source, msg_len: message.length, history_len: history.length, images: images.length,
    has_context: !!context, premium, premium_via: via, setup_ms: setupMs,
  });

  // Attachments = file/image understanding = a premium AI tool. Free users get the upsell.
  if (images.length && !premium) {
    trackUser(env, ctx.uid, email, "ava_chat_upsell", "avaai", { feature: "file_understanding", images: images.length });
    return premiumUpsell(env, ctx.uid, "file_understanding");
  }

  // ChatAVA MASTER BRAIN: run the SAME unified tool-calling loop as Messenger @ava
  // (gemini-3-flash-preview) over the user's ONE Cloudflare AI Search store. It can
  // pull files/messages on demand (search_memory — ALL tiers, since it's the user's
  // own data), read attached files (premium), act on connected apps (premium), and
  // GENERATE images — returned inline as `images` so the ChatAVA thread renders them.
  const ctxStr = [
    context ? `Persona/style for this chat: ${context}` : "",
    history.length
      ? "Recent turns:\n" + history.map((t) => `${t.role === "user" ? "User" : "Ava"}: ${t.text}`).join("\n")
      : "",
  ].filter(Boolean).join("\n\n");
  const generatedImages: string[] = [];
  const runChat = (steer?: string): Promise<string> =>
    runAgentLoop(
      env, ctx.uid, steer ? `${message}\n\n[note: ${steer}]` : message, ctxStr,
      (q) => brainSearchLines(env, ctx.uid, q, 6),
      {
        apps: premium,
        images: premium ? images : undefined,
        onImage: async (prompt, editRef) => {
          const r = await generateAvaImageSync(env, { uid: ctx.uid, prompt, editRef });
          if (r.ok && r.url) { generatedImages.push(r.url); return "Image created and shown to the user."; }
          return r.message ?? "I couldn't create that image right now.";
        },
        onTool: (t: any) => {
          toolCalls++;
          try { if (t?.tool && toolNames.length < 8) toolNames.push(String(t.tool)); } catch { /* best-effort */ }
        },
      },
    );

  const tGen0 = Date.now();
  let result;
  try {
    result = await runGated(env, {
      uid: ctx.uid, tier: "ourkeys", userText: message,
      generate: runChat,
      // Premium users (key or top-up) are uncapped; free users keep the daily cap.
      skipQuota: premium,
    });
  } catch (e: any) {
    trackUser(env, ctx.uid, email, "ai_error", "avaai", {
      source, route: "chat", detail: String(e?.message ?? e).slice(0, 200),
      premium, premium_via: via, latency_ms: Date.now() - t0, setup_ms: setupMs,
      gen_ms: Date.now() - tGen0, tool_calls: toolCalls, images: images.length,
    });
    return json({ error: "ai upstream failed", detail: String(e?.message ?? e).slice(0, 300) }, 502);
  }
  const genMs = Date.now() - tGen0; // model + gate (incl. any agentic tool round-trips)
  const totalMs = Date.now() - t0;
  const timings = { total_ms: totalMs, setup_ms: setupMs, gen_ms: genMs, tool_calls: toolCalls };

  if (result.blocked) {
    if (result.reason === "daily_cap") trackUser(env, ctx.uid, email, "free_chat_cap_hit", "avaai", {});
    trackUser(env, ctx.uid, email, "ava_chat_blocked", "avaai", {
      source, route: "chat", reason: result.reason, premium, latency_ms: totalMs,
      setup_ms: setupMs, gen_ms: genMs, tool_calls: toolCalls,
      ...(result.remaining != null ? { remaining: result.remaining } : {}),
    });
    return json({ answer: result.answer, blocked: true, reason: result.reason, timings, ...(result.remaining != null ? { remaining: result.remaining } : {}) },
      result.reason === "ai_disabled" ? 503 : 200);
  }

  trackUser(env, ctx.uid, email, "ava_chat_completed", "avaai", {
    source, route: "chat", tier: premium ? "premium" : "free", premium, premium_via: via,
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
// Output moderation is skipped (you can't gate a stream before it's sent) — this
// is the user's own companion chat; the input was already theirs.
export async function avaGeminiStream(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  let b: AvaGeminiBody;
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const message = String(b.message ?? "").trim();
  if (!message) return json({ error: "message required" }, 400);
  const context = String(b.context ?? "").trim();
  const history = normHistory(b.history);
  const images = normImages(b.images);
  if (!(env as any).GEMINI_API_KEY) return json({ error: "unavailable" }, 502);

  // ChatAVA master brain over SSE: the SAME unified tool-calling loop as @ava,
  // streamed. search_memory (AI Search) for all tiers, file understanding + apps
  // for premium, and image gen — generated images are sent as a `{image:url}` SSE
  // event the client renders inline. Attachments are premium → free users get the
  // upsell (plain JSON the client also handles).
  const { premium } = await isPremiumAI(req, env, ctx.uid, b);
  if (images.length && !premium) return premiumUpsell(env, ctx.uid, "file_understanding");

  const ctxStr = [
    context ? `Persona/style for this chat: ${context}` : "",
    history.length
      ? "Recent turns:\n" + history.map((t) => `${t.role === "user" ? "User" : "Ava"}: ${t.text}`).join("\n")
      : "",
  ].filter(Boolean).join("\n\n");

  const enc = new TextEncoder();
  const out = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        try { controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`)); } catch { /* closed */ }
      };
      try {
        await runAgentLoop(
          env, ctx.uid, message, ctxStr,
          (q) => brainSearchLines(env, ctx.uid, q, 6),
          {
            apps: premium,
            images: premium ? images : undefined,
            onDelta: (t) => { if (t) send({ delta: t }); },
            onImage: async (prompt, editRef) => {
              // Tell the client to show a "generating image…" placeholder thumbnail
              // immediately, then swap in the real image (or clear on failure).
              send({ image_pending: true });
              const r = await generateAvaImageSync(env, { uid: ctx.uid, prompt, editRef });
              if (r.ok && r.url) { send({ image: r.url }); return "Image created and shown to the user."; }
              send({ image_failed: true });
              return r.message ?? "I couldn't create that image right now.";
            },
          },
        );
      } catch { /* fall through to [DONE] */ }
      try { controller.enqueue(enc.encode("data: [DONE]\n\n")); } catch { /* ignore */ }
      controller.close();
    },
  });
  return new Response(out, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", ...CORS },
  });
}
