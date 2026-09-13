// [AGENT-LIVE-1] Admin CRUD + KB ingest (RAG) + test-call + voices list.
// Specs/SPEC-2026-09-12-AGENT-LIVE-1-BUILD.md §1 (D1 schema), §3 ("Admin
// (requireAgentAdmin)"), §9 (WS-C ownership), §11 M11 ("Admin payloads").
//
// Every handler here is gated by requireAgentAdmin (D2 — the sole agent admin,
// never an allowlist). Creating/editing an agent listing NEVER goes through
// the generic `routes/listings.ts` create/update pipeline (M6 closes that
// bypass at the listings.ts end) — this file owns the whole lifecycle: the
// `listings` row + `agent_live_agents` row are written together in one D1
// batch at create, and PATCH/publish keep the two in sync.
import type { Env } from "../../types";
import { json } from "../../util";
import { requireAgentAdmin, slotMinutesFrom } from "../../lib/agent_live/gate";
import {
  AGENT_LIVE_VOICES,
  AGENT_LIVE_POLICY_VERSION,
  MAX_KB_FILE_BYTES,
  MAX_KB_FILES,
  type AgentVoiceId,
  type AgentLiveHandler,
} from "../../lib/agent_live/types";
import { metaDb } from "../../db/shard";
import { readConfig, type PlatformConfig } from "../config";
import { track } from "../../hooks";
import { LISTING_DEFAULT_CURRENCY, ftsSync, fanout } from "../listings";
import {
  createVectorStore,
  uploadOpenAIFile,
  addFileToVectorStore,
  getVectorStoreFileStatus,
  removeFileFromVectorStore,
  deleteOpenAIFile,
} from "../../lib/agent_live/openai_files";
// [AGENT-LIVE-1] WS-B's typed seat-authority client. Signatures per BUILD
// SPEC §4 (RPC contract) and §9 (WS-C dependency note): reserveProvisional /
// confirm (test-call, below) and nextFreeStart / freeStarts (public.ts).
// This file does not implement the DO — it only calls the client WS-B owns.
import { seatAuthority } from "../../lib/agent_live/seats";

const APP = "agent_live_admin";

// ---------------------------------------------------------------------------
// Field limits (M11 "text lengths"). Chosen to match the generic listings
// pipeline's comparable caps (title/description) where one exists, sized down
// for the agent-specific prompt fields.
// ---------------------------------------------------------------------------
const TITLE_MAX = 120;
const BLURB_MAX = 200;
const DESCRIPTION_MAX = 8000;
const GREETING_MAX = 500;
const INSTRUCTIONS_MAX = 6000;
const BACKEND_INSTRUCTIONS_MAX = 6000;
const IMAGE_INSTRUCTIONS_MAX = 2000;
const CATEGORY_MAX = 40;
const PERSONA_KIND_MAX = 40;
const LANGUAGE_MAX = 20;
const DEFAULT_CATEGORY = "ai_companion";

/** Persona fields whose change bumps `agent_live_agents.persona_version`
 *  (M11 "PATCH bumps persona_version when persona fields change"). */
const PERSONA_FIELDS = [
  "persona_kind",
  "voice",
  "language",
  "greeting",
  "instructions",
  "backend_instructions",
  "image_instructions",
] as const;

// ---------------------------------------------------------------------------
// Body validation — shared by create (all `required`) and patch (none
// required; only keys actually present in the body are validated/applied).
// ---------------------------------------------------------------------------
interface ValidatedAgentFields {
  title?: string;
  blurb?: string | null;
  description?: string | null;
  category?: string;
  cover_media?: unknown[] | null;
  persona_kind?: string;
  voice?: AgentVoiceId;
  language?: string;
  greeting?: string | null;
  instructions?: string;
  backend_instructions?: string;
  image_instructions?: string;
  price_per_min?: number;
  slot_minutes?: number[];
  max_concurrent?: number;
  image_reading?: 0 | 1;
  memory_enabled?: 0 | 1;
  adults_only?: 0 | 1;
}

type ValidateResult =
  | { ok: true; v: ValidatedAgentFields }
  | { ok: false; error: string; field: string };

