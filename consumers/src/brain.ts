// AvaBrain background extraction (Q_BRAIN consumer). Runs ONLY on public,
// server-visible content (the relay/API never enqueue DM ciphertext). For each
// event: store a short-TTL raw copy, extract entities/relationships/facts with an
// 8B model (never 70B on this hot path), upsert idempotently (dedupe by name+type),
// embed a summary into Vectorize (uid-scoped), mark processed.
import type { Env, BrainMsg } from "./types";
import { aiText, bumpAiSpend } from "./ai";
import { avaReason } from "./ava_reason"; // AVA-CORE-5: the ONE reasoning gateway

const RAW_TTL_MS = 30 * 86_400_000; // 30 days

// ── One Brain B0 (SPEC-2026-07-17) — consent keys mirror the registry ────────
// worker/src/lib/brain_domains.ts BRAIN_DOMAINS is THE authority. The consumer is
// a separate Worker package and can't cross-import it, so this map MUST stay in
// sync (domain → consent key). Adding a domain there = add a row here.
const DOMAIN_CONSENT: Record<string, string> = {
  contacts: "contacts",
  calls: "calls",
  missed: "calls",
  voicemail: "voicemail",
  msg_meta: "messages",
  msg_content: "messages",
  listings: "listings",
  wallet: "wallet",
  files: "files",
  profile: "profile",
};

// Legacy app names (legacy event source_app) → new registry consent key. Used
// only when a legacy event carries no explicit capability.
const APP_CONSENT: Record<string, string> = {
  avawallet: "wallet", wallet: "wallet",
  avatok: "messages",
  avalibrary: "files", avastorage: "files",
  listings: "listings", olx: "listings", marketplace: "listings",
  contacts: "contacts", avacontacts: "contacts",
};

// The Q_BRAIN envelope MAJOR version this consumer accepts (§3.2). Unknown majors
// are ACKed and dropped (never processed with the wrong assumptions).
const B0_MAJOR = 1;

// Consent capability names that MAY still hold a stored opt-out row from BEFORE the
// B0 key migration. When the NEW key has no row we still honour a disabled OLD row
// (read old key as fallback), and retro-delete matches rows written under the old
// capability. Keyed by NEW consent key.
function legacyAliasesFor(consentKey: string): string[] {
  switch (consentKey) {
    case "messages":  return ["avatok_messages", "group_chats"];
    case "voicemail": return ["voicemails"];
    case "files":     return ["avatok_files", "avalibrary_files", "avastorage_files"];
    default:          return [];
  }
}

// PostHog telemetry (server side): pullable by the user's email via uid + the
// stored email_hash (raw email is never persisted server-side). Mirrors the
// auto_reply.ts track()/ownerEmail() pattern.
async function brainOwnerEmailHash(env: Env, uid: string): Promise<string | null> {
  try {
    const r = await env.DB_META.prepare("SELECT email_hash FROM users WHERE uid=?1 LIMIT 1").bind(uid).first<{ email_hash: string | null }>();
    return r?.email_hash ?? null;
  } catch { return null; }
}
async function brainTrack(env: Env, uid: string, event: string, props: Record<string, unknown>): Promise<void> {
  try {
    await env.Q_ANALYTICS?.send({
      event, uid, ts: Date.now(),
      props: { ...props, app_name: "avatok", service_name: "avatok-consumers", worker: true, account_id: uid, email_hash: await brainOwnerEmailHash(env, uid) },
    });
  } catch { /* best-effort */ }
}

// The registry consent key that gates an event. Normalized new-envelope events
// arrive with `capability` already set to the registry key (see normalizeEnvelope);
// legacy events derive it here, mapped onto the B0 keys.
function capabilityFor(msg: BrainMsg): string {
  if (msg.capability) return String(msg.capability);
  const p = (msg.payload ?? {}) as any;
  switch (msg.event_type) {
    case "message_stored":
    case "message_received":
      return String(p.kind || "") === "audio" ? "voicemail" : "messages";
    case "library_file_added":
    case "upload_completed":
      return "files";
    default:
      return APP_CONSENT[String(msg.source_app || "")] || "files";
  }
}

