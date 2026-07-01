// System notification producer. Persists to the user's feed (D1), delivers
// realtime to any open app (relay inbox DO over the existing socket), and wakes a
// backgrounded app via push (Q_PUSH → FCM/APNs). NOT chat, NOT E2E — these are
// server-originated alerts (wallet, payments, moderation, briefings, social).
import type { Env } from "./types";
import { metaDb } from "./db/shard";

export interface Notice {
  type: string;          // wallet|system|moderation|social|brain|payment
  title: string;
  body?: string;
  data?: Record<string, unknown>; // e.g. { amount: 30, currency: "INR", deeplink: "/wallet" }
}

export async function notifyUser(
  env: Env, uid: string, n: Notice, opts?: { push?: boolean },
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await metaDb(env).prepare(
    "INSERT INTO notifications (id, uid, type, title, body, data, read, created_at) VALUES (?1,?2,?3,?4,?5,?6,0,?7)",
  ).bind(id, uid, n.type, n.title, n.body ?? null, n.data ? JSON.stringify(n.data) : null, now).run();

  // The in-app feed (D1, above) always records the alert. The FCM WAKE is
  // OPTIONAL: agent↔agent (marketplace) results are delivered over the live
  // socket + PartyKit deal_ready (owner decision 2026-07-01 — no FCM for those),
  // so those callers pass {push:false} to keep the bell entry WITHOUT a push.
  // That stray notify was also what kept re-triggering the marketplace crash.
  if (opts?.push !== false) {
    try { await env.Q_PUSH.send({ kind: "notify", to: uid, fromName: n.title }); } catch { /* best-effort */ }
  }

  return id;
}
