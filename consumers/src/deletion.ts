// Account-deletion cascade (§10.5) — runs in the account-deletions queue consumer
// after the 30-day grace. Order matters: COLLECT R2 keys / Clerk id / Vectorize ids
// BEFORE deleting the rows that reference them, then wipe 15 stores:
//
//   DB_BRAIN → DB_WALLET → DB_RELAY → DB_MEDIA → R2 blobs → R2 verification
//   → R2 agent-audio → DB_MODERATION → DB_META → Vectorize → AI Search → KV
//   → DOs → Clerk → PostHog → Stripe
//
// Stores not yet provisioned (wallet, agent-audio, stripe) are guarded and skipped
// cleanly, so the cascade is correct now and stays correct as later phases add them.
import type { Env, DeletionMsg } from "./types";
import { recordDeletionRetention } from "./retention"; // [AVA-IDGATE-1] spec §10.1

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

/**
 * [AVA-IDGATE-1] Legal hold. Spec §10.5.
 *
 * If a CSAM or serious-harm report has been filed against this account, the content
 * and the identity evidence must be PRESERVED, not destroyed. Deleting it may
 * constitute spoliation, and US law generally requires preserving reported CSAM
 * (Cloudflare's own CSAM guidance says one year, not six months).
 *
 * FAILS CLOSED. If we cannot determine whether a hold exists, we do NOT delete.
 * Retaining data one extra day is recoverable. Destroying evidence we were obliged
 * to keep is not.
 */
async function underLegalHold(env: Env, uid: string): Promise<boolean> {
  try {
    const r = await env.DB_META.prepare("SELECT legal_hold, legal_hold_reason FROM users WHERE uid=?1")
      .bind(uid).first<{ legal_hold: number; legal_hold_reason: string | null }>();
    if (Number(r?.legal_hold ?? 0) === 1) {
      try {
        env.ANALYTICS?.writeDataPoint({
          blobs: ["legal_hold_blocked_deletion", uid, r?.legal_hold_reason ?? "unknown"],
          doubles: [1], indexes: ["legal_hold"],
        });
      } catch { /* metrics best-effort */ }
      return true;
    }
    return false;
  } catch (e) {
    console.error("legal_hold lookup failed — refusing to delete (fail closed)", uid, String(e));
    return true;
  }
}

