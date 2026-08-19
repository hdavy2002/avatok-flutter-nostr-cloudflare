// Venice text-only client.
//
// Media generation is handled exclusively through Vertex in vertex_media.ts.
// This file remains only for the separately gated uncensored-text chat lane.

export interface VeniceEnv {
  VENICE_API_KEY?: string;
}

export const VENICE_BASE = "https://api.venice.ai/api/v1";

/** Used only by the explicitly gated text-chat lane. */
export const VENICE_UNCENSORED_CHAT_MODEL = "venice-uncensored-1-2";

export type VeniceTier = "free" | "paid";

function veniceKey(env: VeniceEnv): string {
  const key = env.VENICE_API_KEY;
  if (!key) throw new Error("venice_key_missing: VENICE_API_KEY secret not set on this worker");
  return key;
}

async function venicePost(env: VeniceEnv, path: string, body: unknown, timeoutMs: number): Promise<any> {
  const response = await fetch(`${VENICE_BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${veniceKey(env)}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await response.json().catch(() => ({})) as any;
  if (!response.ok) {
    const error: any = new Error(`venice ${response.status}: ${String(json?.error ?? json?.message ?? "unknown")}`.slice(0, 500));
    error.status = response.status;
    throw error;
  }
  return json;
}

export interface VeniceChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface VeniceChatResult {
  text: string;
  tokensIn: number | null;
  tokensOut: number | null;
}

export async function veniceChatComplete(
  env: VeniceEnv,
  model: string,
  messages: VeniceChatMessage[],
  opts: { maxTokens?: number; temperature?: number; timeoutMs?: number } = {},
): Promise<VeniceChatResult> {
  const body: any = { model, messages, reasoning: { enabled: false } };
  if (opts.maxTokens != null) body.max_tokens = opts.maxTokens;
  if (opts.temperature != null) body.temperature = opts.temperature;
  const json = await venicePost(env, "/chat/completions", body, opts.timeoutMs ?? 30000);
  const content = json?.choices?.[0]?.message?.content;
  const text = typeof content === "string"
    ? content.trim()
    : Array.isArray(content)
      ? content.map((part: any) => typeof part === "string" ? part : String(part?.text ?? "")).join("").trim()
      : "";
  if (!text) throw new Error("venice chat returned empty content");
  const usage = json?.usage ?? {};
  return {
    text,
    tokensIn: Number.isFinite(usage?.prompt_tokens) ? Number(usage.prompt_tokens) : null,
    tokensOut: Number.isFinite(usage?.completion_tokens) ? Number(usage.completion_tokens) : null,
  };
}
