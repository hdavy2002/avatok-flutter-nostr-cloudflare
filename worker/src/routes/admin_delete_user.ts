// [ADMIN-DELETE-USER-1] Admin-driven, IMMEDIATE right-to-erasure for ANOTHER user.
//
// ⚠️ DESTRUCTIVE + ADMIN-DIRECTED. This runs the SAME 15-store deletion cascade the
// self-serve flow (`routes/account.ts` deleteAccount → Q_DELETE → consumers/deletion.ts)
// uses, but for a TARGET uid supplied by an admin, and with NO 30-day grace: the
// deletion_requests row is written with `scheduled_at = now`, so the queue consumer's
// grace gate (`if (Date.now() < req.scheduled_at) throw "grace not elapsed"`) is
// already satisfied and the cascade runs on the first delivery. The cascade deletes
// the Clerk identity too (consumers/deletion.ts step 13), so the target cannot simply
// log back in.
//
//   POST /api/admin/delete-user[/:secret]   body {uid, force?, note?} or ?uid=
//     [HF-TOK-EXIT-1] With hfTokensEnabled on, a user who is on a call or still has money (unspent purchased tokens, host earnings, an open payout or
//     refund) is NOT deleted: 409 money_remains with the summary. {force:true, note:"why (5+ characters)"} deletes anyway and is audit-logged.
//     Auth: ADMIN_UIDS Clerk bearer (requireAdmin) on the bare path, OR the
//     shared-secret trailing path segment (env.ADMIN_DELETE_SECRET — fails CLOSED
//     when unset), mirroring routes/token_reset.ts so it can be driven from the host
//     shell. Returns { ok, uid, enqueued, immediate:true }.
//
// HARD SAFETY GUARD: refuses (403) to delete any uid listed in env.ADMIN_UIDS — an
// admin must never delete an admin account through this endpoint.
import type { Env } from "../types";
import { json } from "../util";
import { setVerifiedCache } from "../auth";
import { metaDb } from "../db/shard";
import { track, trackException } from "../hooks";
import { requireAdmin } from "./admin_money";
import { enqueueMem0Purge } from "../sentinel/purge";
import { enqueueDeletion } from "./account"; // [DYNW-FLOWS-1] shared queue/WF_DELETION dispatch (deletionWorkflowEnabled)
import { exitSummary } from "../lib/hf_exit"; // [HF-TOK-EXIT-1]
import { hfTokensOn } from "../lib/hf_exit_tokens";
import { hasActiveCall } from "../lib/hf_play_refunds";

