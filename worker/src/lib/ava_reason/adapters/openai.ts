// adapters/openai.ts — OpenAI REST. A thin routing target for the widened verbs
// (reason via chat/completions, embed via /embeddings, transcribe via
// /audio/transcriptions/Whisper). NOT exercised by the current 14 call sites;
// present so policy.ts can route a verb here later. Behaviour is additive.
import type { AdapterCtx, AdapterOut, ReasonEnv } from "../types";
import { buildChatBody, orText, usageTokens } from "../types";

const BASE = "https://api.openai.com/v1";

function apiKey(env: ReasonEnv): string {
  const k = (env as any).OPENAI_API_KEY;
  if (!k) throw new Error("openai api key missing");
  return k;
}

export async function run(env: ReasonEnv, ctx: AdapterCtx): Promise<AdapterOut> {
  const key = apiKey(env);
  const verb = ctx.req.verb ?? "reason";

  if (verb === "embed") {
    const res = await fetch(`${BASE}/embeddings`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: ctx.model, input: ctx.req.input ?? ctx.req.user ?? "" }),
    });
    const out: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`openai ${res.status}: ${String(out?.error?.message ?? "").slice(0, 160)}`);
    return { raw: out, text: "", tokensIn: out?.usage?.prompt_tokens ?? null, tokensOut: null };
  }

  if (verb === "transcribe") {
    // req.input carries a FormData (audio + params) built by the caller.
    const res = await fetch(`${BASE}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: ctx.req.input as any,
    });
    const out: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`openai ${res.status}: ${String(out?.error?.message ?? "").slice(0, 160)}`);
    return { raw: out, text: String(out?.text ?? "").trim(), tokensIn: null, tokensOut: null };
  }

  // reason — chat/completions (OpenAI-compatible body).
  const body = buildChatBody(ctx.req, ctx.body);
  (body as any).model = ctx.model;
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(ctx.req.timeoutMs ? { signal: AbortSignal.timeout(ctx.req.timeoutMs) } : {}),
  });
  const out: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`openai ${res.status}: ${String(out?.error?.message ?? "").slice(0, 160)}`);
  const [tokensIn, tokensOut] = usageTokens(out);
  return { raw: out, text: orText(out), tokensIn, tokensOut };
}
