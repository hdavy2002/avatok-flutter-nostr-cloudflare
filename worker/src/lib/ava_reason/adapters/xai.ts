// adapters/xai.ts — xAI Grok REST (OpenAI-compatible chat/completions). A thin
// routing target for the `reason` verb when policy selects xAI. NOT exercised by
// the current 14 call sites; present so policy.ts can dispatch here later.
import type { AdapterCtx, AdapterOut, ReasonEnv } from "../types";
import { buildChatBody, orText, usageTokens } from "../types";

const BASE = "https://api.x.ai/v1";

export async function run(env: ReasonEnv, ctx: AdapterCtx): Promise<AdapterOut> {
  const key = (env as any).XAI_API_KEY as string | undefined;
  if (!key) throw new Error("xai api key missing");
  const body = buildChatBody(ctx.req, ctx.body);
  (body as any).model = ctx.model;
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(ctx.req.timeoutMs ? { signal: AbortSignal.timeout(ctx.req.timeoutMs) } : {}),
  });
  const out: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`xai ${res.status}: ${String(out?.error?.message ?? out?.error ?? "").slice(0, 160)}`);
  }
  const [tokensIn, tokensOut] = usageTokens(out);
  return { raw: out, text: orText(out), tokensIn, tokensOut };
}
