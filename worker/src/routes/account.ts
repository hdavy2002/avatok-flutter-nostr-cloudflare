// Account lifecycle (Phase 1, §10.5). Right-to-erasure with a 30-day grace window.
//   POST /api/account/delete        → schedule deletion (grace = now+30d), enqueue
//   POST /api/account/delete/cancel  → cancel during the grace window
// The actual 15-store cascade runs in the account-deletions queue consumer
// (avatok-consumers/src/deletion.ts) so it can take its time and retry. We enqueue
// immediately AND record a deletion_requests row; the cron also sweeps matured rows
// as a safety net if the enqueue is ever lost.
import type { Env } from "../types";
import { json } from "../util";
import { authenticate, isErr, setVerifiedCache } from "../auth";
import { metaDb } from "../db/shard";
import { track } from "../hooks";

const GRACE_MS = 30 * 86_400_000; // 30-day grace (§10.5)

export async function deleteAccount(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const npub = auth.npub;
  const now = Date.now();
  const scheduled = now + GRACE_MS;

  const link = await env.DB_META.prepare("SELECT clerk_user_id FROM clerk_nostr_link WHERE npub=?1")
    .bind(npub).first<{ clerk_user_id: string }>();
  const clerkId = link?.clerk_user_id ?? auth.clerkUserId ?? null;

  await metaDb(env).prepare(
    `INSERT INTO deletion_requests (npub, clerk_user_id, pubkey_hex, requested_at, scheduled_at, status)
     VALUES (?1,?2,?3,?4,?5,'pending')
     ON CONFLICT(npub) DO UPDATE SET status='pending', clerk_user_id=?2, pubkey_hex=?3, requested_at=?4, scheduled_at=?5, processed_at=NULL`,
  ).bind(npub, clerkId, auth.pubkeyHex, now, scheduled).run();

  // Drop the Tier-2 cache during grace (re-granted on cancel via re-verify path).
  // The pending state is the deletion_requests row itself (account_status is keyed
  // by clerk_user_id, not npub, so we don't write a soft-suspend row here).
  await setVerifiedCache(env, npub, false);

  // Enqueue for the cascade consumer; it honors scheduled_at (re-delays if early).
  try { await env.Q_DELETE.send({ npub, clerk_user_id: clerkId, pubkey_hex: auth.pubkeyHex, scheduled_at: scheduled }); } catch { /* cron sweep is the backstop */ }

  track(env, npub, "account_deletion_requested", "platform", { scheduled_at: scheduled });
  return json({ scheduled: true, npub, grace_ends_at: scheduled, cancellable: true });
}

export async function cancelDeletion(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const row = await env.DB_META.prepare("SELECT status FROM deletion_requests WHERE npub=?1")
    .bind(auth.npub).first<{ status: string }>();
  if (!row || row.status !== "pending") return json({ error: "no cancellable deletion request" }, 404);

  await metaDb(env).prepare("UPDATE deletion_requests SET status='cancelled', processed_at=?2 WHERE npub=?1")
    .bind(auth.npub, Date.now()).run();
  track(env, auth.npub, "account_deletion_cancelled", "platform", {});
  return json({ cancelled: true });
}
