// AvaBrain background extraction (Q_BRAIN consumer). Runs ONLY on public,
// server-visible content (the relay/API never enqueue DM ciphertext). For each
// event: store a short-TTL raw copy, extract entities/relationships/facts with an
// 8B model (never 70B on this hot path), upsert idempotently (dedupe by name+type),
// embed a summary into Vectorize (uid-scoped), mark processed.
import type { Env, BrainMsg } from "./types";
import { aiText, bumpAiSpend } from "./ai";

const RAW_TTL_MS = 30 * 86_400_000; // 30 days

// Phase 9 — which guardrail capability gates an event. Producers may pass an
// explicit msg.capability; otherwise it's derived here. The AvaBrain settings
// screen renders exactly these keys (default ON / opt-out; rows only exist when
// the user changed something).
function capabilityFor(msg: BrainMsg): string {
  if (msg.capability) return String(msg.capability);
  const p = (msg.payload ?? {}) as any;
  switch (msg.event_type) {
    case "message_stored":
    case "message_received":
      if (String(p.kind || "") === "audio") return "voicemails";
      return p.group ? "group_chats" : "avatok_messages";
    case "library_file_added":
    case "upload_completed":
      return "files";
    default:
      // App-level toggle (avawallet, avacalendar, avapayout, …).
      return msg.source_app || "files";
  }
}

// Guardrail check (master + the event's capability). Default ON when no row
// exists (opt-out model). Fail-open on D1 error — consent rows are tiny.
async function guardrailAllows(env: Env, uid: string, capability: string): Promise<boolean> {
  try {
    const rs = await env.DB_BRAIN.prepare(
      "SELECT capability, enabled FROM brain_consent WHERE uid=?1 AND capability IN ('master',?2)",
    ).bind(uid, capability).all();
    for (const r of (rs.results ?? []) as any[]) if (Number(r.enabled) === 0) return false;
    return true;
  } catch { return true; }
}

export async function handleBrain(msg: BrainMsg, env: Env): Promise<void> {
  const uid = msg.uid;
  if (!uid) return;

  // Maintenance ops bypass guardrails (they REMOVE data, never add it).
  if (msg.event_type === "retro_delete") { await retroDelete(msg, env); return; }
  if (msg.event_type === "purge") { await purgeBrain(uid, env); return; }
  if (msg.event_type === "backfill") { await backfill(uid, env); return; }

  // Phase 9: EVERY ingestion event is guardrail-checked first (master + per-app
  // toggle). Drop silently when the user opted out.
  if (!(await guardrailAllows(env, uid, capabilityFor(msg)))) return;

  // Phase 9: messages + voice notes → retrievable vectors (RAG), not the
  // entity/fact extraction below (too high-volume for an LLM per message).
  if (msg.event_type === "message_stored" || msg.event_type === "message_received") {
    await ingestMessage(msg, env);
    return;
  }

  // AvaLibrary FILE content ingestion (public files only). Separate path: we
  // extract caption/OCR/text from the actual bytes and embed retrievable,
  // media_id-tagged chunks — not the entity/fact extraction below.
  if (msg.event_type === "library_file_added") {
    await ingestLibraryFile(msg, env);
    return;
  }

  const now = Date.now();
  const eventId = crypto.randomUUID();

  // 1. Short-TTL raw copy (catch-up buffer, not permanent source of truth).
  await env.DB_BRAIN.prepare(
    `INSERT INTO brain_events (id, uid, event_type, source_app, payload, processed, trace_id, created_at, expires_at)
     VALUES (?1,?2,?3,?4,?5,0,?6,?7,?8)`,
  ).bind(eventId, uid, msg.event_type, msg.source_app, JSON.stringify(msg.payload ?? {}), msg.traceId ?? null, now, now + RAW_TTL_MS).run();

  // 2. Extract structured memory (8B, JSON).
  const extracted = await extract(env, msg);

  // 3. Upsert entities (dedupe by uid+name+type) → name→id map.
  const idByName = new Map<string, string>();
  for (const e of extracted.entities) {
    if (!e.name) continue;
    const id = await upsertEntity(env, uid, e, now);
    idByName.set(e.name.toLowerCase(), id);
  }

  // 4. Upsert relationships (resolve names → ids; skip if either side unknown).
  for (const r of extracted.relationships) {
    const from = idByName.get((r.from || "").toLowerCase());
    const to = idByName.get((r.to || "").toLowerCase());
    if (!from || !to || !r.relationship) continue;
    await upsertRelationship(env, uid, from, to, r.relationship, r.context ?? null, now);
  }

  // 5. Insert facts (scope=public — server-derived).
  for (const f of extracted.facts) {
    if (!f.content) continue;
    await env.DB_BRAIN.prepare(
      `INSERT INTO brain_facts (id, uid, fact_type, content, scope, source_app, source_id, confidence, created_at, updated_at)
       VALUES (?1,?2,?3,?4,'public',?5,?6,?7,?8,?8)`,
    ).bind(crypto.randomUUID(), uid, f.fact_type || "insight", f.content, msg.source_app, eventId, clamp(f.confidence ?? 0.8), now).run();
  }

  // 6. (Embeddings are done per-ENTITY in upsertEntity — one bounded vector per
  //    person/project/place, updated in place — NOT one per event. This keeps both
  //    Vectorize and D1 bounded by entity count, and vector ids are derivable from
  //    the entity rows, so no separate vector-id table is needed.)

  // 7. Mark processed.
  await env.DB_BRAIN.prepare("UPDATE brain_events SET processed=1 WHERE id=?1").bind(eventId).run();
}

