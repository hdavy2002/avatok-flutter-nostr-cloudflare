// worker/src/routes/campaign_kb.ts — [AVA-CAMP-C-KB] Per-campaign knowledge
// base (Gemini File Search RAG), Specs/OUTBOUND-AI-CALLING-CAMPAIGNS.md §9
// "Knowledge base" + §3 (campaign_kb_files, campaigns.kb_store/kb_version).
//
// Reuses the receptionist KB pattern verbatim (worker/src/routes/receptionist.ts
// ~L1415-1498: ensureReceptionistStore / indexToStore / receptionistKbUpload /
// receptionistKbClear) but scoped per-campaign instead of per-owner:
//   - one Gemini File Search store per CAMPAIGN (`campaign-<uid>-<campaignId>`),
//     not per owner — so different campaigns for the same user never share
//     grounding data.
//   - originals kept in R2 at campaign/<uid>/<campaignId>/kb/<fid>/<name>.
//   - store name + kb_version are persisted on `campaigns` (frozen into the
//     attempt row at launch by the launch path — not this file's job).
//
// The receptionist helpers (ensureReceptionistStore/indexToStore) are NOT
// exported from receptionist.ts, so the minimal Gemini REST calls are
// replicated inline below (assumption: this is intentional per the task brief
// "if those helpers aren't exported, replicate the minimal Gemini REST calls
// inline" — cited receptionist.ts line numbers throughout).
//
// Endpoints (mounted by the caller at /api/campaigns/:id/kb*):
//   POST   /api/campaigns/:id/kb?name=<filename>   raw-bytes body upload
//   GET    /api/campaigns/:id/kb                   list files
//   DELETE /api/campaigns/:id/kb                   clear (delete store, soft-delete rows)
import type { Env } from "../types";
import { json } from "../util";
import { isFail, requireUser } from "../authz";
import { readConfig } from "./config";
import { metaDb } from "../db/shard";
import { track } from "../hooks";

const APP = "campaign_kb";

