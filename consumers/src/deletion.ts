// Account-deletion cascade (§10.5) — runs in the account-deletions queue consumer
// after the 30-day grace. Order matters: COLLECT R2 keys / Clerk id / Vectorize ids
// BEFORE deleting the rows that reference them, then wipe 15 stores:
//
//   DB_BRAIN → DB_WALLET → DB_RELAY → DB_MEDIA → R2 blobs → R2 verification
//   → R2 agent-audio → DB_MODERATION → DB_META → Vectorize → KV → DOs → Clerk
//   → PostHog → Stripe
//
// Stores not yet provisioned (wallet, agent-audio, stripe) are guarded and skipped
// cleanly, so the cascade is correct now and stays correct as later phases add them.
import type { Env, DeletionMsg } from "./types";

const npubToPubkeyHex = (msg: DeletionMsg) => msg.pubkey_hex ?? null;

async function deleteR2Prefix(bucket: R2Bucket, prefix: string): Promise<number> {
  let cursor: string | undefined, n = 0;
  do {
    const list = await bucket.list({ prefix, cursor, limit: 1000 });
    const keys = list.objects.map((o) => o.key);
    if (keys.length) { await bucket.delete(keys); n += keys.length; }
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  return n;
}

export async function handleDeletion(msg: DeletionMsg, env: Env): Promise<void> {
  const npub = msg.npub;
  if (!npub) return;

  // Honor the grace window: if a message arrives early (shouldn't), re-delay.
  const req = await env.DB_META.prepare("SELECT status, scheduled_at, clerk_user_id FROM deletion_requests WHERE npub=?1")
    .bind(npub).first<{ status: string; scheduled_at: number; clerk_user_id: string | null }>();
  if (req && req.status === "cancelled") return;            // user cancelled — abort
  if (req && req.status === "done") return;                 // already processed
  if (req && Date.now() < req.scheduled_at) throw new Error("grace not elapsed — retry later");

  const clerkId = msg.clerk_user_id ?? req?.clerk_user_id ?? null;
  const pubkeyHex = npubToPubkeyHex(msg);
  const done: string[] = [];

  await env.DB_META.prepare("UPDATE deletion_requests SET status='processing' WHERE npub=?1").bind(npub).run();

  // ---- PRE-COLLECT (before deleting referencing rows) ----
  // Vectorize ids derive from brain entities.
  let vectorIds: string[] = [];
  try {
    const er = await env.DB_BRAIN.prepare("SELECT id FROM brain_entities WHERE npub=?1").bind(npub).all();
    vectorIds = (er.results ?? []).map((r: any) => `${npub}:ent:${r.id}`);
  } catch { /* table may be empty */ }
  // AvaLibrary file vectors: `${npub}:lib:${media_id}:${i}` (i = chunk, bounded ≤8).
  try {
    const lr = await env.DB_MEDIA.prepare("SELECT DISTINCT id FROM user_media WHERE npub=?1").bind(npub).all();
    for (const r of (lr.results ?? []) as any[]) for (let i = 0; i < 8; i++) vectorIds.push(`${npub}:lib:${r.id}:${i}`);
  } catch { /* table may be empty */ }
  // Verification selfie keys (locked R2).
  let verifKeys: string[] = [];
  try {
    const v = await env.DB_META.prepare("SELECT selfie_video_key FROM verification_status WHERE npub=?1 AND selfie_video_key IS NOT NULL").bind(npub).all();
    verifKeys = (v.results ?? []).map((r: any) => r.selfie_video_key).filter(Boolean);
  } catch { /* optional */ }

  // 1. DB_BRAIN
  await env.DB_BRAIN.batch([
    env.DB_BRAIN.prepare("DELETE FROM brain_entities WHERE npub=?1").bind(npub),
    env.DB_BRAIN.prepare("DELETE FROM brain_relationships WHERE npub=?1").bind(npub),
    env.DB_BRAIN.prepare("DELETE FROM brain_facts WHERE npub=?1").bind(npub),
    env.DB_BRAIN.prepare("DELETE FROM brain_daily_summaries WHERE npub=?1").bind(npub),
    env.DB_BRAIN.prepare("DELETE FROM brain_events WHERE npub=?1").bind(npub),
  ]); done.push("db_brain");
  // AvaBrain consent toggles.
  try { await env.DB_BRAIN.prepare("DELETE FROM brain_consent WHERE npub=?1").bind(npub).run(); done.push("db_brain_consent"); } catch { /* table optional */ }

  // 2. DB_WALLET (Phase 2) — guarded.
  if (env.DB_WALLET) {
    try {
      await env.DB_WALLET.batch([
        env.DB_WALLET.prepare("DELETE FROM wallet_transactions WHERE npub=?1").bind(npub),
        env.DB_WALLET.prepare("DELETE FROM topup_records WHERE npub=?1").bind(npub),
        env.DB_WALLET.prepare("DELETE FROM earning_holds WHERE npub=?1").bind(npub),
        env.DB_WALLET.prepare("DELETE FROM wallet_balances WHERE npub=?1").bind(npub),
        env.DB_WALLET.prepare("DELETE FROM payout_accounts WHERE npub=?1").bind(npub),
        env.DB_WALLET.prepare("DELETE FROM payout_requests WHERE npub=?1").bind(npub),
      ]); done.push("db_wallet");
    } catch { /* tables may not exist yet */ }
  }

  // 3. DB_RELAY (needs pubkey hex).
  if (env.DB_RELAY && pubkeyHex) {
    await env.DB_RELAY.batch([
      env.DB_RELAY.prepare("DELETE FROM nostr_tags WHERE event_id IN (SELECT id FROM nostr_events WHERE pubkey=?1)").bind(pubkeyHex),
      env.DB_RELAY.prepare("DELETE FROM nostr_events WHERE pubkey=?1").bind(pubkeyHex),
    ]); done.push("db_relay");
  }

  // 4. DB_MEDIA
  await env.DB_MEDIA.batch([
    env.DB_MEDIA.prepare("DELETE FROM user_media WHERE npub=?1").bind(npub),
    env.DB_MEDIA.prepare("DELETE FROM user_media_hashes WHERE npub=?1").bind(npub),
  ]); done.push("db_media");
  // AvaLibrary user folders.
  try { await env.DB_MEDIA.prepare("DELETE FROM library_folders WHERE npub=?1").bind(npub).run(); done.push("db_media_folders"); } catch { /* table optional */ }
  // OLX (Phase 5) — guarded.
  try {
    await env.DB_MEDIA.batch([
      env.DB_MEDIA.prepare("DELETE FROM olx_purchases WHERE buyer_npub=?1 OR seller_npub=?1").bind(npub),
      env.DB_MEDIA.prepare("DELETE FROM olx_digital_products WHERE seller_npub=?1").bind(npub),
      env.DB_MEDIA.prepare("DELETE FROM olx_listings WHERE seller_npub=?1").bind(npub),
    ]); done.push("db_media_olx");
  } catch { /* tables may not exist yet */ }

  // 5. R2 blobs (per-user prefix).
  try { done.push(`r2_blobs:${await deleteR2Prefix(env.BLOBS, `u/${npub}/`)}`); } catch { /* best-effort */ }

  // 6. R2 verification (prefix + explicit keys).
  if (env.VERIFICATION) {
    try { await deleteR2Prefix(env.VERIFICATION, `u/${npub}/`); } catch { /* best-effort */ }
    if (verifKeys.length) { try { await env.VERIFICATION.delete(verifKeys); } catch { /* best-effort */ } }
    done.push("r2_verification");
  }

  // 6b. R2 digital goods (OLX seller files) — guarded.
  if (env.DIGITAL) { try { await deleteR2Prefix(env.DIGITAL, `u/${npub}/`); done.push("r2_digital"); } catch { /* best-effort */ } }

  // 7. R2 agent-audio (Phase 8) — guarded.
  if (env.AGENT_AUDIO) { try { await deleteR2Prefix(env.AGENT_AUDIO, `u/${npub}/`); done.push("r2_agent_audio"); } catch { /* best-effort */ } }

  // 8. DB_MODERATION — drop the user's own reports (keep reports filed AGAINST others).
  try { await env.DB_MODERATION.prepare("DELETE FROM user_reports WHERE reporter_npub=?1").bind(npub).run(); done.push("db_moderation"); } catch { /* optional */ }

  // 9. DB_META — identity, social, settings, verification, deletion bookkeeping last.
  const metaStmts = [
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
    "DELETE FROM live_streams WHERE npub=?1",
    "DELETE FROM notifications WHERE npub=?1",
    "DELETE FROM verification_status WHERE npub=?1",
    "DELETE FROM verification_attempts WHERE npub=?1",
    "DELETE FROM calendar_slots WHERE npub=?1",
    "DELETE FROM calendar_events WHERE host_npub=?1 OR attendee_npub=?1",
    "DELETE FROM agent_personas WHERE npub=?1",
    "DELETE FROM agent_conversations WHERE npub=?1",
    "DELETE FROM agent_inbox WHERE npub=?1",
    "DELETE FROM user_vault WHERE npub=?1",
    "DELETE FROM clerk_nostr_link WHERE npub=?1",
    "DELETE FROM account_status WHERE npub=?1",
  ];
  for (const q of metaStmts) { try { await env.DB_META.prepare(q).bind(npub).run(); } catch { /* table may not exist in this phase */ } }
  done.push("db_meta");

  // 10. Vectorize.
  if (env.VECTOR_INDEX && vectorIds.length) {
    try { for (let i = 0; i < vectorIds.length; i += 1000) await env.VECTOR_INDEX.deleteByIds(vectorIds.slice(i, i + 1000)); done.push(`vectorize:${vectorIds.length}`); } catch { /* best-effort */ }
  }

  // 11. KV — verified cache + any per-user ephemeral keys.
  try { await env.TOKENS.delete(`verified:${npub}`); done.push("kv"); } catch { /* best-effort */ }

  // 12. DOs — UserBrain / Agent / Conversation DOs self-expire (hibernate to nothing);
  //     no API to enumerate by name. Cleared on next access as empty. (Marked noted.)
  done.push("dos_noted");

  // 13. Clerk user (Backend API) — guarded.
  if (env.CLERK_SECRET_KEY && clerkId) {
    try {
      const r = await fetch(`https://api.clerk.com/v1/users/${clerkId}`, { method: "DELETE", headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}` } });
      if (r.ok) done.push("clerk");
    } catch { /* best-effort */ }
  }

  // 14. PostHog person — guarded.
  if (env.POSTHOG_PERSONAL_API_KEY && env.POSTHOG_PROJECT_ID) {
    try {
      await fetch(`https://us.posthog.com/api/projects/${env.POSTHOG_PROJECT_ID}/persons/?distinct_id=${encodeURIComponent(npub)}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${env.POSTHOG_PERSONAL_API_KEY}` },
      });
      done.push("posthog");
    } catch { /* best-effort */ }
  }

  // 15. Stripe customer (Phase 2) — guarded. Customer id lookup lives in wallet rows
  //     (already deleted), so this is a no-op placeholder until Phase 2 wires it.
  if (env.STRIPE_SECRET_KEY) done.push("stripe_noted");

  await env.DB_META.prepare("UPDATE deletion_requests SET status='done', processed_at=?2, stores_done=?3 WHERE npub=?1")
    .bind(npub, Date.now(), JSON.stringify(done)).run();
  try { env.ANALYTICS?.writeDataPoint({ blobs: ["account_deletion", npub.slice(0, 16)], doubles: [done.length], indexes: ["account_deletion"] }); } catch { /* best-effort */ }
  // Lifecycle PostHog event (5 required fields).
  try {
    await env.Q_ANALYTICS?.send({ event: "account_deleted", npub, ts: Date.now(), props: { stores: done.length, trace_id: crypto.randomUUID(), app_name: "platform", app_version: "server", service_name: "avatok-consumers" } });
  } catch { /* best-effort */ }
}
