// [SAATHUM-PREETI-1 2026-09-30] Admin 2 — "AI assistant" (Preeti) admin API.
// Contract: Specs/SPEC-2026-09-30-PREETI-AI-AGENT.md ("Admin API"); wire shapes AdminAi* in
// lib/preeti/contracts.ts. Registered by ONE spread line in routes/admin2.ts (ADMIN2_AI_ROUTES).
//
//   GET/PUT /api/admin/v2/ai/config             POST /ai/avatar            POST /ai/avatar/generate
//   GET/POST /ai/prompts                        POST /ai/prompts/:id/publish
//   POST /ai/test-chat                          GET/POST /ai/files         DELETE /ai/files/:id
//   GET /ai/knowledge                           POST /ai/knowledge/sync
//   GET/POST /ai/incidents                      DELETE /ai/incidents/:id
//   GET /ai/conversations                       GET/PATCH /ai/conversations/:id
//   GET /ai/brand                               POST /ai/brand/change      GET /ai/spend
//
// Admin-only reads/writes are plain SQL against the spec tables (DB_META) so this file does not
// depend on the shape of agent A's store helpers. Only behaviour owned by other agents is imported
// (brand runtime, chat turns, knowledge index). This file never imports routes/admin2.ts at runtime
// (that would be a circular import): it uses requireAdmin directly, like admin2_weather_notice.ts.
//
// Uploads: the handler has no ExecutionContext, and ctx.waitUntil work dies on long jobs
// (memory: poster-generation-dies-in-waituntil), so file indexing and site sync run INLINE in the
// request. A failed index leaves the row 'failed' with the error, never a silent 'uploading'.
import type { Env } from "../types";
import { json, sha256Hex, decodeFileNameHeader } from "../util";
import type { Admin2RouteDef } from "./admin2";
import { requireAdmin } from "./admin_money";
import { track, trackException } from "../hooks";
import { normalizeE164 } from "../lib/phone_e164";
import { readConfig } from "./config";
import { generateImage } from "./ava_image";
import { currentBrand, setBrand } from "../lib/preeti/brand_runtime";
import { streamPreetiTurn, askPreetiOnce } from "../lib/preeti/chat";
import { indexAgentFile, removeAgentFile, syncSiteKnowledge, markFilesForBrandReview } from "../lib/preeti/knowledge";
import type {
  AdminAiConfig, AdminAiPrompt, AdminAiFile, AdminAiKnowledgeDoc, AdminAiIncident, AdminAiConversationRow,
  AdminAiMessage, AdminAiConversationDetail, AdminAiBrand, AdminAiBrandChangeResult, AdminAiSpend, PreetiCard,
} from "../lib/preeti/contracts";

const APP = "saathum";
const ID = "([^/]+)";
const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 330 * 60_000;
const MAX_AVATAR_BYTES = 3 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const PAGE_SIZE = 30;

const err = (status: number, error: string, message: string, extra: Record<string, unknown> = {}) =>
  json({ error, message, ...extra }, status);

async function guard(req: Request, env: Env): Promise<{ uid: string } | Response> {
  const a = await requireAdmin(req, env);
  if (a instanceof Response) {
    return a.status === 403
      ? err(403, "admin_only", "You don't have admin access.")
      : err(a.status, "unauthorized", "Please sign in again.");
  }
  return a;
}

