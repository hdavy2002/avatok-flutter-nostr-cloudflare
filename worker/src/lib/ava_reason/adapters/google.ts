// adapters/google.ts — Google Gemini REST (generativelanguage). Routing target for
// the widened verbs (reason/see via generateContent, embed via embedContent) AND —
// One Brain B1 — the `gemini_direct` feature that replaces the raw generativelanguage
// fetches in util.geminiRun and genui_planner's Gemini fallback. Everything
// Gemini-wire-shaped lives here so core stays policy/routing only.
//
// What this adapter reproduces byte-for-byte from the old raw fetches:
//   • system message → `systemInstruction` (NOT folded into the user turn, NOT
//     dropped) — only when non-empty after trim, matching util.geminiBody.
//   • generationConfig extras (req.generationConfig) merged verbatim.
//   • PER-MODEL thinking-off (req.geminiThinkingOff): gemini-3 → thinkingLevel "low",
//     gemini-2.x → thinkingBudget 0. The two must never be mixed (Google 400s), so
//     this is derived from EACH model in the ladder — a static config could not.
//   • same-provider two-model ladder (Step.models / ctx.models): try each in order,
//     return the first with non-empty answer text; on error OR empty text fall
//     through to the next; return "" (never throw) if all fail — util.geminiRun's
//     exact swallow. Answer text drops "thought" parts (util.geminiText).
//
// [VERTEX-1] 2026-08-17: the transport moved to Vertex (aiplatform.googleapis.com)
// via lib/vertex.ts. The REQUEST AND RESPONSE SHAPES ARE UNCHANGED — Vertex takes
// the same contents/systemInstruction/generationConfig body and returns the same
// candidates/parts — so every guarantee documented above still holds byte-for-byte.
// generateContentVia() falls back to generativelanguage.googleapis.com on any
// Vertex failure, so this adapter cannot become an outage. Live (WebSocket) lanes
// are NOT routed here and deliberately stay on the Developer API; see lib/vertex.ts.
import type { AdapterCtx, AdapterOut, ChatMessage, ReasonEnv } from "../types";
import { buildChatMessages, usageTokens } from "../types";
import { generateContentVia, type GoogleVia } from "../../vertex";

/** Transport that served the most recent call in this isolate — surfaced on
 *  AdapterOut.raw so `ava_reason_call` telemetry can PROVE the switch landed
 *  rather than assuming it (ship-gate rule 3: assert the success VALUE). */
let _lastVia: GoogleVia = "devapi";

/** System turns → a single `systemInstruction`, only when non-empty (util.geminiBody). */
function systemInstruction(msgs: ChatMessage[]): { parts: { text: string }[] } | undefined {
  const sys = msgs.filter((m) => m.role === "system").map((m) => String(m.content ?? "")).join("\n");
  return sys.trim() ? { parts: [{ text: sys }] } : undefined;
}

/** Non-system turns → Gemini `contents` (assistant → model). */
function toContents(msgs: ChatMessage[]): any[] {
  return msgs
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: String(m.content ?? "") }] }));
}

// Per-model thinking-off for LOW LATENCY — EXACTLY util.thinkingCfg. gemini-3 spends
// ~5s reasoning silently by default; turning it down keeps a one-shot reply ~1s.
// NOTE: sending `thinkingBudget` to a gemini-3 model returns HTTP 400 — never mix.
function thinkingOff(model: string): Record<string, unknown> {
  return model.startsWith("gemini-3")
    ? { thinkingConfig: { thinkingLevel: "low" } }
    : { thinkingConfig: { thinkingBudget: 0 } };
}

// Answer text from a Gemini response, dropping any "thought" parts so raw reasoning
// never leaks (EXACTLY util.geminiText's candidates/parts handling).
function geminiText(out: any): string {
  const parts = out?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p: any) => p?.thought !== true)
    .map((p: any) => String(p?.text ?? ""))
    .join("")
    .trim();
}

