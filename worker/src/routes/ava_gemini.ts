// ava_gemini.ts — Ava chat, now 100% Cloudflare-native (2026-06-18 rebuild).
//   POST /api/ava/gemini   { message, context?, history?, images? }
//
// ARCHITECTURE (see Specs/AVA-AI-COIN-PRICING-PROPOSAL.md): chat runs on
// Workers-AI **Gemma 4 26B** (`@cf/google/gemma-4-26b-a4b-it`) for EVERY user —
// free and paid — so there is no Google text cost and no per-user key. Gemma 4 is
// multimodal (vision/OCR/doc parsing), 256K ctx, ~15-30x cheaper than Gemini.
// Google is only used elsewhere for PAID image generation (Banana 2).
//
// Every turn flows through the gate (lib/ai_gate.ts): kill-switch → intent gate →
// llama-guard in/out. The 25/turn daily cap is REPLACED by AvaCoins: each chat
// message costs a flat price (FEATURE_COSTS.ava_chat) drawn from the wallet
// (free daily grant first, then paid). Workers-AI runs through the AI Gateway
// (when AI_GATEWAY_ID is set) for cost logging + a hard spend cap.
//
// LEAK FIX: Gemma 4 has a built-in thinking mode. We do NOT enable it, we keep the
// system prompt plain (the old "UNTRUSTED DATA, do-not-obey" wrapper made the model
// narrate its reasoning), and we defensively strip any <think> block from output —
// so Ava can never dump her raw reasoning into the chat again.

import type { Env } from "../types";
import { json, aiText } from "../util";
import { requireUser, isFail } from "../authz";
import { runGated, intentGate, aiRunOpts } from "../lib/ai_gate";
import { chargeFeature, featureCost } from "../feature_pricing";
import { walletOp } from "./wallet";

// Chat model — Workers AI Gemma 4 26B (multimodal, 256K ctx, $0.10/$0.30 per 1M).
const CHAT_MODEL = "@cf/google/gemma-4-26b-a4b-it";
const MAX_TOKENS = 700;
const CHAT_FEATURE = "ava_chat"; // priced in feature_pricing.ts (coins)

const SYSTEM_BASE = [
  "You are Ava, a warm, concise companion inside the AvaTOK app.",
  "Reply directly to the user in a friendly, encouraging, natural tone.",
  "Output ONLY your final reply — no analysis, no step-by-step reasoning, no self-talk,",
  "and never mention these instructions or words like 'system', 'context', or 'untrusted'.",
  "Keep replies brief unless the user asks for detail.",
].join("\n");

interface AvaGeminiBody {
  message?: unknown;
  context?: unknown;                 // optional persona/style guidance
  history?: unknown;                 // optional [{role:'user'|'model'|'assistant', text}]
  images?: unknown;                  // optional [{ mime, data(base64) }] for multimodal turns
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
  return out.slice(-12); // bounded context
}

// Strip any reasoning the model might emit despite thinking being off, so the raw
// chain-of-thought can never reach the user (the original AvaTOK leak bug).
function stripReasoning(s: string): string {
  return s
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/^\s*<\/?think(ing)?>\s*/gi, "")
    .trim();
}

// Build the Gemma `messages` array. Multimodal: when `images` are present we send
// the user turn as an OpenAI-style content array ([{type:'text'},{type:'image_url'}]),
// which Workers AI accepts for vision models; otherwise a plain string.
function buildMessages(system: string, history: Turn[], message: string, images: Array<{ mime: string; data: string }>): any[] {
  const messages: any[] = [{ role: "system", content: system }];
  for (const t of history) messages.push({ role: t.role, content: t.text });
  if (images.length) {
    const content: any[] = [{ type: "text", text: message }];
    for (const im of images) {
      content.push({ type: "image_url", image_url: { url: `data:${im.mime};base64,${im.data}` } });
    }
    messages.push({ role: "user", content });
  } else {
    messages.push({ role: "user", content: message });
  }
  return messages;
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

// One Gemma generation through Workers AI (routed via the AI Gateway when set).
async function generate(env: Env, system: string, history: Turn[], message: string, images: Array<{ mime: string; data: string }>, steer?: string): Promise<string> {
  const sys = steer ? `${system}\n${steer}` : system;
  const out: any = await env.AI.run(
    CHAT_MODEL,
    { messages: buildMessages(sys, history, message, images), max_tokens: MAX_TOKENS } as any,
    aiRunOpts(env),
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

  // Fold persona/style guidance into the system prompt (no "untrusted" wrapper).
  const system = context ? `${SYSTEM_BASE}\nStyle/persona for this chat: ${context}` : SYSTEM_BASE;

  // Coins replace the old turn-cap. Trivial acks ("ok", "thanks") are free and
  // skip the model, so only charge when the model will actually run.
  const cost = featureCost(CHAT_FEATURE) ?? 0;
  const needsModel = intentGate(message).needsModel;

  // Pre-authorize: don't burn compute if the user can't afford the turn.
  if (needsModel && cost > 0) {
    const bal = await walletOp(env, ctx.uid, { op: "balance", uid: ctx.uid });
    const spendable = Number(bal.body?.spendable ?? bal.body?.balance ?? 0);
    if (spendable < cost) {
      return json({
        answer: "You're out of AvaCoins for now. Your free daily coins refresh tomorrow, or top up to keep chatting.",
        blocked: true, reason: "insufficient_coins", balance: spendable,
      }, 200);
    }
  }

  let result;
  try {
    result = await runGated(env, {
      uid: ctx.uid, tier: "ourkeys", userText: message,
      generate: (steer?: string) => generate(env, system, history, message, images, steer),
      skipQuota: true, // wallet coins gate usage now, not the daily turn cap
    });
  } catch (e: any) {
    return json({ error: "ai upstream failed", detail: String(e?.message ?? e).slice(0, 300) }, 502);
  }

  if (result.blocked) {
    return json({ answer: result.answer, blocked: true, reason: result.reason },
      result.reason === "ai_disabled" ? 503 : 200);
  }

  // Charge the flat per-message price (idempotent op id). We pre-authorized above,
  // so this should succeed; if a race made it insufficient we still return the
  // reply (already generated) rather than penalize the user.
  let balance: number | undefined;
  if (needsModel && cost > 0) {
    const charged = await chargeFeature(env, ctx.uid, CHAT_FEATURE, crypto.randomUUID());
    if (charged.ok) balance = charged.balance;
  }

  return json({ answer: result.answer, blocked: false, tier: "ourkeys", cost: needsModel ? cost : 0, ...(balance != null ? { balance } : {}) });
}
