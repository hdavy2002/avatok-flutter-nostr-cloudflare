// Ringback tone selection — bundled catalog model.
// Specs/proposals/PROPOSAL-AI-RINGBACK-TONES.md
//
// PIVOT (2026-06-19): AI per-user generation is dropped in favour of a fixed,
// app-bundled catalog of royalty-free tones (fast, free, offline). The server
// only records WHICH catalog tone id each account picked as its ringback; the
// caller plays the callee's chosen tone from its own bundled copy. No R2, no AI.
//
//   GET    /api/ringtone/selected            -> { selected: "<id>" }
//   POST   /api/ringtone/select { id }       -> { selected: "<id>" }
//   GET    /api/ringtone/user/:uid/default   -> { id: "<id>" }  (caller lookup)
//
// Storage: we reuse the existing `ringtones` table as a single per-account row
// (is_default=1) whose `url` column holds the catalog id. No new migration, and
// the existing /api/call ringback lookup (reads is_default `url`) keeps working.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { readConfig } from "./config";

// Allowlist — must match app/lib/core/ringtone_catalog.dart ids.
const CATALOG_IDS = new Set([
  "pulse", "marimba", "chimes", "arcade", "sunrise", "bubbles", "classic", "lofi",
]);

async function selectedId(env: Env, uid: string): Promise<string> {
  const row = await env.DB_META
    .prepare("SELECT url FROM ringtones WHERE account_id=?1 AND is_default=1 LIMIT 1")
    .bind(uid).first<{ url: string }>();
  return row?.url ?? "";
}

export async function ringtone(req: Request, env: Env, sub: string): Promise<Response> {
  const cfg = await readConfig(env);
  if (!cfg.ringbackEnabled) return json({ error: "ringback disabled" }, 503);

  // Caller lookup: callee's chosen tone id (used to play the ringback locally).
  // Authed (the caller is a signed-in user), reads ANOTHER account's selection.
  if (req.method === "GET" && sub.startsWith("user/")) {
    const ctx = await requireUser(req, env);
    if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
    const parts = sub.split("/"); // user/<uid>/default
    const target = parts[1];
    if (!target || parts[2] !== "default") return json({ error: "bad path" }, 400);
    return json({ id: await selectedId(env, target) });
  }

  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const uid = ctx.uid;

  if (sub === "selected" && req.method === "GET") {
    return json({ selected: await selectedId(env, uid) });
  }

  if (sub === "select" && req.method === "POST") {
    const b = (await req.json().catch(() => ({}))) as { id?: string };
    const id = (b.id ?? "").trim();
    if (!CATALOG_IDS.has(id)) return json({ error: "unknown ringtone id" }, 400);
    const now = Date.now();
    // One default row per account: clear any prior selection, insert the new one.
    // r2_key='' so nothing in R2 is ever touched (catalog is app-bundled).
    await env.DB_META.batch([
      env.DB_META.prepare("DELETE FROM ringtones WHERE account_id=?1").bind(uid),
      env.DB_META.prepare(
        "INSERT INTO ringtones (id, account_id, name, r2_key, url, seconds, is_default, created_at) VALUES (?1,?2,?3,'',?4,?5,1,?6)",
      ).bind(crypto.randomUUID(), uid, id, id, 0, now),
    ]);
    return json({ selected: id });
  }

  return json({ error: "not found" }, 404);
}