// ---- AvaLibrary file content ingestion (PUBLIC only) ----
// payload: { media_id, key, mime, size, name, category, visibility }. The bytes
// live in R2 (BLOBS, key = r2 path). We caption images, OCR/markdown documents,
// chunk the text, and embed each chunk into avatok-semantic tagged with media_id
// so AvaBrain can retrieve and deep-link the exact file. Private files NEVER reach
// here (the producer gates on visibility + consent; we re-check both as defense).
async function ingestLibraryFile(msg: BrainMsg, env: Env): Promise<void> {
  const uid = msg.uid;
  const p = (msg.payload ?? {}) as any;
  if (p.visibility && p.visibility !== "public") return;        // server ingests public only
  if (!(await consentAllows(env, uid, msg.source_app))) return; // opted out since enqueue
  if (!env.VECTOR_INDEX || !p.key || !p.media_id) return;

  const category = String(p.category || "other");
  const name = String(p.name || "file");
  let text = "";
  try {
    if (category === "image") {
      text = await captionImage(env, p.key);
    } else if (category === "document") {
      text = await extractDocument(env, p.key, String(p.mime || ""), name);
    }
    // audio/video transcription (Whisper) is a later phase; index the name for now.
  } catch { /* extraction best-effort */ }

  const base = `${name}. ${text}`.trim().slice(0, 8000);
  const chunks = chunkText(base, 480).slice(0, 8); // bounded vectors per file
  const md = { uid, media_id: String(p.media_id), app: msg.source_app, folder: p.folder ?? null, category, name, type: "library", summary: base.slice(0, 480) };
  const vectors = [];
  for (let i = 0; i < chunks.length; i++) {
    const values = await embed(env, chunks[i]);
    if (values) vectors.push({ id: `${uid}:lib:${p.media_id}:${i}`, values, metadata: { ...md, summary: chunks[i].slice(0, 480) } });
  }
  if (vectors.length) { try { await env.VECTOR_INDEX.upsert(vectors); } catch { /* best-effort */ } }

  // A retrievable fact so /api/brain ask surfaces it even before a vector hit.
  try {
    await env.DB_BRAIN.prepare(
      `INSERT INTO brain_facts (id, uid, fact_type, content, scope, source_app, source_id, confidence, created_at, updated_at)
       VALUES (?1,?2,'file',?3,'public',?4,?5,0.7,?6,?6)`,
    ).bind(crypto.randomUUID(), uid, `File "${name}" (${category}): ${base.slice(0, 300)}`, msg.source_app, String(p.media_id), Date.now()).run();
  } catch { /* table optional */ }
}