export async function handleDeletion(msg: DeletionMsg, env: Env): Promise<void> {
  const uid = msg.uid;
  if (!uid) return;

  // [AVA-IDGATE-1] Legal hold beats the user's deletion request. Mark the request
  // held rather than failing it, so it neither retries forever nor silently vanishes.
  if (await underLegalHold(env, uid)) {
    console.warn("deletion refused: account under legal hold", uid);
    await env.DB_META.prepare("UPDATE deletion_requests SET status='held' WHERE uid=?1").bind(uid).run().catch(() => {});
    return;
  }

  // [AVA-IDGATE-1] Snapshot the retention decision BEFORE the cascade below destroys
  // the `users` / `clerk_account_link` rows it reads from. Fails PROTECTIVE on error.
  // `keepVideo` is honoured at step 6: on the protective track the liveness video is
  // deleted now; on the extended track it survives until the +256d sweep (retention.ts).
  const retention = await recordDeletionRetention(env, uid);

  // Honor the grace window: if a message arrives early (shouldn't), re-delay.
  const req = await env.DB_META.prepare("SELECT status, scheduled_at, clerk_user_id FROM deletion_requests WHERE uid=?1")
    .bind(uid).first<{ status: string; scheduled_at: number; clerk_user_id: string | null }>();
  if (req && req.status === "cancelled") return;            // user cancelled — abort
  if (req && req.status === "done") return;                 // already processed
  if (req && req.status === "held") return;                 // legal hold — never process
  if (req && Date.now() < req.scheduled_at) throw new Error("grace not elapsed — retry later");

  const clerkId = msg.clerk_user_id ?? req?.clerk_user_id ?? null;
  const pubkeyHex = npubToPubkeyHex(msg);
  const done: string[] = [];

  await env.DB_META.prepare("UPDATE deletion_requests SET status='processing' WHERE uid=?1").bind(uid).run();

  // ---- PRE-COLLECT (before deleting referencing rows) ----
  // Vectorize ids derive from brain entities.
  let vectorIds: string[] = [];
  try {
    const er = await env.DB_BRAIN.prepare("SELECT id FROM brain_entities WHERE uid=?1").bind(uid).all();
    vectorIds = (er.results ?? []).map((r: any) => `${uid}:ent:${r.id}`);
  } catch { /* table may be empty */ }
  // AvaLibrary file vectors: `${uid}:lib:${media_id}:${i}` (i = chunk, bounded ≤8).
  try {
    const lr = await env.DB_MEDIA.prepare("SELECT DISTINCT id FROM user_media WHERE uid=?1").bind(uid).all();
    for (const r of (lr.results ?? []) as any[]) for (let i = 0; i < 8; i++) vectorIds.push(`${uid}:lib:${r.id}:${i}`);
  } catch { /* table may be empty */ }
  // Verification selfie keys (locked R2).
  let verifKeys: string[] = [];
  try {
    const v = await env.DB_META.prepare("SELECT selfie_video_key FROM verification_status WHERE uid=?1 AND selfie_video_key IS NOT NULL").bind(uid).all();
    verifKeys = (v.results ?? []).map((r: any) => r.selfie_video_key).filter(Boolean);
  } catch { /* optional */ }

  // ---- Phase 9 A1: WALLET GATE — pending escrow blocks deletion. ----
  // A balance > 0 after the grace period is FORFEITED (logged); coins held in
  // escrow (an undelivered order) must resolve first → retry later.
  if (env.WALLET_DO) {
    try {
      const res = await env.WALLET_DO.get(env.WALLET_DO.idFromName(uid)).fetch("https://wallet/op", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "balance", uid }),
      });
      const w = (await res.json()) as any;
      if (Number(w.held ?? 0) > 0) throw new Error("pending escrow blocks deletion — retry later");
      if (Number(w.balance ?? 0) > 0) done.push(`wallet_forfeited:${w.balance}`);
    } catch (e) {
      if (String(e).includes("escrow")) throw e;
      /* WalletDO unreachable → proceed (recon catches drift) */
    }
  }

  // 1. DB_BRAIN
  await env.DB_BRAIN.batch([
    env.DB_BRAIN.prepare("DELETE FROM brain_entities WHERE uid=?1").bind(uid),
    env.DB_BRAIN.prepare("DELETE FROM brain_relationships WHERE uid=?1").bind(uid),
    env.DB_BRAIN.prepare("DELETE FROM brain_facts WHERE uid=?1").bind(uid),
    env.DB_BRAIN.prepare("DELETE FROM brain_daily_summaries WHERE uid=?1").bind(uid),
    env.DB_BRAIN.prepare("DELETE FROM brain_events WHERE uid=?1").bind(uid),
  ]); done.push("db_brain");
  // AvaBrain consent toggles.
  try { await env.DB_BRAIN.prepare("DELETE FROM brain_consent WHERE uid=?1").bind(uid).run(); done.push("db_brain_consent"); } catch { /* table optional */ }
  // Phase 9: message/voicemail vector registry + Whisper transcripts (collect
  // ids BEFORE deleting the registry rows).
  try {
    const vr = await env.DB_BRAIN.prepare("SELECT vec_id FROM brain_vectors WHERE uid=?1").bind(uid).all();
    for (const r of (vr.results ?? []) as any[]) vectorIds.push(String(r.vec_id));
    await env.DB_BRAIN.prepare("DELETE FROM brain_vectors WHERE uid=?1").bind(uid).run();
    await env.DB_BRAIN.prepare("DELETE FROM brain_transcripts WHERE uid=?1").bind(uid).run();
    done.push("db_brain_vectors_transcripts");
  } catch { /* tables from brain_phase9.sql */ }

  // 2. DB_WALLET (Phase 2/9). A1: the LEDGER is RETAINED (finance-law retention)
  // with meta anonymized; only PII-bearing side tables are deleted.
  if (env.DB_WALLET) {
    try {
      await env.DB_WALLET.batch([
        // wallet_transactions = the immutable ledger → RETAIN rows, anonymize meta.
        env.DB_WALLET.prepare("UPDATE wallet_transactions SET meta='{\"anonymized\":true}' WHERE uid=?1").bind(uid),
        env.DB_WALLET.prepare("DELETE FROM topup_records WHERE uid=?1").bind(uid),
        env.DB_WALLET.prepare("DELETE FROM earning_holds WHERE uid=?1").bind(uid),
        env.DB_WALLET.prepare("DELETE FROM wallet_balances WHERE uid=?1").bind(uid),
        env.DB_WALLET.prepare("DELETE FROM payout_accounts WHERE uid=?1").bind(uid),
        env.DB_WALLET.prepare("DELETE FROM payout_requests WHERE uid=?1").bind(uid),
      ]); done.push("db_wallet_ledger_retained");
    } catch { /* tables may not exist yet */ }
  }

  // 3. InboxDO (Phase 9 A1) — purge the user's own message log. Peers keep
  // their own side in their own InboxDOs; their conv simply stops updating.
  if (env.INBOX) {
    try {
      await env.INBOX.get(env.INBOX.idFromName(uid)).fetch("https://inbox/purge", { method: "POST" });
      done.push("inbox_do");
    } catch { /* best-effort */ }
  }

  // 4. DB_MEDIA
  await env.DB_MEDIA.batch([
    env.DB_MEDIA.prepare("DELETE FROM user_media WHERE uid=?1").bind(uid),
    env.DB_MEDIA.prepare("DELETE FROM user_media_hashes WHERE uid=?1").bind(uid),
  ]); done.push("db_media");
  // AvaLibrary user folders.
  try { await env.DB_MEDIA.prepare("DELETE FROM library_folders WHERE uid=?1").bind(uid).run(); done.push("db_media_folders"); } catch { /* table optional */ }
  // OLX (Phase 5) — guarded.
  try {
    await env.DB_MEDIA.batch([
      env.DB_MEDIA.prepare("DELETE FROM olx_purchases WHERE buyer_npub=?1 OR seller_npub=?1").bind(uid),
      env.DB_MEDIA.prepare("DELETE FROM olx_digital_products WHERE seller_npub=?1").bind(uid),
      env.DB_MEDIA.prepare("DELETE FROM olx_listings WHERE seller_npub=?1").bind(uid),
    ]); done.push("db_media_olx");
  } catch { /* tables may not exist yet */ }

  // 5. R2 blobs (per-user prefix).
  try { done.push(`r2_blobs:${await deleteR2Prefix(env.BLOBS, `u/${uid}/`)}`); } catch { /* best-effort */ }

  // 6. R2 verification (prefix + explicit keys).
  // [LIVE-PURGE-1] this used to only wipe the transient u/<uid>/ upload prefix —
  // it MISSED the D15 "store everything on pass" retained audit prefix
  // liveness/<uid>/<session>/ (see worker/src/routes/liveness.ts retainEvidence).
  // The immediate-purge path (routes/account.ts, on /api/account/delete) already
  // wipes both prefixes at request time; this stays as a defense-in-depth
  // backstop for the 30-day-grace cascade (e.g. rows created before that fix).
  if (env.VERIFICATION) {
    // Transient upload scratch — always wiped, on every track. Never evidence.
    try { await deleteR2Prefix(env.VERIFICATION, `u/${uid}/`); } catch { /* best-effort */ }

    // [AVA-IDGATE-1] The LIVENESS VIDEO. Retention track decides (spec §10.1):
    //   protective → delete now (IL/TX resident, or residency unknown)
    //   extended   → keep 256 days, then retention.ts:sweepRetention() wipes it
    // Metadata is retained on BOTH tracks in `deleted_account_retention`, so a lawful
    // request can still be answered — who, when, verified how — without the face.
    if (!retention.keepVideo) {
      try { await deleteR2Prefix(env.VERIFICATION, `liveness/${uid}/`); } catch { /* best-effort */ }
      // [LIVE-DIDIT-5] didit.me evidence archive (portrait + clip), its own prefix.
      try { await deleteR2Prefix(env.VERIFICATION, `didit/${uid}/`); } catch { /* best-effort */ }
      try {
        env.ANALYTICS?.writeDataPoint({
          blobs: ["liveness_video_deleted", "account_deleted", retention.track],
          doubles: [1], indexes: ["retention"],
        });
      } catch { /* metrics best-effort */ }
      if (verifKeys.length) { try { await env.VERIFICATION.delete(verifKeys); } catch { /* best-effort */ } }
    } else {
      console.log("retention: extended track — liveness video held until purge_after", uid);
    }
    done.push(`r2_verification:${retention.track}`);
  }

  // 6b. R2 digital goods (OLX seller files) — guarded.
  if (env.DIGITAL) { try { await deleteR2Prefix(env.DIGITAL, `u/${uid}/`); done.push("r2_digital"); } catch { /* best-effort */ } }

  // 7. R2 agent-audio (Phase 8) — guarded.
  if (env.AGENT_AUDIO) { try { await deleteR2Prefix(env.AGENT_AUDIO, `u/${uid}/`); done.push("r2_agent_audio"); } catch { /* best-effort */ } }

  // 8. DB_MODERATION — drop the user's own reports (keep reports filed AGAINST others).
  try { await env.DB_MODERATION.prepare("DELETE FROM user_reports WHERE reporter_npub=?1").bind(uid).run(); done.push("db_moderation"); } catch { /* optional */ }

  // 9. DB_META — identity, social, settings, verification, deletion bookkeeping last.
  const metaStmts = [
    // [DEL-USERS-TABLE-1] The identity row lives in `users` — `profiles` never
    // existed in prod, so the old DELETE silently no-oped and the user's
    // name/bio/avatar/number survived the wipe (found 2026-07-09). Keep the
    // `profiles` statement for any environment that still has that table.
    "DELETE FROM users WHERE uid=?1",
    "DELETE FROM profiles WHERE uid=?1",
    "DELETE FROM contact_phone_index WHERE uid=?1",
    "DELETE FROM follows WHERE uid=?1 OR follows_npub=?1",
    "DELETE FROM blocks WHERE uid=?1 OR blocked_npub=?1",
    "DELETE FROM mutes WHERE uid=?1 OR muted_npub=?1",
    "DELETE FROM user_settings WHERE uid=?1",
    "DELETE FROM push_tokens_v2 WHERE uid=?1",
    "DELETE FROM community_members WHERE uid=?1",
    "DELETE FROM communities WHERE owner_npub=?1",
    "DELETE FROM account_strikes WHERE uid=?1",
    "DELETE FROM live_streams WHERE uid=?1",
    "DELETE FROM notifications WHERE uid=?1",
    "DELETE FROM verification_status WHERE uid=?1",
    "DELETE FROM verification_attempts WHERE uid=?1",
    "DELETE FROM liveness_didit_records WHERE uid=?1", // [LIVE-DIDIT-5] our didit check records
    "DELETE FROM identity_proofs WHERE uid=?1 AND proof='liveness'", // [LIVE-PURGE-1]
    "DELETE FROM calendar_slots WHERE uid=?1",
    // A1: bookings/orders KEEP their rows (the counterparty + finance need
    // them) — the deleted party's id is replaced, so nothing is findable by uid.
    "UPDATE calendar_events SET host_npub='deleted_user' WHERE host_npub=?1",
    "UPDATE calendar_events SET attendee_npub='deleted_user' WHERE attendee_npub=?1",
    "UPDATE bookings SET creator_id='deleted_user', updated_at=strftime('%s','now')*1000 WHERE creator_id=?1",
    "UPDATE bookings SET buyer_id='deleted_user', updated_at=strftime('%s','now')*1000 WHERE buyer_id=?1",
    "DELETE FROM availability_rules WHERE user_id=?1",
    "DELETE FROM booking_policies WHERE user_id=?1",
    "DELETE FROM calendar_blocks WHERE user_id=?1",
    // gcal OAuth tokens (A1 store map).
    "DELETE FROM gcal_accounts WHERE user_id=?1",
    // Marketplace (Phase 6, guarded — tables may not exist yet): listings go,
    // reviews stay anonymized ("deleted user").
    "DELETE FROM listings WHERE creator_id=?1",
    "UPDATE reviews SET author_id='deleted_user' WHERE author_id=?1",
    "DELETE FROM creator_profiles WHERE uid=?1",
    "DELETE FROM agent_personas WHERE uid=?1",
    "DELETE FROM agent_conversations WHERE uid=?1",
    "DELETE FROM agent_inbox WHERE uid=?1",
    "DELETE FROM user_vault WHERE uid=?1",
    "DELETE FROM clerk_nostr_link WHERE uid=?1",
    "DELETE FROM account_status WHERE uid=?1",
  ];
  for (const q of metaStmts) { try { await env.DB_META.prepare(q).bind(uid).run(); } catch { /* table may not exist in this phase */ } }
  done.push("db_meta");

  // 10. Vectorize.
  if (env.VECTOR_INDEX && vectorIds.length) {
    try { for (let i = 0; i < vectorIds.length; i += 1000) await env.VECTOR_INDEX.deleteByIds(vectorIds.slice(i, i + 1000)); done.push(`vectorize:${vectorIds.length}`); } catch { /* best-effort */ }
  }

  // 10b. AI Search shard docs — delete per item id (CF has no delete-by-folder).
  //      ava_search_items records each doc's shard, so we group by shard and
  //      delete by id without recomputing the hash. ava_search_shard_stats is
  //      decremented for capacity telemetry. See PROPOSAL-AI-SEARCH-SHARDING.md.
  if (env.AI_SEARCH) {
    try {
      const rows = await env.DB_META
        .prepare("SELECT shard, item_id FROM ava_search_items WHERE uid=?1")
        .bind(uid).all<{ shard: string; item_id: string }>();
      const byShard = new Map<string, string[]>();
      for (const r of (rows.results ?? []) as any[]) {
        if (!byShard.has(r.shard)) byShard.set(r.shard, []);
        byShard.get(r.shard)!.push(r.item_id);
      }
      let aiDeleted = 0;
      for (const [shard, ids] of byShard) {
        let inst: any = null;
        try { inst = await (env.AI_SEARCH as any).get(shard); } catch { inst = null; }
        if (!inst) continue;
        for (const id of ids) { try { await inst.items.delete(id); aiDeleted++; } catch { /* keep going */ } }
        try {
          await env.DB_META
            .prepare("UPDATE ava_search_shard_stats SET item_count=MAX(0,item_count-?2), updated_at=?3 WHERE shard=?1")
            .bind(shard, ids.length, Date.now()).run();
        } catch { /* best-effort */ }
      }
      try { await env.DB_META.prepare("DELETE FROM ava_search_items WHERE uid=?1").bind(uid).run(); } catch { /* best-effort */ }
      done.push(`ai_search:${aiDeleted}`);
    } catch { /* best-effort */ }
  }

  // 11. KV — verified cache + any per-user ephemeral keys.
  try { await env.TOKENS.delete(`verified:${uid}`); done.push("kv"); } catch { /* best-effort */ }

  // 12. DOs — UserBrain / Agent / Conversation DOs self-expire (hibernate to nothing);
  //     no API to enumerate by name. Cleared on next access as empty. (Marked noted.)
  done.push("dos_noted");

  // 13. Clerk user (Backend API) — guarded.
  // [ACCT-RELINK-1] Deleting the Clerk user is IRREVERSIBLE and, once done, the same
  // person signing back in gets a brand-new Clerk id that no longer matches this
  // account (root cause of the "re-onboarded / lost my number" report). Re-check the
  // deletion request one last time here: if the user reactivated (cancelled) at any
  // point AFTER the top-of-function check but before now, abort the whole cascade
  // rather than destroy the identity out from under a returning user.
  {
    const still = await env.DB_META.prepare("SELECT status FROM deletion_requests WHERE uid=?1")
      .bind(uid).first<{ status: string }>();
    if (still && still.status === "cancelled") return; // reactivated mid-cascade — do NOT delete the Clerk user
  }
  if (env.CLERK_SECRET_KEY && clerkId) {
    try {
      const r = await fetch(`https://api.clerk.com/v1/users/${clerkId}`, { method: "DELETE", headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}` } });
      // [DEL-LOUD-FAIL-1] Record failures instead of vanishing them — a Clerk
      // user that survives the cascade lets the person log back into a
      // supposedly-deleted account (found 2026-07-09).
      if (r.ok || r.status === 404) done.push("clerk"); else done.push(`clerk_failed:${r.status}`);
    } catch { done.push("clerk_error"); }
  } else {
    // Secret missing entirely — surface it in stores_done so it's visible.
    done.push(clerkId ? "clerk_skipped_no_secret" : "clerk_skipped_no_id");
  }

  // 14. PostHog person — guarded.
  if (env.POSTHOG_PERSONAL_API_KEY && env.POSTHOG_PROJECT_ID) {
    try {
      // [DEL-POSTHOG-EU-1] Project lives on EU cloud — us.posthog.com always
      // 404'd here. Also check the response instead of blindly claiming success.
      const pr = await fetch(`https://eu.posthog.com/api/projects/${env.POSTHOG_PROJECT_ID}/persons/?distinct_id=${encodeURIComponent(uid)}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${env.POSTHOG_PERSONAL_API_KEY}` },
      });
      if (pr.ok || pr.status === 404) done.push("posthog"); else done.push(`posthog_failed:${pr.status}`);
    } catch { done.push("posthog_error"); }
  }

  // 15. Stripe customer (Phase 2) — guarded. Customer id lookup lives in wallet rows
  //     (already deleted), so this is a no-op placeholder until Phase 2 wires it.
  if (env.STRIPE_SECRET_KEY) done.push("stripe_noted");

  await env.DB_META.prepare("UPDATE deletion_requests SET status='done', processed_at=?2, stores_done=?3 WHERE uid=?1")
    .bind(uid, Date.now(), JSON.stringify(done)).run();
  try { env.ANALYTICS?.writeDataPoint({ blobs: ["account_deletion", uid.slice(0, 16)], doubles: [done.length], indexes: ["account_deletion"] }); } catch { /* best-effort */ }
  // Lifecycle PostHog event (5 required fields).
  try {
    await env.Q_ANALYTICS?.send({ event: "account_deleted", uid, ts: Date.now(), props: { stores: done.length, trace_id: crypto.randomUUID(), app_name: "platform", app_version: "server", service_name: "avatok-consumers" } });
  } catch { /* best-effort */ }
}
