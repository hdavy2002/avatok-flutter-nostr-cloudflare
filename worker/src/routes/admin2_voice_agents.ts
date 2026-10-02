// [AUMFE-VOICE-AGENTS-DB-1 2026-10-02] Admin 2 -> Voice guides. Guides are data (D1: voice_agents, voice_agent_prompts,
// voice_agent_docs); tools stay in code as "tool packs". Registered by ONE spread line in routes/admin2.ts.
//
//   GET  /api/admin/v2/voice-agents/meta                      -> {voices, languages, tool_packs}
//   GET  /api/admin/v2/voice-agents                           -> {agents}
//   POST /api/admin/v2/voice-agents                           -> {agent}        PUT /:id (partial) -> {agent}
//   DELETE /api/admin/v2/voice-agents/:id                     -> archives it
//   GET/POST /voice-agents/:id/prompts                        POST /:id/prompts/:promptId/publish -> {agent}
//   GET /voice-agents/:id/docs                                POST /:id/docs/file | /docs/url | /docs/text -> {doc}
//   DELETE /voice-agents/:id/docs/:docId                      POST /:id/docs/:docId/reindex -> {doc}
//   GET /voice-agents/:id/sessions?cursor=                    GET /api/admin/v2/voice-sessions/:sid
//
// Knowledge indexing runs INLINE in the upload request: Admin2 handlers get no ExecutionContext, and detached
// waitUntil work dies on long jobs (memory: poster-generation-dies-in-waituntil). A failed index leaves the row
// 'failed' with the reason; the admin screen shows it and offers Reindex. Same approach as routes/admin2_ai.ts.
import type { Env } from "../types";
import { json, decodeFileNameHeader } from "../util";
import type { Admin2RouteDef } from "./admin2";
import { requireAdmin } from "./admin_money";
import { track, trackException } from "../hooks";
import { emailFor } from "../lib/identity";
import { clearVoiceAgentCache, AGENT_STATUSES, type AgentStatus } from "../lib/voice_agents/registry";
import { getToolPack, listToolPacks } from "../lib/voice_agents/tool_packs";
import {
  FILE_TYPES, MAX_DOCS_PER_AGENT, MAX_FILE_BYTES, MAX_TEXT_CHARS, fileTypeOf, indexDoc, kbKey, removeDoc, validateKbUrl,
} from "../lib/voice_agents/kb";

const APP = "aumfe_voice";
const BASE = "/api/admin/v2/voice-agents";
const DAY_MS = 86_400_000;
const PAGE = 30;
const MAX_TRANSCRIPT_CHARS = 200_000;

export const SLUG_RE = /^[a-z0-9-]{2,40}$/;
export const MAX_PERSONA_CHARS = 8000;
export const MAX_PRICE_TOKENS = 1000;

/** Gemini Live prebuilt voices. */
export const VOICES: readonly string[] = [
  "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe", "Autonoe", "Enceladus", "Iapetus",
  "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar", "Alnilam", "Schedar",
  "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi", "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
];
export const LANGUAGES: readonly string[] = ["hi-IN", "en-IN", "en-US", "bn-IN", "gu-IN", "kn-IN", "ml-IN", "mr-IN", "pa-IN", "ta-IN", "te-IN"];

const err = (status: number, error: string, message: string) => json({ error, message }, status);

async function guard(req: Request, env: Env): Promise<{ uid: string } | Response> {
  const a = await requireAdmin(req, env);
  if (a instanceof Response) {
    return a.status === 403 ? err(403, "admin_only", "You don't have admin access.") : err(a.status, "unauthorized", "Please sign in again.");
  }
  return a;
}

async function bodyOf(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = await req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  } catch { return null; }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const hex = (n: number): string => Array.from(crypto.getRandomValues(new Uint8Array(n)), (x) => x.toString(16).padStart(2, "0")).join("");
const num = (v: unknown, d = 0): number => { const n = Number(v); return Number.isFinite(n) ? n : d; };

// ---------------------------------------------------------------------------
// Validation (pure, unit-tested)
// ---------------------------------------------------------------------------
export interface AgentFields {
  name: string; subject: string; blurb: string; initial: string; tint: string; avatar_url: string | null; voice: string;
  language: string; tool_pack: string; price_per_min_tokens: number | null; status: AgentStatus; sort: number;
}

