// ava_rag.ts — Ava "memory & file search", now on Cloudflare AI Search (2026-06-18).
//   POST /api/ava/rag/ingest   { text? , name?, mime?, contentB64? }
//   GET  /api/ava/rag/store
//   POST /api/ava/rag/search   { query }
//
// PREMIUM ONLY (top up). Google BYOK is gone — this runs entirely on Cloudflare
// AI Search (managed RAG with built-in storage + vector index), routed through
// the avatok-ai gateway. Per-user ISOLATION + scale: users are pooled into a
// FIXED set of sharded AI Search instances and isolated by a per-user `<uid>/`
// folder filter, all via the single tenancy boundary in `lib/ava_search.ts`
// (ingestForUser / searchForUser). See Specs/PROPOSAL-AI-SEARCH-SHARDING.md.

import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { isPremiumAI, premiumUpsell } from "../lib/premium";
import { chargeFeature } from "../feature_pricing";
import { track } from "../hooks";
import { mediaSession } from "../db/shard";
import { ingestForUser, searchForUser, shardId } from "../lib/ava_search";

// POST /api/ava/rag/ingest — index a note (text) or a file (base64) into the
// user's own folder inside their shard.
export async function avaRagIngest(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  const { premium } = await isPremiumAI(req, env, ctx.uid);
  if (!premium) return premiumUpsell(env, ctx.uid, "memory");

  let b: any;
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const text = typeof b.text === "string" ? b.text.trim() : "";
  const name = String(b.name || `note-${Date.now()}.txt`).slice(0, 80);
  const b64 = typeof b.contentB64 === "string" ? b.contentB64 : "";
  if (!text && !b64) return json({ error: "text or contentB64 required" }, 400);

  try {
    const content: any = text ? text : Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const item = await ingestForUser(env, ctx.uid, name, content);
    await chargeFeature(env, ctx.uid, "ava_memory", crypto.randomUUID()).catch(() => ({ ok: false }));
    track(env, ctx.uid, "ava_memory_ingest", "avaai", { name });
    return json({ ok: true, item });
  } catch (e: any) {
    track(env, ctx.uid, "ai_error", "avaai", { route: "rag_ingest", detail: String(e?.message ?? e).slice(0, 200) });
    return json({ error: "ingest failed", detail: String(e?.message ?? e).slice(0, 200) }, 502);
  }
}

// GET /api/ava/rag/store — report the user's shard id (shards are created lazily
// on first ingest, so there is nothing to pre-create here).
export async function avaRagStore(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const { premium } = await isPremiumAI(req, env, ctx.uid);
  if (!premium) return premiumUpsell(env, ctx.uid, "memory");
  return json({ ok: true, store: shardId(env, ctx.uid) });
}

// POST /api/ava/rag/backfill — index the user's EXISTING Messenger history into
// their one AI Search instance, so the master brain (ChatAVA) can discuss past
// conversations and files even if they predate live ingestion (or a tier upgrade).
// Premium (memory is a premium feature). Idempotent-ish: re-runs re-upload by name.
//
// COVERAGE: (1) text-bearing messages from the user's InboxDO (server-readable in
// the Cloudflare-native arch), grouped one document per conversation; (2) a
// descriptor per user_media file so files are discoverable by name. Existing-file
// CONTENT (PDF text etc.) is indexed by the client on upload; a deeper server-side
// content backfill (fetch + extract per file) can be queued later for scale.
export async function avaRagBackfill(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const { premium } = await isPremiumAI(req, env, ctx.uid);
  if (!premium) return premiumUpsell(env, ctx.uid, "memory");

  let conversations = 0;
  let files = 0;

  // (1) Messages from the user's own InboxDO, grouped per conversation.
  try {
    const dobj = env.INBOX.get(env.INBOX.idFromName(ctx.uid));
    const r = await dobj.fetch("https://inbox/export?limit=1500");
    const j: any = await r.json().catch(() => ({}));
    const rows: any[] = Array.isArray(j?.messages) ? j.messages : [];
    const byConv = new Map<string, string[]>();
    // rows arrive newest→oldest; reverse to read chronologically.
    for (const m of rows.reverse()) {
      const kind = String(m.kind ?? "text");
      if (kind !== "text" && kind !== "ava" && kind !== "ava_private") continue;
      const body = String(m.body ?? "").trim();
      if (!body || body.startsWith("{")) continue; // skip control/JSON envelopes
      const who = m.sender === "ava" ? "Ava" : (m.sender === ctx.uid ? "Me" : "Them");
      const conv = String(m.conv ?? "chat");
      if (!byConv.has(conv)) byConv.set(conv, []);
      byConv.get(conv)!.push(`${who}: ${body}`);
    }
    for (const [conv, lines] of byConv) {
      if (!lines.length) continue;
      const text = `Messenger conversation ${conv}:\n` + lines.slice(-400).join("\n");
      try {
        await ingestForUser(env, ctx.uid, `messages-${conv}.txt`, text.slice(0, 100_000));
        conversations++;
      } catch { /* skip one conv, keep going */ }
    }
  } catch { /* messages best-effort */ }

  // (2) A descriptor per user_media file (discoverable by name in ChatAVA).
  try {
    const mdb = mediaSession(env);
    const res = await mdb.prepare(
      "SELECT file_name, mime_type, original_app, created_at FROM user_media WHERE uid=?1 ORDER BY created_at DESC LIMIT 200",
    ).bind(ctx.uid).all<any>();
    for (const f of (res.results ?? [])) {
      const name = String(f.file_name ?? "file");
      const when = f.created_at ? new Date(Number(f.created_at)).toISOString().slice(0, 10) : "";
      const descr = `File "${name}" (type ${f.mime_type ?? "unknown"}, from ${f.original_app ?? "avatok"}${when ? ", added " + when : ""}).`;
      try { await ingestForUser(env, ctx.uid, `file-${name}`, descr); files++; } catch { /* skip */ }
    }
  } catch { /* files best-effort */ }

  track(env, ctx.uid, "ava_rag_backfill", "avaai", { conversations, files });
  return json({ ok: true, indexed: { conversations, files } });
}

// POST /api/ava/rag/search — semantic search over the user's own indexed files.
export async function avaRagSearch(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const { premium } = await isPremiumAI(req, env, ctx.uid);
  if (!premium) return premiumUpsell(env, ctx.uid, "memory");

  let b: any;
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const query = String(b.query ?? "").trim();
  if (!query) return json({ error: "query required" }, 400);

  try {
    const results = await searchForUser(env, ctx.uid, query);
    await chargeFeature(env, ctx.uid, "ava_memory", crypto.randomUUID()).catch(() => ({ ok: false }));
    track(env, ctx.uid, "ava_memory_search", "avaai", {});
    return json({ ok: true, results });
  } catch (e: any) {
    track(env, ctx.uid, "ai_error", "avaai", { route: "rag_search", detail: String(e?.message ?? e).slice(0, 200) });
    return json({ error: "search failed", detail: String(e?.message ?? e).slice(0, 200) }, 502);
  }
}
