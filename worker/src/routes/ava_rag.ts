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

// POST /api/ava/rag/backfill — index the user's EXISTING FILES into their one AI
// Search instance so the master brain (ChatAVA) can discover them by name.
// Free + premium (free is capped by freeQuota). Idempotent-ish: re-runs re-upload by name.
//
// One Brain B-D2 (SPEC-2026-07-17 §1, §6.1): the former chat-history feed (InboxDO
// messages → AI Search) is REMOVED — chat content must not be shipped to a second
// store; it is indexed on-device only (AvaLocalBrain). COVERAGE now: a descriptor
// per user_media file so files are discoverable by name (NON-chat). Existing-file
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

  // One Brain B-D2 (SPEC-2026-07-17 §1, §6.1): the CHAT-TEXT feed of this backfill
  // is CUT. It used to read the user's InboxDO messages and index chat BODIES into a
  // second store (Cloudflare AI Search) — a second, unaudited brain of message
  // content, exactly what B-D2 rejects. Message content now lives on-device only
  // (AvaLocalBrain, domain msg_content). The file/document backfill below is
  // NON-chat and is retained. `conversations` stays 0 so the response shape is
  // unchanged for older clients.
  const conversations = 0;
  let files = 0;
  let capped = false;

  // A descriptor per user_media file (discoverable by name in ChatAVA). NON-chat.
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

// POST /api/brain/thread-search — in-thread "smart search". Semantic search over
// the user's OWN AI Search shard (same store the client ingests chat text into),
// then a BEST-EFFORT filter to the requesting conversation so the thread search UI
// can map hits back to local messages.
//
// Metadata reality (why filtering is heuristic, not exact): AI Search stores ONE
// document per conversation — live client ingestion keys it `chat-<chatName>`
// (content prefixed `Chat with <name>:`) and the history backfill keys it
// `messages-<serverConv>.txt` (content prefixed `Messenger conversation <conv>:`).
// There is no per-MESSAGE id and no structured `conv` attribute on AI Search rows,
// so we cannot hard-filter by conversation server-side. Instead we return each hit
// with its source doc `name` + snippet and a coarse `inThread` guess (name/conv
// markers), and let the client fuzzy-match snippet lines to local messages. Hits
// that don't belong to this thread are flagged `inThread:false` ("from your other
// chats") and hidden by default in thread search.
//
// Gating mirrors /rag/search: open to ALL users (free + premium), premium metered
// with AvaCoins. During the free launch betaFreePremium makes premium-quality
// retrieval available to everyone (search itself was never premium-gated here).
export async function avaThreadSearch(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const { premium } = await isPremiumAI(req, env, ctx.uid);

  let b: any;
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const q = String(b.q ?? b.query ?? "").trim();
  if (!q) return json({ error: "q required" }, 400);
  // Conversation scoping hints (best-effort; either/both may be empty):
  //   conv — server conversation id ('dm_…' | 'g_…'); matches backfill docs.
  //   name — chat display name; matches live-ingested `chat-<name>` docs.
  const conv = String(b.conv ?? "").trim();
  const name = String(b.name ?? "").trim();
  const topK = Math.max(1, Math.min(Number(b.topK ?? 8) || 8, 16));

  // A doc/snippet belongs to THIS thread if its filename or content carries the
  // conv id or the chat name marker written at ingest time.
  const nameLc = name.toLowerCase();
  const convLc = conv.toLowerCase();
  const belongs = (docName: string, content: string): boolean => {
    const dn = docName.toLowerCase();
    const ct = content.toLowerCase();
    if (convLc && (dn.includes(convLc) || ct.includes(`conversation ${convLc}`) || ct.includes(convLc))) return true;
    if (nameLc && (dn.includes(`chat-${nameLc}`) || dn.includes(nameLc) || ct.includes(`chat with ${nameLc}`))) return true;
    return false;
  };

  try {
    const r: any = await searchForUser(env, ctx.uid, q, undefined, { tier: premium ? "premium" : "free", src: "thread_search" });
    if (premium) await chargeFeature(env, ctx.uid, "ava_memory", crypto.randomUUID()).catch(() => ({ ok: false }));

    // Flatten AI Search rows → per-hit snippet lines with an inThread guess.
    const rows: any[] = Array.isArray(r?.data) ? r.data
      : Array.isArray(r?.results) ? r.results
      : Array.isArray(r?.matches) ? r.matches
      : Array.isArray(r?.documents) ? r.documents : [];
    const hits: Array<{ text: string; inThread: boolean; source: string }> = [];
    const seen = new Set<string>();
    for (const d of rows) {
      const docName = String(d?.filename ?? d?.name ?? d?.title ?? "").trim();
      const raw = String(d?.content ?? d?.snippet ?? d?.text ?? d?.summary ?? "").replace(/\s+/g, " ").trim();
      if (!raw) continue;
      const inThread = (conv || name) ? belongs(docName, raw) : true;
      // The chat docs pack many labelled lines ("Me: …" / "Them: …") into one
      // document; split so the client can match individual message lines.
      const parts = raw.split(/(?:^|\s)(?=(?:Me|Them|Ava|You)\s*:\s)/i).map((s) => s.trim()).filter(Boolean);
      const lines = parts.length > 1 ? parts : [raw];
      for (const line of lines) {
        const snip = line.slice(0, 300);
        const dedupe = snip.toLowerCase();
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        hits.push({ text: snip, inThread, source: docName });
        if (hits.length >= 40) break;
      }
      if (hits.length >= 40) break;
    }
    // Some AI Search variants synthesise a single answer string instead of rows.
    if (hits.length === 0 && typeof r?.response === "string" && r.response.trim()) {
      hits.push({ text: r.response.trim().slice(0, 500), inThread: true, source: "ava" });
    }

    // In-thread hits first (they're the ones the UI can navigate to), capped to topK.
    hits.sort((a, b2) => Number(b2.inThread) - Number(a.inThread));
    const out = hits.slice(0, topK);
    track(env, ctx.uid, "brain_thread_search", "avaai", {
      tier: premium ? "premium" : "free",
      hits: out.length,
      in_thread: out.filter((h) => h.inThread).length,
      scoped: Boolean(conv || name),
    });
    return json({ ok: true, hits: out });
  } catch (e: any) {
    track(env, ctx.uid, "ai_error", "avaai", { route: "thread_search", detail: String(e?.message ?? e).slice(0, 200) });
    return json({ error: "search failed", detail: String(e?.message ?? e).slice(0, 200) }, 502);
  }
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