async function body(req: Request): Promise<Record<string, any> | null> {
  try {
    const b = await req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, any>) : null;
  } catch { return null; }
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const parseJson = <T>(s: unknown, fallback: T): T => {
  try { return s ? (JSON.parse(String(s)) as T) : fallback; } catch { return fallback; }
};
/** Escape a user string for a LIKE ... ESCAPE '\' pattern. */
const likeOf = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const istMonth = (now: number) => new Date(now + IST_OFFSET_MS).toISOString().slice(0, 7);
const istMonthStartMs = (now: number) => {
  const m = istMonth(now);
  return Date.parse(`${m}-01T00:00:00.000Z`) - IST_OFFSET_MS;
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
type QR = { home: string[]; article: string[]; event: string[] };
const emptyQr = (): QR => ({ home: [], article: [], event: [] });

async function loadConfig(env: Env): Promise<AdminAiConfig> {
  const r = await env.DB_META.prepare("SELECT * FROM ai_agent_config WHERE id=1").first<any>();
  if (!r) throw new Error("ai_agent_config row missing (migration 2026-09-30-preeti-ai.sql not applied)");
  const q = parseJson<Partial<QR>>(r.quick_replies_json, {});
  const cfg = (await readConfig(env)) as unknown as { preetiEnabled?: boolean };
  return {
    name: String(r.name ?? ""), avatar_url: r.avatar_url ?? null, welcome_text: String(r.welcome_text ?? ""),
    quick_replies: { home: q.home ?? [], article: q.article ?? [], event: q.event ?? [] },
    support_whatsapp: String(r.support_whatsapp ?? ""), alert_whatsapp: String(r.alert_whatsapp ?? ""),
    enabled: Number(r.enabled) === 1,
    monthly_cap_rupees: Number(r.monthly_cap_rupees ?? 2000), active_prompt_id: r.active_prompt_id ?? null,
    flag_enabled: cfg.preetiEnabled === true,
  };
}

export async function adminAiConfigGet(req: Request, env: Env): Promise<Response> {
  const a = await guard(req, env); if (a instanceof Response) return a;
  return json(await loadConfig(env), 200, { "cache-control": "private, no-store" });
}

export async function adminAiConfigPut(req: Request, env: Env): Promise<Response> {
  const a = await guard(req, env); if (a instanceof Response) return a;
  const b = await body(req);
  if (!b) return err(400, "bad_request", "Send a JSON body.");
  const sets: string[] = []; const binds: unknown[] = [];
  const put = (col: string, v: unknown) => { binds.push(v); sets.push(`${col}=?${binds.length}`); };

  if ("name" in b) {
    const n = str(b.name).trim();
    if (n.length < 1 || n.length > 40) return err(400, "invalid_name", "The name must be 1 to 40 characters.");
    put("name", n);
  }
  if ("welcome_text" in b) {
    const w = str(b.welcome_text).trim();
    if (!w || w.length > 600) return err(400, "invalid_welcome", "The welcome message must be 1 to 600 characters.");
    put("welcome_text", w);
  }
  if ("quick_replies" in b) {
    const q = b.quick_replies; const out = emptyQr();
    if (!q || typeof q !== "object") return err(400, "invalid_quick_replies", "Quick replies must be an object.");
    for (const kind of ["home", "article", "event"] as const) {
      const arr = q[kind] ?? [];
      if (!Array.isArray(arr) || arr.length > 4) return err(400, "invalid_quick_replies", `At most 4 quick replies for ${kind}.`);
      for (const s of arr) {
        const t = str(s).trim();
        if (!t || t.length > 60) return err(400, "invalid_quick_replies", "Each quick reply must be 1 to 60 characters.");
        out[kind].push(t);
      }
    }
    put("quick_replies_json", JSON.stringify(out));
  }
  for (const [key, label] of [["support_whatsapp", "support"], ["alert_whatsapp", "alert"]] as const) {
    if (key in b) {
      const e = normalizeE164(b[key]);
      if (!e) return err(400, "invalid_phone", `The ${label} WhatsApp number is not valid.`);
      put(key, e);
    }
  }
  if ("enabled" in b) {
    if (typeof b.enabled !== "boolean") return err(400, "invalid_enabled", "enabled must be true or false.");
    put("enabled", b.enabled ? 1 : 0);
  }
  if ("monthly_cap_rupees" in b) {
    const c = Number(b.monthly_cap_rupees);
    if (!Number.isInteger(c) || c < 100 || c > 100000) return err(400, "invalid_cap", "The monthly cap must be a whole number between 100 and 100000.");
    put("monthly_cap_rupees", c);
  }
  if ("avatar_url" in b) {
    const u = b.avatar_url;
    if (u !== null && !(typeof u === "string" && /^https:\/\/\S{4,500}$/.test(u))) return err(400, "invalid_avatar", "The avatar must be an https URL or null.");
    put("avatar_url", u);
  }
  if (!sets.length) return err(400, "nothing_to_save", "Nothing to change.");
  put("updated_at", Date.now()); put("updated_by", a.uid);
  try {
    await env.DB_META.prepare(`UPDATE ai_agent_config SET ${sets.join(", ")} WHERE id=1`).bind(...binds).run();
  } catch (e) {
    await trackException(env, e, { uid: a.uid, route: "admin2_ai:config_put", handled: true, app_name: APP });
    return err(500, "internal", "Could not save the settings.");
  }
  await track(env, a.uid, "preeti_admin_config_saved", APP, { fields: sets.length - 2 });
  return json(await loadConfig(env));
}

// ---------------------------------------------------------------------------
// Avatar (upload + generate). Stored PUBLIC in BLOBS under the u/<uid>/public/ layout so the
// existing image CDN (BLOSSOM_BASE_URL, /cdn-cgi/image) serves it; content-addressed => immutable.
// ---------------------------------------------------------------------------
const IMG_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

function sniffImage(b: Uint8Array): string | null {
  if (b.length > 12 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

async function putAvatar(env: Env, uid: string, bytes: Uint8Array, mime: string): Promise<string> {
  const hash = await sha256Hex(bytes);
  const key = `u/${uid}/public/preeti/${hash}.${IMG_EXT[mime]}`;
  await env.BLOBS.put(key, bytes, { httpMetadata: { contentType: mime, cacheControl: "public, max-age=31536000, immutable" } });
  return `${env.BLOSSOM_BASE_URL}/${key}`;
}

export async function adminAiAvatarUpload(req: Request, env: Env): Promise<Response> {
  const a = await guard(req, env); if (a instanceof Response) return a;
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_AVATAR_BYTES) return err(413, "too_large", "The image must be 3 MB or smaller.");
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (!bytes.byteLength) return err(400, "empty", "No image received.");
  if (bytes.byteLength > MAX_AVATAR_BYTES) return err(413, "too_large", "The image must be 3 MB or smaller.");
  const mime = sniffImage(bytes);
  if (!mime) return err(415, "unsupported_type", "Please upload a PNG, JPEG or WebP image.");
  const fileName = decodeFileNameHeader(req.headers.get("x-file-name"));
  try {
    const url = await putAvatar(env, a.uid, bytes, mime);
    await env.DB_META.prepare("UPDATE ai_agent_config SET avatar_url=?1, updated_at=?2, updated_by=?3 WHERE id=1")
      .bind(url, Date.now(), a.uid).run();
    await track(env, a.uid, "preeti_admin_avatar_uploaded", APP, { bytes: bytes.byteLength, mime, has_name: !!fileName });
    return json({ avatar_url: url });
  } catch (e) {
    await trackException(env, e, { uid: a.uid, route: "admin2_ai:avatar_upload", handled: true, app_name: APP });
    return err(500, "internal", "Could not save the image.");
  }
}

const AVATAR_PROMPT =
  "Photo-realistic portrait photograph of a young Indian woman in her twenties from Garhwal, Uttarakhand, " +
  "warm natural smile, kind eyes, modest traditional Indian dress, soft blurred Himalayan temple background " +
  "with gentle mountain light, head and shoulders portrait, natural skin texture, shallow depth of field. " +
  "No text, no letters, no logos, no watermark.";

export async function adminAiAvatarGenerate(req: Request, env: Env): Promise<Response> {
  const a = await guard(req, env); if (a instanceof Response) return a;
  // Two candidates from the existing Vertex image pipeline (routes/ava_image.ts generateImage) — NOT Higgsfield.
  const runs = await Promise.allSettled([0, 1].map(() =>
    generateImage(env, "", AVATAR_PROMPT, a.uid, undefined, { aspectRatio: "3:4", resolution: "1K" })));
  const urls: string[] = [];
  for (const r of runs) {
    if (r.status === "fulfilled") {
      try { urls.push(await putAvatar(env, a.uid, r.value.bytes, "image/png")); }
      catch (e) { await trackException(env, e, { uid: a.uid, route: "admin2_ai:avatar_generate_store", handled: true, app_name: APP }); }
    } else {
      await trackException(env, r.reason, { uid: a.uid, route: "admin2_ai:avatar_generate", handled: true, app_name: APP });
    }
  }
  if (!urls.length) return err(502, "generation_failed", "Could not create a portrait right now. Please try again.");
  await track(env, a.uid, "preeti_admin_avatar_generated", APP, { candidates: urls.length });
  return json({ candidates: urls });
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------
export async function adminAiPromptsList(req: Request, env: Env): Promise<Response> {
  const a = await guard(req, env); if (a instanceof Response) return a;
  const [rows, cfg] = await Promise.all([
    env.DB_META.prepare("SELECT id, body, note, created_by, created_at, published_at FROM ai_agent_prompts ORDER BY created_at DESC, id DESC LIMIT 100").all<any>(),
    env.DB_META.prepare("SELECT active_prompt_id FROM ai_agent_config WHERE id=1").first<{ active_prompt_id: string | null }>(),
  ]);
  const active = cfg?.active_prompt_id ?? null;
  const prompts: AdminAiPrompt[] = (rows.results ?? []).map((r) => ({
    id: String(r.id), body: String(r.body ?? ""), note: r.note ?? null, created_by: String(r.created_by ?? ""),
    created_at: Number(r.created_at), published_at: r.published_at != null ? Number(r.published_at) : null,
    active: String(r.id) === active,
  }));
  return json({ prompts });
}

export async function adminAiPromptCreate(req: Request, env: Env): Promise<Response> {
  const a = await guard(req, env); if (a instanceof Response) return a;
  const b = await body(req);
  const text = str(b?.body).trim();
  const note = str(b?.note).trim();
  if (!text || text.length > 20000) return err(400, "invalid_prompt", "The instructions must be 1 to 20000 characters.");
  if (note.length > 200) return err(400, "invalid_note", "The note must be 200 characters or fewer.");
  const id = `p_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const now = Date.now();
  await env.DB_META.prepare("INSERT INTO ai_agent_prompts (id, body, note, created_by, created_at, published_at) VALUES (?1,?2,?3,?4,?5,NULL)")
    .bind(id, text, note || null, a.uid, now).run();
  await track(env, a.uid, "preeti_prompt_saved", APP, { prompt_id: id, chars: text.length });
  const p: AdminAiPrompt = { id, body: text, note: note || null, created_by: a.uid, created_at: now, published_at: null, active: false };
  return json(p, 201);
}

export async function adminAiPromptPublish(req: Request, env: Env, id: string): Promise<Response> {
  const a = await guard(req, env); if (a instanceof Response) return a;
  const row = await env.DB_META.prepare("SELECT id FROM ai_agent_prompts WHERE id=?1").bind(id).first();
  if (!row) return err(404, "not_found", "That version does not exist.");
  const now = Date.now();
  await env.DB_META.batch([
    env.DB_META.prepare("UPDATE ai_agent_prompts SET published_at=?2 WHERE id=?1").bind(id, now),
    env.DB_META.prepare("UPDATE ai_agent_config SET active_prompt_id=?1, updated_at=?2, updated_by=?3 WHERE id=1").bind(id, now, a.uid),
  ]);
  await track(env, a.uid, "preeti_prompt_published", APP, { prompt_id: id });
  return json({ ok: true, active_prompt_id: id });
}

// ---------------------------------------------------------------------------
// Test chat — the same SSE stream as the public widget, on an is_test conversation.
// ---------------------------------------------------------------------------
export async function adminAiTestChat(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const a = await guard(req, env); if (a instanceof Response) return a;
  const b = await body(req);
  const message = str(b?.message).trim();
  if (!message || message.length > 2000) return err(400, "invalid_message", "Type a message of up to 2000 characters.");
  const promptId = b?.prompt_id ? str(b.prompt_id) : undefined;
  if (promptId) {
    const p = await env.DB_META.prepare("SELECT id FROM ai_agent_prompts WHERE id=?1").bind(promptId).first();
    if (!p) return err(404, "not_found", "That prompt version does not exist.");
  }
  let convId = b?.conversation_id ? str(b.conversation_id) : "";
  const now = Date.now();
  // [SAATHUM-PREETI-TESTCHAT-1] The admin screen mints its own conversation id (a UUID) and reuses it
  // until "New". An unknown id therefore means "start a test chat under this id", not 404. An id that
  // belongs to a REAL (non-test) conversation is still refused, so a test can never write into one.
  if (convId && !/^[A-Za-z0-9_-]{8,64}$/.test(convId)) return err(400, "invalid_conversation", "Bad conversation id.");
  const existing = convId
    ? await env.DB_META.prepare("SELECT id, is_test FROM ai_conversations WHERE id=?1").bind(convId).first<{ id: string; is_test: number }>()
    : null;
  if (existing && !Number(existing.is_test)) return err(404, "not_found", "Test conversation not found.");
  if (!existing) {
    if (!convId) convId = `t_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await env.DB_META.prepare(
      "INSERT INTO ai_conversations (id, uid, visitor_id, name, is_test, created_at, last_message_at) VALUES (?1,?2,?3,?4,1,?5,?5)",
    ).bind(convId, a.uid, `admin-test-${a.uid.slice(0, 8)}`, "Admin test", now).run();
  }
  await track(env, a.uid, "preeti_admin_test_chat", APP, { prompt_id: promptId ?? null });
  const res = await streamPreetiTurn(env, ctx ?? (undefined as unknown as ExecutionContext), {
    conversationId: convId, message, page: { path: "/admin/ai", kind: "other" }, uid: a.uid,
    promptOverrideId: promptId, isTest: true,
  });
  const headers = new Headers(res.headers);
  headers.set("x-preeti-conversation", convId);
  return new Response(res.body, { status: res.status, headers });
}

// ---------------------------------------------------------------------------
// Files (uploaded knowledge). R2 DIGITAL preeti/files/<id>. Indexed INLINE (see header).
// ---------------------------------------------------------------------------
const FILE_MIME: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain", md: "text/markdown", csv: "text/csv", html: "text/html",
};

const fileOf = (r: any): AdminAiFile => ({
  id: String(r.id), file_name: String(r.file_name), mime: String(r.mime), size_bytes: Number(r.size_bytes),
  status: String(r.status), error: r.error ?? null, created_at: Number(r.created_at),
});

export async function adminAiFilesList(req: Request, env: Env): Promise<Response> {
  const a = await guard(req, env); if (a instanceof Response) return a;
  const rows = await env.DB_META.prepare(
    "SELECT id, file_name, mime, size_bytes, status, error, created_at FROM ai_agent_files ORDER BY created_at DESC LIMIT 200",
  ).all<any>();
  return json({ files: (rows.results ?? []).map(fileOf) });
}

export async function adminAiFileUpload(req: Request, env: Env): Promise<Response> {
  const a = await guard(req, env); if (a instanceof Response) return a;
  const name = decodeFileNameHeader(req.headers.get("x-file-name")).replace(/[\\/]/g, "_").trim().slice(0, 200);
  if (!name) return err(400, "missing_name", "The file name is missing.");
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  const mime = FILE_MIME[ext];
  if (!mime) return err(415, "unsupported_type", "Allowed files: PDF, DOCX, TXT, MD, CSV, HTML.");
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_FILE_BYTES) return err(413, "too_large", "The file must be 20 MB or smaller.");
  const bytes = await req.arrayBuffer();
  if (!bytes.byteLength) return err(400, "empty", "The file is empty.");
  if (bytes.byteLength > MAX_FILE_BYTES) return err(413, "too_large", "The file must be 20 MB or smaller.");

  const id = `f_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const key = `preeti/files/${id}`;
  const now = Date.now();
  try {
    await env.DIGITAL.put(key, bytes, { httpMetadata: { contentType: mime }, customMetadata: { file_name: encodeURIComponent(name) } });
    await env.DB_META.prepare(
      "INSERT INTO ai_agent_files (id, r2_key, file_name, mime, size_bytes, status, uploaded_by, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,'uploading',?6,?7,?7)",
    ).bind(id, key, name, mime, bytes.byteLength, a.uid, now).run();
  } catch (e) {
    await trackException(env, e, { uid: a.uid, route: "admin2_ai:file_store", handled: true, app_name: APP });
    return err(500, "internal", "Could not store the file.");
  }
  // Inline indexing (no ExecutionContext here, and waitUntil kills long jobs).
  try {
    await indexAgentFile(env, id);
  } catch (e) {
    await trackException(env, e, { uid: a.uid, route: "admin2_ai:file_index", handled: true, app_name: APP, extra: { file_id: id } });
    await env.DB_META.prepare("UPDATE ai_agent_files SET status='failed', error=?2, updated_at=?3 WHERE id=?1 AND status IN ('uploading','indexing')")
      .bind(id, String((e as Error)?.message ?? e).slice(0, 300), Date.now()).run();
  }
  const row = await env.DB_META.prepare("SELECT id, file_name, mime, size_bytes, status, error, created_at FROM ai_agent_files WHERE id=?1").bind(id).first<any>();
  await track(env, a.uid, "preeti_file_uploaded", APP, { file_id: id, ext, bytes: bytes.byteLength, status: row?.status ?? "unknown" });
  return json(fileOf(row), 201);
}

export async function adminAiFileDelete(req: Request, env: Env, id: string): Promise<Response> {
  const a = await guard(req, env); if (a instanceof Response) return a;
  const row = await env.DB_META.prepare("SELECT id, r2_key FROM ai_agent_files WHERE id=?1").bind(id).first<{ id: string; r2_key: string }>();
  if (!row) return err(404, "not_found", "File not found.");
  try {
    await removeAgentFile(env, id);
    await env.DIGITAL.delete(row.r2_key);
    await env.DB_META.prepare("DELETE FROM ai_agent_files WHERE id=?1").bind(id).run();
  } catch (e) {
    await trackException(env, e, { uid: a.uid, route: "admin2_ai:file_delete", handled: true, app_name: APP, extra: { file_id: id } });
    return err(500, "internal", "Could not remove the file.");
  }
  await track(env, a.uid, "preeti_file_deleted", APP, { file_id: id });
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Knowledge
// ---------------------------------------------------------------------------
export async function adminAiKnowledgeList(req: Request, env: Env): Promise<Response> {
  const a = await guard(req, env); if (a instanceof Response) return a;
  const rows = await env.DB_META.prepare(
    "SELECT url, kind, title, status, synced_at, error FROM ai_knowledge_docs ORDER BY kind, url LIMIT 1000",
  ).all<any>();
  const docs: AdminAiKnowledgeDoc[] = (rows.results ?? []).map((r) => ({
    url: String(r.url), kind: r.kind === "article" ? "article" : "page", title: r.title ?? null,
    status: String(r.status ?? ""), synced_at: r.synced_at != null ? Number(r.synced_at) : null, error: r.error ?? null,
  }));
  return json({ docs });
}

export async function adminAiKnowledgeSync(req: Request, env: Env): Promise<Response> {
  const a = await guard(req, env); if (a instanceof Response) return a;
  const b = await body(req);
  try {
    const result = await syncSiteKnowledge(env, { full: b?.full === true });
    await track(env, a.uid, "preeti_knowledge_sync", APP, { full: b?.full === true, ...result });
    return json({ ok: true, result });
  } catch (e) {
    await trackException(env, e, { uid: a.uid, route: "admin2_ai:knowledge_sync", handled: true, app_name: APP });
    return err(502, "sync_failed", "The sync did not finish. Please try again.");
  }
}

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------
export async function adminAiIncidentsList(req: Request, env: Env): Promise<Response> {
  const a = await guard(req, env); if (a instanceof Response) return a;
  const now = Date.now();
  const rows = await env.DB_META.prepare(
    `SELECT i.id, i.listing_id, l.title AS listing_title, i.message, i.starts_at, i.expires_at, i.source, i.created_at
       FROM ai_incidents i LEFT JOIN listings l ON l.id=i.listing_id
      WHERE i.expires_at IS NULL OR i.expires_at>?1 OR i.created_at>=?2
      ORDER BY i.created_at DESC LIMIT 200`,
  ).bind(now, now - 30 * DAY_MS).all<any>();
  const incidents: (AdminAiIncident & { active: boolean })[] = (rows.results ?? []).map((r) => ({
    id: String(r.id), listing_id: r.listing_id ?? null, listing_title: r.listing_title ?? null, message: String(r.message),
    starts_at: Number(r.starts_at), expires_at: r.expires_at != null ? Number(r.expires_at) : null,
    source: String(r.source), created_at: Number(r.created_at),
    active: r.expires_at == null || Number(r.expires_at) > now,
  }));
  return json({ incidents });
}

export async function adminAiIncidentCreate(req: Request, env: Env): Promise<Response> {
  const a = await guard(req, env); if (a instanceof Response) return a;
  const b = await body(req);
  const message = str(b?.message).trim();
  if (!message || message.length > 500) return err(400, "invalid_message", "The message must be 1 to 500 characters.");
  const now = Date.now();
  let expires: number | null = null;
  if (b?.expires_at != null) {
    expires = Number(b.expires_at);
    if (!Number.isFinite(expires) || expires <= now) return err(400, "invalid_expiry", "The end time must be in the future.");
  }
  const listingId = b?.listing_id ? str(b.listing_id) : null;
  if (listingId) {
    const l = await env.DB_META.prepare("SELECT id FROM listings WHERE id=?1").bind(listingId).first();
    if (!l) return err(404, "not_found", "That event does not exist.");
  }
  const id = `i_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await env.DB_META.prepare(
    "INSERT INTO ai_incidents (id, listing_id, message, starts_at, expires_at, source, created_by, created_at) VALUES (?1,?2,?3,?4,?5,'admin',?6,?4)",
  ).bind(id, listingId, message, now, expires, a.uid).run();
  await track(env, a.uid, "preeti_incident_created", APP, { incident_id: id, listing_id: listingId, has_expiry: expires != null });
  return json({ id }, 201);
}

