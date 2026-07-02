// Chat archive consumer (Q_ARCHIVE → "chat-archive"). Phase 1 (ABLY-R2-1).
//
// Ably owns realtime delivery; Cloudflare owns the DURABLE archive. For each sent
// message the avatok-api router enqueues an ArchiveMsg here. We:
//   1. write the message body to R2 (BACKUP_R2, private) at chat/<conv>/<serial>.json
//   2. upsert a row into D1 message_index (the queryable index for paged reads +
//      AI-search backfill).
// Idempotent on `serial` (the canonical id), so queue retries can't duplicate.
// Best-effort but DLQ-backed (5 retries) — a chat must never be silently lost.
import type { Env, ArchiveMsg } from "./types";

function archiveKey(conv: string, serial: string): string {
  return `chat/${conv}/${serial}.json`;
}

// A short, search-friendly snippet stored in D1 so list/search views don't need
// an R2 read. Control envelopes ({"t":"del"|"read"|…}) carry no human text.
function previewOf(kind: string, body?: string | null, mediaRef?: string | null): string {
  if (kind === "audio") return "🎤 Voice message";
  if (mediaRef && !body) return "📎 Attachment";
  const t = (body ?? "").trim();
  if (t.startsWith("{") && t.includes('"t":"')) return ""; // control envelope — no preview
  return t.slice(0, 280);
}

let _indexReady = false;
async function ensureIndexTable(env: Env): Promise<void> {
  if (_indexReady) return;
  await env.DB_META.prepare(
    `CREATE TABLE IF NOT EXISTS message_index (
       conv       TEXT NOT NULL,
       serial     TEXT NOT NULL,
       sender     TEXT NOT NULL,
       kind       TEXT NOT NULL,
       preview    TEXT,
       media_ref  TEXT,
       client_id  TEXT,
       r2_key     TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       PRIMARY KEY (conv, serial)
     )`,
  ).run();
  _indexReady = true;
}

export async function handleArchive(msg: ArchiveMsg, env: Env): Promise<void> {
  // Phase 4 reactions ride the same queue; route them to their own table.
  if (msg.type === "reaction") { await archiveReaction(msg, env); return; }

  const { conv, serial, sender, kind, body, media_ref, client_id, created_at } = msg;
  if (!conv || !serial) return;
  await ensureIndexTable(env); // self-create the deep-archive index on first use

  const key = archiveKey(conv, serial);

  // 1) Durable body → R2 (private bucket). The full envelope is stored so a
  //    restore reproduces the message exactly (replyTo, captions, special, etc.).
  if (env.BACKUP_R2) {
    await env.BACKUP_R2.put(
      key,
      JSON.stringify({ conv, serial, sender, kind, body: body ?? null, media_ref: media_ref ?? null, client_id: client_id ?? null, created_at }),
      { httpMetadata: { contentType: "application/json" } },
    );
  }

  // 2) D1 index (idempotent on (conv, serial)).
  await env.DB_META.prepare(
    `INSERT INTO message_index (conv, serial, sender, kind, preview, media_ref, client_id, r2_key, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT(conv, serial) DO UPDATE SET
       preview=excluded.preview, kind=excluded.kind, media_ref=excluded.media_ref`,
  ).bind(
    conv, serial, sender, kind || "text",
    previewOf(kind || "text", body, media_ref), media_ref ?? null, client_id ?? null, key, created_at || Date.now(),
  ).run();
}

// Phase 4: persist a per-message reaction toggle. Table is created in the
// chat_reactions migration; guard so this can't crash if it isn't applied yet.
async function archiveReaction(msg: ArchiveMsg, env: Env): Promise<void> {
  const { conv, target, sender, emoji, op } = msg;
  if (!conv || !target || !sender || !emoji) return;
  try {
    if (op === "remove") {
      await env.DB_META.prepare(
        "DELETE FROM message_reactions WHERE conv=?1 AND target=?2 AND uid=?3 AND emoji=?4",
      ).bind(conv, target, sender, emoji).run();
    } else {
      await env.DB_META.prepare(
        `INSERT INTO message_reactions (conv, target, uid, emoji, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(conv, target, uid, emoji) DO NOTHING`,
      ).bind(conv, target, sender, emoji, Date.now()).run();
    }
  } catch { /* migration not applied yet — live reaction still delivered via Ably */ }
}
