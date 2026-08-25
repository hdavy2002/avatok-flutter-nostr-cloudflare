// Notification producer for the async layer (consumers). Persists to the feed
// (D1) + wakes the app via FCM/APNs. No realtime-socket delivery here (background
// events; the user sees them on open or via push) — the API Worker handles
// realtime for synchronous actions like wallet/payment.
import type { Env } from "./types";
import { handlePush } from "./fcm";

export async function notifyUser(
  env: Env,
  uid: string,
  n: { type: string; title: string; body?: string; data?: Record<string, unknown> },
  opts?: { id?: string; push?: boolean },
): Promise<void> {
  let inserted = true;
  try {
    const result = await env.DB_META.prepare(
      "INSERT OR IGNORE INTO notifications (id, uid, type, title, body, data, read, created_at) VALUES (?1,?2,?3,?4,?5,?6,0,?7)",
    ).bind(opts?.id ?? crypto.randomUUID(), uid, n.type, n.title, n.body ?? null, n.data ? JSON.stringify(n.data) : null, Date.now()).run();
    inserted = Number(result.meta?.changes ?? 1) !== 0;
  } catch { /* feed best-effort */ }
  if (inserted && opts?.push !== false) {
    try { await handlePush({ kind: "notify", to_uid: uid, fromName: n.title, title: n.title, body: n.body, data: n.data }, env); } catch { /* push best-effort */ }
  }
}
