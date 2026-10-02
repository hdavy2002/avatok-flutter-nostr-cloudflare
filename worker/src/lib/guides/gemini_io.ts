// [AUMFE-PANDIT-COST-1 2026-10-02] Gemini transport shared by the chat turn (text_chat.ts) and the summary/close calls
// (topic.ts). Split out so topic.ts does not import text_chat.ts (which imports topic.ts).
import type { Env } from "../../types";
import { geminiFetch } from "../gemini_egress";
import type { Usage } from "../preeti/gemini";

export const GLA = "https://generativelanguage.googleapis.com";

export function apiKey(env: Env): string {
  const k = (env.GEMINI_API_KEY ?? "").trim();
  if (!k) throw new Error("GEMINI_API_KEY missing");
  return k;
}

export function usageOf(j: any): Usage {
  const u = j?.usageMetadata ?? {};
  return {
    inTok: Number(u.promptTokenCount ?? 0) + Number(u.toolUsePromptTokenCount ?? 0),
    outTok: Number(u.candidatesTokenCount ?? 0) + Number(u.thoughtsTokenCount ?? 0),
  };
}

export const thinking = (model: string) => (model.startsWith("gemini-3") ? { thinkingConfig: { thinkingLevel: "low" } } : { thinkingConfig: { thinkingBudget: 0 } });

export async function post(env: Env, model: string, method: string, body: unknown, query = ""): Promise<Response> {
  let last: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await geminiFetch(env, `${GLA}/v1beta/models/${encodeURIComponent(model)}:${method}${query}`, {
      method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": apiKey(env) }, body: JSON.stringify(body),
    });
    if (r.ok || (r.status !== 429 && r.status < 500)) return r;
    last = r;
    await new Promise((res) => setTimeout(res, 400));
  }
  return last!;
}

/** Model output -> up to 3 safe one-line facts. Pure; exported for tests. */
export function parseFacts(raw: string): string[] {
  let arr: unknown;
  try { arr = JSON.parse(raw.replace(/^```(?:json)?|```$/g, "").trim()); } catch { return []; }
  return cleanFacts(arr);
}

/** Already-parsed array -> up to 3 safe facts (same filters as parseFacts). */
export function cleanFacts(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  for (const x of arr) {
    if (typeof x !== "string") continue;
    const t = x.replace(/\s+/g, " ").trim();
    if (t.length < 6 || t.length > 160) continue;
    if (/\d{9,}/.test(t) || /password|otp|cvv|card number/i.test(t)) continue; // never keep numbers that look like ids / cards / secrets
    out.push(t);
    if (out.length >= 3) break;
  }
  return out;
}

/** One non-streaming text call; returns the visible text plus usage. Throws on a non-2xx. */
export async function generateText(env: Env, model: string, a: { system: string; user: string; maxOutputTokens: number; json?: boolean }): Promise<{ text: string; usage: Usage; finishReason: string }> {
  const body = {
    systemInstruction: { parts: [{ text: a.system }] },
    contents: [{ role: "user", parts: [{ text: a.user }] }],
    generationConfig: { maxOutputTokens: a.maxOutputTokens, temperature: 0.2, ...(a.json ? { responseMimeType: "application/json" } : {}), ...thinking(model) },
  };
  const r = await post(env, model, "generateContent", body);
  if (!r.ok) throw new Error(`gemini ${r.status} (summary)`);
  const j: any = await r.json();
  const cand = j?.candidates?.[0];
  const text = (cand?.content?.parts ?? []).filter((p: any) => !p.thought).map((p: any) => p.text ?? "").join("").trim();
  return { text, usage: usageOf(j), finishReason: String(cand?.finishReason ?? "") };
}
