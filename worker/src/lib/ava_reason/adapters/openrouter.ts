// adapters/openrouter.ts — OpenRouter chat completions. Used as the reasoner ALT
// fallback and as the worker's `legacyModel` pinned primary. Reproduces the
// historical worker `openRouterCall` / `openRouterStream` and the consumers
// `runOpenRouter` wire calls exactly (headers, body, error string, timeout).
import type { AdapterCtx, AdapterOut, ReasonEnv } from "../types";
import { buildChatBody, orText, usageTokens, OPENROUTER_URL } from "../types";

function orHeaders(key: string, title?: string): Record<string, string> {
  return {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
    "HTTP-Referer": "https://avatok.ai",
    "X-Title": title ?? "AvaTOK avaReason",
  };
}

export async function run(env: ReasonEnv, ctx: AdapterCtx): Promise<AdapterOut> {
  const key = (env as any).OPENROUTER_API_KEY as string | undefined;
  if (!key) throw new Error("openrouter key missing");
  const body = buildChatBody(ctx.req, ctx.body);
  (body as any).model = ctx.model;
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: orHeaders(key, ctx.title),
    body: JSON.stringify(body),
    ...(ctx.req.timeoutMs ? { signal: AbortSignal.timeout(ctx.req.timeoutMs) } : {}),
  });
  const out: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`openrouter ${res.status}: ${String(out?.error?.message ?? out?.error ?? "").slice(0, 160)}`);
  }
  const [tokensIn, tokensOut] = usageTokens(out);
  return { raw: out, text: orText(out), tokensIn, tokensOut };
}

/** Streaming passthrough — returns the raw fetch Response (SSE body). Worker-only. */
export async function stream(env: ReasonEnv, ctx: AdapterCtx): Promise<Response> {
  const key = (env as any).OPENROUTER_API_KEY as string | undefined;
  if (!key) throw new Error("openrouter key missing");
  const body = buildChatBody(ctx.req, ctx.body);
  (body as any).model = ctx.model;
  (body as any).stream = true;
  return fetch(OPENROUTER_URL, {
    method: "POST",
    headers: orHeaders(key, ctx.title),
    body: JSON.stringify(body),
  });
}
