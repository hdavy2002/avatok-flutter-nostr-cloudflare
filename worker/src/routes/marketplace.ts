// AvaMarketplace routes (Specs/AVAMARKETPLACE-FINAL-PROPOSAL.md).
// Buy/sell/social marketplace glue on top of the Phase-6 listings tables:
//   POST /api/marketplace/ai-assist          P3 — "Help me write" (Claude Sonnet)
//   POST /api/marketplace/negotiate          P5 — queue agent↔agent negotiation
//   GET  /api/marketplace/negotiate/state     P5 — talk-once-per-version check
//   GET  /api/marketplace/search              P6 — AI search over active listings
//   POST /api/marketplace/precheck            P7 — text + PII safety precheck
// All write routes require auth. The negotiation LLM is the latest Claude Sonnet
// via OpenRouter; deal audio (Gemini 2.5 multi-speaker TTS) is rendered ONLY on
// a DEAL. Everything here is dark until the marketplaceEnabled kill switch is on.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { track } from "../hooks";

/** Latest Claude Sonnet via OpenRouter — overridable by env for "latest" tracking. */
export const MARKET_LLM = "anthropic/claude-sonnet-4.6";

/** One-shot OpenRouter chat call (Sonnet). Returns trimmed text or "" on error. */
export async function callSonnet(
  env: Env,
  system: string,
  user: string,
  maxTokens = 400,
): Promise<string> {
  const key = (env as any).OPENROUTER_API_KEY as string | undefined;
  if (!key) return "";
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        "HTTP-Referer": "https://avatok.ai",
        "X-Title": "AvaMarketplace",
      },
      body: JSON.stringify({
        model: (env as any).OPENROUTER_MARKET_MODEL || MARKET_LLM,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.4,
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) return "";
    const out: any = await res.json().catch(() => null);
    return String(out?.choices?.[0]?.message?.content ?? "").trim();
  } catch {
    return "";
  }
}

// ── P3: AI writing help ──────────────────────────────────────────────────────
// want = instructions | title | description. `fields` carries the form so far.
export async function marketplaceAiAssist(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const want = String(b.want || "instructions");
  const kind = String(b.kind || "sell");
  const f = (b.fields ?? {}) as Record<string, unknown>;

  const ctxLine =
    `Listing type: ${kind}. Title: ${f.title ?? ""}. Category: ${f.category ?? ""}. ` +
    `Description: ${f.description ?? ""}. Price: ${f.price_amount ?? ""} ${f.price_currency ?? ""}. ` +
    `Location: ${f.location ?? ""}.`;

  let system: string;
  if (want === "title") {
    system =
      "You write short, honest marketplace listing TITLES (max 8 words). No phone numbers, " +
      "emails, emojis, ALL-CAPS or hype. Output only the title text.";
  } else if (want === "description") {
    system =
      "You write clear, honest marketplace DESCRIPTIONS (2-4 short sentences). Never invent facts. " +
      "Never include phone numbers, emails or off-platform contact details. Output only the description.";
  } else {
    system =
      "You write a short INSTRUCTION a person gives their negotiation agent for a marketplace listing. " +
      "Cover their price stance (floor/target for sellers, max for buyers), key facts to mention, and tone. " +
      "2-4 sentences, first person ('You represent me...'). No contact details. Output only the instruction.";
  }

  const text = await callSonnet(env, system, ctxLine, want === "title" ? 40 : 250);
  track(env, ctx.uid, "listing_ai_assist_used", "avamarketplace", { want, kind, ok: text.length > 0 });
  if (!text) return json({ error: "ai_unavailable" }, 503);
  return json({ ok: true, text });
}

// ── P5/P6/P7 handlers — declared here so index.ts always resolves its imports;
//    their real bodies are filled in by the matching phase. ──────────────────
export async function marketplaceNegotiate(_req: Request, _env: Env): Promise<Response> {
  return json({ error: "not_implemented" }, 501); // P5
}
export async function marketplaceNegotiateState(_req: Request, _env: Env): Promise<Response> {
  return json({ already_talked: false }, 200); // P5
}
export async function marketplaceSearch(_req: Request, _env: Env): Promise<Response> {
  return json({ listings: [] }, 200); // P6
}
export async function marketplacePrecheck(_req: Request, _env: Env): Promise<Response> {
  return json({ ok: true }, 200); // P7
}