// Image → caption + OCR + chart/UI/document understanding, via GEMMA 4 vision
// (multimodal, 256K ctx, OCR/doc/chart/UI/detection). Unified onto Gemma 4 so
// the whole AvaBrain pipeline runs on ONE model. Bytes are passed as a base64
// data URL in the OpenAI-style messages format Gemma 4 accepts on Workers AI.
async function captionImage(env: Env, key: string): Promise<string> {
  const obj = await env.BLOBS.get(key);
  if (!obj) return "";
  const buf = await obj.arrayBuffer();
  const mime = obj.httpMetadata?.contentType || "image/jpeg";
  const dataUrl = `data:${mime};base64,${bytesToBase64(new Uint8Array(buf))}`;
  const model = env.BRAIN_VISION_MODEL || env.BRAIN_EXTRACT_MODEL || "@cf/google/gemma-4-26b-a4b-it";
  try {
    const out = (await env.AI.run(model as any, {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Describe this image in one or two sentences. Transcribe any visible text verbatim. If it is a document, chart, screenshot, or UI, summarise its content and key data/labels." },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      }],
      max_tokens: 512,
      temperature: 0,
    })) as any;
    return (aiText(out) || "").toString().slice(0, 2000);
  } catch { return ""; }
}

// base64-encode bytes in chunks (avoids call-stack limits on large buffers).
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// Document → markdown/text. Uses the AI binding's document-to-markdown conversion
// (handles pdf/docx/etc); falls back to UTF-8 decode for text/markdown.
async function extractDocument(env: Env, key: string, mime: string, name: string): Promise<string> {
  const obj = await env.BLOBS.get(key);
  if (!obj) return "";
  const buf = await obj.arrayBuffer();
  if (mime.startsWith("text/") || name.endsWith(".md") || name.endsWith(".txt")) {
    try { return new TextDecoder().decode(buf).slice(0, 8000); } catch { return ""; }
  }
  try {
    const blob = new Blob([buf], { type: mime || "application/octet-stream" });
    const md = await (env.AI as any).toMarkdown?.([{ name, blob }]);
    const first = Array.isArray(md) ? md[0] : md;
    return (first?.data || first?.markdown || "").toString().slice(0, 8000);
  } catch { return ""; }
}

function chunkText(s: string, size: number): string[] {
  const t = s.replace(/\s+/g, " ").trim();
  if (!t) return [];
  const out: string[] = [];
  for (let i = 0; i < t.length; i += size) out.push(t.slice(i, i + size));
  return out;
}

// Consent re-check in the consumer (defense in depth; default ON when absent).
async function consentAllows(env: Env, uid: string, app: string): Promise<boolean> {
  try {
    const rs = await env.DB_BRAIN.prepare(
      "SELECT capability, enabled FROM brain_consent WHERE uid=?1 AND capability IN ('master',?2)",
    ).bind(uid, `${app}_files`).all();
    for (const r of (rs.results ?? []) as any[]) if (Number(r.enabled) === 0) return false;
    return true;
  } catch { return true; }
}

// ---- extraction ----
interface Extracted {
  summary?: string;
  entities: Array<{ name: string; entity_type?: string; summary?: string }>;
  relationships: Array<{ from: string; to: string; relationship: string; context?: string }>;
  facts: Array<{ fact_type?: string; content: string; confidence?: number }>;
}

