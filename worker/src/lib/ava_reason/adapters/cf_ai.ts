// adapters/cf_ai.ts — Workers AI (env.AI.run). The primary provider for the
// reasoner ladder and for every image/vision/classifier body. Reproduces the
// historical worker `workersAiCall` and consumers `env.AI.run(model, body)` paths.
//
// aiRunOpts (SPEC §4 / ai_gate.aiRunOpts): when the caller passes a gateway options
// object, it is forwarded as the THIRD arg to env.AI.run so the next step's env.AI.run
// migrations get AI Gateway cost logging / caching / per-uid metadata. When absent,
// the 2-arg form is used — byte-identical to today's calls.
import type { AdapterCtx, AdapterOut, ReasonEnv } from "../types";
import { buildChatBody, cfText, usageTokens } from "../types";

export async function run(env: ReasonEnv, ctx: AdapterCtx): Promise<AdapterOut> {
  const ai: any = (env as any).AI;
  if (!ai || typeof ai.run !== "function") throw new Error("workers-ai binding missing");
  const body = buildChatBody(ctx.req, ctx.body);
  const out: any = ctx.aiRunOpts
    ? await ai.run(ctx.model, body, ctx.aiRunOpts)
    : await ai.run(ctx.model, body);
  const [tokensIn, tokensOut] = usageTokens(out);
  return { raw: out, text: cfText(out), tokensIn, tokensOut };
}
