// ava_rag.ts — per-user RAG via the Gemini File Search tool.
//
// The user's OWN Google AI Studio key creates a File Search store and indexes
// their files + chat history into it. Everything (embeddings, storage) lives in
// Google under the USER's key + free quota — AvaTOK stores none of the content.
// We only remember ONE string per user: the store name (in KV), so @ava can
// query it later. Data flow: client → Worker (pass-through, key forwarded) →
// Google File Search. The Worker holds the bytes only in-flight, never at rest.
//
// File Search: storage free, query-time embeddings free; only first-time
// indexing embeddings are billed (free on the user's free tier, 1 GB cap).

import type { Env } from "../types";

const GLA = "https://generativelanguage.googleapis.com";
const EMBED_MODEL = "models/gemini-embedding-2"; // multimodal (text + images)

function storeKey(uid: string): string {
  return `ava_rag:${uid}`;
}

/** The remembered File Search store name for a user, or null if none yet. */
export async function getStoreName(env: Env, uid: string): Promise<string | null> {
  try {
    return (await env.TOKENS.get(storeKey(uid))) || null;
  } catch {
    return null;
  }
}

/** Get-or-create the user's File Search store (created under THEIR key). */
export async function ensureStore(env: Env, uid: string, key: string): Promise<string> {
  const existing = await getStoreName(env, uid);
  if (existing) return existing;
  const res = await fetch(`${GLA}/v1beta/fileSearchStores`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      displayName: `avatok-${uid.slice(0, 20)}`,
      embedding_model: EMBED_MODEL,
    }),
  });
  if (!res.ok) throw new Error(`store create ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const j: any = await res.json().catch(() => ({}));
  const name = String(j?.name || "");
  if (!name) throw new Error("store create: no name returned");
  await env.TOKENS.put(storeKey(uid), name);
  return name;
}

/** Resumable upload of raw bytes into the store (returns the operation name). */
async function uploadBytes(
  key: string, store: string, displayName: string, mime: string, bytes: Uint8Array,
): Promise<string> {
  const start = await fetch(`${GLA}/upload/v1beta/${store}:uploadToFileSearchStore`, {
    method: "POST",
    headers: {
      "x-goog-api-key": key,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes.length),
      "X-Goog-Upload-Header-Content-Type": mime,
      "content-type": "application/json",
    },
    body: JSON.stringify({ display_name: displayName.slice(0, 80) }),
  });
  if (!start.ok) throw new Error(`upload start ${start.status}: ${(await start.text().catch(() => "")).slice(0, 200)}`);
  const up = start.headers.get("x-goog-upload-url");
  if (!up) throw new Error("upload start: no upload url");
  const fin = await fetch(up, {
    method: "POST",
    headers: {
      "x-goog-api-key": key,
      "Content-Length": String(bytes.length),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: bytes,
  });
  if (!fin.ok) throw new Error(`upload finalize ${fin.status}: ${(await fin.text().catch(() => "")).slice(0, 200)}`);
  const op: any = await fin.json().catch(() => ({}));
  return String(op?.name || ""); // indexing continues async; query works once done
}

/** Index a chunk of text (chat history, a note) into the user's store. */
export async function ingestText(
  env: Env, uid: string, key: string, displayName: string, text: string,
): Promise<{ store: string; op: string }> {
  const store = await ensureStore(env, uid, key);
  const op = await uploadBytes(key, store, displayName, "text/plain", new TextEncoder().encode(text));
  return { store, op };
}

/** Index raw file bytes (pdf, docx, png/jpeg, …) into the user's store. */
export async function ingestBytes(
  env: Env, uid: string, key: string, displayName: string, mime: string, b64: string,
): Promise<{ store: string; op: string }> {
  const store = await ensureStore(env, uid, key);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const op = await uploadBytes(key, store, displayName, mime, bytes);
  return { store, op };
}