export async function adminAiIncidentDelete(req: Request, env: Env, id: string): Promise<Response> {
  const a = await guard(req, env); if (a instanceof Response) return a;
  const r = await env.DB_META.prepare("DELETE FROM ai_incidents WHERE id=?1").bind(id).run();
  if (!r.meta?.changes) return err(404, "not_found", "Notice not found.");
  await track(env, a.uid, "preeti_incident_deleted", APP, { incident_id: id });
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Conversations (inbox)
// ---------------------------------------------------------------------------
const CONV_SELECT = `
  SELECT c.id, c.uid, c.visitor_id, c.name, c.e164, c.email, c.first_page, c.last_page, c.lead_score, c.badges_json, c.status,
         c.admin_note, c.message_count, c.last_message_at, COALESCE(c.agent,'preeti') AS agent,
         (SELECT m.text FROM ai_messages m WHERE m.conversation_id=c.id AND m.role IN ('visitor','preeti') ORDER BY m.id DESC LIMIT 1) AS last_text
    FROM ai_conversations c`;

function convRow(r: any): AdminAiConversationRow & { first_page: string | null; last_page: string | null; admin_note: string | null; agent: string } {
  const label = r.name || r.e164 || r.email || `Visitor ${String(r.visitor_id ?? "").slice(-4)}`;
  const status = r.status === "resolved" || r.status === "needs_human" ? r.status : "open";
  return {
    id: String(r.id), name: r.name ?? null, e164: r.e164 ?? null, email: r.email ?? null, uid: r.uid ?? null, visitor_label: String(label),
    last_text: String(r.last_text ?? "").slice(0, 160), last_message_at: Number(r.last_message_at ?? 0),
    badges: parseJson<string[]>(r.badges_json, []), status, lead_score: Number(r.lead_score ?? 0),
    message_count: Number(r.message_count ?? 0),
    first_page: r.first_page ?? null, last_page: r.last_page ?? null, admin_note: r.admin_note ?? null,
    agent: String(r.agent ?? "preeti"),
  };
}

export async function adminAiConversationsList(req: Request, env: Env): Promise<Response> {
  const a = await guard(req, env); if (a instanceof Response) return a;
  const u = new URL(req.url);
  const q = (u.searchParams.get("q") ?? "").trim().slice(0, 100);
  const badge = u.searchParams.get("badge") ?? "";
  const status = u.searchParams.get("status") ?? "";
  const cursor = u.searchParams.get("cursor") ?? "";
  const agent = u.searchParams.get("agent") ?? ""; // optional: preeti | pandit | voice (every voice guide); omitted = all
  const where: string[] = []; const binds: unknown[] = [];
  const bind = (v: unknown) => { binds.push(v); return `?${binds.length}`; };

  if (u.searchParams.get("test") !== "1") where.push("c.is_test=0");
  if (badge) {
    if (!["hot_lead", "needs_human", "booking_check", "angry"].includes(badge)) return err(400, "invalid_badge", "Unknown badge.");
    where.push(`c.badges_json LIKE ${bind(`%"${badge}"%`)}`);
  }
  if (agent) {
    if (!["preeti", "pandit", "voice"].includes(agent)) return err(400, "invalid_agent", "Unknown agent.");
    if (agent === "voice") where.push("COALESCE(c.agent,'preeti') NOT IN ('preeti','pandit')");
    else where.push(`COALESCE(c.agent,'preeti')=${bind(agent)}`);
  }
  if (status) {
    if (!["open", "resolved", "needs_human"].includes(status)) return err(400, "invalid_status", "Unknown status.");
    where.push(`c.status=${bind(status)}`);
  }
  if (q) {
    const like = bind(likeOf(q));
    const digits = q.replace(/\D/g, "");
    const phone = digits.length >= 4 ? ` OR c.e164 LIKE ${bind(likeOf(digits))}` : "";
    where.push(`(c.name LIKE ${like} ESCAPE '\\' OR c.email LIKE ${like} ESCAPE '\\' OR c.id=${bind(q)}${phone}
      OR EXISTS (SELECT 1 FROM ai_messages m WHERE m.conversation_id=c.id AND m.role IN ('visitor','preeti') AND m.text LIKE ${like} ESCAPE '\\'))`);
  }
  if (cursor) {
    const [ts, ...rest] = cursor.split(":");
    const cid = rest.join(":");
    const t = Number(ts);
    if (!Number.isFinite(t) || !cid) return err(400, "invalid_cursor", "Bad cursor.");
    const t1 = bind(t);
    where.push(`(c.last_message_at<${t1} OR (c.last_message_at=${t1} AND c.id<${bind(cid)}))`);
  }
  const sql = `${CONV_SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY c.last_message_at DESC, c.id DESC LIMIT ${PAGE_SIZE + 1}`;
  const rows = (await env.DB_META.prepare(sql).bind(...binds).all<any>()).results ?? [];
  const page = rows.slice(0, PAGE_SIZE);
  const last = page[page.length - 1];
  const next = rows.length > PAGE_SIZE && last ? `${last.last_message_at}:${last.id}` : null;
  const rowsOut = page.map(convRow);
  return json({ items: rowsOut, conversations: rowsOut, next_cursor: next }, 200, { "cache-control": "private, no-store" });
}

export async function adminAiConversationGet(req: Request, env: Env, id: string): Promise<Response> {
  const a = await guard(req, env); if (a instanceof Response) return a;
  const c = await env.DB_META.prepare(`${CONV_SELECT} WHERE c.id=?1`).bind(id).first<any>();
  if (!c) return err(404, "not_found", "Conversation not found.");
  const msgs = await env.DB_META.prepare(
    "SELECT id, role, text, cards_json, tool_name, tool_summary, blocked, created_at FROM ai_messages WHERE conversation_id=?1 ORDER BY id ASC LIMIT 1000",
  ).bind(id).all<any>();
  const messages: AdminAiMessage[] = (msgs.results ?? []).map((m) => ({
    id: Number(m.id), role: m.role, text: String(m.text ?? ""), cards: parseJson<PreetiCard[]>(m.cards_json, []),
    tool_name: m.tool_name ?? null, tool_summary: m.tool_summary ?? null, blocked: Number(m.blocked) === 1, created_at: Number(m.created_at),
  }));

  // Bookings: the conversation's signed-in uid, else the uid(s) that verified this WhatsApp number.
  const uids = new Set<string>();
  if (c.uid) uids.add(String(c.uid));
  else if (c.e164) {
    const v = await env.DB_META.prepare("SELECT DISTINCT uid FROM phone_otp WHERE e164=?1 AND status='verified' LIMIT 5")
      .bind(c.e164).all<{ uid: string }>().catch(() => ({ results: [] as { uid: string }[] }));
    for (const r of v.results ?? []) uids.add(r.uid);
  }
  let bookings: AdminAiConversationDetail["bookings"] = [];
  if (uids.size) {
    const list = [...uids];
    const ph = list.map((_, i) => `?${i + 1}`).join(",");
    const rows = await env.DB_META.prepare(
      `SELECT k.checkout_id, l.title AS listing_title, k.status, k.created_at
         FROM saathum_checkouts k LEFT JOIN listings l ON l.id=k.listing_id
        WHERE k.uid IN (${ph}) ORDER BY k.created_at DESC LIMIT 20`,
    ).bind(...list).all<any>();
    bookings = (rows.results ?? []).map((r) => ({
      checkout_id: String(r.checkout_id), listing_title: String(r.listing_title ?? ""), status: String(r.status), created_at: Number(r.created_at),
    }));
  }
  const out: AdminAiConversationDetail = { conversation: convRow(c), messages, bookings };
  return json(out, 200, { "cache-control": "private, no-store" });
}

export async function adminAiConversationPatch(req: Request, env: Env, id: string): Promise<Response> {
  const a = await guard(req, env); if (a instanceof Response) return a;
  const b = await body(req);
  if (!b) return err(400, "bad_request", "Send a JSON body.");
  const sets: string[] = []; const binds: unknown[] = [id];
  const put = (col: string, v: unknown) => { binds.push(v); sets.push(`${col}=?${binds.length}`); };
  if ("status" in b) {
    if (!["open", "resolved", "needs_human"].includes(b.status)) return err(400, "invalid_status", "Unknown status.");
    put("status", b.status);
  }
  if ("admin_note" in b) {
    const n = str(b.admin_note).trim();
    if (n.length > 2000) return err(400, "invalid_note", "The note must be 2000 characters or fewer.");
    put("admin_note", n || null);
  }
  if (!sets.length) return err(400, "nothing_to_save", "Nothing to change.");
  const r = await env.DB_META.prepare(`UPDATE ai_conversations SET ${sets.join(", ")} WHERE id=?1`).bind(...binds).run();
  if (!r.meta?.changes) return err(404, "not_found", "Conversation not found.");
  if (b.status === "resolved") {
    await env.DB_META.prepare("UPDATE ai_handoffs SET resolved_at=?2 WHERE conversation_id=?1 AND resolved_at IS NULL").bind(id, Date.now()).run();
  }
  await track(env, a.uid, "preeti_conversation_updated", APP, { conversation_id: id, status: b.status ?? null, note_changed: "admin_note" in b });
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Brand & domain
// ---------------------------------------------------------------------------
/** Plain-English steps that live OUTSIDE the code (Specs brand plan). The site/Preeti update themselves; these do not. */
const BRAND_CHECKLIST = [
  "Point the new domain's DNS at the website (Cloudflare Pages custom domain) and confirm the padlock shows.",
  "Add the new domain to the sign-in provider (Clerk) as an allowed domain and update its redirect URLs.",
  "Set up email on the new domain: add the SPF and DKIM records and verify them with the email provider.",
  "Set up 301 redirects from every page of the old domain to the same page on the new domain.",
  "In Google Search Console, verify the new domain and use 'Change of address' from the old one.",
  "Update the Play Store listing links (website, privacy policy, support) to the new domain.",
  "Update the payment / UPI display name so buyers see the new name when they pay.",
  "Replace the logo art wherever it is baked into images (posters, social cards, app icon).",
  "Re-read the legal pages (terms, privacy, refunds) and the About page for the old name.",
];

const HOST_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;

const CHECK_QUESTIONS = (oldName: string, oldDomain: string): string[] => [
  "What's your website?", "Who are you?", "What is the name of this company?", "Were you called something else before?",
  `Is this ${oldName}?`, "Give me the link to book a havan", `What is ${oldDomain}?`, "Who runs this site?",
  "How do I contact support?", "Tell me about your previous name",
];

export async function adminAiBrandGet(req: Request, env: Env): Promise<Response> {
  const a = await guard(req, env); if (a instanceof Response) return a;
  const out: AdminAiBrand = { current: await currentBrand(env), checklist: BRAND_CHECKLIST };
  return json(out);
}

export async function adminAiBrandChange(req: Request, env: Env): Promise<Response> {
  const a = await guard(req, env); if (a instanceof Response) return a;
  const b = await body(req);
  const name = str(b?.name).trim();
  const domain = str(b?.domain).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (name.length < 1 || name.length > 60) return err(400, "invalid_name", "The brand name must be 1 to 60 characters.");
  if (!HOST_RE.test(domain)) return err(400, "invalid_domain", "Enter a domain like example.com (no https:// or path).");

  // The new site must already be live and serving its knowledge index.
  let live = false;
  try {
    const r = await fetch(`https://${domain}/llms.txt`, { redirect: "follow", signal: AbortSignal.timeout(8000) });
    live = r.status === 200;
  } catch { live = false; }
  if (!live) return err(400, "domain_not_live", `https://${domain}/llms.txt did not answer. Point the domain at the site first, then try again.`);

  const before = await currentBrand(env);
  let after;
  try {
    after = await setBrand(env, { name, domain }, a.uid);
    await markFilesForBrandReview(env);
    await syncSiteKnowledge(env, { full: true });
  } catch (e) {
    await trackException(env, e, { uid: a.uid, route: "admin2_ai:brand_change", handled: true, app_name: APP });
    return err(500, "internal", "The change could not be completed. Check the brand and try again.");
  }

  const former = after.former.length ? after.former : [{ name: before.name, domain: before.domain }];
  const banned = former.flatMap((f) => [f.name, f.domain ?? ""]).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const questions = CHECK_QUESTIONS(before.name, before.domain);
  const answers = await Promise.allSettled(questions.map((q) => askPreetiOnce(env, q)));
  const check = questions.map((question, i) => {
    const r = answers[i];
    const answer = r.status === "fulfilled" ? String(r.value ?? "") : "";
    const pass = r.status === "fulfilled" && answer.trim().length > 0 && !banned.some((f) => answer.toLowerCase().includes(f));
    return { question, answer, pass };
  });
  for (let i = 0; i < answers.length; i++) {
    const r = answers[i];
    if (r.status === "rejected") await trackException(env, r.reason, { uid: a.uid, route: "admin2_ai:brand_check", handled: true, app_name: APP });
  }
  const ok = check.every((c) => c.pass);
  await track(env, a.uid, "preeti_brand_changed", APP, { new_domain: domain, checks_passed: check.filter((c) => c.pass).length, checks_total: check.length });
  const out: AdminAiBrandChangeResult = ok ? { ok, check } : { ok, error: "check_failed", check };
  return json(out);
}

// ---------------------------------------------------------------------------
// Spend
// ---------------------------------------------------------------------------
export async function adminAiSpend(req: Request, env: Env): Promise<Response> {
  const a = await guard(req, env); if (a instanceof Response) return a;
  const now = Date.now();
  const month = istMonth(now);
  const start = istMonthStartMs(now);
  const [cfg, spend, cap, msgs, convs] = await Promise.all([
    readConfig(env),
    env.DB_META.prepare("SELECT cost_micro_usd FROM ai_spend_months WHERE month=?1").bind(month).first<{ cost_micro_usd: number }>(),
    env.DB_META.prepare("SELECT monthly_cap_rupees FROM ai_agent_config WHERE id=1").first<{ monthly_cap_rupees: number }>(),
    env.DB_META.prepare("SELECT COUNT(*) AS n FROM ai_messages m JOIN ai_conversations c ON c.id=m.conversation_id WHERE m.role='visitor' AND c.is_test=0 AND m.created_at>=?1").bind(start).first<{ n: number }>(),
    env.DB_META.prepare("SELECT COUNT(*) AS n FROM ai_conversations WHERE is_test=0 AND created_at>=?1").bind(start).first<{ n: number }>(),
  ]);
  const rupees = (Number(spend?.cost_micro_usd ?? 0) / 1_000_000) * cfg.usdInrRate;
  const capR = Number(cap?.monthly_cap_rupees ?? 2000);
  const out: AdminAiSpend = {
    month, cost_rupees: Math.round(rupees * 100) / 100, cap_rupees: capR,
    pct: capR > 0 ? Math.round((rupees / capR) * 1000) / 10 : 0,
    messages: Number(msgs?.n ?? 0), conversations: Number(convs?.n ?? 0),
  };
  return json(out, 200, { "cache-control": "private, no-store" });
}

// ---------------------------------------------------------------------------
// Route table (spread into ADMIN2_ROUTES by routes/admin2.ts)
// ---------------------------------------------------------------------------
const P = (s: string) => new RegExp(`^/api/admin/v2/ai/${s}$`);
const BASE = "/api/admin/v2/ai";
export const ADMIN2_AI_ROUTES: Admin2RouteDef[] = [
  { method: "GET", path: `${BASE}/config`, handler: (req, env) => adminAiConfigGet(req, env) },
  { method: "PUT", path: `${BASE}/config`, handler: (req, env) => adminAiConfigPut(req, env) },
  { method: "POST", path: `${BASE}/avatar`, handler: (req, env) => adminAiAvatarUpload(req, env) },
  { method: "POST", path: `${BASE}/avatar/generate`, handler: (req, env) => adminAiAvatarGenerate(req, env) },
  { method: "GET", path: `${BASE}/prompts`, handler: (req, env) => adminAiPromptsList(req, env) },
  { method: "POST", path: `${BASE}/prompts`, handler: (req, env) => adminAiPromptCreate(req, env) },
  { method: "POST", path: P(`prompts/${ID}/publish`), handler: (req, env, [id]) => adminAiPromptPublish(req, env, id) },
  { method: "POST", path: `${BASE}/test-chat`, handler: (req, env) => adminAiTestChat(req, env) },
  { method: "GET", path: `${BASE}/files`, handler: (req, env) => adminAiFilesList(req, env) },
  { method: "POST", path: `${BASE}/files`, handler: (req, env) => adminAiFileUpload(req, env) },
  { method: "DELETE", path: P(`files/${ID}`), handler: (req, env, [id]) => adminAiFileDelete(req, env, id) },
  { method: "GET", path: `${BASE}/knowledge`, handler: (req, env) => adminAiKnowledgeList(req, env) },
  { method: "POST", path: `${BASE}/knowledge/sync`, handler: (req, env) => adminAiKnowledgeSync(req, env) },
  { method: "GET", path: `${BASE}/incidents`, handler: (req, env) => adminAiIncidentsList(req, env) },
  { method: "POST", path: `${BASE}/incidents`, handler: (req, env) => adminAiIncidentCreate(req, env) },
  { method: "DELETE", path: P(`incidents/${ID}`), handler: (req, env, [id]) => adminAiIncidentDelete(req, env, id) },
  { method: "GET", path: `${BASE}/conversations`, handler: (req, env) => adminAiConversationsList(req, env) },
  { method: "GET", path: P(`conversations/${ID}`), handler: (req, env, [id]) => adminAiConversationGet(req, env, id) },
  { method: "PATCH", path: P(`conversations/${ID}`), handler: (req, env, [id]) => adminAiConversationPatch(req, env, id) },
  // [SAATHUM-PREETI-1 review] util.ts CORS advertises no PATCH, so the browser uses PUT (same handler).
  { method: "PUT", path: P(`conversations/${ID}`), handler: (req, env, [id]) => adminAiConversationPatch(req, env, id) },
  { method: "GET", path: `${BASE}/brand`, handler: (req, env) => adminAiBrandGet(req, env) },
  { method: "POST", path: `${BASE}/brand/change`, handler: (req, env) => adminAiBrandChange(req, env) },
  { method: "GET", path: `${BASE}/spend`, handler: (req, env) => adminAiSpend(req, env) },
];
