// [AGENT-LIVE-1] OpenAI Files + Vector Stores — RAG knowledge bases (D5,
// Specs/SPEC-2026-09-12-AGENT-LIVE-1-BUILD.md §3 admin KB routes). One vector
// store per agent, created lazily on first upload; the AgentLiveRoom DO's
// `search_knowledge` tool (WS-E1) calls `searchVectorStore` at runtime.
//
// Every call requires `env.OPENAI_API_KEY` — routes/agent_live/admin.ts only
// reaches this module from behind `requireAgentAdmin`, and the talk lane is
// gated separately by laneGate/talkGate (D12), so this module does not
// re-check the platform flags; it only fails closed on a missing key. No
// silent catches: every failure THROWS an `OpenAIFilesError` so the caller
// (admin.ts) can track() the outcome and return a real error to the admin UI.
import type { Env } from "../../types";

const OPENAI_BASE = "https://api.openai.com/v1";
const TIMEOUT_MS = 10_000;

export class OpenAIFilesError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "OpenAIFilesError";
    this.status = status;
  }
}

function authHeaders(env: Env): Record<string, string> {
  if (!env.OPENAI_API_KEY) throw new OpenAIFilesError("openai_key_missing");
  return { authorization: `Bearer ${env.OPENAI_API_KEY}` };
}

/** Every OpenAI call gets a hard 10s timeout (spec) — a hung upstream request
 *  must never hang the admin's request or a `ctx.waitUntil` poll forever. */
async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    return await fn(ac.signal);
  } finally {
    clearTimeout(t);
  }
}

