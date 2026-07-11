// RAG document pipeline (WP4, plan §5/§9 of Specs/PLAN-2026-07-11-dialpad-
// business-calls-ava-voice-agent.md): the owner uploads documents in Ava
// Business Agent settings → stored in R2 → pushed into a Grok Collection
// (one per Agent Profile, created lazily) via lib/grok.ts → the voice session
// declares `file_search` over that collection and Grok retrieves the right
// passages mid-call itself (do/agent_voice_room.ts).
//
// Flag-gated on `voiceAgent` throughout (plan §4/§7 item 9) — when off every
// route here 403s, matching agent_profiles.ts's flagOff() pattern exactly.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { metaDb } from "../db/shard";
import { readConfig } from "./config";
import { getProfileForOwner, setProfileCollectionId, bumpProfileVersion } from "./agent_profiles";
import { createCollection, uploadDocument, deleteDocument } from "../lib/grok";

let tableEnsured = false;
async function ensureTable(env: Env): Promise<void> {
  if (tableEnsured) return;
  await metaDb(env).prepare(
    `CREATE TABLE IF NOT EXISTS agent_docs (
       id TEXT PRIMARY KEY,
       profile_id TEXT NOT NULL,
       owner_uid TEXT NOT NULL,
       filename TEXT NOT NULL,
       r2_key TEXT NOT NULL,
       grok_file_id TEXT,
       content_type TEXT,
       size INTEGER NOT NULL DEFAULT 0,
       created_at INTEGER NOT NULL
     )`,
  ).run();
  await metaDb(env).prepare(`CREATE INDEX IF NOT EXISTS idx_agent_docs_profile ON agent_docs (profile_id)`).run();
  tableEnsured = true;
}

async function flagOff(env: Env): Promise<Response | null> {
  const cfg = await readConfig(env);
  return cfg.voiceAgent !== true ? json({ error: "disabled", flag: "voiceAgent" }, 403) : null;
}

interface AgentDocRow {
  id: string; profile_id: string; owner_uid: string; filename: string;
  r2_key: string; grok_file_id: string | null; content_type: string | null;
  size: number; created_at: number;
}