function validateAgentBody(cfg: PlatformConfig, b: any, required: readonly string[]): ValidateResult {
  const v: ValidatedAgentFields = {};
  const has = (k: string) => b != null && typeof b === "object" && Object.prototype.hasOwnProperty.call(b, k);

  for (const k of required) if (!has(k)) return { ok: false, error: `${k} is required`, field: k };

  if (has("title")) {
    const t = String(b.title ?? "").trim();
    if (!t || t.length > TITLE_MAX) return { ok: false, error: `title must be 1-${TITLE_MAX} characters`, field: "title" };
    v.title = t;
  }
  if (has("blurb")) {
    const t = b.blurb == null ? null : String(b.blurb);
    if (t !== null && t.length > BLURB_MAX) return { ok: false, error: `blurb must be at most ${BLURB_MAX} characters`, field: "blurb" };
    v.blurb = t;
  }
  if (has("description")) {
    const t = b.description == null ? null : String(b.description);
    if (t !== null && t.length > DESCRIPTION_MAX) {
      return { ok: false, error: `description must be at most ${DESCRIPTION_MAX} characters`, field: "description" };
    }
    v.description = t;
  }
  if (has("category")) {
    const t = String(b.category ?? "").trim() || DEFAULT_CATEGORY;
    if (t.length > CATEGORY_MAX) return { ok: false, error: `category must be at most ${CATEGORY_MAX} characters`, field: "category" };
    v.category = t;
  }
  if (has("cover_media")) {
    if (b.cover_media != null && !Array.isArray(b.cover_media)) {
      return { ok: false, error: "cover_media must be an array", field: "cover_media" };
    }
    v.cover_media = b.cover_media ?? null;
  }
  if (has("persona_kind")) {
    const t = String(b.persona_kind ?? "").trim();
    if (!t || t.length > PERSONA_KIND_MAX) {
      return { ok: false, error: `persona_kind must be 1-${PERSONA_KIND_MAX} characters`, field: "persona_kind" };
    }
    v.persona_kind = t;
  }
  if (has("voice")) {
    const id = String(b.voice ?? "");
    if (!AGENT_LIVE_VOICES.some((x) => x.id === id)) {
      return { ok: false, error: "voice must be one of the published voice ids", field: "voice" };
    }
    v.voice = id as AgentVoiceId;
  }
  if (has("language")) {
    const t = String(b.language ?? "auto").trim() || "auto";
    if (t.length > LANGUAGE_MAX) return { ok: false, error: `language must be at most ${LANGUAGE_MAX} characters`, field: "language" };
    v.language = t;
  }
  if (has("greeting")) {
    const t = b.greeting == null ? null : String(b.greeting);
    if (t !== null && t.length > GREETING_MAX) return { ok: false, error: `greeting must be at most ${GREETING_MAX} characters`, field: "greeting" };
    v.greeting = t;
  }
  if (has("instructions")) {
    const t = String(b.instructions ?? "").trim();
    if (!t || t.length > INSTRUCTIONS_MAX) {
      return { ok: false, error: `instructions must be 1-${INSTRUCTIONS_MAX} characters`, field: "instructions" };
    }
    v.instructions = t;
  }
  if (has("backend_instructions")) {
    const t = String(b.backend_instructions ?? "");
    if (t.length > BACKEND_INSTRUCTIONS_MAX) {
      return { ok: false, error: `backend_instructions must be at most ${BACKEND_INSTRUCTIONS_MAX} characters`, field: "backend_instructions" };
    }
    v.backend_instructions = t;
  }
  if (has("image_instructions")) {
    const t = String(b.image_instructions ?? "");
    if (t.length > IMAGE_INSTRUCTIONS_MAX) {
      return { ok: false, error: `image_instructions must be at most ${IMAGE_INSTRUCTIONS_MAX} characters`, field: "image_instructions" };
    }
    v.image_instructions = t;
  }
  if (has("price_per_min")) {
    const n = Math.trunc(Number(b.price_per_min));
    if (!Number.isFinite(n) || n < cfg.agentMinPricePerMin) {
      return { ok: false, error: `price_per_min must be an integer >= ${cfg.agentMinPricePerMin}`, field: "price_per_min" };
    }
    v.price_per_min = n;
  }
  if (has("slot_minutes")) {
    const allowed = new Set(slotMinutesFrom(cfg));
    const rawSlot: unknown = b.slot_minutes;
    const arr: number[] | null = Array.isArray(rawSlot) ? rawSlot.map((n: unknown) => Math.trunc(Number(n))) : null;
    if (!arr || !arr.length || arr.some((n) => !allowed.has(n))) {
      return { ok: false, error: `slot_minutes must be a non-empty subset of ${[...allowed].join(",")}`, field: "slot_minutes" };
    }
    v.slot_minutes = Array.from(new Set(arr)).sort((a, b2) => a - b2);
  }
  if (has("max_concurrent")) {
    const n = Math.trunc(Number(b.max_concurrent));
    if (!Number.isFinite(n) || n < 1 || n > 50) return { ok: false, error: "max_concurrent must be an integer 1-50", field: "max_concurrent" };
    v.max_concurrent = n;
  }
  if (has("image_reading")) v.image_reading = b.image_reading ? 1 : 0;
  if (has("memory_enabled")) v.memory_enabled = b.memory_enabled ? 1 : 0;
  if (has("adults_only")) v.adults_only = b.adults_only ? 1 : 0;

  return { ok: true, v };
}