/** Validate the fields present in `b`. `partial` = PUT (only what is sent); otherwise POST (name + subject required). */
export function validateAgentInput(b: Record<string, unknown>, partial: boolean): { ok: true; v: Partial<AgentFields> } | { ok: false; message: string } {
  const v: Partial<AgentFields> = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k) && b[k] !== undefined;
  if (has("name") || !partial) {
    const x = str(b.name).trim();
    if (!x || x.length > 60) return { ok: false, message: "The name must be 1 to 60 characters." };
    v.name = x;
  }
  if (has("subject") || !partial) {
    const x = str(b.subject).trim();
    if (!x || x.length > 60) return { ok: false, message: "The subject must be 1 to 60 characters." };
    v.subject = x;
  }
  if (has("blurb")) {
    const x = str(b.blurb).trim();
    if (x.length > 160) return { ok: false, message: "The blurb must be 160 characters or fewer." };
    v.blurb = x;
  }
  if (has("initial")) {
    const x = str(b.initial).trim();
    if (x.length > 2) return { ok: false, message: "The initial must be 1 or 2 characters." };
    v.initial = x;
  }
  if (has("tint")) {
    const x = str(b.tint).trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(x)) return { ok: false, message: "The colour must look like #07545b." };
    v.tint = x.toLowerCase();
  }
  if (has("avatar_url")) {
    const x = b.avatar_url == null ? "" : str(b.avatar_url).trim();
    if (x && (x.length > 500 || !/^(https:\/\/|\/)/.test(x))) return { ok: false, message: "The picture must be an https link." };
    v.avatar_url = x || null;
  }
  if (has("voice")) {
    if (!VOICES.includes(str(b.voice))) return { ok: false, message: "Unknown voice." };
    v.voice = str(b.voice);
  }
  if (has("language")) {
    if (!LANGUAGES.includes(str(b.language))) return { ok: false, message: "Unknown language." };
    v.language = str(b.language);
  }
  if (has("tool_pack")) {
    if (!getToolPack(b.tool_pack)) return { ok: false, message: "Unknown tool pack." };
    v.tool_pack = str(b.tool_pack);
  }
  if (has("price_per_min_tokens")) {
    if (b.price_per_min_tokens === null) v.price_per_min_tokens = null; // back to the platform default
    else {
      const n = Number(b.price_per_min_tokens);
      if (!Number.isInteger(n) || n < 0 || n > MAX_PRICE_TOKENS) return { ok: false, message: `The price must be a whole number of tokens from 0 to ${MAX_PRICE_TOKENS}.` };
      v.price_per_min_tokens = n;
    }
  }
  if (has("status")) {
    if (!AGENT_STATUSES.includes(b.status as AgentStatus)) return { ok: false, message: "Status must be draft, preview, live or archived." };
    v.status = b.status as AgentStatus;
  }
  if (has("sort")) {
    const n = Number(b.sort);
    if (!Number.isInteger(n) || n < -100000 || n > 100000) return { ok: false, message: "Sort must be a whole number." };
    v.sort = n;
  }
  return { ok: true, v };
}

