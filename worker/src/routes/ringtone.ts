// AI Ringback Tones + Busy Tone — generation + per-account 5-item library.
// Specs/proposals/PROPOSAL-AI-RINGBACK-TONES.md
//
//   POST   /api/ringtone/generate          { prompt, name?, instrumental? }
//   GET    /api/ringtone/list
//   POST   /api/ringtone/:id/default
//   DELETE /api/ringtone/:id
//   GET    /api/ringtone/user/:uid/default   (caller resolves callee's default)
//
// Model: minimax/music-2.6 (Workers AI) → returns an audio URL; we fetch the
// bytes and store them in OUR public R2 (BLOBS, served by blossom). Metadata
// lives in D1 DB_META `ringtones`. Nothing lives in a Durable Object.
//
// Library rules (enforced here): <=5 ringtones per account; a 6th evicts the
// OLDEST (R2 object deleted first, then the row). Exactly one is_default per
// account; deleting/evicting the default auto-promotes the newest remaining.
// Free to users (our AI key); cost is bounded by a per-account daily rate limit.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { readConfig } from "./config";
import { aiRunOpts } from "../lib/ai_gate";

const MODEL = "minimax/music-2.6";
const MAX_PER_ACCOUNT = 5;
const RINGTONE_SECONDS = 30;
const DAILY_GEN_LIMIT = 5;          // generations per account per day (cost cap)
const MAX_BYTES = 8 * 1024 * 1024;  // refuse absurdly large model output

interface RingtoneRow {
  id: string; account_id: string; name: string; r2_key: string;
  url: string; seconds: number; is_default: number; created_at: number;
}

function publicRow(r: RingtoneRow) {
  return { id: r.id, name: r.name, url: r.url, seconds: r.seconds, isDefault: r.is_default === 1, createdAt: r.created_at };
}

async function listFor(env: Env, uid: string): Promise<RingtoneRow[]> {
  const rs = await env.DB_META
    .prepare("SELECT * FROM ringtones WHERE account_id=?1 ORDER BY created_at DESC")
    .bind(uid).all<RingtoneRow>();
  return rs.results ?? [];
}

// Delete one ringtone's R2 object then its row. Best-effort on R2 (a missing
// object must not orphan the row delete).
async function hardDelete(env: Env, row: RingtoneRow): Promise<void> {
  try { await env.BLOBS.delete(row.r2_key); } catch { /* object already gone */ }
  await env.DB_META.prepare("DELETE FROM ringtones WHERE id=?1").bind(row.id).run();
}

// After any delete/evict, guarantee exactly one default exists (promote newest).
async function ensureDefault(env: Env, uid: string): Promise<void> {
  const rows = await listFor(env, uid);
  if (!rows.length) return;
  if (rows.some((r) => r.is_default === 1)) return;
  await env.DB_META.prepare("UPDATE ringtones SET is_default=1 WHERE id=?1").bind(rows[0].id).run();
}