async function extract(env: Env, msg: BrainMsg): Promise<Extracted> {
  const model = env.BRAIN_EXTRACT_MODEL || "@cf/google/gemma-4-26b-a4b-it";
  const sys =
    "You extract structured memory from a single app event. Return ONLY minified JSON: " +
    `{"summary":string,"entities":[{"name":string,"entity_type":"person|project|company|place|task|goal|interest|event|community","summary":string}],` +
    `"relationships":[{"from":string,"to":string,"relationship":string,"context":string}],` +
    `"facts":[{"fact_type":"preference|habit|goal|deadline|decision|reminder|insight","content":string,"confidence":number}]}. ` +
    "Use [] when nothing applies. Do not invent details not present in the event.";
  const started = Date.now();
  try {
    // Single user message (sys + data): portable across models incl. Gemma 4,
    // whose chat template doesn't take a separate system role. max_tokens leaves
    // room for thinking-mode before the JSON. Parsed via aiText (choices/content).
    const out = (await env.AI.run(model as any, {
      messages: [
        { role: "user", content: `${sys}\n\nEvent type: ${msg.event_type}\nApp: ${msg.source_app}\nData: ${JSON.stringify(msg.payload).slice(0, 4000)}` },
      ],
      max_tokens: 1024,
      temperature: 0,
    })) as unknown;
    try { env.ANALYTICS?.writeDataPoint({ blobs: ["brain_extract", model], doubles: [Date.now() - started, 1], indexes: ["brain"] }); } catch { /* noop */ }
    await bumpAiSpend(env, Date.now() - started);
    return parseExtracted(aiText(out));
  } catch {
    return { entities: [], relationships: [], facts: [] };
  }
}

function parseExtracted(text: string): Extracted {
  const base: Extracted = { entities: [], relationships: [], facts: [] };
  const m = text.match(/\{[\s\S]*\}/); // first JSON object
  if (!m) return base;
  try {
    const j = JSON.parse(m[0]);
    return {
      summary: typeof j.summary === "string" ? j.summary : undefined,
      entities: Array.isArray(j.entities) ? j.entities : [],
      relationships: Array.isArray(j.relationships) ? j.relationships : [],
      facts: Array.isArray(j.facts) ? j.facts : [],
    };
  } catch { return base; }
}

// ---- idempotent upserts ----
async function upsertEntity(env: Env, uid: string, e: { name: string; entity_type?: string; summary?: string }, now: number): Promise<string> {
  const type = e.entity_type || "person";
  const existing = await env.DB_BRAIN.prepare(
    "SELECT id, importance, summary FROM brain_entities WHERE uid=?1 AND name=?2 AND entity_type=?3",
  ).bind(uid, e.name, type).first<{ id: string; importance: number; summary: string | null }>();
  let id: string;
  let needsEmbed = false;
  if (existing) {
    id = existing.id;
    const imp = Math.min(1, (existing.importance ?? 0.5) + 0.05); // interaction bump
    await env.DB_BRAIN.prepare(
      "UPDATE brain_entities SET summary=COALESCE(?2,summary), importance=?3, last_seen=?4, updated_at=?4 WHERE id=?1",
    ).bind(id, e.summary ?? null, imp, now).run();
    needsEmbed = !!e.summary && e.summary !== existing.summary; // re-embed only on real change
  } else {
    id = crypto.randomUUID();
    await env.DB_BRAIN.prepare(
      `INSERT INTO brain_entities (id, uid, entity_type, name, summary, metadata, scope, importance, first_seen, last_seen, updated_at)
       VALUES (?1,?2,?3,?4,?5,NULL,'public',0.5,?6,?6,?6)`,
    ).bind(id, uid, type, e.name, e.summary ?? null, now).run();
    needsEmbed = true;
  }
  // One vector PER ENTITY, deterministic id, updated in place (overwrite — no growth).
  // The id is derivable from the entity row, so deletion needs no separate map.
  if (needsEmbed && env.VECTOR_INDEX) {
    try {
      const values = await embed(env, `${e.name}. ${e.summary ?? ""}`.slice(0, 512));
      if (values) await env.VECTOR_INDEX.upsert([{ id: `${uid}:ent:${id}`, values, metadata: { uid, name: e.name, summary: (e.summary ?? "").slice(0, 480) } }]);
    } catch { /* embedding best-effort */ }
  }
  return id;
}

