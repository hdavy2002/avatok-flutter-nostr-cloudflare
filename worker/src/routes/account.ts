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
// [SENTINEL-MEM0-PURGE] Guardian Sentinel S2 — best-effort mem0 behaviour-memory
// purge. Enqueue + retry asynchronously; NEVER blocks canonical deletion (plan §1.1
// rule 5: an external SaaS can never block account deletion). No-ops without a key.
import { enqueueMem0Purge } from "../sentinel/purge";

// [ACCT-RELINK-1] Reverted the [TEMP-1H-GRACE] test hack back to the spec's 30-day
// grace (§10.5). The 1-hour window let the deletion cascade mature and DELETE the
// Clerk user within an hour of a test delete; the same person signing back in then
// got a brand-new Clerk id, orphaning their account + number (root cause of the
// "re-onboarded / choose a new number" report). 30 days gives a returning user room
// to reactivate before anything is destroyed; email relink in /api/me covers the rest.
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

  // [LIVE-PURGE-2] Owner decision 2026-07-08: verification/liveness evidence is
  // NO LONGER purged at request time. It is wiped by the 30-day-grace cascade
  // (consumers/deletion.ts already deletes BOTH the u/<uid>/ and liveness/<uid>/
  // R2 prefixes and the identity_proofs liveness row — a full superset of the old
  // immediate purge). Rationale: deletion is now cancellable AND reactivatable on
  // log-back-in, so a user who returns within the grace keeps their verification
  // instead of being downgraded to "needs re-verify". The delete dialog already
  // says evidence is wiped "after a 30-day grace period", so this matches the UI.

  // [SENTINEL-MEM0-PURGE] Queue a mem0 behaviour-memory purge and move on. This is
  // best-effort and DETACHED — canonical deletion must never wait on an external SaaS
  // (plan §1.1 rule 5). The row is drained/retried with backoff by
  // processPurgeQueue (called opportunistically from the Sentinel summariser).
  // No-ops cleanly if MEM0_API_KEY is unset; the queue row is a derived record only
  // (mem0 holds no owner-of-truth data — the account's evidence log is wiped by the
  // canonical cascade regardless).
  void enqueueMem0Purge(env, ctx.uid).catch(() => {});

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

// GET/POST /api/account/deletion-status → is this account in the 30-day grace?
// Read-only reconcile probe the client calls right after ANY successful sign-in
// (Google, email-OTP, password) so it can tell the user "this account is scheduled
// for deletion — logging in reactivates it" and offer to cancel via
// /api/account/delete/cancel. `pending` is true only while a request is still
// `pending` AND the grace hasn't elapsed.
export async function deletionStatus(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const row = await env.DB_META.prepare("SELECT status, scheduled_at FROM deletion_requests WHERE uid=?1")
    .bind(ctx.uid).first<{ status: string; scheduled_at: number }>();
  const pending = !!row && row.status === "pending" && Date.now() < row.scheduled_at;
  return json({ pending, status: row?.status ?? null, grace_ends_at: pending ? row!.scheduled_at : null });
}
