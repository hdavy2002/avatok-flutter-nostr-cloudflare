// Shared helpers: HTTP/CORS, hashing, hex, phone normalization.
import { avaReason } from "./lib/ava_reason"; // One Brain B1: unified reasoning gateway

export const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type,authorization,x-content-type,idempotency-key",
};

export function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...CORS, ...extra },
  });
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

// Robust text extraction across Workers AI chat shapes: `{response}` (Llama/Gemma3)
// or `{choices:[{message:{content,reasoning}}]}` (Gemma 4 OpenAI-style; `reasoning`
// is the thinking chain, `content` the final answer). Prefer content.
export function aiText(out: any): string {
  if (!out) return "";
  if (typeof out.response === "string") return out.response;
  const m = out.choices?.[0]?.message;
  if (m) return (m.content ?? m.reasoning ?? "") as string;
  return (out.description ?? "") as string;
}

// Extract answer text from a Gemini (candidates/parts) response, dropping any
// "thought" parts so raw reasoning never leaks. Falls back to aiText for other
// (OpenAI / Workers-AI) shapes, so it's safe on any env.AI.run result.
export function geminiText(out: any): string {
  const parts = out?.candidates?.[0]?.content?.parts
    ?? out?.response?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    return parts
      .filter((p: any) => p?.thought !== true)
      .map((p: any) => String(p?.text ?? ""))
      .join("")
      .trim();
  }
  return aiText(out).trim();
}

// Per-model "thinking off" config for LOW LATENCY. Gemini 3 spends ~5s reasoning
// silently by default (thinkingLevel "medium"), which dominates @ava latency and
// defeats streaming (no visible token until thinking ends). We turn it down:
// Gemini 3 uses `thinkingLevel` ("low"); Gemini 2.x uses `thinkingBudget:0`.
// NOTE: sending `thinkingBudget` to a Gemini-3 model returns HTTP 400 — never mix
// the two. Returns a generationConfig fragment to merge into the request body.
export function thinkingCfg(model: string): Record<string, unknown> {
  return model.startsWith("gemini-3")
    ? { thinkingConfig: { thinkingLevel: "low" } }
    : { thinkingConfig: { thinkingBudget: 0 } };
}

// Build a Gemini-native request body — one user turn, system as systemInstruction.
export function geminiBody(system: string, user: string, maxTokens = 700, temperature = 0.7): any {
  const body: any = {
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: { maxOutputTokens: maxTokens, temperature },
  };
  if (system && system.trim()) body.systemInstruction = { parts: [{ text: system }] };
  return body;
}

// Our online brain model. gemini-3-flash-preview is NOT a valid Workers-AI
// partner id ('google/gemini-3-flash-preview' → 7003 "User Input Error", which
// wasted a failed round-trip on every turn). It DOES work via the DIRECT Google
// API (same path AvaVision + the Composio tool-loop use), so we call it there.
export const GEMINI_MODEL = "gemini-3-flash-preview";
export const GEMINI_FALLBACK_MODEL = "gemini-2.5-flash-lite";

/// Run a single-turn Gemini generation via the DIRECT generativelanguage API using
/// env.GEMINI_API_KEY. Tries gemini-3, falls back to gemini-2.5; returns the answer
/// text (or "" on total failure). One real call, no 7003 penalty.
///
/// One Brain B1 (SPEC §4): now a THIN SHIM over the shared avaReason gateway via the
/// `gemini_direct` route. Behaviour is preserved EXACTLY for all 6 call sites
/// (ava_agent ×3, conversation, user_brain, ava_delegate): system → systemInstruction,
/// per-model thinking-off (geminiThinkingOff), the gemini-3 → gemini-2.5-flash-lite
/// two-model empty-text ladder (now in the google adapter, models from policy),
/// answer text with "thought" parts dropped, and the "never throw, return '' on any
/// failure" contract. The public signature is unchanged. The model ladder now lives
/// in ava_reason/policy.ts (env-overridable via GEMINI_DIRECT_MODEL / _ALT_MODEL) and
/// each call now emits a unified `ava_reason_call` telemetry event.
export async function geminiRun(
  env: any, system: string, user: string,
  maxTokens = 700, temperature = 0.7,
): Promise<string> {
  if (!env?.GEMINI_API_KEY) return ""; // no key → "" without a gateway call (as before)
  try {
    return await avaReason(env, {
      role: "reasoner", capability: "reason", trigger: "gemini_run",
      feature: "gemini_direct",
      system, user, maxTokens, temperature,
      geminiThinkingOff: true, // per-model thinking off for ~1s latency (was thinkingCfg)
    });
  } catch { return ""; } // preserve geminiRun's total-failure "" (never throws)
}

// D1 caps bound parameters at 100 per query. Split arrays into safe batches.
export function chunk<T>(arr: T[], size = 90): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export async function sha256Bytes(data: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return new Uint8Array(buf);
}

export async function sha256Hex(input: string | ArrayBuffer | Uint8Array): Promise<string> {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  return hex(await sha256Bytes(data));
}

// Best-effort E.164 normalization. Client should send +CC numbers; we strip the rest.
export function normalizePhone(raw: string): string {
  const t = raw.trim().replace(/[^\d+]/g, "");
  return t.startsWith("+") ? t : "+" + t;
}

/** Canonical, chronologically-sortable message id: 13-digit zero-padded epoch ms
 *  + a short random suffix → lexical sort == time order, collision-safe. Used as
 *  the message serial, the R2 archive key, and the client dedupe key. (Relocated
 *  from the deleted routes/ably.ts — it was never Ably-specific.) */
export function canonicalMsgId(createdMs: number): string {
  return `${String(createdMs).padStart(13, "0")}.${crypto.randomUUID().slice(0, 8)}`;
}