// ---------------------------------------------------------------------------
// Gating — mirrors routes/campaigns.ts's gate() (campaignsEnabled) plus the
// KB-specific flag `campaignKbEnabled` (spec §17 "C — Conversation features").
// ---------------------------------------------------------------------------
function parseUidList(raw: string | undefined): string[] {
  return (raw ?? "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

async function gate(env: Env, uid: string): Promise<{ error: string; status: number } | null> {
  const cfg = await readConfig(env);
  if (cfg.campaignsEnabled !== true) return { error: "disabled", status: 503 };
  if (cfg.campaignKbEnabled !== true) return { error: "kb_disabled", status: 503 };
  if (cfg.campaignOwnerAllowlist === true) {
    const admins = parseUidList(env.ADMIN_UIDS);
    if (!admins.includes(uid)) return { error: "beta access required", status: 403 };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------
interface CampaignRow {
  id: string;
  uid: string;
  status: string;
  kb_store: string | null;
  kb_version: number | null;
}

interface KbFileRow {
  id: string;
  name: string;
  bytes: number | null;
  status: string;
  indexed_at: number | null;
}

/** Ownership-checked single-row fetch — same pattern as campaigns.ts's
 *  loadOwnedCampaign; the client never supplies a trusted owner. */
async function loadOwnedCampaign(env: Env, id: string, uid: string): Promise<CampaignRow | null | "forbidden"> {
  const row = await metaDb(env)
    .prepare(`SELECT id, uid, status, kb_store, kb_version FROM campaigns WHERE id=?1`)
    .bind(id)
    .first<CampaignRow>();
  if (!row) return null;
  if (row.uid !== uid) return "forbidden";
  return row;
}

const MUTABLE_STATUSES = new Set(["draft", "ready"]);
const ALLOWED_EXT = new Set(["pdf", "doc", "docx", "txt", "md"]);
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB cap (receptionist.ts L1466)

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i + 1).toLowerCase();
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Gemini File Search REST calls — mirrors receptionist.ts L1422-1454 exactly
// (POST fileSearchStores to create; multipart uploadToFileSearchStore to
// index; x-goog-api-key: GEMINI_API_KEY on both). Replicated here (not
// imported) because receptionist.ts does not export these helpers, and this
// store is per-campaign rather than per-owner.
// ---------------------------------------------------------------------------

/** Lazily create the campaign's File Search store; returns its resource name
 *  and persists it (+ kb_version=1) onto the campaigns row on first create. */
async function ensureCampaignStore(env: Env, uid: string, campaignId: string, c: CampaignRow): Promise<string | null> {
  if (c.kb_store) return c.kb_store;
  if (!env.GEMINI_API_KEY) return null;
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/fileSearchStores", {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({ displayName: `campaign-${uid}-${campaignId}` }),
  });
  const j = (await r.json().catch(() => ({}))) as any;
  if (!r.ok || !j?.name) return null;
  await metaDb(env).prepare(
    "UPDATE campaigns SET kb_store=?2, kb_version=1 WHERE id=?1",
  ).bind(campaignId, String(j.name)).run();
  return String(j.name);
}

/** Multipart upload one file into a File Search store (mirrors receptionist.ts
 *  indexToStore, L1440-1454, and the avavoice pattern it in turn mirrors). */
async function indexToStore(env: Env, store: string, filename: string, bytes: ArrayBuffer): Promise<string | null> {
  const meta = JSON.stringify({ displayName: filename });
  const boundary = "camp" + crypto.randomUUID().replace(/-/g, "");
  const enc = new TextEncoder();
  const head = enc.encode(`--${boundary}\r\ncontent-type: application/json\r\n\r\n${meta}\r\n--${boundary}\r\ncontent-type: application/octet-stream\r\n\r\n`);
  const tail = enc.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.length + bytes.byteLength + tail.length);
  body.set(head, 0); body.set(new Uint8Array(bytes), head.length); body.set(tail, head.length + bytes.byteLength);
  const r = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/${store}:uploadToFileSearchStore`,
    { method: "POST", headers: { "content-type": `multipart/related; boundary=${boundary}`, "x-goog-api-key": env.GEMINI_API_KEY! }, body },
  );
  const j = (await r.json().catch(() => ({}))) as any;
  return r.ok ? String(j?.name ?? j?.response?.document?.name ?? "pending") : null;
}

// ---------------------------------------------------------------------------
// POST /api/campaigns/:id/kb?name=<filename>   (raw bytes body)
// ---------------------------------------------------------------------------
async function uploadKbFile(req: Request, env: Env, uid: string, campaignId: string): Promise<Response> {
  const c = await loadOwnedCampaign(env, campaignId, uid);
  if (c === null) return json({ error: "not found" }, 404);
  if (c === "forbidden") return json({ error: "forbidden" }, 403);
  if (!MUTABLE_STATUSES.has(c.status)) {
    return json({ error: `cannot change knowledge base from status '${c.status}'` }, 409);
  }

  const name = (new URL(req.url).searchParams.get("name") || "file").slice(0, 200);
  const ext = extOf(name);
  if (!ALLOWED_EXT.has(ext)) {
    return json({ error: `unsupported file type '.${ext}' — allowed: pdf, doc, docx, txt, md` }, 400);
  }

  const bytes = await req.arrayBuffer();
  if (bytes.byteLength === 0) return json({ error: "empty body" }, 400);
  if (bytes.byteLength > MAX_BYTES) return json({ error: "max 25 MB" }, 413);

  const cfg = await readConfig(env);
  const maxFiles = typeof cfg.campaignKbMaxFiles === "number" && cfg.campaignKbMaxFiles > 0 ? cfg.campaignKbMaxFiles : 10;
  const countRow = await metaDb(env)
    .prepare(`SELECT COUNT(*) AS n FROM campaign_kb_files WHERE campaign_id=?1 AND status!='deleted'`)
    .bind(campaignId)
    .first<{ n: number }>();
  const existing = countRow?.n ?? 0;
  if (existing >= maxFiles) {
    return json({ error: `max ${maxFiles} files per campaign` }, 409);
  }

  const store = await ensureCampaignStore(env, uid, campaignId, c);
  if (!store) return json({ error: "kb_unavailable" }, 503);

  const fid = crypto.randomUUID();
  const sha256 = await sha256Hex(bytes);
  const r2Key = `campaign/${uid}/${campaignId}/kb/${fid}/${name}`;
  try { await env.BLOBS.put(r2Key, bytes); } catch { /* best-effort — original keep, not the indexing critical path */ }

  const doc = await indexToStore(env, store, name, bytes);
  const now = Date.now();
  await metaDb(env).prepare(
    `INSERT INTO campaign_kb_files (id, campaign_id, r2_key, name, bytes, sha256, indexed_at, status)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  ).bind(fid, campaignId, r2Key, name, bytes.byteLength, sha256, doc ? now : null, doc ? "indexed" : "failed").run();

  const countAfter = existing + 1;
  track(env, uid, "ava_campaign_kb_uploaded", APP, { campaign_id: campaignId, size: bytes.byteLength, indexed: !!doc, count: countAfter });
  return json({ ok: true, fileId: fid, count: countAfter, indexed: !!doc });
}