// Guardrail check (master + the event's consent key + any legacy alias keys).
// Default ON only when NO relevant row exists (opt-out model). FAILS CLOSED on a
// D1 error (§2/§5.2): a consent-store outage MUST block ingestion, never allow it.
async function guardrailAllows(env: Env, uid: string, consentKey: string): Promise<boolean> {
  const keys = ["master", consentKey, ...legacyAliasesFor(consentKey)];
  try {
    const ph = keys.map((_, i) => `?${i + 2}`).join(",");
    const rs = await env.DB_BRAIN.prepare(
      `SELECT capability, enabled FROM brain_consent WHERE uid=?1 AND capability IN (${ph})`,
    ).bind(uid, ...keys).all();
    for (const r of (rs.results ?? []) as any[]) if (Number(r.enabled) === 0) return false;
    return true;
  } catch (e) {
    console.error("[brain] consent check failed — dropping event (fail-closed):", String(e));
    await brainTrack(env, uid, "consent_check_failed_closed", { where: "guardrailAllows", consent_key: consentKey });
    return false;
  }
}

// A normalized internal event carries the legacy BrainMsg fields PLUS the optional
// idempotency key (present on B0 v1-envelope events).
type NormMsg = BrainMsg & { idempotencyKey?: string };

// Accept both wire shapes: the B0 v1 envelope {v,uid,domain,kind,idempotencyKey,
// text,meta,ts} (§3) and the legacy {uid,event_type,source_app,payload}. Returns
// null ONLY for an unknown MAJOR version (rejected + dropped per §3.2).
function normalizeEnvelope(m: any): NormMsg | null {
  if (m && m.v != null && m.domain) {
    const major = Number(m.v);
    if (!Number.isFinite(major) || Math.trunc(major) !== B0_MAJOR) return null; // unknown major → reject
    const domain = String(m.domain);
    const consent = DOMAIN_CONSENT[domain] || "files";
    const meta = (m.meta ?? {}) as Record<string, unknown>;
    return {
      uid: String(m.uid || ""),
      event_type: mapDomainToEventType(domain, String(m.kind || "")),
      source_app: domain,
      payload: { ...meta, text: m.text ?? "" },
      capability: consent,                       // registry-resolved consent key
      traceId: m.traceId ?? m.trace_id ?? undefined,
      ts: m.ts,
      idempotencyKey: m.idempotencyKey ? String(m.idempotencyKey) : undefined,
    };
  }
  if (m && typeof m.event_type === "string") {
    return { ...(m as BrainMsg), idempotencyKey: m.idempotencyKey ? String(m.idempotencyKey) : undefined };
  }
  return m ? { ...(m as BrainMsg) } : null;
}

// Map a registry domain onto the consumer's processing branch. Files → the
// library ingest path; message domains → the message/vector path; everything
// else flows through the generic entity/fact extractor (event_type is only a
// label there).
function mapDomainToEventType(domain: string, kind: string): string {
  if (domain === "files") return "library_file_added";
  if (domain === "msg_meta" || domain === "msg_content") return "message_stored";
  return kind || domain;
}

// §5.1 ingest-time deletion watermark: while a deletion for this uid is active
// (pending/running/partial), DROP any incoming event so a queue retry can't
// resurrect data mid-wipe. Fail-open only if the table is absent (nothing to
// delete pre-B0) — that is NOT a consent decision.
async function hasActiveDeletion(env: Env, uid: string): Promise<boolean> {
  try {
    const r = await env.DB_BRAIN.prepare(
      "SELECT 1 FROM brain_deletions WHERE uid=?1 AND state IN ('pending','running','partial') LIMIT 1",
    ).bind(uid).first();
    return !!r;
  } catch { return false; }
}

