import type { Env } from "./types";

// Daily Workers AI call counter (Scale proposal Phase 0: neuron budget alarm).
// Best-effort single UPSERT per model call into DB_MODERATION.ai_spend; the 6h
// cron compares calls vs AI_DAILY_CALL_BUDGET and emails once/day if exceeded.
export async function bumpAiSpend(env: Env, ms: number): Promise<void> {
  try {
    const day = new Date().toISOString().slice(0, 10);
    await env.DB_MODERATION.prepare(
      "INSERT INTO ai_spend (day, calls, ms) VALUES (?1, 1, ?2) ON CONFLICT(day) DO UPDATE SET calls=calls+1, ms=ms+?2",
    ).bind(day, ms).run();
  } catch { /* table may not exist yet; never block the pipeline */ }
}

// Robust text extraction across Workers AI chat response shapes:
//  • `{ response: "..." }`                         — Llama, Gemma 3
//  • `{ choices: [{ message: { content, reasoning } }] }` — Gemma 4 (OpenAI-style;
//    `reasoning` holds the thinking-mode chain, `content` the final answer)
// Prefer the final content; fall back to reasoning, then description.
export function aiText(out: any): string {
  if (!out) return "";
  if (typeof out.response === "string") return out.response;
  const m = out.choices?.[0]?.message;
  if (m) return (m.content ?? m.reasoning ?? "") as string;
  return (out.description ?? "") as string;
}
