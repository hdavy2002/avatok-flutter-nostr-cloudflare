// ava_rag.ts — Ava "memory & file search", now on Cloudflare AI Search (2026-06-18).
//   POST /api/ava/rag/ingest   { text? , name?, mime?, contentB64? }
//   GET  /api/ava/rag/store
//   POST /api/ava/rag/search   { query }
//
// PREMIUM ONLY (top up). Google BYOK is gone — this runs entirely on Cloudflare
// AI Search (managed RAG with built-in storage + vector index), routed through
// the avatok-ai gateway. For per-user ISOLATION each premium user gets their OWN
// AI Search instance (namespace binding `env.AI_SEARCH`), created on first use,
// so one user can never search another's files.

import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { isPremiumAI, premiumUpsell } from "../lib/premium";
import { chargeFeature } from "../feature_pricing";
import { track } from "../hooks";

// AI Search instance id for a user (lowercase alnum + hyphens, bounded length).
function instanceId(uid: string): string {
  return ("ava-" + uid.replace(/[^a-zA-Z0-9]/g, "-")).toLowerCase().slice(0, 50);
}

// Get-or-create the user's own AI Search instance (built-in storage).
async function userInstance(env: Env, uid: string): Promise<any> {
  const id = instanceId(uid);
  const ns: any = env.AI_SEARCH;
  try {
    const got = await ns.get(id);
    if (got) return got;
  } catch { /* not created yet */ }
  try { return await ns.create({ id }); } catch { return ns.get(id); }
}

// POST /api/ava/rag/ingest — index a note (text) or a file (base64) into the
// user's private AI Search instance.
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
    const inst = await userInstance(env, ctx.uid);
    const content: any = text ? text : Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const item = await inst.items.uploadAndPoll(name, content);
    await chargeFeature(env, ctx.uid, "ava_memory", crypto.randomUUID()).catch(() => ({ ok: false }));
    track(env, ctx.uid, "ava_memory_ingest", "avaai", { name });
    return json({ ok: true, item });
  } catch (e: any) {
    track(env, ctx.uid, "ai_error", "avaai", { route: "rag_ingest", detail: String(e?.message ?? e).slice(0, 200) });
    return json({ error: "ingest failed", detail: String(e?.message ?? e).slice(0, 200) }, 502);
  }
}

// GET /api/ava/rag/store — ensure the user's instance exists; return its id.
export async function avaRagStore(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const { premium } = await isPremiumAI(req, env, ctx.uid);
  if (!premium) return premiumUpsell(env, ctx.uid, "memory");
  try {
    await userInstance(env, ctx.uid);
    return json({ ok: true, store: instanceId(ctx.uid) });
  } catch (e: any) {
    return json({ error: "store failed", detail: String(e?.message ?? e).slice(0, 200) }, 502);
  }
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
    const inst = await userInstance(env, ctx.uid);
    const results = await inst.search({ messages: [{ role: "user", content: query }] });
    await chargeFeature(env, ctx.uid, "ava_memory", crypto.randomUUID()).catch(() => ({ ok: false }));
    track(env, ctx.uid, "ava_memory_search", "avaai", {});
    return json({ ok: true, results });
  } catch (e: any) {
    track(env, ctx.uid, "ai_error", "avaai", { route: "rag_search", detail: String(e?.message ?? e).slice(0, 200) });
    return json({ error: "search failed", detail: String(e?.message ?? e).slice(0, 200) }, 502);
  }
}
