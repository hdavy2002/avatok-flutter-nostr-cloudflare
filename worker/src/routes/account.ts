// Account lifecycle (§10.5). Right-to-erasure with a 30-day grace window.
//   POST /api/account/delete        → schedule deletion (grace = now+30d), enqueue
//   POST /api/account/delete/cancel  → cancel during the grace window
// The 15-store cascade runs in the account-deletions queue consumer; we enqueue
// immediately AND record a deletion_requests row (cron sweeps matured rows as a
// safety net). Identity is the Clerk uid (Nostr deprecated — no pubkey/relay cleanup).
import type { Env } from "../types";
import { json } from "../util";
import { setVerifiedCache } from "../auth";
import { requireUser, isFail } from "../authz";
import { metaDb } from "../db/shard";
import { track } from "../hooks";
import { purgeLivenessEvidence } from "./liveness_audit";

const GRACE_MS = 30 * 86_400_000; // 30-day grace (§10.5)

export async function deleteAccount(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const now = Date.now();
  const scheduled = now + GRACE_MS;

  await metaDb(env).prepare(
    `INSERT INTO deletion_requests (uid, clerk_user_id, pubkey_hex, requested_at, scheduled_at, status)
     VALUES (?1,?2,NULL,?3,?4,'pending')
     ON CONFLICT(uid) DO UPDATE SET status='pending', clerk_user_id=?2, requested_at=?3, scheduled_at=?4, processed_at=NULL`,
  ).bind(ctx.uid, ctx.uid, now, scheduled).run();

  // Drop any cached verified flag during grace.
  await setVerifiedCache(env, ctx.uid, false);

  // [LIVE-PURGE-1] The identity-verification UI promises "your video is erased
  // the moment you close your account" — that can't wait for the 30-day grace
  // cascade (consumers/deletion.ts only wipes the transient u/<uid>/ prefix
  // anyway, not the D15 retained liveness/<uid>/ audit prefix). Purge liveness
  // evidence immediately, best-effort, at request time — everything else in the
  // account still honors the 30-day grace/cancel window.
  // TRADE-OFF: if the user cancels within the grace window (cancelDeletion
  // below), their account is fully restored EXCEPT liveness evidence, which is
  // already gone — a cancel-and-restore user would need to re-verify. This is
  // the deliberate cost of honoring the "erased the moment you close your
  // account" promise literally rather than only after the 30-day grace elapses.
  void purgeLivenessEvidence(env, ctx.uid).catch(() => {});

  // Enqueue for the cascade consumer; it honors scheduled_at (re-delays if early).
  try { await env.Q_DELETE.send({ uid: ctx.uid, clerk_user_id: ctx.uid, scheduled_at: scheduled }); } catch { /* cron sweep is the backstop */ }

  track(env, ctx.uid, "account_deletion_requested", "platform", { scheduled_at: scheduled });
  return json({ scheduled: true, uid: ctx.uid, grace_ends_at: scheduled, cancellable: true });
}

export async function cancelDeletion(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const row = await env.DB_META.prepare("SELECT status FROM deletion_requests WHERE uid=?1")
    .bind(ctx.uid).first<{ status: string }>();
  if (!row || row.status !== "pending") return json({ error: "no cancellable deletion request" }, 404);

  await metaDb(env).prepare("UPDATE deletion_requests SET status='cancelled', processed_at=?2 WHERE uid=?1")
    .bind(ctx.uid, Date.now()).run();
  track(env, ctx.uid, "account_deletion_cancelled", "platform", {});
  return json({ cancelled: true });
}