// ---------------------------------------------------------------------------
// GET /api/campaigns/:id/kb
// ---------------------------------------------------------------------------
async function listKbFiles(env: Env, uid: string, campaignId: string): Promise<Response> {
  const c = await loadOwnedCampaign(env, campaignId, uid);
  if (c === null) return json({ error: "not found" }, 404);
  if (c === "forbidden") return json({ error: "forbidden" }, 403);

  const { results } = await metaDb(env)
    .prepare(`SELECT id, name, bytes, status, indexed_at FROM campaign_kb_files WHERE campaign_id=?1 ORDER BY indexed_at DESC`)
    .bind(campaignId)
    .all<KbFileRow>();
  return json({ ok: true, files: results ?? [] });
}

// ---------------------------------------------------------------------------
// DELETE /api/campaigns/:id/kb — clear the store (Ava stops grounding on it).
// Mirrors receptionist.ts L1482-1497. Does NOT delete R2 originals here —
// retention (30-day soft-delete then GC) is handled elsewhere (spec §9, §18).
// ---------------------------------------------------------------------------
async function clearKb(env: Env, uid: string, campaignId: string): Promise<Response> {
  const c = await loadOwnedCampaign(env, campaignId, uid);
  if (c === null) return json({ error: "not found" }, 404);
  if (c === "forbidden") return json({ error: "forbidden" }, 403);
  if (!MUTABLE_STATUSES.has(c.status)) {
    return json({ error: `cannot change knowledge base from status '${c.status}'` }, 409);
  }

  if (c.kb_store && env.GEMINI_API_KEY) {
    try {
      await fetch(`https://generativelanguage.googleapis.com/v1beta/${c.kb_store}?force=true`, {
        method: "DELETE", headers: { "x-goog-api-key": env.GEMINI_API_KEY },
      });
    } catch { /* best-effort */ }
  }

  await metaDb(env).prepare("UPDATE campaigns SET kb_store=NULL WHERE id=?1").bind(campaignId).run();
  await metaDb(env).prepare("UPDATE campaign_kb_files SET status='deleted' WHERE campaign_id=?1 AND status!='deleted'").bind(campaignId).run();

  track(env, uid, "ava_campaign_kb_cleared", APP, { campaign_id: campaignId });
  return json({ ok: true, has_kb: false });
}

// ---------------------------------------------------------------------------
// Dispatcher — caller delegates /api/campaigns/:id/kb* here with the full
// original `path` (e.g. "/api/campaigns/abc123/kb").
// ---------------------------------------------------------------------------
export async function campaignKbRoute(req: Request, env: Env, path: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const gated = await gate(env, ctx.uid);
  if (gated) return json({ error: gated.error }, gated.status);

  const rest = path.slice("/api/campaigns".length).replace(/^\/+/, ""); // "<id>/kb"
  const parts = rest.split("/").filter(Boolean);
  if (parts.length !== 2 || parts[1] !== "kb") return json({ error: "not found" }, 404);
  const campaignId = parts[0];

  if (req.method === "POST") return await uploadKbFile(req, env, ctx.uid, campaignId);
  if (req.method === "GET") return await listKbFiles(env, ctx.uid, campaignId);
  if (req.method === "DELETE") return await clearKb(env, ctx.uid, campaignId);
  return json({ error: "method not allowed" }, 405);
}
