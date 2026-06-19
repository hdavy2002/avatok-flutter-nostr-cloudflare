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
import { json, aiText } from "../util";
import { requireUser, isFail } from "../authz";
import { runGated, intentGate, aiRunOpts } from "../lib/ai_gate";
import { isPremiumAI, premiumUpsell } from "../lib/premium";
import { track } from "../hooks";

// Ava chat text model: Gemini 2.5 Flash-Lite as a Workers-AI THIRD-PARTY model
// ({author}/{model} id), called through env.AI.run so it still flows via our CF
// AI Gateway (per-uid metering + caching), same as the Gemma path did. Flash-Lite
// is fast and has thinking OFF by default → quick replies, no chain-of-thought
// leak. Gemma 4 stays as a resilient fallback if the partner model is ever down.
const CHAT_MODEL = "google/gemini-2.5-flash-lite";
const FALLBACK_MODEL = "@cf/google/gemma-4-26b-a4b-it";
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
    const ns: any = (env as any).AI_SEARCH;
    if (!ns) return "";
    const id = ("ava-" + uid.replace(/[^a-zA-Z0-9]/g, "-")).toLowerCase().slice(0, 50);
    let inst: any = null;
    try { inst = await ns.get(id); } catch { return ""; } // no memory instance yet
    if (!inst) return "";
    const r: any = await inst.search({ messages: [{ role: "user", content: query }] });
    const rows: any[] = r?.data ?? r?.results ?? r?.chunks ?? [];
    if (!Array.isArray(rows) || !rows.length) return "";
    const text = rows
      .map((c: any) => String(c?.content ?? c?.text ?? (Array.isArray(c?.content) ? c.content.map((x: any) => x?.text ?? "").join(" ") : "")))
      .filter(Boolean).slice(0, 5).join("\n---\n");
    return text.slice(0, 4000);
  } catch { return ""; }
}

async function generate(env: Env, uid: string, system: string, history: Turn[], message: string, images: Array<{ mime: string; data: string }>, steer?: string): Promise<string> {
  const sys = steer ? `${system}\n${steer}` : system;
  // Primary: Gemini 2.5 Flash-Lite (third-party model) through the AI Gateway.
  try {
    const out: any = await env.AI.run(
      CHAT_MODEL,
      {
        systemInstruction: { parts: [{ text: sys }] },
        contents: buildGeminiContents(history, message, images),
        generationConfig: { maxOutputTokens: MAX_TOKENS, temperature: 0.7 },
      } as any,
      aiRunOpts(env, uid),
    );
    const t = stripReasoning(extractGeminiText(out));
    if (t) return t;
  } catch (_) { /* partner model unavailable → fall back to Workers-AI Gemma */ }
  // Fallback: Workers-AI Gemma 4 (OpenAI-style messages).
  const out: any = await env.AI.run(
    FALLBACK_MODEL,
    { messages: buildMessages(sys, history, message, images), max_tokens: MAX_TOKENS } as any,
    aiRunOpts(env, uid),
  );
  return stripReasoning(aiText(out).trim());
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

  // Premium status (BYO key OR topped-up). Used to gate attachments + uncap chat.
  const { premium, via } = await isPremiumAI(req, env, ctx.uid, b);

  // Attachments = file/image understanding = a premium AI tool. Free users get the upsell.
  if (images.length && !premium) {
    return premiumUpsell(env, ctx.uid, "file_understanding");
  }

  let system = context ? `${SYSTEM_BASE}\nStyle/persona for this chat: ${context}` : SYSTEM_BASE;

  // Premium memory: weave in the user's own AI Search results so Ava "remembers"
  // their saved notes/files mid-conversation. Free users have no memory instance.
  if (premium) {
    const mem = await retrieveMemory(env, ctx.uid, message);
    if (mem) {
      system += `\n\nRelevant notes from the user's saved memory (use only if helpful, never quote verbatim):\n"""${mem}"""`;
      track(env, ctx.uid, "ava_memory_used", "avaai", {});
    }
  }

  let result;
  try {
    result = await runGated(env, {
      uid: ctx.uid, tier: "ourkeys", userText: message,
      generate: (steer?: string) => generate(env, ctx.uid, system, history, message, images, steer),
      // Premium users (key or top-up) are uncapped; free users keep the daily cap.
      skipQuota: premium,
    });
  } catch (e: any) {
    track(env, ctx.uid, "ai_error", "avaai", { route: "chat", detail: String(e?.message ?? e).slice(0, 200), premium_via: via });
    return json({ error: "ai upstream failed", detail: String(e?.message ?? e).slice(0, 300) }, 502);
  }

  if (result.blocked) {
    if (result.reason === "daily_cap") track(env, ctx.uid, "free_chat_cap_hit", "avaai", {});
    return json({ answer: result.answer, blocked: true, reason: result.reason, ...(result.remaining != null ? { remaining: result.remaining } : {}) },
      result.reason === "ai_disabled" ? 503 : 200);
  }

  return json({ answer: result.answer, blocked: false, tier: premium ? "premium" : "free", premium, ...(result.remaining != null ? { remaining: result.remaining } : {}) });
}