// ---------------------------------------------------------------------------
// Small local helpers (deliberately NOT imported from routes/listings.ts —
// this file owns its own slug/JSON-column plumbing so it does not depend on
// listings.ts internals beyond the two exported helpers above).
// ---------------------------------------------------------------------------
function slugify(title: string): string {
  const base = String(title || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "agent";
}

function parseJsonArray(raw: unknown): unknown[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function parseSlotMinutes(raw: unknown): number[] {
  return String(raw ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const ALLOWED_KB_EXT: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i + 1).toLowerCase();
}

/** `%PDF-` magic bytes. */
function looksLikePdf(head: Uint8Array): boolean {
  return head.length >= 5 && String.fromCharCode(head[0], head[1], head[2], head[3], head[4]) === "%PDF-";
}
/** Local-file-header zip signature — DOCX is a zip container. Not a perfect
 *  DOCX check (any zip matches), but combined with the `.docx` extension gate
 *  it catches the common "renamed random file" mistake. */
function looksLikeZip(head: Uint8Array): boolean {
  return head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadKbFiles(env: Env, agentId: string): Promise<any[]> {
  const rs = await metaDb(env)
    .prepare(
      `SELECT id, name, mime, bytes, status, error, created_at, updated_at
         FROM agent_live_kb_files WHERE agent_id=?1 AND status<>'deleted' ORDER BY created_at DESC`,
    )
    .bind(agentId)
    .all();
  return ((rs.results ?? []) as any[]).map((r) => ({
    id: r.id,
    name: r.name,
    mime: r.mime,
    bytes: Number(r.bytes),
    status: r.status,
    error: r.error ?? null,
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
  }));
}

async function loadAgentFull(env: Env, id: string): Promise<{ listing: any; agent: any; kb: any[] } | null> {
  const listing = await metaDb(env).prepare("SELECT * FROM listings WHERE id=?1 AND kind='agent'").bind(id).first<any>();
  if (!listing) return null;
  const agent = await metaDb(env).prepare("SELECT * FROM agent_live_agents WHERE listing_id=?1").bind(id).first<any>();
  if (!agent) return null;
  const kb = await loadKbFiles(env, id);
  return {
    listing: {
      id: listing.id,
      title: listing.title,
      blurb: listing.blurb ?? null,
      description: listing.description ?? null,
      category: listing.category,
      price: Number(listing.price),
      currency_display: listing.currency_display,
      adults_only: !!listing.adults_only,
      cover_media: parseJsonArray(listing.cover_media),
      status: listing.status,
      section: listing.section,
      created_at: Number(listing.created_at),
      updated_at: Number(listing.updated_at),
    },
    agent: {
      listing_id: agent.listing_id,
      persona_kind: agent.persona_kind,
      voice: agent.voice,
      language: agent.language,
      greeting: agent.greeting ?? null,
      instructions: agent.instructions,
      backend_instructions: agent.backend_instructions ?? "",
      image_instructions: agent.image_instructions ?? "",
      live_model: agent.live_model,
      backend_model: agent.backend_model,
      price_per_min: Number(agent.price_per_min),
      slot_minutes: parseSlotMinutes(agent.slot_minutes),
      max_concurrent: Number(agent.max_concurrent),
      image_reading: !!agent.image_reading,
      memory_enabled: !!agent.memory_enabled,
      adults_only: !!agent.adults_only,
      vector_store_id: agent.vector_store_id ?? null,
      persona_version: Number(agent.persona_version),
    },
    kb,
  };
}

// ---------------------------------------------------------------------------
// GET /api/agents/admin/list
// ---------------------------------------------------------------------------
export const agentAdminList: AgentLiveHandler = async (req, env) => {
  const gated = await requireAgentAdmin(req, env);
  if (gated instanceof Response) return gated;

  const rs = await metaDb(env)
    .prepare(
      `SELECT l.id AS listing_id, l.title, l.status, l.price, l.adults_only, l.cover_media, l.updated_at,
              a.voice, a.persona_kind, a.max_concurrent, a.persona_version,
              (SELECT COUNT(*) FROM agent_live_kb_files k WHERE k.agent_id=l.id AND k.status<>'deleted') AS kb_count
         FROM listings l JOIN agent_live_agents a ON a.listing_id=l.id
        WHERE l.kind='agent'
        ORDER BY l.updated_at DESC`,
    )
    .all();
  const rows = (rs.results ?? []) as any[];
  return json({
    agents: rows.map((r) => ({
      listing_id: r.listing_id,
      title: r.title,
      status: r.status,
      price_per_min: Number(r.price),
      adults_only: !!r.adults_only,
      cover_media: parseJsonArray(r.cover_media),
      voice: r.voice,
      persona_kind: r.persona_kind,
      max_concurrent: Number(r.max_concurrent),
      persona_version: Number(r.persona_version),
      kb_count: Number(r.kb_count ?? 0),
      updated_at: Number(r.updated_at),
    })),
  });
};

// ---------------------------------------------------------------------------
// POST /api/agents/admin — create listing + agent_live_agents in one batch
// ---------------------------------------------------------------------------
const CREATE_REQUIRED = ["title", "persona_kind", "voice", "instructions", "price_per_min", "slot_minutes", "max_concurrent"] as const;

export const agentAdminCreate: AgentLiveHandler = async (req, env) => {
  const gated = await requireAgentAdmin(req, env);
  if (gated instanceof Response) return gated;
  const { uid } = gated;

  const cfg = await readConfig(env);
  const b = (await req.json().catch(() => ({}))) as any;
  const val = validateAgentBody(cfg, b, CREATE_REQUIRED);
  if (!val.ok) {
    track(env, uid, "agent_admin_create", APP, { outcome: "invalid", field: val.field, error: val.error });
    return json({ error: val.error, field: val.field }, 400);
  }
  const v = val.v;
  const id = crypto.randomUUID();
  const now = Date.now();
  const category = v.category ?? DEFAULT_CATEGORY;
  const coverMedia = v.cover_media ? JSON.stringify(v.cover_media) : null;
  const slug = `${slugify(v.title!)}-${id.slice(0, 8)}`;

  try {
    await metaDb(env).batch([
      metaDb(env)
        .prepare(
          `INSERT INTO listings (
             id, creator_id, kind, title, description, category, price, currency_display,
             country, adults_only, badges, cover_media, starts_at, duration_min, capacity, status,
             created_at, updated_at, vertical, section, slug, blurb, schedule_mode, billing_unit,
             media_mode, cat_version, playbook_version, template_version, attrs
           ) VALUES (
             ?1,?2,'agent',?3,?4,?5,?6,?7,
             NULL,?8,NULL,?9,NULL,NULL,NULL,'draft',
             ?10,?10,'commerce','ai_voice_agents',?11,?12,'always_on','minute',
             'audio_only',1,1,1,?13
           )`,
        )
        .bind(id, uid, v.title, v.description ?? null, category, v.price_per_min, LISTING_DEFAULT_CURRENCY, v.adults_only ?? 0, coverMedia, now, slug, v.blurb ?? null,
          JSON.stringify({ slot_minutes: v.slot_minutes, price_per_min: v.price_per_min, persona_kind: v.persona_kind })),
      metaDb(env)
        .prepare(
          `INSERT INTO agent_live_agents (
             listing_id, owner_uid, persona_kind, voice, language, greeting, instructions,
             backend_instructions, image_instructions, price_per_min, slot_minutes, max_concurrent,
             image_reading, memory_enabled, adults_only, persona_version, created_at, updated_at
           ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,1,?16,?16)`,
        )
        .bind(
          id,
          uid,
          v.persona_kind,
          v.voice,
          v.language ?? "auto",
          v.greeting ?? null,
          v.instructions,
          v.backend_instructions ?? "",
          v.image_instructions ?? "",
          v.price_per_min,
          v.slot_minutes!.join(","),
          v.max_concurrent,
          v.image_reading ?? 1,
          v.memory_enabled ?? 1,
          v.adults_only ?? 0,
          now,
        ),
    ]);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    track(env, uid, "agent_admin_create", APP, { outcome: "error", error: message });
    return json({ error: "create_failed", message }, 500);
  }

  track(env, uid, "agent_admin_create", APP, { outcome: "ok", listing_id: id });
  return json({ listing_id: id });
};

// ---------------------------------------------------------------------------
// GET /api/agents/admin/:id
// ---------------------------------------------------------------------------
export const agentAdminGet: AgentLiveHandler = async (req, env, _ctx, params) => {
  const gated = await requireAgentAdmin(req, env);
  if (gated instanceof Response) return gated;
  const full = await loadAgentFull(env, params.id);
  if (!full) return json({ error: "not found" }, 404);
  return json(full);
};

// ---------------------------------------------------------------------------
// PATCH /api/agents/admin/:id
// ---------------------------------------------------------------------------
export const agentAdminPatch: AgentLiveHandler = async (req, env, _ctx, params) => {
  const gated = await requireAgentAdmin(req, env);
  if (gated instanceof Response) return gated;
  const { uid } = gated;
  const id = params.id;

  const listing = await metaDb(env).prepare("SELECT * FROM listings WHERE id=?1 AND kind='agent'").bind(id).first<any>();
  if (!listing) return json({ error: "not found" }, 404);
  const agent = await metaDb(env).prepare("SELECT * FROM agent_live_agents WHERE listing_id=?1").bind(id).first<any>();
  if (!agent) return json({ error: "not found" }, 404);

  const cfg = await readConfig(env);
  const b = (await req.json().catch(() => ({}))) as any;
  const val = validateAgentBody(cfg, b, []);
  if (!val.ok) {
    track(env, uid, "agent_admin_patch", APP, { outcome: "invalid", field: val.field, agent_id: id, error: val.error });
    return json({ error: val.error, field: val.field }, 400);
  }
  const v = val.v;
  const hasKey = (k: string) => Object.prototype.hasOwnProperty.call(v, k);
  const personaChanged = (PERSONA_FIELDS as readonly string[]).some((k) => hasKey(k) && (v as Record<string, unknown>)[k] !== agent[k]);
  const now = Date.now();

  const agentSets: string[] = [];
  const agentBinds: unknown[] = [];
  let n = 1;
  const setAgent = (col: string, value: unknown) => {
    n += 1;
    agentSets.push(`${col}=?${n}`);
    agentBinds.push(value);
  };
  if (hasKey("persona_kind")) setAgent("persona_kind", v.persona_kind);
  if (hasKey("voice")) setAgent("voice", v.voice);
  if (hasKey("language")) setAgent("language", v.language);
  if (hasKey("greeting")) setAgent("greeting", v.greeting);
  if (hasKey("instructions")) setAgent("instructions", v.instructions);
  if (hasKey("backend_instructions")) setAgent("backend_instructions", v.backend_instructions);
  if (hasKey("image_instructions")) setAgent("image_instructions", v.image_instructions);
  if (hasKey("price_per_min")) setAgent("price_per_min", v.price_per_min);
  if (hasKey("slot_minutes")) setAgent("slot_minutes", v.slot_minutes!.join(","));
  if (hasKey("max_concurrent")) setAgent("max_concurrent", v.max_concurrent);
  if (hasKey("image_reading")) setAgent("image_reading", v.image_reading);
  if (hasKey("memory_enabled")) setAgent("memory_enabled", v.memory_enabled);
  if (hasKey("adults_only")) setAgent("adults_only", v.adults_only);
  if (personaChanged) setAgent("persona_version", Number(agent.persona_version || 1) + 1);
  const agentTouched = agentSets.length > 0;
  setAgent("updated_at", now);

  const listingSets: string[] = [];
  const listingBinds: unknown[] = [];
  let m = 1;
  const setListing = (col: string, value: unknown) => {
    m += 1;
    listingSets.push(`${col}=?${m}`);
    listingBinds.push(value);
  };
  if (hasKey("title")) setListing("title", v.title);
  if (hasKey("blurb")) setListing("blurb", v.blurb);
  if (hasKey("description")) setListing("description", v.description);
  if (hasKey("price_per_min")) setListing("price", v.price_per_min);
  if (hasKey("adults_only")) setListing("adults_only", v.adults_only);
  if (hasKey("cover_media")) setListing("cover_media", v.cover_media ? JSON.stringify(v.cover_media) : null);
  if (hasKey("category")) setListing("category", v.category);
  const listingTouched = listingSets.length > 0;
  setListing("updated_at", now);

  if (!agentTouched && !listingTouched) return json({ error: "nothing to update" }, 400);

  const statements = [
    metaDb(env).prepare(`UPDATE agent_live_agents SET ${agentSets.join(",")} WHERE listing_id=?1`).bind(id, ...agentBinds),
    metaDb(env).prepare(`UPDATE listings SET ${listingSets.join(",")} WHERE id=?1`).bind(id, ...listingBinds),
  ];

  try {
    await metaDb(env).batch(statements);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    track(env, uid, "agent_admin_patch", APP, { outcome: "error", agent_id: id, error: message });
    return json({ error: "patch_failed", message }, 500);
  }

  // A published listing's search index must reflect a title/description edit
  // immediately, not wait for the next publish toggle.
  if (listing.status === "published" && (hasKey("title") || hasKey("description"))) {
    try {
      await ftsSync(env, id);
    } catch {
      /* best-effort reindex — the edit itself already committed */
    }
  }

  track(env, uid, "agent_admin_patch", APP, { outcome: "ok", agent_id: id, persona_bumped: personaChanged });
  const full = await loadAgentFull(env, id);
  return json(full);
};

// ---------------------------------------------------------------------------
// POST /api/agents/admin/:id/publish { publish: boolean }
// ---------------------------------------------------------------------------
export const agentAdminPublish: AgentLiveHandler = async (req, env, _ctx, params) => {
  const gated = await requireAgentAdmin(req, env);
  if (gated instanceof Response) return gated;
  const { uid } = gated;
  const id = params.id;

  const listing = await metaDb(env).prepare("SELECT * FROM listings WHERE id=?1 AND kind='agent'").bind(id).first<any>();
  if (!listing) return json({ error: "not found" }, 404);
  const agent = await metaDb(env).prepare("SELECT * FROM agent_live_agents WHERE listing_id=?1").bind(id).first<any>();
  if (!agent) return json({ error: "not found" }, 404);

  const b = (await req.json().catch(() => ({}))) as any;
  const publish = b.publish !== false;
  const now = Date.now();

  if (publish) {
    const complete =
      !!String(listing.title || "").trim() &&
      !!String(agent.instructions || "").trim() &&
      !!agent.voice &&
      Number(agent.price_per_min) > 0;
    if (!complete) {
      track(env, uid, "agent_admin_publish", APP, { outcome: "incomplete", agent_id: id });
      return json({ error: "agent is missing required fields (title, instructions, voice, price_per_min)" }, 409);
    }
    await metaDb(env).prepare("UPDATE listings SET status='published', updated_at=?2 WHERE id=?1").bind(id, now).run();
    // [MARKET-SECTION-1]/[UI-MKT-3] Same reconciliation createListing's publish
    // path performs (ensurePublicationEffects) — search index + follower
    // fan-out — best-effort: the status flip above already committed, so a
    // search/notify hiccup here must not un-publish the listing.
    try {
      await ftsSync(env, id);
      await fanout(env, uid, `New AI voice agent: ${listing.title}`, "Talk any time, day or night.", `/l/${id}`, {
        eventId: `agent:${id}:published:${now}`,
        listingId: id,
        eventType: "agent_published",
      });
    } catch {
      /* best-effort — publish itself already committed */
    }
    track(env, uid, "agent_admin_publish", APP, { outcome: "ok", agent_id: id, status: "published" });
    return json({ status: "published" });
  }

  await metaDb(env).prepare("UPDATE listings SET status='draft', updated_at=?2 WHERE id=?1").bind(id, now).run();
  try {
    await ftsSync(env, id, true);
  } catch {
    /* best-effort */
  }
  track(env, uid, "agent_admin_publish", APP, { outcome: "ok", agent_id: id, status: "draft" });
  return json({ status: "draft" });
};

// ---------------------------------------------------------------------------
// GET /api/agents/admin/voices
// ---------------------------------------------------------------------------
export const agentAdminVoices: AgentLiveHandler = async (req, env) => {
  const gated = await requireAgentAdmin(req, env);
  if (gated instanceof Response) return gated;
  return json({ voices: AGENT_LIVE_VOICES });
};

// ---------------------------------------------------------------------------
// KB ingest — POST/GET/DELETE /api/agents/admin/:id/kb[/:fileId] (D5)
// ---------------------------------------------------------------------------

/** Bounded (8-try, ~1.5s apart) poll of one vector-store file's indexing
 *  status, run in `ctx.waitUntil` right after upload so the HTTP response
 *  does not block on OpenAI's async indexing. Every terminal state (and the
 *  final timed-out try) updates the D1 row and emits `agent_kb_indexed` —
 *  nothing here is a silent catch. */
async function pollKbIndexing(
  env: Env,
  fileId: string,
  storeId: string,
  openaiFileId: string,
  uid: string,
  agentId: string,
): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await sleep(1500);
    try {
      const s = await getVectorStoreFileStatus(env, storeId, openaiFileId);
      if (s.status === "completed") {
        await metaDb(env).prepare("UPDATE agent_live_kb_files SET status='indexed', updated_at=?2 WHERE id=?1").bind(fileId, Date.now()).run();
        track(env, uid, "agent_kb_indexed", APP, { outcome: "ok", agent_id: agentId });
        return;
      }
      if (s.status === "failed" || s.status === "cancelled") {
        const reason = s.lastError ?? s.status;
        await metaDb(env)
          .prepare("UPDATE agent_live_kb_files SET status='failed', error=?2, updated_at=?3 WHERE id=?1")
          .bind(fileId, reason, Date.now())
          .run();
        track(env, uid, "agent_kb_indexed", APP, { outcome: "failed", agent_id: agentId, reason });
        return;
      }
      // still in_progress — loop again
    } catch (e) {
      if (i === 7) {
        const message = e instanceof Error ? e.message : String(e);
        await metaDb(env)
          .prepare("UPDATE agent_live_kb_files SET status='failed', error=?2, updated_at=?3 WHERE id=?1")
          .bind(fileId, message.slice(0, 500), Date.now())
          .run()
          .catch(() => {});
        track(env, uid, "agent_kb_indexed", APP, { outcome: "error", agent_id: agentId, error: message });
        return;
      }
      // transient — retry on the next iteration
    }
  }
  // Exhausted retries while still in_progress. The row stays 'indexing'; the
  // admin panel's GET .../kb re-reads it, and OpenAI indexing typically
  // finishes within seconds of this window closing.
  track(env, uid, "agent_kb_indexed", APP, { outcome: "timeout", agent_id: agentId });
}

export const agentAdminKbUpload: AgentLiveHandler = async (req, env, ctx, params) => {
  const gated = await requireAgentAdmin(req, env);
  if (gated instanceof Response) return gated;
  const { uid } = gated;
  const agentId = params.id;
  const t0 = Date.now();

  const agent = await metaDb(env).prepare("SELECT * FROM agent_live_agents WHERE listing_id=?1").bind(agentId).first<any>();
  if (!agent) return json({ error: "not found" }, 404);

  const contentType = req.headers.get("content-type") || "";
  if (!/^multipart\/form-data/i.test(contentType)) return json({ error: "multipart/form-data required" }, 400);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "bad multipart body" }, 400);
  }
  const part = form.get("file");
  if (!part || typeof part === "string" || typeof (part as Blob).arrayBuffer !== "function") {
    return json({ error: "multipart 'file' part required" }, 400);
  }
  const filePart = part as File;
  const bytes = await filePart.arrayBuffer();
  if (bytes.byteLength === 0) return json({ error: "empty file" }, 400);
  if (bytes.byteLength > MAX_KB_FILE_BYTES) {
    track(env, uid, "agent_kb_upload", APP, { outcome: "too_large", bytes: bytes.byteLength, ms: Date.now() - t0, agent_id: agentId });
    return json({ error: "file too large", max: MAX_KB_FILE_BYTES }, 413);
  }

  const rawName = filePart.name || "file";
  const ext = extOf(rawName);
  const mime = ALLOWED_KB_EXT[ext];
  if (!mime) {
    track(env, uid, "agent_kb_upload", APP, { outcome: "unsupported_type", bytes: bytes.byteLength, ms: Date.now() - t0, agent_id: agentId, ext });
    return json({ error: "file type must be pdf, txt, md or docx" }, 415);
  }
  if (ext === "pdf" && !looksLikePdf(new Uint8Array(bytes.slice(0, 5)))) {
    return json({ error: "file does not look like a PDF" }, 415);
  }
  if (ext === "docx" && !looksLikeZip(new Uint8Array(bytes.slice(0, 4)))) {
    return json({ error: "file does not look like a DOCX" }, 415);
  }

  const countRow = await metaDb(env)
    .prepare("SELECT COUNT(*) AS n FROM agent_live_kb_files WHERE agent_id=?1 AND status<>'deleted'")
    .bind(agentId)
    .first<{ n: number }>();
  if ((countRow?.n ?? 0) >= MAX_KB_FILES) {
    track(env, uid, "agent_kb_upload", APP, { outcome: "quota", bytes: bytes.byteLength, ms: Date.now() - t0, agent_id: agentId });
    return json({ error: `at most ${MAX_KB_FILES} knowledge files per agent` }, 409);
  }

  const sha = await sha256Hex(bytes);
  const r2Key = `agent-live/kb/${agentId}/${sha}.${ext}`;
  const now = Date.now();
  const fileId = crypto.randomUUID();

  await env.DIGITAL.put(r2Key, bytes, { httpMetadata: { contentType: mime } });
  await metaDb(env)
    .prepare(
      `INSERT INTO agent_live_kb_files (id, agent_id, name, mime, bytes, content_sha256, r2_key, status, created_at, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,'uploaded',?8,?8)`,
    )
    .bind(fileId, agentId, rawName.slice(0, 200), mime, bytes.byteLength, sha, r2Key, now)
    .run();

  let storeId = (agent.vector_store_id as string | null) ?? null;
  try {
    if (!storeId) {
      storeId = await createVectorStore(env, `agent-${agentId}`);
      await metaDb(env).prepare("UPDATE agent_live_agents SET vector_store_id=?2, updated_at=?3 WHERE listing_id=?1").bind(agentId, storeId, Date.now()).run();
    }
    const openaiFile = await uploadOpenAIFile(env, bytes, rawName, mime);
    await metaDb(env)
      .prepare("UPDATE agent_live_kb_files SET openai_file_id=?2, status='indexing', updated_at=?3 WHERE id=?1")
      .bind(fileId, openaiFile.id, Date.now())
      .run();
    await addFileToVectorStore(env, storeId, openaiFile.id);

    ctx.waitUntil(pollKbIndexing(env, fileId, storeId, openaiFile.id, uid, agentId));

    track(env, uid, "agent_kb_upload", APP, { outcome: "ok", bytes: bytes.byteLength, ms: Date.now() - t0, agent_id: agentId });
    return json({ id: fileId, status: "indexing", bytes: bytes.byteLength, name: rawName });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await metaDb(env)
      .prepare("UPDATE agent_live_kb_files SET status='failed', error=?2, updated_at=?3 WHERE id=?1")
      .bind(fileId, message.slice(0, 500), Date.now())
      .run();
    track(env, uid, "agent_kb_upload", APP, { outcome: "error", bytes: bytes.byteLength, ms: Date.now() - t0, agent_id: agentId, error: message });
    return json({ id: fileId, status: "failed", error: message }, 502);
  }
};

