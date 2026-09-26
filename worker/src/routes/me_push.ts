// [DASH2-PUSH 2026-09-26] Web Push subscription routes for Saa Thum Dashboard 2.
//   GET  /api/me/push/public-key            -> { enabled, public_key }
//   POST /api/me/push/subscribe   {endpoint, keys:{p256dh, auth}} -> { ok }   (also sets notify.push=true)
//   POST /api/me/push/unsubscribe {endpoint}                       -> { ok, remaining }
// Clerk auth; every row is scoped to the caller's uid. Sending lives in lib/web_push.ts.
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { trackException } from "../hooks";
import { vapidFromEnv, validSubscriptionKeys, type PushEnv } from "../lib/web_push";

const APP = "saathum";
const MAX_SUBS_PER_UID = 10;
const DEFAULT_NOTIFY = { push: false, email: true, whatsapp: false };

const err = (status: number, error: string, message: string) => json({ error, message }, status);

async function authed(req: Request, env: PushEnv): Promise<{ uid: string } | Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return err(ctx.status, ctx.status === 401 ? "unauthorized" : ctx.error, "Please sign in again.");
  return { uid: ctx.uid };
}

async function body(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (text.length > 4096) return null;
  try {
    const v = JSON.parse(text || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

/** A push-service endpoint: https, sane length. */
export function validEndpoint(v: unknown): v is string {
  if (typeof v !== "string" || v.length < 12 || v.length > 1024) return false;
  try { return new URL(v).protocol === "https:"; } catch { return false; }
}

async function setNotifyPush(env: PushEnv, uid: string, on: boolean, now: number): Promise<void> {
  const db = env.DB_META;
  const cur = await db.prepare("SELECT notify_json FROM user_profile_extras WHERE uid=?1").bind(uid).first<{ notify_json: string | null }>();
  let prev: Record<string, unknown> = {};
  try { prev = cur?.notify_json ? JSON.parse(cur.notify_json) : {}; } catch { prev = {}; }
  const notify = JSON.stringify({ ...DEFAULT_NOTIFY, ...prev, push: on });
  await db.prepare(
    `INSERT INTO user_profile_extras (uid, notify_json, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(uid) DO UPDATE SET notify_json=excluded.notify_json, updated_at=excluded.updated_at`,
  ).bind(uid, notify, now).run();
}

export async function mePushRoute(req: Request, env: PushEnv, p: string): Promise<Response | null> {
  const m = req.method;
  try {
    if (p === "/api/me/push/public-key" && m === "GET") {
      const a = await authed(req, env); if (a instanceof Response) return a;
      const v = vapidFromEnv(env);
      return json({ enabled: !!v, public_key: v?.publicKey ?? null }, 200, { "cache-control": "private, no-store" });
    }
    if (p === "/api/me/push/subscribe" && m === "POST") {
      const a = await authed(req, env); if (a instanceof Response) return a;
      const b = await body(req);
      if (!b) return err(400, "invalid_request", "Send a JSON body.");
      const keys = (b.keys ?? {}) as Record<string, unknown>;
      if (!validEndpoint(b.endpoint)) return err(400, "invalid_endpoint", "That push subscription is not valid.");
      if (!validSubscriptionKeys(keys.p256dh, keys.auth)) return err(400, "invalid_keys", "That push subscription is not valid.");
      const db = env.DB_META, now = Date.now();
      // Upsert by endpoint: a browser endpoint moves to whoever subscribed last on that device.
      await db.prepare(
        `INSERT INTO push_subscriptions (id, uid, endpoint, p256dh, auth, created_at) VALUES (?1,?2,?3,?4,?5,?6)
         ON CONFLICT(endpoint) DO UPDATE SET uid=excluded.uid, p256dh=excluded.p256dh, auth=excluded.auth, created_at=excluded.created_at`,
      ).bind(crypto.randomUUID(), a.uid, b.endpoint, keys.p256dh, keys.auth, now).run();
      // Keep the newest MAX_SUBS_PER_UID devices per account.
      await db.prepare(
        `DELETE FROM push_subscriptions WHERE uid=?1 AND id NOT IN
           (SELECT id FROM push_subscriptions WHERE uid=?1 ORDER BY created_at DESC LIMIT ${MAX_SUBS_PER_UID})`,
      ).bind(a.uid).run();
      await setNotifyPush(env, a.uid, true, now);
      return json({ ok: true });
    }
    if (p === "/api/me/push/unsubscribe" && m === "POST") {
      const a = await authed(req, env); if (a instanceof Response) return a;
      const b = await body(req);
      if (!b || !validEndpoint(b.endpoint)) return err(400, "invalid_endpoint", "Send {endpoint}.");
      await env.DB_META.prepare("DELETE FROM push_subscriptions WHERE endpoint=?1 AND uid=?2").bind(b.endpoint, a.uid).run();
      const left = await env.DB_META.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE uid=?1").bind(a.uid).first<{ n: number }>();
      return json({ ok: true, remaining: Number(left?.n ?? 0) });
    }
    return null;
  } catch (e) {
    await trackException(env, e, { route: p, method: m, handled: true, app_name: APP, extra: { area: "dash2_push" } }).catch(() => undefined);
    return err(500, "internal", "Something went wrong. Please try again.");
  }
}
