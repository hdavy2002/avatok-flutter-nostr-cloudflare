// adapters/google.ts — Google Gemini REST (generativelanguage). A thin routing
// target for the widened verbs (reason/see via generateContent, embed via
// embedContent, speak via TTS). NOT exercised by the current 14 call sites — the
// reasoner ladder routes `reason` to cf_ai/openrouter — but present so policy.ts
// can dispatch a verb here without core changing. Behaviour is additive.
import type { AdapterCtx, AdapterOut, ReasonEnv } from "../types";
import { buildChatMessages, usageTokens } from "../types";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

function apiKey(env: ReasonEnv): string {
  const k = (env as any).GEMINI_API_KEY || (env as any).GOOGLE_API_KEY;
  if (!k) throw new Error("google api key missing");
  return k;
}

/** Gemini `contents` from chat messages (system folded into the first user turn). */
function toContents(ctx: AdapterCtx): any[] {
  const msgs = buildChatMessages(ctx.req);
  return msgs
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: String(m.content ?? "") }] }));
}

export async function run(env: ReasonEnv, ctx: AdapterCtx): Promise<AdapterOut> {
  const key = apiKey(env);
  const verb = ctx.req.verb ?? "reason";

  if (verb === "embed") {
    const res = await fetch(`${BASE}/models/${ctx.model}:embedContent?key=${key}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: { parts: [{ text: String(ctx.req.input ?? ctx.req.user ?? "") }] } }),
    });
    const out: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`google ${res.status}: ${String(out?.error?.message ?? "").slice(0, 160)}`);
    return { raw: out, text: "", tokensIn: null, tokensOut: null };
  }

  // reason / see — generateContent (vision content passed via req.raw.contents).
  const bodyContents = (ctx.req.raw as any)?.contents ?? toContents(ctx);
  const gen: Record<string, unknown> = {};
  if (ctx.req.maxTokens != null) gen.maxOutputTokens = ctx.req.maxTokens;
  if (ctx.req.temperature != null) gen.temperature = ctx.req.temperature;
  if (ctx.req.json) gen.responseMimeType = "application/json";
  const res = await fetch(`${BASE}/models/${ctx.model}:generateContent?key=${key}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contents: bodyContents, ...(Object.keys(gen).length ? { generationConfig: gen } : {}) }),
    ...(ctx.req.timeoutMs ? { signal: AbortSignal.timeout(ctx.req.timeoutMs) } : {}),
  });
  const out: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`google ${res.status}: ${String(out?.error?.message ?? "").slice(0, 160)}`);
  const text = String(out?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text ?? "").join("") ?? "").trim();
  const [tokensIn, tokensOut] = usageTokens(out);
  return { raw: out, text, tokensIn, tokensOut };
}
