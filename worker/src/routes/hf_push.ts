// [HF-APP-4] Push token registration for the HF Android app.
//   POST   /api/hf/push/register  { token, platform: "android", shell }   signed in; stores/moves the token to this user
//   DELETE /api/hf/push/register  { token }                               signed in; removes the token (sign-out)
// Registration is allowed while hfPushEnabled is off so tokens are ready when the flag is turned on; nothing is sent until then.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { rateLimit } from "../money";
import { track, trackException } from "../hooks";
import { BRAND } from "../lib/brand";
import { cleanShell, validPushToken } from "../lib/hf_push_pure";

const APP = BRAND.slug;
const err = (status: number, error: string, message?: string) => json({ error, message: message ?? error }, status);

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try { const b = await req.json(); return b && typeof b === "object" ? (b as Record<string, unknown>) : {}; } catch { return {}; }
}

export async function hfPushRoute(req: Request, env: Env, p: string): Promise<Response | null> {
  if (p !== "/api/hf/push/register") return null;
  if (req.method !== "POST" && req.method !== "DELETE") return err(405, "method_not_allowed");
  try {
    const u = await requireUser(req, env);
    if (isFail(u)) return err(u.status, u.error);
    const lim = await rateLimit(env, `hfpush:${u.uid}`, 30, 3600);
    if (lim) return lim;
    const b = await readJson(req);
    if (!validPushToken(b.token)) return err(400, "bad_token", "That device token is not valid.");
    if (req.method === "DELETE") {
      await env.DB_META.prepare("DELETE FROM hf_push_tokens WHERE token=?1 AND user_id=?2").bind(b.token, u.uid).run();
      return json({ ok: true });
    }
    if (b.platform !== "android") return err(400, "bad_platform", "Only Android is supported.");
    const now = Date.now();
    // One row per token; a token that moves to a new account (shared phone) is re-owned, never duplicated.
    await env.DB_META.prepare(
      "INSERT INTO hf_push_tokens (user_id, token, platform, shell, created_at, last_seen_at) VALUES (?1,?2,'android',?3,?4,?4) " +
      "ON CONFLICT(token) DO UPDATE SET user_id=excluded.user_id, shell=excluded.shell, last_seen_at=excluded.last_seen_at",
    ).bind(u.uid, b.token, cleanShell(b.shell), now).run();
    return json({ ok: true });
  } catch (e) {
    await trackException(env, e, { route: p, method: req.method, handled: true, app_name: APP, extra: { area: "hf_push" } });
    return err(500, "internal_error");
  }
}