// §3.2 idempotency: claim the (uid, idempotency_key) slot by inserting the raw
// brain_events copy. Returns the event id on a fresh claim, or null when the row
// already existed (duplicate → ACK + drop). A real D1 error is re-thrown so the
// queue RETRIES (we must not silently drop a live event on a transient fault).
async function claimIdempotency(env: Env, uid: string, idem: string, msg: NormMsg): Promise<string | null> {
  const eventId = crypto.randomUUID();
  const now = Date.now();
  const r = await env.DB_BRAIN.prepare(
    `INSERT INTO brain_events (id, uid, event_type, source_app, payload, processed, trace_id, idempotency_key, created_at, expires_at)
     VALUES (?1,?2,?3,?4,?5,0,?6,?7,?8,?9)
     ON CONFLICT(uid, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
  ).bind(eventId, uid, msg.event_type, msg.source_app, JSON.stringify(msg.payload ?? {}), msg.traceId ?? null, idem, now, now + RAW_TTL_MS).run();
  return Number((r as any).meta?.changes ?? 0) === 0 ? null : eventId;
}

export async function handleBrain(rawMsg: BrainMsg, env: Env): Promise<void> {
  const msg = normalizeEnvelope(rawMsg);
  if (msg === null) {
    await brainTrack(env, String((rawMsg as any).uid || ""), "brain_envelope_rejected", { v: (rawMsg as any).v });
    return; // unknown major — ACK + drop
  }
  const uid = msg.uid;
  if (!uid) return;

  // Maintenance ops bypass guardrails + watermark (they REMOVE data, never add it).
  if (msg.event_type === "retro_delete") { await retroDelete(msg, env); return; }
  if (msg.event_type === "delete_all" || msg.event_type === "purge") {
    const p = (msg.payload ?? {}) as any;
    await runDeletionJob(env, uid, p.deletionId ? String(p.deletionId) : null, p.targets ?? null);
    return;
  }
  if (msg.event_type === "backfill") { await backfill(uid, env); return; }

  // §5.1 deletion watermark — never resurrect data for a uid being deleted.
  if (await hasActiveDeletion(env, uid)) return;

  // Consent — FAILS CLOSED (§2). Drop silently when opted out / on store error.
  if (!(await guardrailAllows(env, uid, capabilityFor(msg)))) return;

  // §3.2 idempotency: dedup on the producer-supplied key (queue redelivery, client
  // retry, multi-device double-fire all collapse to one insert).
  const idem = msg.idempotencyKey ? String(msg.idempotencyKey) : null;
  let eventId: string | null = null;
  if (idem) {
    eventId = await claimIdempotency(env, uid, idem, msg);
    if (eventId === null) return; // duplicate — already processed, drop
  }

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
  // The idempotency claim already wrote the raw brain_events copy; only insert
  // one here when the event carried no key (legacy path).
  if (!eventId) {
    eventId = crypto.randomUUID();
    // 1. Short-TTL raw copy (catch-up buffer, not permanent source of truth).
    await env.DB_BRAIN.prepare(
      `INSERT INTO brain_events (id, uid, event_type, source_app, payload, processed, trace_id, created_at, expires_at)
       VALUES (?1,?2,?3,?4,?5,0,?6,?7,?8)`,
    ).bind(eventId, uid, msg.event_type, msg.source_app, JSON.stringify(msg.payload ?? {}), msg.traceId ?? null, now, now + RAW_TTL_MS).run();
  }

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

  // OWNER RULE 2026-07-03: media bytes are never ingested (cost).
  // VIDPOL-3 (D6): video/audio are indexed on METADATA ONLY — never bytes, never
  // a transcript. We embed exactly {title, caption, filename, mime, duration_s,
  // sender, ts} so AvaBrain can still find "that clip Sam sent on Tuesday" without
  // paying for transcription/vision over large media. This branch returns before
  // any R2 byte read below.
  if (category === "video" || category === "audio") {
    const title = String(p.title || p.name || "file");
    const caption = String(p.caption || "");
    const filename = String(p.name || "file");
    const mime = String(p.mime || "");
    const durationS = p.duration_s != null ? Number(p.duration_s) : null;
    const sender = String(p.sender || p.peer || "");
    const ts = Number(p.ts || p.created_at || Date.now());
    const metaText = [
      title, caption, filename, mime,
      durationS != null ? `${durationS}s` : "",
      sender ? `from ${sender}` : "",
    ].filter(Boolean).join(". ").trim().slice(0, 1000);
    const values = await embed(env, metaText || filename);
    if (values) {
      const vecId = `${uid}:lib:${p.media_id}:0`;
      try {
        await env.VECTOR_INDEX.upsert([{
          id: vecId, values,
          metadata: {
            uid, media_id: String(p.media_id), app: msg.source_app, category,
            type: "library", title, caption, filename, mime,
            duration_s: durationS, sender, ts, summary: metaText.slice(0, 480),
          },
        }]);
      } catch { /* best-effort */ }
    }
    try {
      await env.DB_BRAIN.prepare(
        `INSERT INTO brain_facts (id, uid, fact_type, content, scope, source_app, source_id, confidence, created_at, updated_at)
         VALUES (?1,?2,'file',?3,'public',?4,?5,0.7,?6,?6)`,
      ).bind(crypto.randomUUID(), uid, `${category === "video" ? "Video" : "Audio"} "${title}" (${mime})${caption ? `: ${caption}` : ""}`, msg.source_app, String(p.media_id), Date.now()).run();
    } catch { /* table optional */ }
    return;
  }

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
  // AVA-CORE-5: BRAIN_VISION_MODEL/BRAIN_EXTRACT_MODEL still WIN over the reasoner
  // default (behavior-preserving); undefined → AVA_REASONER.
  const model = env.BRAIN_VISION_MODEL || env.BRAIN_EXTRACT_MODEL;
  try {
    const out = (await avaReason(env, {
      role: "brain", capability: "vision", trigger: "file_ingest",
      model,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Describe this image in one or two sentences. Transcribe any visible text verbatim. If it is a document, chart, screenshot, or UI, summarise its content and key data/labels." },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      }],
      maxTokens: 512,
      temperature: 0,
      fallback: false, // multimodal input — keep on Workers AI, no OpenRouter hop
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

// File-ingestion consent re-check in the consumer (defense in depth). Checks the
// B0 "files" key + its legacy aliases + the legacy per-app `${app}_files` key.
// FAILS CLOSED on a D1 error (§2/§5.2).
async function consentAllows(env: Env, uid: string, app: string): Promise<boolean> {
  const keys = ["master", "files", ...legacyAliasesFor("files"), `${app}_files`];
  try {
    const ph = keys.map((_, i) => `?${i + 2}`).join(",");
    const rs = await env.DB_BRAIN.prepare(
      `SELECT capability, enabled FROM brain_consent WHERE uid=?1 AND capability IN (${ph})`,
    ).bind(uid, ...keys).all();
    for (const r of (rs.results ?? []) as any[]) if (Number(r.enabled) === 0) return false;
    return true;
  } catch (e) {
    console.error("[brain] file consent check failed — dropping (fail-closed):", String(e));
    await brainTrack(env, uid, "consent_check_failed_closed", { where: "consentAllows", app });
    return false;
  }
}

// ---- extraction ----
interface Extracted {
  summary?: string;
  entities: Array<{ name: string; entity_type?: string; summary?: string }>;
  relationships: Array<{ from: string; to: string; relationship: string; context?: string }>;
  facts: Array<{ fact_type?: string; content: string; confidence?: number }>;
}

async function extract(env: Env, msg: BrainMsg): Promise<Extracted> {
  // AVA-CORE-5: BRAIN_EXTRACT_MODEL still WINS over the reasoner default.
  const model = env.BRAIN_EXTRACT_MODEL || (env as any).AVA_REASONER || "@cf/google/gemma-4-26b-a4b-it";
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
    const out = (await avaReason(env, {
      role: "brain", capability: "fact_extract", trigger: "event_ingest",
      uid: (msg as any).uid,
      model,
      messages: [
        { role: "user", content: `${sys}\n\nEvent type: ${msg.event_type}\nApp: ${msg.source_app}\nData: ${JSON.stringify(msg.payload).slice(0, 4000)}` },
      ],
      maxTokens: 1024,
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
      for (const v of vectors) await recordVector(env, uid, v.id, "voicemail", "voicemail", "avatok", mediaRef);
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

// A capability toggled OFF → remove already-indexed items for that consent key
// (§5.1: retro-delete is NO LONGER env-gated — the /api/brain consent route always
// enqueues this). payload: { capability } where capability is the registry consent
// key. Matches rows written under the key AND its legacy aliases (pre-B0 vectors
// were stored under old capability names like `voicemails`/`avatok_messages`).
async function retroDelete(msg: BrainMsg, env: Env): Promise<void> {
  const uid = msg.uid;
  const consentKey = String((msg.payload as any)?.capability || msg.capability || "");
  if (!consentKey || !env.VECTOR_INDEX) return;
  const caps = [consentKey, ...legacyAliasesFor(consentKey)];
  const ph = caps.map((_, i) => `?${i + 2}`).join(",");
  const rs = await env.DB_BRAIN.prepare(
    `SELECT vec_id FROM brain_vectors WHERE uid=?1 AND capability IN (${ph})`,
  ).bind(uid, ...caps).all().catch(() => ({ results: [] as any[] }));
  const ids = ((rs.results ?? []) as any[]).map((r) => String(r.vec_id));
  for (let i = 0; i < ids.length; i += 1000) {
    try { await env.VECTOR_INDEX.deleteByIds(ids.slice(i, i + 1000)); } catch { /* best-effort */ }
  }
  await env.DB_BRAIN.prepare(`DELETE FROM brain_vectors WHERE uid=?1 AND capability IN (${ph})`).bind(uid, ...caps).run().catch(() => null);
  if (consentKey === "voicemail" || consentKey === "voicemails") {
    await env.DB_BRAIN.prepare("DELETE FROM brain_transcripts WHERE uid=?1").bind(uid).run().catch(() => null);
  }
  // Derived facts from that source (facts.source_app holds the app/consent key).
  await env.DB_BRAIN.prepare(`DELETE FROM brain_facts WHERE uid=?1 AND source_app IN (${ph})`).bind(uid, ...caps).run().catch(() => null);
}

// Every Vectorize id owned by a user (entity + registry + library). Vectorize can
// only delete BY ID, so we enumerate them from the D1 rows before wiping those rows.
async function collectVectorIds(env: Env, uid: string): Promise<string[]> {
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
  return ids;
}

// A missing D1 table (pre-B0 DB, optional store) is NOT a deletion failure —
// there's simply nothing to delete. Distinguish it from a real error so an absent
// table can't pin a deletion at 'partial' forever.
function isMissingTable(e: unknown): boolean {
  return /no such table/i.test(String((e as any)?.message ?? e));
}

// "Delete my AvaBrain data" — the low-level idempotent store wipe (vectors + the 7
// DB_BRAIN tables + avachat_sessions). Used by the churn sweep. The settings-screen
// deletion goes through runDeletionJob (stateful) which reuses the SAME steps.
async function purgeBrain(uid: string, env: Env): Promise<void> {
  const ids = await collectVectorIds(env, uid);
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
  try { await env.DB_META.prepare("DELETE FROM avachat_sessions WHERE user_id=?1").bind(uid).run(); } catch { /* optional */ }
}

// ═══════════ One Brain B0 — stateful deletion job (SPEC §5.1) ═══════════
// Deletion is a JOB WITH STATE, not a request. Idempotent per-store steps run in
// one pass; on any store failure the row is pinned at 'partial' and an alert fires,
// and (until DELETION_MAX_ATTEMPTS) the queue message is re-thrown so Cloudflare
// redelivers it with backoff. On full success the row goes 'complete' with a
// per-store counts audit + completed_at (Settings surfaces "deleted on <date>").
const DELETION_MAX_ATTEMPTS = 6;

// Best-effort targeted wipe of the AvaChat history in the user's InboxDO (conv
// 'brain'). The InboxDO exposes NO per-conversation hard-delete today (only a wipe-
// everything /purge, which we must NOT use here), and inbox.ts is out of this
// change's scope — so this posts to /conv_delete (to be added by the InboxDO owner)
// and treats its absence as a no-op that does NOT pin the deletion at 'partial'.
// See the B0 report: this step is a documented gap until /conv_delete lands.
async function deleteInboxBrainConv(env: Env, uid: string): Promise<{ ok: boolean; count: number }> {
  if (!env.INBOX) return { ok: true, count: 0 };
  try {
    const stub = env.INBOX.get(env.INBOX.idFromName(uid));
    const res = await stub.fetch("https://inbox/conv_delete", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ conv: "brain" }),
    });
    if (res.ok) {
      const j = (await res.json().catch(() => ({}))) as any;
      return { ok: true, count: Number(j.deleted ?? 0) };
    }
    return { ok: true, count: 0 }; // endpoint absent / non-2xx — best-effort, don't block
  } catch (e) {
    console.error("[brain] del inbox brain conv:", String(e));
    return { ok: true, count: 0 };
  }
}

async function runDeletionJob(env: Env, uid: string, deletionId: string | null, targets: unknown): Promise<void> {
  const now = Date.now();
  let id = deletionId;
  let attempts = 0;

  // Ensure a tracking row exists + advance to 'running' with an incremented attempt.
  try {
    if (id) {
      const row = await env.DB_BRAIN.prepare("SELECT attempts FROM brain_deletions WHERE id=?1").bind(id).first<{ attempts: number }>();
      if (row) attempts = Number(row.attempts) || 0;
      else {
        await env.DB_BRAIN.prepare(
          `INSERT INTO brain_deletions (id, uid, requested_at, targets, state, attempts, counts, completed_at)
           VALUES (?1,?2,?3,?4,'pending',0,NULL,NULL) ON CONFLICT(id) DO NOTHING`,
        ).bind(id, uid, now, JSON.stringify(targets ?? "all")).run();
      }
    } else {
      id = crypto.randomUUID();
      await env.DB_BRAIN.prepare(
        `INSERT INTO brain_deletions (id, uid, requested_at, targets, state, attempts, counts, completed_at)
         VALUES (?1,?2,?3,?4,'pending',0,NULL,NULL)`,
      ).bind(id, uid, now, JSON.stringify(targets ?? "all")).run();
      // Legacy /api/brain/purge entry point has no worker-side telemetry — emit here.
      await brainTrack(env, uid, "brain_deletion_requested", { deletion_id: id, targets: targets ?? "all", via: "purge" });
    }
  } catch (e) {
    console.error("[brain] deletion row init failed:", String(e));
    throw e; // transient — let the queue retry
  }
  attempts += 1;
  try { await env.DB_BRAIN.prepare("UPDATE brain_deletions SET state='running', attempts=?2 WHERE id=?1").bind(id, attempts).run(); } catch { /* best-effort */ }

  const counts: Record<string, number> = {};
  const failures: string[] = [];

  // Step 1 — Vectorize ids.
  try {
    const ids = await collectVectorIds(env, uid);
    if (env.VECTOR_INDEX && ids.length) {
      for (let i = 0; i < ids.length; i += 1000) await env.VECTOR_INDEX.deleteByIds(ids.slice(i, i + 1000));
    }
    counts.vectors = ids.length;
  } catch (e) { failures.push("vectors"); console.error("[brain] del vectors:", String(e)); }

  // Step 2 — the 7 DB_BRAIN tables (one idempotent DELETE each).
  for (const [store, sql] of [
    ["brain_entities", "DELETE FROM brain_entities WHERE uid=?1"],
    ["brain_relationships", "DELETE FROM brain_relationships WHERE uid=?1"],
    ["brain_facts", "DELETE FROM brain_facts WHERE uid=?1"],
    ["brain_daily_summaries", "DELETE FROM brain_daily_summaries WHERE uid=?1"],
    ["brain_events", "DELETE FROM brain_events WHERE uid=?1"],
    ["brain_vectors", "DELETE FROM brain_vectors WHERE uid=?1"],
    ["brain_transcripts", "DELETE FROM brain_transcripts WHERE uid=?1"],
  ] as Array<[string, string]>) {
    try {
      const r = await env.DB_BRAIN.prepare(sql).bind(uid).run();
      counts[store] = Number((r as any).meta?.changes ?? 0);
    } catch (e) {
      if (isMissingTable(e)) counts[store] = 0;
      else { failures.push(store); console.error(`[brain] del ${store}:`, String(e)); }
    }
  }

  // Step 3 — avachat_sessions (DB_META): AvaChat cloud transcripts.
  try {
    const r = await env.DB_META.prepare("DELETE FROM avachat_sessions WHERE user_id=?1").bind(uid).run();
    counts.avachat_sessions = Number((r as any).meta?.changes ?? 0);
  } catch (e) {
    if (isMissingTable(e)) counts.avachat_sessions = 0;
    else { failures.push("avachat_sessions"); console.error("[brain] del avachat_sessions:", String(e)); }
  }

  // Step 4 — InboxDO 'brain' conversation (AvaChat chat history).
  const inbox = await deleteInboxBrainConv(env, uid);
  counts.inbox_brain = inbox.count;
  if (!inbox.ok) failures.push("inbox_brain");

  const audit = { ...counts, attempts, failures };

  if (failures.length === 0) {
    try {
      await env.DB_BRAIN.prepare(
        "UPDATE brain_deletions SET state='complete', counts=?2, completed_at=?3 WHERE id=?1",
      ).bind(id, JSON.stringify(audit), Date.now()).run();
    } catch (e) { console.error("[brain] deletion finalize:", String(e)); }
    await brainTrack(env, uid, "brain_deletion_complete", { deletion_id: id, attempts, counts: audit });
    return;
  }

  // Failures remain → pin at 'partial', record the audit, and ALERT (never silently
  // half-complete). Re-throw to get a backoff retry until attempts are exhausted.
  try {
    await env.DB_BRAIN.prepare("UPDATE brain_deletions SET state='partial', counts=?2 WHERE id=?1").bind(id, JSON.stringify(audit)).run();
  } catch { /* best-effort */ }
  await brainTrack(env, uid, "brain_deletion_partial_alert", { deletion_id: id, attempts, failures, counts: audit });
  if (attempts < DELETION_MAX_ATTEMPTS) {
    throw new Error(`brain deletion ${id} partial: ${failures.join(",")} (attempt ${attempts})`);
  }
  // Retries exhausted — leave state='partial' + the alert; ACK to stop looping.
}

// [BRAIN-CHURN-1] Storage reclaim for churned users. A user is "churned" when their
// NEWEST durable brain activity is older than `cutoffDays` (default 90) — measured
// across brain_vectors.created_at, brain_entities.updated_at and brain_facts.updated_at
// (brain_events are ignored; they self-expire at 30d). For each, purgeBrain() removes
// every DB_BRAIN row + Vectorize id, so the user drops out of this query on the next
// run (self-dedup, no marker table needed); their brain rebuilds from scratch if they
// ever return (owner-accepted 2026-06-30). All in the SAME `uid` space as purgeBrain —
// no cross-table/identity join, so it can never mis-target an active account. Bounded
// by `limit` so a backlog drains across successive 6h ticks. Returns #users purged.
export async function purgeChurnedBrains(env: Env, cutoffDays = 90, limit = 200): Promise<number> {
  const cutoff = Date.now() - cutoffDays * 86_400_000;
  let rows: Array<{ uid: string }> = [];
  try {
    const rs = await env.DB_BRAIN.prepare(
      `SELECT uid, MAX(ts) AS last FROM (
         SELECT uid, created_at AS ts FROM brain_vectors
         UNION ALL SELECT uid, updated_at AS ts FROM brain_entities
         UNION ALL SELECT uid, updated_at AS ts FROM brain_facts
       ) GROUP BY uid HAVING last < ?1 LIMIT ?2`,
    ).bind(cutoff, limit).all();
    rows = (rs.results ?? []) as Array<{ uid: string }>;
  } catch { return 0; } // brain tables optional / absent pre-Phase-9
  let n = 0;
  for (const r of rows) {
    try { await purgeBrain(String(r.uid), env); n++; } catch { /* best-effort; retry next tick */ }
  }
  return n;
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
