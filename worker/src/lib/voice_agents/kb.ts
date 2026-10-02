// [AUMFE-VOICE-AGENTS-DB-1 2026-10-02] Per-guide knowledge base (RAG). Files, web pages and pasted text the owner adds
// to a voice guide in admin are cut into chunks, embedded with the shared knowledge helper (bge-m3, 1024 dims) and
// stored in the Vectorize index `aumfe-agent-kb` (binding VEC_AGENT_KB), filtered by agent_id at search time.
// Bytes of files and pasted text live in private R2 (DIGITAL) at voice-agent-kb/<agent>/<doc>. Rows: voice_agent_docs.
// Vector ids are `<doc>:<n>`; metadata {agent_id, doc_id, title, n, text}. The index is created by hand (never by code).
import type { Env } from "../../types";
import { track, trackException } from "../../hooks";
import { BRAND } from "../brand";
import { chunkText, embedOne, embedTexts } from "../knowledge/embed";
import type { VoiceTool } from "./types";

export const KB_INDEX = "aumfe-agent-kb";
const APP = "aumfe_voice";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_URL_BYTES = 2 * 1024 * 1024;
export const MAX_TEXT_CHARS = 200_000;
/** Text kept after conversion, before chunking. */
const MAX_EXTRACT_CHARS = 500_000;
export const MAX_DOCS_PER_AGENT = 60;
export const CHUNK_CHARS = 1200; // about 350 tokens
export const CHUNK_OVERLAP = 160; // about 40 tokens
export const MAX_CHUNKS = 600;
const UPSERT_BATCH = 100;
const PASSAGES = 4;
const PASSAGE_CLIP = 800;

export const FILE_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  md: "text/markdown",
};