export const agentAdminKbList: AgentLiveHandler = async (req, env, _ctx, params) => {
  const gated = await requireAgentAdmin(req, env);
  if (gated instanceof Response) return gated;
  const agentId = params.id;
  const agent = await metaDb(env).prepare("SELECT listing_id FROM agent_live_agents WHERE listing_id=?1").bind(agentId).first();
  if (!agent) return json({ error: "not found" }, 404);
  return json({ kb: await loadKbFiles(env, agentId) });
};

export const agentAdminKbDelete: AgentLiveHandler = async (req, env, _ctx, params) => {
  const gated = await requireAgentAdmin(req, env);
  if (gated instanceof Response) return gated;
  const { uid } = gated;
  const agentId = params.id;
  const fileId = params.fileId;

  const agent = await metaDb(env).prepare("SELECT vector_store_id FROM agent_live_agents WHERE listing_id=?1").bind(agentId).first<any>();
  if (!agent) return json({ error: "not found" }, 404);
  const file = await metaDb(env).prepare("SELECT * FROM agent_live_kb_files WHERE id=?1 AND agent_id=?2").bind(fileId, agentId).first<any>();
  if (!file || file.status === "deleted") return json({ error: "not found" }, 404);

  try {
    if (agent.vector_store_id && file.openai_file_id) {
      await removeFileFromVectorStore(env, agent.vector_store_id, file.openai_file_id);
    }
    if (file.openai_file_id) await deleteOpenAIFile(env, file.openai_file_id);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    track(env, uid, "agent_kb_delete", APP, { outcome: "error", agent_id: agentId, file_id: fileId, error: message });
    return json({ error: "kb_delete_failed", message }, 502);
  }

  await metaDb(env).prepare("UPDATE agent_live_kb_files SET status='deleted', updated_at=?2 WHERE id=?1").bind(fileId, Date.now()).run();
  track(env, uid, "agent_kb_delete", APP, { outcome: "ok", agent_id: agentId, file_id: fileId });
  return json({ ok: true });
};

