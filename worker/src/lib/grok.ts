// grok.ts — thin x.ai client: the Grok Voice Agent realtime session URL/payload
// builders + the Collections REST client used for RAG document ingestion (WP4,
// plan §4/§5/§9 of Specs/PLAN-2026-07-11-dialpad-business-calls-ava-voice-agent.md).
//
// VERIFIED against docs.x.ai on 2026-07-11 (fetched
// https://docs.x.ai/developers/model-capabilities/audio/voice-agent.md and
// https://docs.x.ai/developers/tools/collections-search.md directly):
//
//  - Realtime (voice) uses api.x.ai + the REGULAR GROK_API_KEY. session.update
//    audio format is nested under `session.audio.input/output.format`
//    (`{type:"audio/pcm", rate:16000|24000|...}`), NOT the flat OpenAI-beta
//    `input_audio_format`/`output_audio_format` strings this file used before.
//    The realtime `file_search` tool IS documented (Collections-backed RAG in
//    a voice session) with exactly the `{type, vector_store_ids,
//    max_num_results}` shape already used here — no fallback tool needed.
//  - Collections MANAGEMENT (create/update/delete a collection; add/remove a
//    document) is a SEPARATE host — management-api.x.ai — authenticated with
//    a SEPARATE secret (GROK_MANAGEMENT_KEY, an x.ai Management API key with
//    AddFileToCollection + Collections Endpoint permissions). This was not
//    documented in the fetched pages (which show the xAI Python SDK, whose
//    AsyncClient(api_key=..., management_api_key=...) already implies two
//    distinct keys) — the exact REST paths below come from the owner's
//    verified-today facts. Document upload is the one-step multipart POST
//    (fields: name, data, content_type) — simpler than the two-step
//    api.x.ai/v1/files → management-api attach flow the SDK example also
//    supports.
//  - Document search (RAG lookup used by the realtime session's optional
//    custom `search_docs` function tool, and by any server-side reindex/QA
//    path) uses the REGULAR key against api.x.ai/v1/documents/search.
import type { Env } from "../types";

const REALTIME_BASE = "wss://api.x.ai/v1/realtime";
const REST_BASE = "https://api.x.ai/v1"; // regular GROK_API_KEY: realtime + documents/search
const MANAGEMENT_BASE = "https://management-api.x.ai/v1"; // GROK_MANAGEMENT_KEY: collections CRUD + doc add/remove
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

/** Collections-backed RAG tool for a realtime voice session — doc-confirmed
 *  shape (docs.x.ai "Using Tools with Grok Voice Agent API" → Collections
 *  Search): {type:"file_search", vector_store_ids:[...], max_num_results}. */
export interface GrokFileSearchTool {
  type: "file_search";
  vector_store_ids: string[];
  max_num_results: number;
}

export type GrokTool = GrokFunctionTool | GrokFileSearchTool;

/**
 * Build the `session.update` event payload — verified shape per docs.x.ai's
 * Voice Agent API page (Session Parameters + "Configuring Audio Format").
 * NEVER includes `web_search`/`x_search` — plan §4 "owner decision
 * 2026-07-11": the agent answers from the owner's Collection + connectors
 * only.
 */
