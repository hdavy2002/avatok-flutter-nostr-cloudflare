// [HF-WIRE-14] Admin: demo influencers from pasted YouTube links (HF-REEL-34). ADMIN_UIDS only.
//   GET    /api/admin/hf/demo-influencers                 -> { ok, items:[{uid,slug,name,handle,followers,ratePaise,videos,createdAt}] }
//   POST   /api/admin/hf/demo-influencers { name, ratePaise, youtubeUrls:[string], uid?, handle?, followers? }
//                                                        -> { ok, result:{uid,slug,name,added,skipped,missing,bad} }   (uid given = add videos to that demo host)
//   DELETE /api/admin/hf/demo-influencers/:uid            -> { ok }
// Needs YOUTUBE_API_KEY (videos.list). Demo hosts never take calls or bookings (409 demo_host).
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { trackException } from "../hooks";
import { BRAND } from "../lib/brand";
import { isAdminUid } from "../lib/preview";
import { ProviderError } from "../lib/hf_channel_providers";
import { upsertDemoInfluencer, listDemoInfluencers, deleteDemoInfluencer } from "../lib/hf_demo";

const NO_STORE = { "cache-control": "private, no-store" };
const err = (status: number, error: string, message?: string) => json({ ok: false, error, message: message ?? error }, status, NO_STORE);
const MAX_LINES = 60;

export async function hfDemoAdminRoute(req: Request, env: Env, p: string, fetchImpl: typeof fetch = fetch): Promise<Response | null> {
  const m = p.match(/^\/api\/admin\/hf\/demo-influencers(?:\/([A-Za-z0-9_-]{3,60}))?$/);
  if (!m) return null;
  const uidParam = m[1] ?? null;
  const method = req.method;
  if (uidParam ? method !== "DELETE" : method !== "GET" && method !== "POST") return err(405, "method_not_allowed");
  try {
    const u = await requireUser(req, env);
    if (isFail(u)) return err(u.status, u.error);
    if (!isAdminUid(env, u.uid)) return err(403, "forbidden");
    if (method === "GET") return json({ ok: true, items: await listDemoInfluencers(env) }, 200, NO_STORE);
    if (method === "DELETE") {
      if (!(await deleteDemoInfluencer(env, uidParam!))) return err(404, "not_found", "That is not a demo influencer.");
      return json({ ok: true }, 200, NO_STORE);
    }
    const txt = await req.text().catch(() => "");
    let b: any = null;
    try { b = txt && txt.length < 40_000 ? JSON.parse(txt) : null; } catch { b = null; }
    if (!b || typeof b !== "object") return err(400, "invalid_body", "Send the name, rate and YouTube links.");
    const name = typeof b.name === "string" ? b.name.trim().slice(0, 60) : "";
    const ratePaise = Number(b.ratePaise);
    const urls: string[] = Array.isArray(b.youtubeUrls) ? b.youtubeUrls.map((x: unknown) => String(x ?? "")).slice(0, MAX_LINES + 1) : typeof b.youtubeUrls === "string" ? b.youtubeUrls.split(/\r?\n/).slice(0, MAX_LINES + 1) : [];
    if (urls.length > MAX_LINES) return err(400, "too_many", `Paste at most ${MAX_LINES} links at a time.`);
    const existing = typeof b.uid === "string" && b.uid ? b.uid : undefined;
    if (!existing && !name) return err(400, "invalid_field", "Give the demo influencer a display name.");
    if (!Number.isFinite(ratePaise) || ratePaise < 100 || ratePaise > 100_000) return err(400, "invalid_field", "Rate must be between 100 and 100000 paise per minute.");
    try {
      const result = await upsertDemoInfluencer(env, { uid: existing, name, ratePaise, urls, handle: typeof b.handle === "string" ? b.handle : undefined, followers: b.followers != null ? Number(b.followers) : undefined }, fetchImpl);
      return json({ ok: true, result }, 200, NO_STORE);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (msg === "no_videos") return err(400, "no_videos", "None of those links is a public YouTube video we could read.");
      if (msg === "not_demo") return err(404, "not_found", "That is not a demo influencer.");
      if (e instanceof ProviderError) return err(503, e.code, e.code === "provider_not_configured" ? "YOUTUBE_API_KEY is not set on the server yet." : "YouTube did not answer. Try again in a minute.");
      throw e;
    }
  } catch (e) {
    await trackException(env, e, { route: p, method, handled: true, app_name: BRAND.slug, extra: { area: "hf_demo_admin" } });
    return err(500, "internal_error", "Something went wrong. Please try again.");
  }
}