export function validatePersona(b: Record<string, unknown>): { ok: true; persona: string; greeting: string | null; note: string | null } | { ok: false; message: string } {
  const persona = str(b.persona).trim();
  if (!persona || persona.length > MAX_PERSONA_CHARS) return { ok: false, message: `The persona must be 1 to ${MAX_PERSONA_CHARS} characters.` };
  const greeting = str(b.greeting).trim();
  if (greeting.length > 500) return { ok: false, message: "The greeting must be 500 characters or fewer." };
  const note = str(b.note).trim();
  if (note.length > 200) return { ok: false, message: "The note must be 200 characters or fewer." };
  return { ok: true, persona, greeting: greeting || null, note: note || null };
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------
const AGENT_SQL = `SELECT a.id, a.name, a.subject, a.blurb, a.initial, a.tint, a.avatar_url, a.voice, a.language, a.tool_pack,
    a.price_per_min_tokens, a.status, a.sort, a.updated_at,
    (SELECT p.version FROM voice_agent_prompts p WHERE p.id = a.published_prompt_id) AS published_prompt_version,
    (SELECT COUNT(*) FROM voice_agent_docs d WHERE d.agent_id = a.id AND d.status = 'ready') AS docs_ready,
    (SELECT COUNT(*) FROM voice_agent_docs d WHERE d.agent_id = a.id) AS docs_total,
    (SELECT COUNT(*) FROM agent_sessions s WHERE s.agent = a.id AND s.channel = 'voice' AND s.started_at >= ?1) AS sessions_7d
  FROM voice_agents a`;

const agentOf = (r: any) => ({
  id: String(r.id), name: String(r.name), subject: String(r.subject), blurb: String(r.blurb ?? ""), initial: String(r.initial ?? ""),
  tint: String(r.tint ?? ""), avatar_url: r.avatar_url ?? null, voice: String(r.voice), language: String(r.language),
  tool_pack: String(r.tool_pack), price_per_min_tokens: r.price_per_min_tokens == null ? null : Number(r.price_per_min_tokens),
  status: String(r.status), sort: Number(r.sort ?? 0),
  published_prompt_version: r.published_prompt_version == null ? null : Number(r.published_prompt_version),
  docs_ready: Number(r.docs_ready ?? 0), docs_total: Number(r.docs_total ?? 0), sessions_7d: Number(r.sessions_7d ?? 0),
  updated_at: Number(r.updated_at ?? 0),
});

async function loadAgent(env: Env, id: string) {
  const r = await env.DB_META.prepare(`${AGENT_SQL} WHERE a.id = ?2`).bind(Date.now() - 7 * DAY_MS, id).first<any>();
  return r ? agentOf(r) : null;
}

const saved = (env: Env, uid: string, agentId: string, fields: string) =>
  track(env, uid, "voice_agent_saved", APP, { agent_id: agentId, admin_uid: uid, fields });

async function meta(req: Request, env: Env): Promise<Response> {
  const a = await guard(req, env); if (a instanceof Response) return a;
  return json({ voices: VOICES, languages: LANGUAGES, tool_packs: listToolPacks() });
}

async function list(req: Request, env: Env): Promise<Response> {
  const a = await guard(req, env); if (a instanceof Response) return a;
  const rows = await env.DB_META.prepare(`${AGENT_SQL} ORDER BY a.sort ASC, a.name ASC`).bind(Date.now() - 7 * DAY_MS).all<any>();
  return json({ agents: (rows.results ?? []).map(agentOf) });
}

async function create(req: Request, env: Env): Promise<Response> {
  const a = await guard(req, env); if (a instanceof Response) return a;
  const b = await bodyOf(req);
  if (!b) return err(400, "bad_json", "The request was not valid.");
  const id = str(b.id).trim();
  if (!SLUG_RE.test(id)) return err(400, "invalid_id", "The id must be 2 to 40 characters: lowercase letters, digits and dashes.");
  const parsed = validateAgentInput(b, false);
  if (!parsed.ok) return err(400, "invalid_field", parsed.message);
  const v = parsed.v as AgentFields;
  if (await env.DB_META.prepare("SELECT id FROM voice_agents WHERE id=?1").bind(id).first()) return err(409, "id_taken", "A guide with that id already exists.");
  const now = Date.now();
  await env.DB_META.prepare(
    `INSERT INTO voice_agents (id, name, subject, blurb, initial, tint, avatar_url, voice, language, tool_pack, price_per_min_tokens, status, sort, published_prompt_id, created_at, updated_at, updated_by)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,NULL,?14,?14,?15)`,
  ).bind(
    id, v.name, v.subject, v.blurb ?? "", v.initial || v.name.slice(0, 1).toUpperCase(), v.tint ?? "#07545b", v.avatar_url ?? null,
    v.voice ?? "Aoede", v.language ?? "hi-IN", v.tool_pack ?? "knowledge_only", v.price_per_min_tokens ?? null, v.status ?? "draft", v.sort ?? 0, now, a.uid,
  ).run();
  clearVoiceAgentCache();
  void saved(env, a.uid, id, "created");
  return json({ agent: await loadAgent(env, id) }, 201);
}

async function update(req: Request, env: Env, id: string): Promise<Response> {
  const a = await guard(req, env); if (a instanceof Response) return a;
  const b = await bodyOf(req);
  if (!b) return err(400, "bad_json", "The request was not valid.");
  const parsed = validateAgentInput(b, true);
  if (!parsed.ok) return err(400, "invalid_field", parsed.message);
  const keys = Object.keys(parsed.v) as (keyof AgentFields)[];
  if (!keys.length) return err(400, "no_changes", "Nothing to change.");
  if (!(await env.DB_META.prepare("SELECT id FROM voice_agents WHERE id=?1").bind(id).first())) return err(404, "not_found", "That guide does not exist.");
  const sets = keys.map((k, i) => `${k}=?${i + 3}`).join(", ");
  await env.DB_META.prepare(`UPDATE voice_agents SET ${sets}, updated_at=?1, updated_by=?2 WHERE id=?${keys.length + 3}`)
    .bind(Date.now(), a.uid, ...keys.map((k) => (parsed.v as any)[k]), id).run();
  clearVoiceAgentCache();
  void saved(env, a.uid, id, keys.join(","));
  return json({ agent: await loadAgent(env, id) });
}

async function archive(req: Request, env: Env, id: string): Promise<Response> {
  const a = await guard(req, env); if (a instanceof Response) return a;
  if (!(await env.DB_META.prepare("SELECT id FROM voice_agents WHERE id=?1").bind(id).first())) return err(404, "not_found", "That guide does not exist.");
  await env.DB_META.prepare("UPDATE voice_agents SET status='archived', updated_at=?1, updated_by=?2 WHERE id=?3").bind(Date.now(), a.uid, id).run();
  clearVoiceAgentCache();
  void saved(env, a.uid, id, "archived");
  return json({ ok: true, agent: await loadAgent(env, id) });
}

// ---------------------------------------------------------------------------
// Prompts (versions: draft -> published -> retired)
// ---------------------------------------------------------------------------
const promptOf = (r: any) => ({
  id: String(r.id), version: Number(r.version), persona: String(r.persona ?? ""), greeting: r.greeting ?? null, note: r.note ?? null,
  status: String(r.status), created_at: Number(r.created_at), published_at: r.published_at == null ? null : Number(r.published_at),
});

async function promptsList(req: Request, env: Env, id: string): Promise<Response> {
  const a = await guard(req, env); if (a instanceof Response) return a;
  const rows = await env.DB_META.prepare(
    "SELECT id, version, persona, greeting, note, status, created_at, published_at FROM voice_agent_prompts WHERE agent_id=?1 ORDER BY version DESC LIMIT 100",
  ).bind(id).all<any>();
  return json({ prompts: (rows.results ?? []).map(promptOf) });
}

async function promptCreate(req: Request, env: Env, id: string): Promise<Response> {
  const a = await guard(req, env); if (a instanceof Response) return a;
  const b = await bodyOf(req);
  if (!b) return err(400, "bad_json", "The request was not valid.");
  const p = validatePersona(b);
  if (!p.ok) return err(400, "invalid_prompt", p.message);
  if (!(await env.DB_META.prepare("SELECT id FROM voice_agents WHERE id=?1").bind(id).first())) return err(404, "not_found", "That guide does not exist.");
  const pid = `vp_${hex(8)}`;
  await env.DB_META.prepare(
    `INSERT INTO voice_agent_prompts (id, agent_id, version, persona, greeting, note, status, created_at, created_by, published_at)
     SELECT ?1, ?2, COALESCE(MAX(version), 0) + 1, ?3, ?4, ?5, 'draft', ?6, ?7, NULL FROM voice_agent_prompts WHERE agent_id = ?2`,
  ).bind(pid, id, p.persona, p.greeting, p.note, Date.now(), a.uid).run();
  void saved(env, a.uid, id, "prompt_draft");
  const row = await env.DB_META.prepare("SELECT id, version, persona, greeting, note, status, created_at, published_at FROM voice_agent_prompts WHERE id=?1").bind(pid).first<any>();
  return json({ prompt: promptOf(row) }, 201);
}

async function promptPublish(req: Request, env: Env, id: string, promptId: string): Promise<Response> {
  const a = await guard(req, env); if (a instanceof Response) return a;
  const row = await env.DB_META.prepare("SELECT id FROM voice_agent_prompts WHERE id=?1 AND agent_id=?2").bind(promptId, id).first();
  if (!row) return err(404, "not_found", "That prompt version does not exist.");
  const now = Date.now();
  await env.DB_META.batch([
    env.DB_META.prepare("UPDATE voice_agent_prompts SET status='retired' WHERE agent_id=?1 AND status='published' AND id!=?2").bind(id, promptId),
    env.DB_META.prepare("UPDATE voice_agent_prompts SET status='published', published_at=COALESCE(published_at,?2) WHERE id=?1").bind(promptId, now),
    env.DB_META.prepare("UPDATE voice_agents SET published_prompt_id=?1, updated_at=?2, updated_by=?3 WHERE id=?4").bind(promptId, now, a.uid, id),
  ]);
  clearVoiceAgentCache();
  void saved(env, a.uid, id, "prompt_published");
  return json({ agent: await loadAgent(env, id) });
}

// ---------------------------------------------------------------------------
// Knowledge docs
// ---------------------------------------------------------------------------
const docOf = (r: any) => ({
  id: String(r.id), kind: String(r.kind), title: String(r.title), bytes: Number(r.bytes ?? 0), status: String(r.status),
  chunks: Number(r.chunks ?? 0), error: r.error ?? null, created_at: Number(r.created_at),
});
const DOC_COLS = "id, kind, title, bytes, status, chunks, error, created_at";

async function docRow(env: Env, docId: string) {
  const r = await env.DB_META.prepare(`SELECT ${DOC_COLS} FROM voice_agent_docs WHERE id=?1`).bind(docId).first<any>();
  return r ? docOf(r) : null;
}

async function docsList(req: Request, env: Env, id: string): Promise<Response> {
  const a = await guard(req, env); if (a instanceof Response) return a;
  const rows = await env.DB_META.prepare(`SELECT ${DOC_COLS} FROM voice_agent_docs WHERE agent_id=?1 ORDER BY created_at DESC LIMIT 200`).bind(id).all<any>();
  return json({ docs: (rows.results ?? []).map(docOf) });
}

/** Shared by file / url / text: capacity + agent checks, insert a 'queued' row, index inline, answer with the final row. */
async function addDoc(
  env: Env, uid: string, agentId: string, kind: "file" | "url" | "text", title: string, source: string, bytes: number,
): Promise<Response> {
  const docId = `d_${hex(8)}`;
  await env.DB_META.prepare(
    "INSERT INTO voice_agent_docs (id, agent_id, kind, title, source, bytes, status, chunks, error, created_at, created_by, indexed_at) VALUES (?1,?2,?3,?4,?5,?6,'queued',0,NULL,?7,?8,NULL)",
  ).bind(docId, agentId, kind, title, source, bytes, Date.now(), uid).run();
  await indexDoc(env, docId); // never throws; leaves 'ready' or 'failed'
  clearVoiceAgentCache();
  return json({ doc: await docRow(env, docId) }, 201);
}

async function precheck(env: Env, agentId: string): Promise<Response | null> {
  if (!(await env.DB_META.prepare("SELECT id FROM voice_agents WHERE id=?1").bind(agentId).first())) return err(404, "not_found", "That guide does not exist.");
  const n = await env.DB_META.prepare("SELECT COUNT(*) AS n FROM voice_agent_docs WHERE agent_id=?1").bind(agentId).first<{ n: number }>();
  if (Number(n?.n ?? 0) >= MAX_DOCS_PER_AGENT) return err(409, "too_many_docs", `A guide can hold up to ${MAX_DOCS_PER_AGENT} documents.`);
  return null;
}

async function docFile(req: Request, env: Env, agentId: string): Promise<Response> {
  const a = await guard(req, env); if (a instanceof Response) return a;
  const bad = await precheck(env, agentId); if (bad) return bad;
  if (num(req.headers.get("content-length")) > MAX_FILE_BYTES + 1024 * 1024) return err(413, "too_large", "The file must be 10 MB or smaller.");
  let form: FormData;
  try { form = await req.formData(); } catch { return err(400, "bad_form", "Send the file as multipart form data in the field \"file\"."); }
  const f = form.get("file") as unknown as { name?: string; size?: number; arrayBuffer?: () => Promise<ArrayBuffer> } | string | null;
  if (!f || typeof f === "string" || typeof f.arrayBuffer !== "function") return err(400, "missing_file", "Choose a file to upload.");
  const name = decodeFileNameHeader(f.name ?? "").replace(/[\\/]/g, "_").trim().slice(0, 200);
  const ft = fileTypeOf(name);
  if (!ft) return err(415, "unsupported_type", `Allowed files: ${Object.keys(FILE_TYPES).map((x) => x.toUpperCase()).join(", ")}.`);
  const buf = await f.arrayBuffer();
  if (!buf.byteLength) return err(400, "empty", "The file is empty.");
  if (buf.byteLength > MAX_FILE_BYTES) return err(413, "too_large", "The file must be 10 MB or smaller.");
  const title = str(form.get("title")).trim().slice(0, 120) || name;
  const docId = `d_${hex(8)}`;
  const key = kbKey(agentId, docId);
  try {
    await env.DIGITAL.put(key, buf, { httpMetadata: { contentType: ft.mime }, customMetadata: { file_name: encodeURIComponent(name) } });
    await env.DB_META.prepare(
      "INSERT INTO voice_agent_docs (id, agent_id, kind, title, source, bytes, status, chunks, error, created_at, created_by, indexed_at) VALUES (?1,?2,'file',?3,?4,?5,'queued',0,NULL,?6,?7,NULL)",
    ).bind(docId, agentId, title, key, buf.byteLength, Date.now(), a.uid).run();
  } catch (e) {
    await trackException(env, e, { uid: a.uid, route: "admin2_voice_agents:file_store", handled: true, app_name: APP });
    return err(500, "internal", "Could not store the file.");
  }
  await indexDoc(env, docId);
  clearVoiceAgentCache();
  return json({ doc: await docRow(env, docId) }, 201);
}

async function docUrl(req: Request, env: Env, agentId: string): Promise<Response> {
  const a = await guard(req, env); if (a instanceof Response) return a;
  const b = await bodyOf(req);
  if (!b) return err(400, "bad_json", "The request was not valid.");
  const u = validateKbUrl(b.url);
  if (!u) return err(400, "invalid_url", "Enter a public https link.");
  const bad = await precheck(env, agentId); if (bad) return bad;
  const title = str(b.title).trim().slice(0, 120) || `${u.hostname}${u.pathname === "/" ? "" : u.pathname}`.slice(0, 120);
  return addDoc(env, a.uid, agentId, "url", title, u.toString(), 0);
}

async function docText(req: Request, env: Env, agentId: string): Promise<Response> {
  const a = await guard(req, env); if (a instanceof Response) return a;
  const b = await bodyOf(req);
  if (!b) return err(400, "bad_json", "The request was not valid.");
  const title = str(b.title).trim();
  const text = str(b.text).trim();
  if (!title || title.length > 120) return err(400, "invalid_title", "The title must be 1 to 120 characters.");
  if (!text || text.length > MAX_TEXT_CHARS) return err(400, "invalid_text", `The text must be 1 to ${MAX_TEXT_CHARS} characters.`);
  const bad = await precheck(env, agentId); if (bad) return bad;
  // The text is kept in private R2 so a Reindex can rebuild the vectors later.
  const docId = `d_${hex(8)}`;
  const key = kbKey(agentId, docId);
  const bytes = new TextEncoder().encode(text);
  try {
    await env.DIGITAL.put(key, bytes, { httpMetadata: { contentType: "text/plain" }, customMetadata: { file_name: encodeURIComponent("text.txt") } });
    await env.DB_META.prepare(
      "INSERT INTO voice_agent_docs (id, agent_id, kind, title, source, bytes, status, chunks, error, created_at, created_by, indexed_at) VALUES (?1,?2,'text',?3,?4,?5,'queued',0,NULL,?6,?7,NULL)",
    ).bind(docId, agentId, title, key, bytes.byteLength, Date.now(), a.uid).run();
  } catch (e) {
    await trackException(env, e, { uid: a.uid, route: "admin2_voice_agents:text_store", handled: true, app_name: APP });
    return err(500, "internal", "Could not store the text.");
  }
  await indexDoc(env, docId);
  clearVoiceAgentCache();
  return json({ doc: await docRow(env, docId) }, 201);
}

async function docOwned(env: Env, agentId: string, docId: string): Promise<boolean> {
  return !!(await env.DB_META.prepare("SELECT id FROM voice_agent_docs WHERE id=?1 AND agent_id=?2").bind(docId, agentId).first());
}

async function docDelete(req: Request, env: Env, agentId: string, docId: string): Promise<Response> {
  const a = await guard(req, env); if (a instanceof Response) return a;
  if (!(await docOwned(env, agentId, docId))) return err(404, "not_found", "Document not found.");
  try { await removeDoc(env, docId); } catch (e) {
    await trackException(env, e, { uid: a.uid, route: "admin2_voice_agents:doc_delete", handled: true, app_name: APP, extra: { doc_id: docId } });
    return err(500, "internal", "Could not remove the document. Please try again.");
  }
  clearVoiceAgentCache();
  return json({ ok: true });
}

async function docReindex(req: Request, env: Env, agentId: string, docId: string): Promise<Response> {
  const a = await guard(req, env); if (a instanceof Response) return a;
  if (!(await docOwned(env, agentId, docId))) return err(404, "not_found", "Document not found.");
  await indexDoc(env, docId);
  clearVoiceAgentCache();
  return json({ doc: await docRow(env, docId) });
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
async function sessionsList(req: Request, env: Env, agentId: string): Promise<Response> {
  const a = await guard(req, env); if (a instanceof Response) return a;
  const cursorRaw = new URL(req.url).searchParams.get("cursor");
  const cursor = cursorRaw && /^\d{1,16}$/.test(cursorRaw) ? Number(cursorRaw) : null;
  const rows = await env.DB_META.prepare(
    `SELECT s.id, s.uid, s.started_at, s.minutes, s.cost_paise, s.status, s.summary, u.display_name
       FROM agent_sessions s LEFT JOIN users u ON u.uid = s.uid
      WHERE s.agent = ?1 AND s.channel = 'voice' AND (?2 IS NULL OR s.started_at < ?2)
      ORDER BY s.started_at DESC LIMIT ?3`,
  ).bind(agentId, cursor, PAGE + 1).all<any>();
  const all = rows.results ?? [];
  const page = all.slice(0, PAGE);
  const emails = await Promise.all(page.map((r) => emailFor(env, String(r.uid)).catch(() => null)));
  return json({
    sessions: page.map((r, i) => ({
      id: String(r.id), uid: String(r.uid), name: r.display_name ?? null, email: emails[i] ?? null,
      started_at: Number(r.started_at), minutes: r.minutes == null ? null : Math.round(Number(r.minutes) * 10) / 10,
      cost_tokens: Math.round(Number(r.cost_paise ?? 0)) / 100, status: String(r.status), summary: r.summary ?? null,
    })),
    next_cursor: all.length > PAGE ? String(page[page.length - 1].started_at) : null,
  });
}

async function sessionDetail(req: Request, env: Env, sid: string): Promise<Response> {
  const a = await guard(req, env); if (a instanceof Response) return a;
  if (!/^[A-Za-z0-9-]{8,64}$/.test(sid)) return err(400, "invalid_id", "Bad session id.");
  const r = await env.DB_META.prepare(
    `SELECT s.id, s.uid, s.agent, s.started_at, s.ended_at, s.minutes, s.cost_paise, s.status, s.summary, s.transcript_r2_key, u.display_name
       FROM agent_sessions s LEFT JOIN users u ON u.uid = s.uid WHERE s.id = ?1`,
  ).bind(sid).first<any>();
  if (!r) return err(404, "not_found", "Session not found.");
  const email = await emailFor(env, String(r.uid)).catch(() => null);

  let transcript: string | null = null;
  if (r.transcript_r2_key) {
    try { transcript = (await (await env.DIGITAL.get(String(r.transcript_r2_key)))?.text())?.slice(0, MAX_TRANSCRIPT_CHARS) ?? null; } catch (e) {
      await trackException(env, e, { uid: a.uid, route: "admin2_voice_agents:transcript", handled: true, app_name: APP });
    }
  }
  let memories: { id: string; kind: string; text: string; created_at: number }[] = [];
  try {
    const m = await env.DB_META.prepare(
      "SELECT id, kind, text, created_at FROM ai_memory WHERE source_conversation_id=?1 AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 50",
    ).bind(sid).all<any>();
    memories = (m.results ?? []).map((x) => ({ id: String(x.id), kind: String(x.kind), text: String(x.text), created_at: Number(x.created_at) }));
  } catch { /* table absent: leave empty */ }
  // Minute charges: ledger ids are the op ids voice:<session>:m<N> (billing.opIdCharge).
  let charges: { minute: number; tokens: number; created_at: number }[] = [];
  try {
    const c = await env.DB_META.prepare("SELECT id, amount, created_at FROM wallet_ledger WHERE id LIKE ?1 ORDER BY created_at ASC LIMIT 200")
      .bind(`voice:${sid}:m%`).all<any>();
    charges = (c.results ?? []).map((x) => ({ minute: Number(String(x.id).split(":m").pop()) || 0, tokens: Number(x.amount), created_at: Number(x.created_at) }));
  } catch { /* ledger not in this DB: leave empty */ }

  return json({
    session: {
      id: String(r.id), uid: String(r.uid), agent: String(r.agent), name: r.display_name ?? null, email,
      started_at: Number(r.started_at), ended_at: r.ended_at == null ? null : Number(r.ended_at),
      minutes: r.minutes == null ? null : Math.round(Number(r.minutes) * 10) / 10,
      cost_tokens: Math.round(Number(r.cost_paise ?? 0)) / 100, status: String(r.status), summary: r.summary ?? null,
    },
    transcript, memories, charges,
  });
}

// ---------------------------------------------------------------------------
// Route table (spread into ADMIN2_ROUTES by routes/admin2.ts)
// ---------------------------------------------------------------------------
const P = (s: string) => new RegExp(`^${BASE}/${s}$`);
const ID = "([^/]+)";
export const ADMIN2_VOICE_AGENT_ROUTES: Admin2RouteDef[] = [
  { method: "GET", path: `${BASE}/meta`, handler: (req, env) => meta(req, env) },
  { method: "GET", path: BASE, handler: (req, env) => list(req, env) },
  { method: "POST", path: BASE, handler: (req, env) => create(req, env) },
  { method: "PUT", path: P(ID), handler: (req, env, [id]) => update(req, env, id) },
  { method: "DELETE", path: P(ID), handler: (req, env, [id]) => archive(req, env, id) },
  { method: "GET", path: P(`${ID}/prompts`), handler: (req, env, [id]) => promptsList(req, env, id) },
  { method: "POST", path: P(`${ID}/prompts`), handler: (req, env, [id]) => promptCreate(req, env, id) },
  { method: "POST", path: P(`${ID}/prompts/${ID}/publish`), handler: (req, env, [id, pid]) => promptPublish(req, env, id, pid) },
  { method: "GET", path: P(`${ID}/docs`), handler: (req, env, [id]) => docsList(req, env, id) },
  { method: "POST", path: P(`${ID}/docs/file`), handler: (req, env, [id]) => docFile(req, env, id) },
  { method: "POST", path: P(`${ID}/docs/url`), handler: (req, env, [id]) => docUrl(req, env, id) },
  { method: "POST", path: P(`${ID}/docs/text`), handler: (req, env, [id]) => docText(req, env, id) },
  { method: "POST", path: P(`${ID}/docs/${ID}/reindex`), handler: (req, env, [id, d]) => docReindex(req, env, id, d) },
  { method: "DELETE", path: P(`${ID}/docs/${ID}`), handler: (req, env, [id, d]) => docDelete(req, env, id, d) },
  { method: "GET", path: P(`${ID}/sessions`), handler: (req, env, [id]) => sessionsList(req, env, id) },
  { method: "GET", path: /^\/api\/admin\/v2\/voice-sessions\/([^/]+)$/, handler: (req, env, [sid]) => sessionDetail(req, env, sid) },
];