export async function ringtone(req: Request, env: Env, sub: string): Promise<Response> {
  const cfg = await readConfig(env);
  if (!cfg.ringbackEnabled) return json({ error: "ringback disabled" }, 503);

  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const uid = ctx.uid;

  // GET /list
  if (sub === "list" && req.method === "GET") {
    const rows = await listFor(env, uid);
    return json({ ringtones: rows.map(publicRow), max: MAX_PER_ACCOUNT });
  }

  // GET /user/:uid/default  → a callee's default (for the caller's ringback)
  if (req.method === "GET" && sub.startsWith("user/")) {
    const parts = sub.split("/"); // user/<uid>/default
    const target = parts[1];
    if (!target || parts[2] !== "default") return json({ error: "bad path" }, 400);
    const row = await env.DB_META
      .prepare("SELECT url, seconds FROM ringtones WHERE account_id=?1 AND is_default=1 LIMIT 1")
      .bind(target).first<{ url: string; seconds: number }>();
    return json({ url: row?.url ?? "", seconds: row?.seconds ?? 0 });
  }

  // POST /generate
  if (sub === "generate" && req.method === "POST") {
    const b = (await req.json().catch(() => ({}))) as { prompt?: string; name?: string; instrumental?: boolean };
    const prompt = (b.prompt ?? "").trim();
    if (!prompt) return json({ error: "prompt required" }, 400);
    if (prompt.length > 400) return json({ error: "prompt too long" }, 400);

    // Per-account daily rate limit (cost cap) — KV counter, resets at UTC day.
    const day = new Date().toISOString().slice(0, 10);
    const rlKey = `rtgen:${uid}:${day}`;
    const used = parseInt((await env.TOKENS.get(rlKey)) ?? "0", 10) || 0;
    if (used >= DAILY_GEN_LIMIT) return json({ error: "daily limit reached", limit: DAILY_GEN_LIMIT }, 429);

    // Generate. minimax/music-2.6 returns { audio: <url> } (sometimes nested
    // under result). Default to instrumental (lower licensing risk for tones).
    let audioUrl = "";
    try {
      const out = (await env.AI.run(
        MODEL as any,
        { prompt, is_instrumental: b.instrumental !== false, format: "mp3" } as any,
        aiRunOpts(env, uid),
      )) as any;
      audioUrl = out?.audio || out?.result?.audio || "";
    } catch (e) {
      return json({ error: "generation failed", detail: String(e) }, 502);
    }
    if (!audioUrl) return json({ error: "no audio produced" }, 502);

    // Fetch the model's audio and store the bytes in OUR public bucket.
    const res = await fetch(audioUrl);
    if (!res.ok) return json({ error: "fetch audio failed", status: res.status }, 502);
    const bytes = await res.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength > MAX_BYTES) return json({ error: "audio too large" }, 502);

    const id = crypto.randomUUID();
    const r2Key = `u/${uid}/ringtones/${id}.mp3`;
    await env.BLOBS.put(r2Key, bytes, { httpMetadata: { contentType: "audio/mpeg" } });
    const url = `${env.BLOSSOM_BASE_URL}/${r2Key}`;
    const name = (b.name ?? "").trim().slice(0, 60) || `Ringtone ${day}`;
    const now = Date.now();

    // FIFO eviction: if already at the cap, drop the oldest (R2 + row) first.
    const existing = await listFor(env, uid); // newest first
    if (existing.length >= MAX_PER_ACCOUNT) {
      const oldest = existing[existing.length - 1];
      await hardDelete(env, oldest);
    }

    // First-ever ringtone for the account becomes the default automatically.
    const isFirst = existing.length === 0;
    await env.DB_META.prepare(
      "INSERT INTO ringtones (id, account_id, name, r2_key, url, seconds, is_default, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
    ).bind(id, uid, name, r2Key, url, RINGTONE_SECONDS, isFirst ? 1 : 0, now).run();
    await ensureDefault(env, uid); // covers the case where the evicted row was default

    await env.TOKENS.put(rlKey, String(used + 1), { expirationTtl: 60 * 60 * 36 });

    const rows = await listFor(env, uid);
    const mine = rows.find((r) => r.id === id)!;
    return json({ ringtone: publicRow(mine), ringtones: rows.map(publicRow), remaining: Math.max(0, DAILY_GEN_LIMIT - used - 1) });
  }

  // POST /:id/default
  if (req.method === "POST" && sub.endsWith("/default")) {
    const id = sub.slice(0, -"/default".length);
    if (!id) return json({ error: "id required" }, 400);
    const row = await env.DB_META
      .prepare("SELECT id FROM ringtones WHERE id=?1 AND account_id=?2")
      .bind(id, uid).first<{ id: string }>();
    if (!row) return json({ error: "not found" }, 404);
    await env.DB_META.batch([
      env.DB_META.prepare("UPDATE ringtones SET is_default=0 WHERE account_id=?1").bind(uid),
      env.DB_META.prepare("UPDATE ringtones SET is_default=1 WHERE id=?1 AND account_id=?2").bind(id, uid),
    ]);
    const rows = await listFor(env, uid);
    return json({ ringtones: rows.map(publicRow) });
  }

  // DELETE /:id
  if (req.method === "DELETE" && sub) {
    const id = sub;
    const row = await env.DB_META
      .prepare("SELECT * FROM ringtones WHERE id=?1 AND account_id=?2")
      .bind(id, uid).first<RingtoneRow>();
    if (!row) return json({ error: "not found" }, 404);
    await hardDelete(env, row);        // R2 object first, then the row
    await ensureDefault(env, uid);     // promote newest if we just deleted the default
    const rows = await listFor(env, uid);
    return json({ ringtones: rows.map(publicRow) });
  }

  return json({ error: "not found" }, 404);
}