// POST /api/agent/docs?profile_id=... — raw file bytes in the request body
// (same convention as routes/media.ts's uploadPublic: raw arrayBuffer body +
// `x-file-name`/`x-content-type` headers, not multipart/form-data — kept
// consistent with the rest of this codebase's upload routes rather than
// introducing a second upload shape). Owner-auth via getProfileForOwner
// (never lets an owner upload into someone else's profile).
export async function uploadAgentDoc(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const off = await flagOff(env); if (off) return off;
  await ensureTable(env);

  const url = new URL(req.url);
  const profileId = url.searchParams.get("profile_id") || "";
  if (!profileId) return json({ error: "profile_id required" }, 400);
  const profile = await getProfileForOwner(env, profileId, ctx.uid);
  if (!profile) return json({ error: "not_found" }, 404);

  const raw = await req.arrayBuffer();
  if (!raw.byteLength || raw.byteLength > 25 * 1024 * 1024) return json({ error: "body must be 1 byte..25MB" }, 400);
  const bytes = new Uint8Array(raw);
  const filename = (req.headers.get("x-file-name") || "document").slice(0, 200);
  const contentType = req.headers.get("x-content-type") || req.headers.get("content-type") || "application/octet-stream";

  // 1. Store the raw doc in R2 (source of truth — survives even if the Grok
  //    push below fails; a retry can re-push without re-uploading from the client).
  const docId = crypto.randomUUID();
  const r2Key = `agent_docs/${profileId}/${docId}/${filename}`;
  try {
    await env.BLOBS.put(r2Key, bytes, { httpMetadata: { contentType } });
  } catch (e) {
    return json({ error: "r2_put_failed", detail: String(e).slice(0, 200) }, 502);
  }

  // 2. Lazily create the Grok Collection for this profile if it doesn't have
  //    one yet (plan §5 "create collection lazily per profile if profile.
  //    collection_id null, store id + bump profile version").
  let collectionId = profile.collection_id;
  if (!collectionId) {
    const c = await createCollection(env, `AvaTOK agent — ${profileId}`);
    if (!c.ok || !c.id) {
      // Doc is safely in R2; Grok push can be retried later without asking the
      // owner to re-upload — surface a soft failure so the client can show
      // "saved, indexing pending" rather than losing the upload.
      await metaDb(env).prepare(
        `INSERT INTO agent_docs (id, profile_id, owner_uid, filename, r2_key, grok_file_id, content_type, size, created_at)
         VALUES (?1,?2,?3,?4,?5,NULL,?6,?7,?8)`,
      ).bind(docId, profileId, ctx.uid, filename, r2Key, contentType, bytes.byteLength, Date.now()).run();
      return json({ ok: true, doc_id: docId, indexed: false, error: c.error ?? "collection_create_failed" }, 200);
    }
    collectionId = c.id;
    await setProfileCollectionId(env, profileId, collectionId);
  }

  // 3. Push the file into the collection.
  const up = await uploadDocument(env, collectionId, filename, bytes, contentType);
  await metaDb(env).prepare(
    `INSERT INTO agent_docs (id, profile_id, owner_uid, filename, r2_key, grok_file_id, content_type, size, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
  ).bind(docId, profileId, ctx.uid, filename, r2Key, up.fileId ?? null, contentType, bytes.byteLength, Date.now()).run();
  if (up.ok) await bumpProfileVersion(env, profileId);

  return json({ ok: true, doc_id: docId, indexed: up.ok, collection_id: collectionId, error: up.ok ? undefined : up.error });
}

// GET /api/agent/docs?profile_id=...
export async function listAgentDocs(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const off = await flagOff(env); if (off) return off;
  await ensureTable(env);
  const url = new URL(req.url);
  const profileId = url.searchParams.get("profile_id") || "";
  if (!profileId) return json({ error: "profile_id required" }, 400);
  const profile = await getProfileForOwner(env, profileId, ctx.uid);
  if (!profile) return json({ error: "not_found" }, 404);
  const { results } = await metaDb(env).prepare(
    "SELECT id, filename, content_type, size, grok_file_id, created_at FROM agent_docs WHERE profile_id=?1 ORDER BY created_at DESC",
  ).bind(profileId).all<Pick<AgentDocRow, "id" | "filename" | "content_type" | "size" | "grok_file_id" | "created_at">>();
  const docs = (results ?? []).map((d) => ({ ...d, indexed: !!d.grok_file_id }));
  return json({ ok: true, collection_id: profile.collection_id, docs });
}

// DELETE /api/agent/docs { profile_id, doc_id }
export async function deleteAgentDoc(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const off = await flagOff(env); if (off) return off;
  await ensureTable(env);
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const profileId = String(b.profile_id || "");
  const docId = String(b.doc_id || "");
  if (!profileId || !docId) return json({ error: "profile_id and doc_id required" }, 400);
  const profile = await getProfileForOwner(env, profileId, ctx.uid);
  if (!profile) return json({ error: "not_found" }, 404);
  const row = await metaDb(env).prepare("SELECT * FROM agent_docs WHERE id=?1 AND profile_id=?2").bind(docId, profileId).first<AgentDocRow>();
  if (!row) return json({ error: "not_found" }, 404);

  if (row.grok_file_id && profile.collection_id) {
    await deleteDocument(env, profile.collection_id, row.grok_file_id).catch(() => ({ ok: false }));
  }
  try { await env.BLOBS.delete(row.r2_key); } catch { /* best-effort */ }
  await metaDb(env).prepare("DELETE FROM agent_docs WHERE id=?1").bind(docId).run();
  await bumpProfileVersion(env, profileId);
  return json({ ok: true, deleted: docId });
}
