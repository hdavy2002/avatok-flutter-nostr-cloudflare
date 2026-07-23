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
//   POST /api/admin/delete-user[/:secret]   body {uid} or ?uid=
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
  if (!uid) {
    const b = (await req.json().catch(() => ({}))) as { uid?: unknown };
    uid = String(b?.uid ?? "").trim();
  }
  if (!uid) return json({ error: "uid required (body {uid} or ?uid=)" }, 400);

  // --- HARD SAFETY GUARD: never delete an admin account through this endpoint. ---
  if (adminUids(env).includes(uid)) {
    return json({ error: "refused: target uid is an admin account (ADMIN_UIDS) — cannot be deleted via this endpoint", uid }, 403);
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

    // Enqueue for the cascade consumer; it honors scheduled_at (now → runs immediately).
    await env.Q_DELETE.send({ uid, clerk_user_id: uid, scheduled_at: now });

    // Telemetry: actor + target on one auditable event.
    track(env, actor, "admin_user_deleted", "platform", { target_uid: uid, immediate: true, scheduled_at: now });
    return json({ ok: true, uid, enqueued: true, immediate: true });
  } catch (err) {
    void trackException(env, err, { uid: actor, route: "/api/admin/delete-user", method: "POST", handled: true, app_name: "platform", extra: { target_uid: uid } });
    return json({ ok: false, uid, error: "delete enqueue failed" }, 500);
  }
}