async function upsertRelationship(env: Env, uid: string, from: string, to: string, rel: string, context: string | null, now: number): Promise<void> {
  const existing = await env.DB_BRAIN.prepare(
    "SELECT id, strength FROM brain_relationships WHERE uid=?1 AND from_entity_id=?2 AND to_entity_id=?3 AND relationship=?4",
  ).bind(uid, from, to, rel).first<{ id: string; strength: number }>();
  if (existing) {
    await env.DB_BRAIN.prepare(
      "UPDATE brain_relationships SET strength=?2, context=COALESCE(?3,context), last_seen=?4 WHERE id=?1",
    ).bind(existing.id, Math.min(1, (existing.strength ?? 0.5) + 0.05), context, now).run();
    return;
  }
  await env.DB_BRAIN.prepare(
    `INSERT INTO brain_relationships (id, uid, from_entity_id, to_entity_id, relationship, strength, context, first_seen, last_seen)
     VALUES (?1,?2,?3,?4,?5,0.5,?6,?7,?7)`,
  ).bind(crypto.randomUUID(), uid, from, to, rel, context, now).run();
}

// ═══════════ Phase 9 — message / voicemail ingestion + RAG vectors ═══════════

// Record a vector id in the brain_vectors registry (enables retro-delete +
// purge — Vectorize can only delete by id, never by metadata filter).
async function recordVector(env: Env, uid: string, vecId: string, capability: string, kind: string, sourceApp: string, ref: string | null): Promise<void> {
  try {
    await env.DB_BRAIN.prepare(
      `INSERT OR REPLACE INTO brain_vectors (vec_id, uid, capability, kind, source_app, ref, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7)`,
    ).bind(vecId, uid, capability, kind, sourceApp, ref, Date.now()).run();
  } catch { /* registry best-effort (table from brain_phase9.sql) */ }
}

// Message stored/received → embed the text (or the Whisper transcript for a
// voice note) into Vectorize, uid-scoped, with deep-linkable metadata.
// payload: { conv, kind, body, media_ref, peer, group, created_at }
async function ingestMessage(msg: BrainMsg, env: Env): Promise<void> {
  const uid = msg.uid;
  const p = (msg.payload ?? {}) as any;
  if (!env.VECTOR_INDEX || !p.conv) return;
  const conv = String(p.conv);
  const ts = Number(p.created_at || Date.now());
  const peer = p.peer ? String(p.peer) : "";
  const capability = capabilityFor(msg);

  // Voice note / voice mail → Whisper transcription → kind=voicemail vectors.
  if (String(p.kind || "text") === "audio" && p.media_ref) {
    const mediaRef = String(p.media_ref);
    // Client-encrypted blobs (legacy E2E DM media) are unscannable ciphertext —
    // skip them; only server-readable voice notes get transcribed.
    try {
      const row = await env.DB_MEDIA.prepare("SELECT encrypted FROM user_media WHERE key=?1 LIMIT 1").bind(mediaRef).first<{ encrypted: number }>();
      if (row && Number(row.encrypted) === 1) return;
    } catch { /* lookup best-effort */ }
    const transcript = await transcribeVoice(env, mediaRef);
    if (!transcript) return; // no key / fetch failed — nothing to index
    try {
      await env.DB_BRAIN.prepare(
        `INSERT OR REPLACE INTO brain_transcripts (uid, media_ref, conv, transcript, created_at)
         VALUES (?1,?2,?3,?4,?5)`,
      ).bind(uid, mediaRef, conv, transcript.slice(0, 8000), ts).run();
    } catch { /* table from brain_phase9.sql */ }
    const chunks = chunkText(transcript, 480).slice(0, 8);
    const md = { uid, kind: "voicemail", app: "avatok", conv, media_ref: mediaRef, peer, ts, type: "voicemail" };
    const vectors = [] as any[];
    for (let i = 0; i < chunks.length; i++) {
      const values = await embed(env, chunks[i]);
      if (values) vectors.push({ id: `${uid}:vm:${mediaRef}:${i}`, values, metadata: { ...md, snippet: chunks[i].slice(0, 480) } });
    }
    if (vectors.length) {
      try { await env.VECTOR_INDEX.upsert(vectors); } catch { return; }
      for (const v of vectors) await recordVector(env, uid, v.id, "voicemails", "voicemail", "avatok", mediaRef);
    }
    return;
  }

  // Text message → one bounded vector (snippet keeps the answerable content).
  const body = String(p.body || "").trim();
  if (!body) return;
  const values = await embed(env, body.slice(0, 512));
  if (!values) return;
  const vecId = `${uid}:msg:${conv}:${ts}`;
  try {
    await env.VECTOR_INDEX.upsert([{
      id: vecId, values,
      metadata: { uid, kind: "message", app: "avatok", conv, peer, ts, snippet: body.slice(0, 480), type: "message" },
    }]);
  } catch { return; }
  await recordVector(env, uid, vecId, capability, "message", "avatok", conv);
}