// ---------------------------------------------------------------------------
// POST /api/agents/admin/:id/test-call (M11)
// ---------------------------------------------------------------------------
export const agentAdminTestCall: AgentLiveHandler = async (req, env, _ctx, params) => {
  const gated = await requireAgentAdmin(req, env);
  if (gated instanceof Response) return gated;
  const { uid } = gated;
  const id = params.id;

  const cfg = await readConfig(env);
  const listing = await metaDb(env).prepare("SELECT * FROM listings WHERE id=?1 AND kind='agent'").bind(id).first<any>();
  if (!listing) return json({ error: "not found" }, 404);
  const agent = await metaDb(env).prepare("SELECT * FROM agent_live_agents WHERE listing_id=?1").bind(id).first<any>();
  if (!agent) return json({ error: "not found" }, 404);

  const bookingId = crypto.randomUUID();
  const minutes = 3;
  const startMs = Date.now();
  const endMs = startMs + minutes * 60_000;

  const reserved = await seatAuthority(env).reserveProvisional({
    bookingId,
    agentId: id,
    buyerUid: uid,
    // Test calls have no real quote/idempotency key upstream — the booking id
    // is already fresh (crypto.randomUUID() above) so a fixed per-booking hash
    // satisfies reserveProvisional's "idempotent on (bookingId, requestHash)"
    // contract without a second real request to hash.
    requestHash: `agent_admin_test_call:${bookingId}`,
    startMs,
    endMs,
    agentCap: Number(agent.max_concurrent),
    platformCap: Number(cfg.agentPlatformMaxConcurrent),
    revision: Number(agent.persona_version),
  });
  if (!reserved.ok) {
    track(env, uid, "agent_admin_test_call", APP, { outcome: "seat_taken", agent_id: id });
    return json({ error: "seat_taken", next_free_at: reserved.nextFreeAt ?? null }, 409);
  }
  // Talk-now semantics (D9) — rebase to confirmation time and re-check.
  const confirmed = await seatAuthority(env).confirm({ bookingId, token: reserved.token, instant: true });
  if (!confirmed.ok) {
    track(env, uid, "agent_admin_test_call", APP, { outcome: "confirm_failed", agent_id: id });
    return json({ error: "seat_confirm_failed" }, 409);
  }
  const finalStart = confirmed.startMs;
  const finalEnd = confirmed.endMs;
  const now = Date.now();

  await metaDb(env)
    .prepare(
      `INSERT INTO agent_live_bookings (
         id, agent_id, buyer_uid, buyer_email, buyer_tz, starts_at, ends_at, minutes,
         price_per_min, amount, beneficiary_uid, persona_version, policy_version, order_id,
         idempotency_key, request_hash, status, money_state, instant, is_test, join_token_hash,
         checkout_phase, quote_json, persona_snapshot_json, created_at, updated_at
       ) VALUES (
         ?1,?2,?3,NULL,NULL,?4,?5,?6,
         ?7,0,?3,?8,?9,?10,
         NULL,NULL,'booked','none',1,1,NULL,
         'booked',NULL,?11,?12,?12
       )`,
    )
    .bind(
      bookingId,
      id,
      uid,
      finalStart,
      finalEnd,
      minutes,
      Number(agent.price_per_min),
      Number(agent.persona_version),
      AGENT_LIVE_POLICY_VERSION,
      `agl_test_${bookingId}`,
      JSON.stringify(agent),
      now,
    )
    .run();

  try {
    const stub = env.AGENT_LIVE_ROOMS.get(env.AGENT_LIVE_ROOMS.idFromName(bookingId));
    await stub.fetch("https://room/schedule", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookingId }),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    track(env, uid, "agent_admin_test_call", APP, { outcome: "room_schedule_failed", agent_id: id, booking_id: bookingId, error: message });
    return json({ error: "room_unavailable", message }, 503);
  }

  track(env, uid, "agent_admin_test_call", APP, { outcome: "ok", agent_id: id, booking_id: bookingId });
  return json({ bookingId, talkPath: `/talk/${bookingId}` });
};
