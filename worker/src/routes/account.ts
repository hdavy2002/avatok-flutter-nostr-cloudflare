// POST /api/account/delete — right-to-erasure. Dual-auth (NIP-98 + Clerk); the
// caller can only delete THEIR OWN account. Removes the user's media (R2, per-user
// prefix), Bunny videos (their collection), all D1 rows across meta/media/brain,
// their relay events, and verification docs. Content-level moderation records
// (sha256 blocklist, scan cache) are kept — they're not personal identifiers and
// dropping them would un-ban known-bad content.
import type { Env } from "../types";
import { json } from "../util";
import { authenticate, isErr } from "../auth";
import { deleteUserVideos } from "../bunny";

export async function deleteAccount(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const npub = auth.npub;
  const pubkeyHex = auth.pubkeyHex;
  const counts: Record<string, number> = {};

  // 1. R2 media — everything under the user's folder (public/, dm/, backups/).
  counts.r2_media = await deleteR2Prefix(env.BLOBS, `u/${npub}/`);
  // Verification bucket is also per-user-prefixed → prefix wipe (belt-and-suspenders
  // alongside the row-key delete below).
  if (env.VERIFICATION) { try { counts.r2_verification = await deleteR2Prefix(env.VERIFICATION, `u/${npub}/`); } catch { /* best-effort */ } }

  // 1b. Vectorize — vector ids are derived from the user's entities
  // (`<npub>:ent:<entityId>`), so we read entity ids (still present here) and
  // deleteByIds (batched 1000). No orphans; no separate vector-id table needed.
  if (env.VECTOR_INDEX) {
    try {
      const er = await env.DB_BRAIN.prepare("SELECT id FROM brain_entities WHERE npub=?1").bind(npub).all();
      const ids = (er.results ?? []).map((r: any) => `${npub}:ent:${r.id}`);
      for (let i = 0; i < ids.length; i += 1000) await env.VECTOR_INDEX.deleteByIds(ids.slice(i, i + 1000));
      counts.vectors = ids.length;
    } catch { /* best-effort */ }
  }

  // 2. Verification docs (separate locked bucket) — keyed off the user's rows.
  const link = await env.DB_META.prepare("SELECT clerk_user_id FROM clerk_nostr_link WHERE npub=?1").bind(npub).first<{ clerk_user_id: string }>();
  const clerkId = link?.clerk_user_id ?? null;
  if (clerkId) {
    const vr = await env.DB_META.prepare(
      "SELECT document_front_key, document_back_key, selfie_key, liveness_video_key FROM verification_requests WHERE clerk_user_id=?1",
    ).bind(clerkId).all();
    const keys = (vr.results ?? []).flatMap((r: any) => [r.document_front_key, r.document_back_key, r.selfie_key, r.liveness_video_key]).filter(Boolean) as string[];
    if (keys.length && env.VERIFICATION) { try { await env.VERIFICATION.delete(keys); } catch { /* best-effort */ } }
    counts.verification_blobs = keys.length;
  }

  // 3. Bunny videos (their collection).
  counts.bunny_videos = await deleteUserVideos(env, npub);

  // 4. Relay events authored by the user (+ their tag rows).
  await env.DB_RELAY.batch([
    env.DB_RELAY.prepare("DELETE FROM nostr_tags WHERE event_id IN (SELECT id FROM nostr_events WHERE pubkey=?1)").bind(pubkeyHex),
    env.DB_RELAY.prepare("DELETE FROM nostr_events WHERE pubkey=?1").bind(pubkeyHex),
  ]);

  // 5. AvaBrain memory.
  await env.DB_BRAIN.batch([
    env.DB_BRAIN.prepare("DELETE FROM brain_entities WHERE npub=?1").bind(npub),
    env.DB_BRAIN.prepare("DELETE FROM brain_relationships WHERE npub=?1").bind(npub),
    env.DB_BRAIN.prepare("DELETE FROM brain_facts WHERE npub=?1").bind(npub),
    env.DB_BRAIN.prepare("DELETE FROM brain_daily_summaries WHERE npub=?1").bind(npub),
    env.DB_BRAIN.prepare("DELETE FROM brain_events WHERE npub=?1").bind(npub),
  ]);

  // 6. Media metadata (FTS/triggers n/a here).
  await env.DB_MEDIA.batch([
    env.DB_MEDIA.prepare("DELETE FROM user_media WHERE npub=?1").bind(npub),
    env.DB_MEDIA.prepare("DELETE FROM user_media_hashes WHERE npub=?1").bind(npub),
  ]);

  // 7. Identity / social / settings (profiles delete also clears profiles_fts via trigger).
  const meta = [
    "DELETE FROM profiles WHERE npub=?1",
    "DELETE FROM contact_phone_index WHERE npub=?1",
    "DELETE FROM follows WHERE npub=?1 OR follows_npub=?1",
    "DELETE FROM blocks WHERE npub=?1 OR blocked_npub=?1",
    "DELETE FROM mutes WHERE npub=?1 OR muted_npub=?1",
    "DELETE FROM user_settings WHERE npub=?1",
    "DELETE FROM push_tokens WHERE npub=?1",
    "DELETE FROM community_members WHERE npub=?1",
    "DELETE FROM communities WHERE owner_npub=?1",
    "DELETE FROM account_strikes WHERE npub=?1",
    "DELETE FROM account_status WHERE npub=?1",
    "DELETE FROM live_streams WHERE npub=?1",
    "DELETE FROM notifications WHERE npub=?1",
    "DELETE FROM clerk_nostr_link WHERE npub=?1",
  ].map((q) => env.DB_META.prepare(q).bind(npub));
  if (clerkId) meta.push(env.DB_META.prepare("DELETE FROM verification_requests WHERE clerk_user_id=?1").bind(clerkId));
  await env.DB_META.batch(meta);

  // 8. User's own moderation reports (keep reports filed AGAINST others for safety).
  try { await env.DB_MODERATION.prepare("DELETE FROM user_reports WHERE reporter_npub=?1").bind(npub).run(); } catch { /* table optional */ }

  return json({ deleted: true, npub, counts });
}

async function deleteR2Prefix(bucket: R2Bucket, prefix: string): Promise<number> {
  let cursor: string | undefined;
  let n = 0;
  do {
    const list = await bucket.list({ prefix, cursor, limit: 1000 });
    const keys = list.objects.map((o) => o.key);
    if (keys.length) { await bucket.delete(keys); n += keys.length; }
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  return n;
}