// Whisper transcription of a voice note in R2. Prefers OpenAI when
// OPENAI_API_KEY is set; otherwise falls back to Workers AI
// (@cf/openai/whisper) on the existing AI binding — no external key needed.
async function transcribeVoice(env: Env, mediaRef: string): Promise<string> {
  const obj = await env.BLOBS.get(mediaRef).catch(() => null);
  if (!obj) return "";
  const buf = await obj.arrayBuffer();
  if (buf.byteLength > 24_000_000) return ""; // Whisper hard limit ~25 MB
  if (env.OPENAI_API_KEY) {
    const mime = obj.httpMetadata?.contentType || "audio/mp4";
    const form = new FormData();
    form.append("file", new File([buf], "voice.m4a", { type: mime }));
    form.append("model", "whisper-1");
    try {
      const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
        body: form,
      });
      if (!res.ok) return "";
      const j = (await res.json()) as any;
      try { env.ANALYTICS?.writeDataPoint({ blobs: ["brain_whisper"], doubles: [buf.byteLength], indexes: ["brain"] }); } catch { /* noop */ }
      return String(j.text || "").trim();
    } catch { return ""; }
  }
  // Workers AI fallback (Whisper large file support varies; voice notes are short)
  try {
    const r = (await (env as any).AI.run("@cf/openai/whisper", {
      audio: [...new Uint8Array(buf)],
    })) as any;
    try { env.ANALYTICS?.writeDataPoint({ blobs: ["brain_whisper_cf"], doubles: [buf.byteLength], indexes: ["brain"] }); } catch { /* noop */ }
    return String(r?.text || "").trim();
  } catch { return ""; }
}

// Guardrail toggled OFF with BRAIN_RETRO_DELETE → remove already-indexed items
// for that capability. payload: { capability }
async function retroDelete(msg: BrainMsg, env: Env): Promise<void> {
  const uid = msg.uid;
  const capability = String((msg.payload as any)?.capability || msg.capability || "");
  if (!capability || !env.VECTOR_INDEX) return;
  const rs = await env.DB_BRAIN.prepare(
    "SELECT vec_id, kind, ref FROM brain_vectors WHERE uid=?1 AND capability=?2",
  ).bind(uid, capability).all().catch(() => ({ results: [] as any[] }));
  const rows = (rs.results ?? []) as any[];
  const ids = rows.map((r) => String(r.vec_id));
  for (let i = 0; i < ids.length; i += 1000) {
    try { await env.VECTOR_INDEX.deleteByIds(ids.slice(i, i + 1000)); } catch { /* best-effort */ }
  }
  await env.DB_BRAIN.prepare("DELETE FROM brain_vectors WHERE uid=?1 AND capability=?2").bind(uid, capability).run().catch(() => null);
  if (capability === "voicemails") {
    await env.DB_BRAIN.prepare("DELETE FROM brain_transcripts WHERE uid=?1").bind(uid).run().catch(() => null);
  }
  // App-level toggles also drop derived facts from that app.
  await env.DB_BRAIN.prepare("DELETE FROM brain_facts WHERE uid=?1 AND source_app=?2").bind(uid, capability).run().catch(() => null);
}