function adminUids(env: Env): string[] {
  return (env.ADMIN_UIDS ?? "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

// POST /api/admin/delete-user[/:secret]  body {uid} or ?uid=
export async function adminDeleteUser(req: Request, env: Env, secret?: string): Promise<Response> {
  // --- AUTH: shared-secret trailing segment OR Clerk admin bearer (mirrors token_reset). ---
  let actor = "admin_secret";
  if (secret !== undefined) {
    // Trailing-path-segment path: fail CLOSED when the secret is unset.
    if (!env.ADMIN_DELETE_SECRET || secret !== env.ADMIN_DELETE_SECRET) {
      return json({ error: "forbidden" }, 403);
    }
  } else {
    const a = await requireAdmin(req, env);
    if (a instanceof Response) return a;
    actor = a.uid;
  }

  // --- Resolve the target uid from JSON body {uid} or ?uid= (email NOT required). ---
  const url = new URL(req.url);
  let uid = (url.searchParams.get("uid") || "").trim();
  const body = (await req.json().catch(() => ({}))) as { uid?: unknown; force?: unknown; note?: unknown };
  if (!uid) uid = String(body?.uid ?? "").trim();
  const force = body?.force === true;
  const note = String(body?.note ?? "").trim().slice(0, 300);
  if (!uid) return json({ error: "uid required (body {uid} or ?uid=)" }, 400);

  // --- HARD SAFETY GUARD: never delete an admin account through this endpoint. ---
  if (adminUids(env).includes(uid)) {
    return json({ error: "refused: target uid is an admin account (ADMIN_UIDS) — cannot be deleted via this endpoint", uid }, 403);
  }

  // [HF-TOK-EXIT-1] Pay-out-first for tokens: the same money rule as a person closing their own account (lib/hf_exit exitSummary).
  if (await hfTokensOn(env)) {
    let money = false, active = false, summary: Record<string, unknown> = {};
    try {
      active = await hasActiveCall(env, uid);
      const s = await exitSummary(env, uid);
      money = s.hasMoney;
      summary = { refundableRupees: s.refundable, withdrawableRupees: s.withdrawable, heldRupees: s.held, openPayouts: s.openPayouts, openRefunds: s.openRefunds, testCreditsRupees: s.testCredits };
    } catch (err) {
      void trackException(env, err, { uid: actor, route: "/api/admin/delete-user", method: "POST", handled: true, app_name: "platform", extra: { target_uid: uid, step: "money_check" } });
      return json({ ok: false, uid, error: "money_check_failed", message: "Could not check this user's money. Nothing was deleted." }, 503);
    }
    if (active || money) {
      if (!(force && note.length >= 5)) {
        return json({
          ok: false, uid, error: "money_remains", activeCall: active, summary,
          message: active ? "This user is on a call. Nothing was deleted." : "This user still has money to settle. Nothing was deleted.",
          hint: "Ask them to close the account from /account/close so the money is paid out first, or send force:true with a note of at least 5 characters to delete anyway (audit-logged).",
        }, 409);
      }
      try {
        await env.DB_WALLET.prepare("INSERT INTO admin_audit (id, admin_id, action, target, meta, created_at) VALUES (?1,?2,?3,?4,?5,?6)")
          .bind(crypto.randomUUID(), actor, "admin_delete_user_force_money", uid, JSON.stringify({ note, activeCall: active, summary }), Date.now()).run();
      } catch { /* the track event below is the second record */ }
      track(env, actor, "admin_user_deleted_with_money", "platform", { target_uid: uid, note, active_call: active, ...summary });
    }
  }

  try {
    const now = Date.now();
    // Immediate: scheduled_at = now means the consumer's grace gate is already
    // satisfied on first delivery, so the cascade runs NOW (no 30-day wait). uid IS
    // the Clerk user id in this system (Nostr deprecated), so clerk_user_id=uid — the
    // cascade will delete the Clerk identity (deletion.ts step 13).
    await metaDb(env).prepare(
      `INSERT INTO deletion_requests (uid, clerk_user_id, pubkey_hex, requested_at, scheduled_at, status)
       VALUES (?1,?2,NULL,?3,?4,'pending')
       ON CONFLICT(uid) DO UPDATE SET status='pending', clerk_user_id=?2, requested_at=?3, scheduled_at=?4, processed_at=NULL`,
    ).bind(uid, uid, now, now).run();

    // Drop any cached verified flag (same as the self-serve flow).
    await setVerifiedCache(env, uid, false).catch(() => {});

    // Best-effort mem0 behaviour-memory purge — DETACHED, never blocks deletion.
    void enqueueMem0Purge(env, uid).catch(() => {});

    // Enqueue for the cascade (queue consumer, or the dark WF_DELETION Workflow
    // behind deletionWorkflowEnabled — see routes/account.ts enqueueDeletion). It
    // honors scheduled_at (now → runs immediately) either way.
    await enqueueDeletion(env, { uid, clerk_user_id: uid, scheduled_at: now });

    // Telemetry: actor + target on one auditable event.
    track(env, actor, "admin_user_deleted", "platform", { target_uid: uid, immediate: true, scheduled_at: now });
    return json({ ok: true, uid, enqueued: true, immediate: true });
  } catch (err) {
    void trackException(env, err, { uid: actor, route: "/api/admin/delete-user", method: "POST", handled: true, app_name: "platform", extra: { target_uid: uid } });
    return json({ ok: false, uid, error: "delete enqueue failed" }, 500);
  }
}
