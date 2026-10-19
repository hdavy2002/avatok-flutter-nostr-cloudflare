// [HF-WIRE-5] GET /api/hf/online-count -> { count }  public, cached 60 s. Live hosts whose presence is 'online'.
// (hf_hosts has no is_demo column today, so demo hosts are counted like any other live host.)
// Open when the reels app OR calls are open (hfReelsEnabled / hfCallsEnabled).
import type { Env } from "../types";
import { json } from "../util";
import { trackException } from "../hooks";
import { readConfig } from "./config";

export async function hfOnlineCountRoute(req: Request, env: Env): Promise<Response | null> {
  if (new URL(req.url).pathname !== "/api/hf/online-count") return null;
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);
  try {
    const cfg = (await readConfig(env)) as unknown as Record<string, unknown>;
    if (cfg.hfReelsEnabled !== true && cfg.hfCallsEnabled !== true) return json({ error: "not_enabled" }, 404);
    const row = await env.DB_META.prepare("SELECT COUNT(*) AS n FROM hf_hosts WHERE status='live' AND presence='online'").first<{ n: number }>();
    return json({ count: Number(row?.n ?? 0) }, 200, { "cache-control": "public, max-age=60" });
  } catch (cause) {
    await trackException(env, cause, { route: "/api/hf/online-count", method: "GET", handled: true, app_name: "hf", extra: { area: "hf_online_count" } }).catch(() => undefined);
    return json({ error: "internal_error" }, 500);
  }
}