// "Delete my AvaBrain data" — wipe ALL brain stores + vectors for the user
// (account itself stays; this is the settings-screen button, not GDPR deletion).
async function purgeBrain(uid: string, env: Env): Promise<void> {
  const ids: string[] = [];
  try {
    const er = await env.DB_BRAIN.prepare("SELECT id FROM brain_entities WHERE uid=?1").bind(uid).all();
    for (const r of (er.results ?? []) as any[]) ids.push(`${uid}:ent:${r.id}`);
  } catch { /* empty */ }
  try {
    const vr = await env.DB_BRAIN.prepare("SELECT vec_id FROM brain_vectors WHERE uid=?1").bind(uid).all();
    for (const r of (vr.results ?? []) as any[]) ids.push(String(r.vec_id));
  } catch { /* empty */ }
  try {
    const lr = await env.DB_MEDIA.prepare("SELECT DISTINCT id FROM user_media WHERE uid=?1").bind(uid).all();
    for (const r of (lr.results ?? []) as any[]) for (let i = 0; i < 8; i++) ids.push(`${uid}:lib:${r.id}:${i}`);
  } catch { /* empty */ }
  if (env.VECTOR_INDEX) {
    for (let i = 0; i < ids.length; i += 1000) {
      try { await env.VECTOR_INDEX.deleteByIds(ids.slice(i, i + 1000)); } catch { /* best-effort */ }
    }
  }
  for (const q of [
    "DELETE FROM brain_entities WHERE uid=?1",
    "DELETE FROM brain_relationships WHERE uid=?1",
    "DELETE FROM brain_facts WHERE uid=?1",
    "DELETE FROM brain_daily_summaries WHERE uid=?1",
    "DELETE FROM brain_events WHERE uid=?1",
    "DELETE FROM brain_vectors WHERE uid=?1",
    "DELETE FROM brain_transcripts WHERE uid=?1",
  ]) { try { await env.DB_BRAIN.prepare(q).bind(uid).run(); } catch { /* table optional */ } }
}

// Admin-triggered backfill: re-index the user's existing PUBLIC library files
// (bounded). Messages live in InboxDO and flow in as they're sent — the backfill
// covers the static file history, guardrails respected via the normal path.
async function backfill(uid: string, env: Env): Promise<void> {
  if (!(await guardrailAllows(env, uid, "files"))) return;
  try {
    const rs = await env.DB_MEDIA.prepare(
      "SELECT id, key, mime_type, size_bytes, file_name, category FROM user_media WHERE uid=?1 AND visibility='public' AND moderation_status='live' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 200",
    ).bind(uid).all();
    for (const r of (rs.results ?? []) as any[]) {
      await ingestLibraryFile({
        uid, event_type: "library_file_added", source_app: "avalibrary",
        payload: { media_id: r.id, key: r.key, mime: r.mime_type, size: r.size_bytes, name: r.file_name, category: r.category, visibility: "public" },
      }, env);
    }
  } catch { /* columns may differ; backfill best-effort */ }
}

async function embed(env: Env, text: string): Promise<number[] | null> {
  const model = env.BRAIN_EMBED_MODEL || "@cf/baai/bge-small-en-v1.5";
  const out = (await env.AI.run(model as any, { text })) as unknown as { data?: number[][] };
  return out.data?.[0] ?? null;
}

function clamp(n: number): number { return Math.max(0, Math.min(1, Number(n) || 0)); }