export function buildSessionUpdate(args: {
  instructions: string;
  voice?: string;
  tools: GrokTool[];
  sampleRate?: number; // Hz; the caller-audio bridge here runs PCM16 16k (do/agent_voice_room.ts)
}): Record<string, unknown> {
  // Defensive allow-list: even if a caller ever mistakenly builds a tool array
  // containing a search tool, strip it here — this function is the single choke
  // point every session.update flows through.
  const tools = (args.tools ?? []).filter((t) => t.type !== ("web_search" as string) && t.type !== ("x_search" as string));
  const rate = args.sampleRate || 16000;
  return {
    type: "session.update",
    session: {
      instructions: args.instructions,
      voice: args.voice || "eve", // eve|ara|rex|sal|leo (or custom voice_id) — doc default voice is "eve"
      turn_detection: { type: "server_vad" },
      audio: {
        input: {
          format: { type: "audio/pcm", rate },
          // Enables conversation.item.input_audio_transcription.completed —
          // per the docs.x.ai OpenAI-compat note, the "updated" (cumulative
          // delta) variant is only emitted with this model set; harmless to
          // set even if we only consume the final `.completed` event.
          transcription: { model: "grok-transcribe" },
        },
        output: { format: { type: "audio/pcm", rate } },
      },
      tools,
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

/** Management-API fetch (collections CRUD + document add/remove). Graceful:
 *  never throws, and returns a distinguishable MANAGEMENT_KEY_MISSING reason
 *  when GROK_MANAGEMENT_KEY isn't set so callers can degrade instead of
 *  erroring the whole upload/delete flow. */
async function mgmtFetch(env: Env, path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; json: any; reason?: string }> {
  const key = env.GROK_MANAGEMENT_KEY;
  if (!key) return { ok: false, status: 0, json: {}, reason: "MANAGEMENT_KEY_MISSING" };
  try {
    const res = await fetch(`${MANAGEMENT_BASE}${path}`, {
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
 *  called the first time a profile with no `collection_id` uploads a doc.
 *  management-api.x.ai/v1/collections, body {collection_name}. */
export async function createCollection(env: Env, name: string): Promise<{ ok: boolean; id?: string; error?: string; reason?: string }> {
  const r = await mgmtFetch(env, "/collections", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ collection_name: name.slice(0, 120) }),
  });
  if (r.reason === "MANAGEMENT_KEY_MISSING") return { ok: false, reason: "MANAGEMENT_KEY_MISSING" };
  if (!r.ok) return { ok: false, error: r.json?.error ?? `http_${r.status}` };
  const id = r.json?.collection_id ?? r.json?.id ?? r.json?.data?.id;
  if (!id) return { ok: false, error: "no_id_in_response" };
  return { ok: true, id: String(id) };
}

/** Upload one document into an existing collection — one-step multipart POST
 *  management-api.x.ai/v1/collections/{id}/documents, fields: name, data,
 *  content_type. */
export async function uploadDocument(
  env: Env, collectionId: string, filename: string, content: Uint8Array, contentType: string,
): Promise<{ ok: boolean; fileId?: string; error?: string; reason?: string }> {
  const key = env.GROK_MANAGEMENT_KEY;
  if (!key) return { ok: false, reason: "MANAGEMENT_KEY_MISSING" };
  try {
    const form = new FormData();
    form.append("name", filename);
    form.append("content_type", contentType || "application/octet-stream");
    form.append("data", new Blob([content], { type: contentType || "application/octet-stream" }), filename);
    const res = await fetch(`${MANAGEMENT_BASE}/collections/${encodeURIComponent(collectionId)}/documents`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(30000),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: j?.error ?? `http_${res.status}` };
    const fileId = j?.file_id ?? j?.id ?? j?.file_metadata?.file_id ?? j?.data?.id;
    if (!fileId) return { ok: false, error: "no_id_in_response" };
    return { ok: true, fileId: String(fileId) };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
}

/** Remove a document from a collection.
 *  DELETE management-api.x.ai/v1/collections/{id}/documents/{fileId}. */
export async function deleteDocument(env: Env, collectionId: string, fileId: string): Promise<{ ok: boolean; error?: string; reason?: string }> {
  const r = await mgmtFetch(env, `/collections/${encodeURIComponent(collectionId)}/documents/${encodeURIComponent(fileId)}`, { method: "DELETE" });
  if (r.reason === "MANAGEMENT_KEY_MISSING") return { ok: false, reason: "MANAGEMENT_KEY_MISSING" };
  return r.ok ? { ok: true } : { ok: false, error: r.json?.error ?? `http_${r.status}` };
}

/** Document/collections search with the REGULAR key.
 *  POST api.x.ai/v1/documents/search {query, source:{collection_ids}, retrieval_mode:{type:"hybrid"}}.
 *  Used server-side by any RAG lookup that isn't the realtime session's own
 *  `file_search` tool call (e.g. a text-channel agent, or a diagnostic route).
 *
 *  One Brain B1 (SPEC §4) note: NOTHING in this file is a `reason`-verb inference
 *  call, so nothing routes through the xai adapter today. The realtime voice session
 *  builders (session.update / wrap-up nudges) are WebSocket control payloads, the
 *  collections CRUD hits management-api.x.ai, and this `documents/search` is a
 *  vector-retrieval endpoint — none is an api.x.ai chat/completions call. The moment
 *  a server-side x.ai *chat/completions* inference is added here (e.g. a text-channel
 *  Grok agent that answers from a Collection), route THAT call through
 *  `avaReason({ verb:"reason", ... })` → the xai adapter; leave these transport,
 *  RAG-retrieval, and realtime paths as-is. */
export async function searchDocuments(
  env: Env, query: string, collectionIds: string[],
): Promise<{ ok: boolean; results?: unknown[]; error?: string }> {
  if (!collectionIds.length) return { ok: true, results: [] };
  const r = await xfetch(env, "/documents/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      source: { collection_ids: collectionIds },
      retrieval_mode: { type: "hybrid" },
    }),
  });
  if (!r.ok) return { ok: false, error: r.json?.error ?? `http_${r.status}` };
  const results = r.json?.results ?? r.json?.data ?? [];
  return { ok: true, results: Array.isArray(results) ? results : [] };
}