async function readJson(r: Response): Promise<any> {
  const text = await r.text().catch(() => "");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

function errMsg(j: any, r: Response): string {
  return String(j?.error?.message ?? j?.raw ?? r.statusText ?? r.status);
}

export interface OpenAIFileHandle {
  id: string;
}

/** Upload one knowledge-base file to OpenAI Files (`purpose: 'assistants'`). */
export async function uploadOpenAIFile(
  env: Env,
  bytes: ArrayBuffer,
  filename: string,
  mime: string,
): Promise<OpenAIFileHandle> {
  const form = new FormData();
  form.set("purpose", "assistants");
  form.set("file", new Blob([bytes], { type: mime || "application/octet-stream" }), filename);
  const r = await withTimeout((signal) =>
    fetch(`${OPENAI_BASE}/files`, { method: "POST", headers: authHeaders(env), body: form, signal }),
  );
  const j = await readJson(r);
  if (!r.ok || !j?.id) throw new OpenAIFilesError(`openai_file_upload_failed: ${errMsg(j, r)}`, r.status);
  return { id: String(j.id) };
}

/** Delete an OpenAI file outright (independent of any vector store). Treats
 *  404 as success — a file already gone is the desired end state. */
export async function deleteOpenAIFile(env: Env, fileId: string): Promise<void> {
  const r = await withTimeout((signal) =>
    fetch(`${OPENAI_BASE}/files/${encodeURIComponent(fileId)}`, {
      method: "DELETE",
      headers: authHeaders(env),
      signal,
    }),
  );
  if (!r.ok && r.status !== 404) {
    const j = await readJson(r);
    throw new OpenAIFilesError(`openai_file_delete_failed: ${errMsg(j, r)}`, r.status);
  }
}

/** Create one vector store — called lazily the first time an agent gets a KB
 *  upload; the id is persisted onto `agent_live_agents.vector_store_id`. */
export async function createVectorStore(env: Env, name: string): Promise<string> {
  const r = await withTimeout((signal) =>
    fetch(`${OPENAI_BASE}/vector_stores`, {
      method: "POST",
      headers: { ...authHeaders(env), "content-type": "application/json" },
      body: JSON.stringify({ name }),
      signal,
    }),
  );
  const j = await readJson(r);
  if (!r.ok || !j?.id) throw new OpenAIFilesError(`openai_vector_store_create_failed: ${errMsg(j, r)}`, r.status);
  return String(j.id);
}

/** Attach an already-uploaded file to a vector store. Indexing runs async on
 *  OpenAI's side — poll `getVectorStoreFileStatus` for completion. */
export async function addFileToVectorStore(env: Env, storeId: string, fileId: string): Promise<void> {
  const r = await withTimeout((signal) =>
    fetch(`${OPENAI_BASE}/vector_stores/${encodeURIComponent(storeId)}/files`, {
      method: "POST",
      headers: { ...authHeaders(env), "content-type": "application/json" },
      body: JSON.stringify({ file_id: fileId }),
      signal,
    }),
  );
  const j = await readJson(r);
  if (!r.ok) throw new OpenAIFilesError(`openai_vector_store_attach_failed: ${errMsg(j, r)}`, r.status);
}

export type VectorStoreFileStatus = "in_progress" | "completed" | "failed" | "cancelled";

/** Poll one vector-store file's indexing status — admin.ts calls this in a
 *  bounded (8-try) loop inside `ctx.waitUntil` right after upload, and again
 *  on-demand from `GET /api/agents/admin/:id/kb`. */
export async function getVectorStoreFileStatus(
  env: Env,
  storeId: string,
  fileId: string,
): Promise<{ status: VectorStoreFileStatus; lastError?: string }> {
  const r = await withTimeout((signal) =>
    fetch(`${OPENAI_BASE}/vector_stores/${encodeURIComponent(storeId)}/files/${encodeURIComponent(fileId)}`, {
      method: "GET",
      headers: authHeaders(env),
      signal,
    }),
  );
  const j = await readJson(r);
  if (!r.ok) throw new OpenAIFilesError(`openai_vector_store_status_failed: ${errMsg(j, r)}`, r.status);
  return { status: (j?.status ?? "in_progress") as VectorStoreFileStatus, lastError: j?.last_error?.message };
}

/** Detach a file from a vector store (does not delete the underlying OpenAI
 *  file — call `deleteOpenAIFile` too). Treats 404 as success. */
export async function removeFileFromVectorStore(env: Env, storeId: string, fileId: string): Promise<void> {
  const r = await withTimeout((signal) =>
    fetch(`${OPENAI_BASE}/vector_stores/${encodeURIComponent(storeId)}/files/${encodeURIComponent(fileId)}`, {
      method: "DELETE",
      headers: authHeaders(env),
      signal,
    }),
  );
  if (!r.ok && r.status !== 404) {
    const j = await readJson(r);
    throw new OpenAIFilesError(`openai_vector_store_detach_failed: ${errMsg(j, r)}`, r.status);
  }
}

export interface VectorStoreSearchHit {
  text: string;
  score: number;
  filename: string | null;
}

/** `POST /v1/vector_stores/{id}/search` (D5) — the AgentLiveRoom DO's
 *  `search_knowledge` function tool (WS-E1) calls this at talk time. */
export async function searchVectorStore(
  env: Env,
  storeId: string,
  query: string,
  opts: { maxResults?: number } = {},
): Promise<{ results: VectorStoreSearchHit[] }> {
  const maxResults = Math.max(1, Math.min(20, Math.trunc(opts.maxResults ?? 5)));
  const r = await withTimeout((signal) =>
    fetch(`${OPENAI_BASE}/vector_stores/${encodeURIComponent(storeId)}/search`, {
      method: "POST",
      headers: { ...authHeaders(env), "content-type": "application/json" },
      body: JSON.stringify({ query, max_num_results: maxResults }),
      signal,
    }),
  );
  const j = await readJson(r);
  if (!r.ok) throw new OpenAIFilesError(`openai_vector_store_search_failed: ${errMsg(j, r)}`, r.status);
  const data: any[] = Array.isArray(j?.data) ? j.data : [];
  const results: VectorStoreSearchHit[] = data.map((d) => ({
    text: Array.isArray(d?.content)
      ? d.content.map((c: any) => String(c?.text ?? "")).join("\n")
      : String(d?.text ?? ""),
    score: Number(d?.score ?? 0),
    filename: d?.filename ?? d?.attributes?.filename ?? null,
  }));
  return { results };
}
