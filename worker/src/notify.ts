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

export async function notifyUser(env: Env, npub: string, n: Notice): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await metaDb(env).prepare(
    "INSERT INTO notifications (id, npub, type, title, body, data, read, created_at) VALUES (?1,?2,?3,?4,?5,?6,0,?7)",
  ).bind(id, npub, n.type, n.title, n.body ?? null, n.data ? JSON.stringify(n.data) : null, now).run();

  const payload = { id, type: n.type, title: n.title, body: n.body ?? "", data: n.data ?? {}, created_at: now };

  // Realtime to an open app (best-effort; the user may be offline).
  try {
    await env.RELAY.get(env.RELAY.idFromName(npub)).fetch("https://relay/notify", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    });
  } catch { /* not connected — push + feed-on-open cover it */ }

  // Background wake (app closed).
  try { await env.Q_PUSH.send({ kind: "notify", to: npub, fromName: n.title }); } catch { /* best-effort */ }

  return id;
}
