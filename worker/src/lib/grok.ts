// grok.ts — thin x.ai client: the Grok Voice Agent realtime session URL/payload
// builders + the Collections REST client used for RAG document ingestion (WP4,
// plan §4/§5/§9 of Specs/PLAN-2026-07-11-dialpad-business-calls-ava-voice-agent.md).
//
// ⚠️ TODO (verify before enabling `voiceAgent` in KV): the exact x.ai Collections
// REST endpoint PATHS below (create/upload/delete) are implemented against the
// documented base URL (https://api.x.ai/v1) and the shape x.ai's own docs use
// for OpenAI-Assistants-style vector stores, but have NOT been hit against a
// live x.ai account as of this writing. Verify `/v1/collections`,
// `/v1/collections/{id}/files` against current x.ai docs on first deploy, the
// same way reception_room_cf.ts flags its own "verify against a live call"
// TODO for Workers AI model I/O shapes. Everything here is defensive (never
// throws on an unexpected response shape) so a path drift degrades to "RAG
// unavailable this call" rather than crashing the agent.
import type { Env } from "../types";

const REALTIME_BASE = "wss://api.x.ai/v1/realtime";
const REST_BASE = "https://api.x.ai/v1";
export const GROK_VOICE_MODEL = "grok-voice-latest";

/** The realtime WS URL the DO connects to as a CLIENT (do/agent_voice_room.ts). */
export function realtimeUrl(model = GROK_VOICE_MODEL): string {
  return `${REALTIME_BASE}?model=${encodeURIComponent(model)}`;
}

export interface GrokFunctionTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface GrokFileSearchTool {
  type: "file_search";
  vector_store_ids: string[];
  max_num_results: number;
}

export type GrokTool = GrokFunctionTool | GrokFileSearchTool;

/**
 * Build the `session.update` event payload (OpenAI-Realtime-shaped — Grok's
 * realtime API follows the same event protocol per x.ai's docs). NEVER
 * includes `web_search`/`x_search` — plan §4 "owner decision 2026-07-11":
 * the agent answers from the owner's Collection + connectors only.
 */
export function buildSessionUpdate(args: {
  instructions: string;
  voice?: string;
  tools: GrokTool[];
}): Record<string, unknown> {
  // Defensive allow-list: even if a caller ever mistakenly builds a tool array
  // containing a search tool, strip it here — this function is the single choke
  // point every session.update flows through.
  const tools = (args.tools ?? []).filter((t) => t.type !== ("web_search" as string) && t.type !== ("x_search" as string));
  return {
    type: "session.update",
    session: {
      instructions: args.instructions,
      voice: args.voice || "verse",
      modalities: ["audio", "text"],
      input_audio_format: "pcm16",
      output_audio_format: "pcm16",
      tools,
      tool_choice: "auto",
    },
  };
}

/** Inject a wrap-up nudge without tearing down the session — used at T-30s of
 *  agentMaxCallSec and on low-balance mid-call (plan §9 "graceful wrap-up"). */
export function buildWrapUpNudge(reason: "time_limit" | "wallet_low"): Record<string, unknown> {
  const text = reason === "time_limit"
    ? "[SYSTEM: the call is almost at its time limit. Wrap up the conversation now — summarize any next steps and say a brief goodbye within the next few sentences.]"
    : "[SYSTEM: the caller's account balance is running low. Wrap up the conversation now — say you have to go and invite them to call back or leave a message.]";
  return {
    type: "conversation.item.create",
    item: { type: "message", role: "system", content: [{ type: "input_text", text }] },
  };
}

async function xfetch(env: Env, path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; json: any }> {
  const key = env.GROK_API_KEY;
  if (!key) return { ok: false, status: 0, json: { error: "GROK_API_KEY unset" } };
  try {
    const res = await fetch(`${REST_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(init?.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(20000),
    });
    const j = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json: j };
  } catch (e) {
    return { ok: false, status: 0, json: { error: String(e).slice(0, 200) } };
  }
}

/** Create a Grok Collection (vector store) for one Agent Profile, lazily —
 *  called the first time a profile with no `collection_id` uploads a doc. */
export async function createCollection(env: Env, name: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  const r = await xfetch(env, "/collections", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name.slice(0, 120) }),
  });
  if (!r.ok) return { ok: false, error: r.json?.error ?? `http_${r.status}` };
  const id = r.json?.id ?? r.json?.collection_id ?? r.json?.data?.id;
  if (!id) return { ok: false, error: "no_id_in_response" };
  return { ok: true, id: String(id) };
}

/** Upload one document into an existing collection. `content` is the raw file
 *  bytes; uploaded as multipart/form-data (the conventional Collections/Files
 *  upload shape) — see the TODO at the top of this file. */
export async function uploadDocument(
  env: Env, collectionId: string, filename: string, content: Uint8Array, contentType: string,
): Promise<{ ok: boolean; fileId?: string; error?: string }> {
  const key = env.GROK_API_KEY;
  if (!key) return { ok: false, error: "GROK_API_KEY unset" };
  try {
    const form = new FormData();
    form.append("file", new Blob([content], { type: contentType || "application/octet-stream" }), filename);
    const res = await fetch(`${REST_BASE}/collections/${encodeURIComponent(collectionId)}/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(30000),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: j?.error ?? `http_${res.status}` };
    const fileId = j?.id ?? j?.file_id ?? j?.data?.id;
    if (!fileId) return { ok: false, error: "no_id_in_response" };
    return { ok: true, fileId: String(fileId) };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
}

/** Remove a document from a collection. */
export async function deleteDocument(env: Env, collectionId: string, fileId: string): Promise<{ ok: boolean; error?: string }> {
  const r = await xfetch(env, `/collections/${encodeURIComponent(collectionId)}/files/${encodeURIComponent(fileId)}`, { method: "DELETE" });
  return r.ok ? { ok: true } : { ok: false, error: r.json?.error ?? `http_${r.status}` };
}