/** Assemble the Gemini generationConfig for one model (order-independent). */
function generationConfig(ctx: AdapterCtx, model: string): Record<string, unknown> {
  const gen: Record<string, unknown> = {};
  if (ctx.req.maxTokens != null) gen.maxOutputTokens = ctx.req.maxTokens;
  if (ctx.req.temperature != null) gen.temperature = ctx.req.temperature;
  if (ctx.req.json) gen.responseMimeType = "application/json";
  if (ctx.req.generationConfig) Object.assign(gen, ctx.req.generationConfig);
  if (ctx.req.geminiThinkingOff) Object.assign(gen, thinkingOff(model)); // per-model, wins
  return gen;
}

/** One generateContent call for `model`. Returns status + parsed body; never throws
 *  on a non-2xx (the caller decides strict-throw vs soft-ladder). */
async function generate(env: ReasonEnv, ctx: AdapterCtx, model: string): Promise<{ ok: boolean; status: number; out: any }> {
  const msgs = buildChatMessages(ctx.req);
  const contents = (ctx.req.raw as any)?.contents ?? toContents(msgs);
  const sysI = systemInstruction(msgs);
  const gen = generationConfig(ctx, model);
  const body: Record<string, unknown> = { contents };
  if (sysI) body.systemInstruction = sysI;
  if (Object.keys(gen).length) body.generationConfig = gen;
  const r = await generateContentVia(env as any, model, body, "generateContent", {
    timeoutMs: ctx.req.timeoutMs,
    // A BYO user key must bill to that user, so it pins the Developer API.
    apiKey: (ctx.req as any).apiKey || undefined,
  });
  _lastVia = r.via;
  return { ok: r.ok, status: r.status, out: r.out };
}

export async function run(env: ReasonEnv, ctx: AdapterCtx): Promise<AdapterOut> {
  const verb = ctx.req.verb ?? "reason";

  if (verb === "embed") {
    const r = await generateContentVia(
      env as any, ctx.model,
      { content: { parts: [{ text: String(ctx.req.input ?? ctx.req.user ?? "") }] } },
      "embedContent",
      { apiKey: (ctx.req as any).apiKey || undefined },
    );
    _lastVia = r.via;
    if (!r.ok) throw new Error(`google ${r.status}: ${String(r.out?.error?.message ?? "").slice(0, 160)}`);
    return { raw: { ...r.out, _via: r.via }, text: "", tokensIn: null, tokensOut: null };
  }

  // gemini_direct SAME-PROVIDER LADDER (Step.models). Try each rung; return the first
  // with non-empty answer text; on error OR empty text fall through; return "" (never
  // throw) if every rung fails — util.geminiRun's exact behaviour. Both call sites
  // (geminiRun, genui fallback) wrap in try/catch, but this soft-fail means a missing
  // key or a dead model simply yields "" rather than propagating.
  const ladder = ctx.models && ctx.models.length ? ctx.models : null;
  if (ladder) {
    let last: any = null;
    for (const model of ladder) {
      try {
        const { ok, out } = await generate(env, ctx, model);
        last = out;
        if (ok) {
          const text = geminiText(out);
          if (text) {
            const [ti, to] = usageTokens(out);
            return { raw: { ...out, _via: _lastVia }, text, tokensIn: ti, tokensOut: to };
          }
        }
      } catch { /* try the next model */ }
    }
    const [ti, to] = usageTokens(last);
    return { raw: last, text: "", tokensIn: ti ?? null, tokensOut: to ?? null };
  }

  // Strict single-model reason/see (dormant verb routes) — throws on error.
  const { ok, status, out } = await generate(env, ctx, ctx.model);
  if (!ok) throw new Error(`google ${status}: ${String(out?.error?.message ?? "").slice(0, 160)}`);
  const [tokensIn, tokensOut] = usageTokens(out);
  return { raw: { ...out, _via: _lastVia }, text: geminiText(out), tokensIn, tokensOut };
}