export interface DocRow {
  id: string; agent_id: string; kind: "file" | "url" | "text"; title: string; source: string;
  bytes: number; status: string; chunks: number; error: string | null;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------
export const kbKey = (agentId: string, docId: string): string => `voice-agent-kb/${agentId}/${docId}`;
export const vectorId = (docId: string, n: number): string => `${docId}:${n}`;
export function vectorIds(docId: string, from: number, to: number): string[] {
  const out: string[] = [];
  for (let n = Math.max(0, from); n < to; n++) out.push(vectorId(docId, n));
  return out;
}

/** Chunk a document: ~350 tokens per chunk, ~40 overlap, empty chunks dropped, capped at MAX_CHUNKS. */
export function chunkDoc(text: string): string[] {
  return chunkText(text, CHUNK_CHARS, CHUNK_OVERLAP).map((c) => c.trim()).filter(Boolean).slice(0, MAX_CHUNKS);
}

/** File name -> allowed {ext, mime}, or null (pdf, docx, txt, md only). */
export function fileTypeOf(name: string): { ext: string; mime: string } | null {
  const ext = (String(name).split(".").pop() ?? "").toLowerCase();
  return Object.prototype.hasOwnProperty.call(FILE_TYPES, ext) ? { ext, mime: FILE_TYPES[ext] } : null;
}

/** https only, no credentials, no localhost / IP-literal hosts. Returns the parsed URL or null. */
export function validateKbUrl(raw: unknown): URL | null {
  if (typeof raw !== "string" || raw.length > 2000) return null;
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  const h = u.hostname.toLowerCase();
  if (!h.includes(".") || h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return null;
  if (/^[\d.]+$/.test(h) || h.includes(":") || h.startsWith("[")) return null; // IPv4 / IPv6 literals
  return u;
}

export interface Passage { title: string; text: string; score: number }

/** Vectorize matches -> the passages the model sees (clipped, titled). Pure. */
export function toPassages(matches: { score?: number; metadata?: Record<string, unknown> | null }[]): Passage[] {
  const out: Passage[] = [];
  for (const m of matches) {
    const text = typeof m.metadata?.text === "string" ? m.metadata.text.trim() : "";
    if (!text) continue;
    out.push({
      title: typeof m.metadata?.title === "string" ? m.metadata.title : "Document",
      text: text.length > PASSAGE_CLIP ? text.slice(0, PASSAGE_CLIP - 1) + "…" : text,
      score: Math.round((Number(m.score) || 0) * 1000) / 1000,
    });
    if (out.length >= PASSAGES) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------
async function toMarkdownText(env: Env, buf: ArrayBuffer, name: string, mime: string): Promise<string> {
  const ai = env.AI as unknown as { toMarkdown?: (files: { name: string; blob: Blob }[]) => Promise<any> };
  if (typeof ai.toMarkdown !== "function") throw new Error("document conversion is not available");
  const res = await ai.toMarkdown([{ name, blob: new Blob([buf], { type: mime }) }]);
  const first = Array.isArray(res) ? res[0] : res;
  if (!first || first.format === "error") throw new Error(String(first?.error ?? "could not convert the document").slice(0, 200));
  return String(first.data ?? "");
}

export async function extractText(env: Env, buf: ArrayBuffer, name: string, mime: string): Promise<string> {
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  const plain = mime.startsWith("text/") && mime !== "text/html";
  const text = plain || ext === "txt" || ext === "md" ? new TextDecoder().decode(buf) : await toMarkdownText(env, buf, name, mime);
  return text.slice(0, MAX_EXTRACT_CHARS);
}

async function readCapped(r: Response, max: number): Promise<ArrayBuffer> {
  const reader = r.body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { try { await reader.cancel(); } catch { /* ignore */ } throw new Error("the page is larger than 2 MB"); }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out.buffer;
}

export async function fetchUrlText(env: Env, raw: string): Promise<{ text: string; bytes: number }> {
  const u = validateKbUrl(raw);
  if (!u) throw new Error("only public https links are allowed");
  const r = await fetch(u.toString(), {
    headers: { accept: "text/html,text/plain,application/pdf;q=0.8", "user-agent": `${BRAND.slug}-guide-kb/1` },
    redirect: "follow", signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`the page answered ${r.status}`);
  if (!validateKbUrl(r.url)) throw new Error("the page redirected somewhere not allowed");
  const buf = await readCapped(r, MAX_URL_BYTES);
  const ct = (r.headers.get("content-type") ?? "").toLowerCase();
  if (ct.includes("text/plain")) return { text: new TextDecoder().decode(buf).slice(0, MAX_EXTRACT_CHARS), bytes: buf.byteLength };
  if (ct.includes("html")) return { text: (await toMarkdownText(env, buf, "page.html", "text/html")).slice(0, MAX_EXTRACT_CHARS), bytes: buf.byteLength };
  if (ct.includes("pdf")) return { text: (await toMarkdownText(env, buf, "page.pdf", "application/pdf")).slice(0, MAX_EXTRACT_CHARS), bytes: buf.byteLength };
  throw new Error("the link is not a web page, text or PDF");
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------
async function loadRow(env: Env, docId: string): Promise<DocRow | null> {
  return env.DB_META.prepare(
    "SELECT id, agent_id, kind, title, source, bytes, status, chunks, error FROM voice_agent_docs WHERE id=?1",
  ).bind(docId).first<DocRow>();
}

async function loadText(env: Env, row: DocRow): Promise<{ text: string; bytes?: number }> {
  if (row.kind === "url") return fetchUrlText(env, row.source);
  const obj = await env.DIGITAL.get(row.source);
  if (!obj) throw new Error("the stored file is missing");
  const buf = await obj.arrayBuffer();
  const mime = obj.httpMetadata?.contentType ?? "text/plain";
  const name = obj.customMetadata?.file_name ? decodeURIComponent(obj.customMetadata.file_name) : (row.kind === "text" ? "text.txt" : row.title);
  return { text: await extractText(env, buf, name, mime), bytes: buf.byteLength };
}

/**
 * Index (or re-index) one document: queued|failed|ready -> indexing -> ready | failed. Never throws.
 * Old vectors beyond the new chunk count are removed after the new ones are in, so search is never empty mid-way.
 */
export async function indexDoc(env: Env, docId: string): Promise<{ ok: boolean; chunks: number; error?: string }> {
  const t0 = Date.now();
  const row = await loadRow(env, docId);
  if (!row) return { ok: false, chunks: 0, error: "not_found" };
  const now = () => Date.now();
  await env.DB_META.prepare("UPDATE voice_agent_docs SET status='indexing', error=NULL WHERE id=?1").bind(docId).run();
  try {
    const idx = env.VEC_AGENT_KB;
    if (!idx) throw new Error("the knowledge index is not set up yet");
    const { text, bytes } = await loadText(env, row);
    const chunks = chunkDoc(text);
    if (!chunks.length) throw new Error("no readable text found in this source");
    const vectors = await embedTexts(env, chunks, "agent_kb");
    const items = vectors.map((values, n) => ({
      id: vectorId(docId, n), values,
      metadata: { agent_id: row.agent_id, doc_id: docId, title: row.title.slice(0, 120), n, text: chunks[n] },
    }));
    for (let i = 0; i < items.length; i += UPSERT_BATCH) await idx.upsert(items.slice(i, i + UPSERT_BATCH));
    const prev = Math.max(0, Number(row.chunks) || 0);
    if (prev > chunks.length) await idx.deleteByIds(vectorIds(docId, chunks.length, prev));
    await env.DB_META.prepare(
      "UPDATE voice_agent_docs SET status='ready', chunks=?2, error=NULL, bytes=COALESCE(?3,bytes), indexed_at=?4 WHERE id=?1",
    ).bind(docId, chunks.length, bytes ?? null, now()).run();
    void track(env, "server", "voice_kb_indexed", APP, { agent_id: row.agent_id, doc_id: docId, chunks: chunks.length, ms: now() - t0, ok: true });
    return { ok: true, chunks: chunks.length };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 300);
    try {
      await env.DB_META.prepare("UPDATE voice_agent_docs SET status='failed', error=?2 WHERE id=?1").bind(docId, msg).run();
    } catch { /* the row is still 'indexing'; a retry from admin fixes it */ }
    void track(env, "server", "voice_kb_indexed", APP, { agent_id: row.agent_id, doc_id: docId, chunks: 0, ms: now() - t0, ok: false });
    void trackException(env, e, { route: "voice_agents.kb.indexDoc", handled: true, app_name: APP, extra: { doc_id: docId } });
    return { ok: false, chunks: 0, error: msg };
  }
}

/** Remove vectors, the R2 object and the row. Throws when vectors cannot be removed (the row stays so admin can retry). */
export async function removeDoc(env: Env, docId: string): Promise<boolean> {
  const row = await loadRow(env, docId);
  if (!row) return false;
  const count = Math.max(0, Number(row.chunks) || 0);
  if (count > 0) {
    if (!env.VEC_AGENT_KB) throw new Error("the knowledge index is not available");
    for (let n = 0; n < count; n += UPSERT_BATCH) await env.VEC_AGENT_KB.deleteByIds(vectorIds(docId, n, Math.min(count, n + UPSERT_BATCH)));
  }
  if (row.kind !== "url") await env.DIGITAL.delete(row.source);
  await env.DB_META.prepare("DELETE FROM voice_agent_docs WHERE id=?1").bind(docId).run();
  return true;
}

// ---------------------------------------------------------------------------
// Search (the guide's search_knowledge tool)
// ---------------------------------------------------------------------------
export async function searchKb(env: Env, agentId: string, query: string): Promise<Passage[]> {
  const idx = env.VEC_AGENT_KB;
  if (!idx) return [];
  const t0 = Date.now();
  try {
    const vec = await embedOne(env, query, "agent_kb_query");
    const res = await idx.query(vec, { topK: PASSAGES, filter: { agent_id: agentId } as any, returnMetadata: "all" });
    const out = toPassages((res.matches ?? []) as any);
    void track(env, "server", "vector_search", APP, { index: KB_INDEX, ms: Date.now() - t0, hits: out.length, top_score: out[0]?.score ?? null, ok: true });
    return out;
  } catch (e) {
    void track(env, "server", "vector_search", APP, { index: KB_INDEX, ms: Date.now() - t0, ok: false, reason: "error" });
    void trackException(env, e, { route: "voice_agents.kb.search", handled: true, app_name: APP });
    return [];
  }
}

const NO_PASSAGES = { passages: [], note: "Nothing in the uploaded files matches. Say you are not sure; do not invent an answer." };

/** The tool added to a guide that has at least one ready document. */
export function searchKnowledgeTool(agentId: string): VoiceTool {
  return {
    blocking: true,
    decl: {
      name: "search_knowledge",
      description:
        `Look up the guide's own reference material (files the owner uploaded). Returns at most ${PASSAGES} passages with their document titles. ` +
        "Use it before stating a specific fact, rule, price or procedure that your persona does not already give. Answer from the passages; name the document when asked.",
      parameters: { type: "OBJECT", properties: { query: { type: "STRING", description: "The question, in a few words." } }, required: ["query"] },
    },
    async run(ctx, args) {
      const q = typeof args.query === "string" ? args.query.trim().slice(0, 300) : "";
      if (!q) return { error: "query_required" };
      const passages = await searchKb(ctx.env, agentId, q);
      return passages.length ? { passages } : NO_PASSAGES;
    },
  };
}
