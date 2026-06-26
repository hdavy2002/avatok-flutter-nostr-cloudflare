// ava_rag.ts — Ava "memory & file search", now on Cloudflare AI Search (2026-06-18).
//   POST /api/ava/rag/ingest   { text? , name?, mime?, contentB64? }
//   GET  /api/ava/rag/store
//   POST /api/ava/rag/search   { query }
//
// FREE + PREMIUM. AI Search (memory & file search) is available to ALL users:
//   • FREE  — ingest is CAPPED (freeQuota: default 10 GB / 10,000 items),
//             search is unrestricted, and there is NO AvaCoin charge.
//   • PREMIUM (topped-up wallet) — uncapped ingest, metered per op via chargeFeature.
// Per-user ISOLATION + scale: users are pooled into a FIXED set of sharded AI
// Search instances and isolated by a per-user `<uid>/` folder filter, all via the
// single tenancy boundary in `lib/ava_search.ts`. See PROPOSAL-AI-SEARCH-SHARDING.md.

import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { isPremiumAI, premiumUpsell } from "../lib/premium";
import { chargeFeature } from "../feature_pricing";
import { track, trackUser } from "../hooks";
import { emailFor } from "../lib/identity";
import { mediaSession } from "../db/shard";
import { ingestForUser, searchForUser, shardId, ingestUsage, freeQuota } from "../lib/ava_search";

// POST /api/ava/rag/ingest — index a note (text) or a file (base64) into the
// user's own folder inside their shard.
export async function avaRagIngest(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  const { premium } = await isPremiumAI(req, env, ctx.uid);

  let b: any;
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const text = typeof b.text === "string" ? b.text.trim() : "";
  const name = String(b.name || `note-${Date.now()}.txt`).slice(0, 80);
  const b64 = typeof b.contentB64 === "string" ? b.contentB64 : "";
  if (!text && !b64) return json({ error: "text or contentB64 required" }, 400);

  const content: any = text ? text : Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const addBytes = typeof content === "string" ? content.length : content.byteLength;

  // FREE tier: enforce the ingest cap (uncapped for premium). On exceed, emit a
  // telemetry block event (email-stamped) and return the premium upsell.
  if (!premium) {
    const q = freeQuota(env);
    const used = await ingestUsage(env, ctx.uid);
    if (used.items >= q.maxItems || used.bytes + addBytes > q.maxBytes) {
      const reason = used.items >= q.maxItems ? "items" : "bytes";
      trackUser(env, ctx.uid, await emailFor(env, ctx.uid).catch(() => null),
        "ava_search_quota_block", "avaai",
        { reason, items: used.items, bytes: used.bytes, add_bytes: addBytes, max_items: q.maxItems, max_bytes: q.maxBytes });
      return premiumUpsell(env, ctx.uid, "memory");
    }
  }

  try {
    const item = await ingestForUser(env, ctx.uid, name, content, undefined, { tier: premium ? "premium" : "free" });
    if (premium) await chargeFeature(env, ctx.uid, "ava_memory", crypto.randomUUID()).catch(() => ({ ok: false }));
    track(env, ctx.uid, "ava_memory_ingest", "avaai", { name, tier: premium ? "premium" : "free" });
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
  // Available to all users (free + premium); shards are created lazily.
  return json({ ok: true, store: shardId(env, ctx.uid) });
}

// POST /api/ava/rag/backfill — index the user's EXISTING Messenger history into
// their one AI Search instance, so the master brain (ChatAVA) can discuss past
// conversations and files even if they predate live ingestion (or a tier upgrade).
// Free + premium (free is capped by freeQuota). Idempotent-ish: re-runs re-upload by name.
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

  // FREE tier: backfill is bulk ingest, so it counts against the same cap. Track
  // running usage and stop ingesting once the cap is hit (premium = uncapped).
  const q = freeQuota(env);
  const used = premium ? null : await ingestUsage(env, ctx.uid);
  const tier = premium ? "premium" : "free";
  const canIngest = (bytes: number): boolean =>
    premium || (used!.items < q.maxItems && used!.bytes + bytes <= q.maxBytes);

  let conversations = 0;
  let files = 0;
  let capped = false;

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
      const doc = (`Messenger conversation ${conv}:\n` + lines.slice(-400).join("\n")).slice(0, 100_000);
      if (!canIngest(doc.length)) { capped = true; break; }
      try {
        await ingestForUser(env, ctx.uid, `messages-${conv}.txt`, doc, undefined, { tier, src: "backfill" });
        if (used) { used.items++; used.bytes += doc.length; }
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
      if (!canIngest(descr.length)) { capped = true; break; }
      try {
        await ingestForUser(env, ctx.uid, `file-${name}`, descr, undefined, { tier, src: "backfill" });
        if (used) { used.items++; used.bytes += descr.length; }
        files++;
      } catch { /* skip */ }
    }
  } catch { /* files best-effort */ }

  track(env, ctx.uid, "ava_rag_backfill", "avaai", { conversations, files, tier, capped });
  return json({ ok: true, indexed: { conversations, files }, capped });
}

// POST /api/ava/rag/search — semantic search over the user's own indexed files.
export async function avaRagSearch(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const { premium } = await isPremiumAI(req, env, ctx.uid);

  let b: any;
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const query = String(b.query ?? "").trim();
  if (!query) return json({ error: "query required" }, 400);

  try {
    // Search is open to all users; only premium is metered with AvaCoins.
    const results = await searchForUser(env, ctx.uid, query, undefined, { tier: premium ? "premium" : "free" });
    if (premium) await chargeFeature(env, ctx.uid, "ava_memory", crypto.randomUUID()).catch(() => ({ ok: false }));
    track(env, ctx.uid, "ava_memory_search", "avaai", { tier: premium ? "premium" : "free" });
    return json({ ok: true, results });
  } catch (e: any) {
    track(env, ctx.uid, "ai_error", "avaai", { route: "rag_search", detail: String(e?.message ?? e).slice(0, 200) });
    return json({ error: "search failed", detail: String(e?.message ?? e).slice(0, 200) }, 502);
  }
}
