// [HF-FIX-HANDLE-1] Every user of the call app has a handle, shown read-only.
//
// A chosen username lives in hf_user_registration (immutable). Users who never
// finished registration have none, which left the dashboard Handle box empty
// and locked. Owner decision 2026-10-23: anyone without a handle gets an
// auto-generated one, using the same machinery as the web handles
// (lib/handles.ts ensureHandle -> users.handle: idempotent, never overwrites,
// conditional UPDATE so a race cannot clobber, UNIQUE collisions retried).
//
// Lazy: called from GET /api/hf/me and GET /api/hf/me/profile. Never throws.
import type { Env } from "../types";
import { ensureHandle } from "./handles";
import { track, trackException } from "../hooks";
import { BRAND } from "./brand";

const APP = BRAND.slug;

/** The handle to show for [uid]: the registered username if any, else the
 *  users.handle (assigned now when still missing). Null only when the user has
 *  no users row yet or assignment failed (the UI shows a placeholder). */
export async function resolveHfHandle(env: Env, uid: string, registered: string | null | undefined): Promise<string | null> {
  if (registered) return registered;
  try {
    const row = await env.DB_META.prepare("SELECT handle FROM users WHERE uid=?1").bind(uid).first<{ handle: string | null }>();
    if (!row) return null;
    if (row.handle) return row.handle;
    const handle = await ensureHandle(env, uid);
    if (handle) {
      void track(env, uid, "hf_handle_auto_assigned", APP, { outcome: "ok", handle_length: handle.length });
    } else {
      void track(env, uid, "hf_handle_auto_assigned", APP, { outcome: "failed", reason: "no_candidate" });
    }
    return handle;
  } catch (e) {
    void track(env, uid, "hf_handle_auto_assigned", APP, { outcome: "failed", reason: "error" });
    await trackException(env, e, { uid, route: "hf_handle", handled: true, app_name: APP, extra: { area: "hf_handle" } }).catch(() => {});
    return null;
  }
}
