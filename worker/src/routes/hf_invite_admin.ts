// [HF-WIRE-22] Admin: invite creators (HF-REEL-40). ADMIN_UIDS only. Creators who are NOT on Hello Fraands but whose reels show in the feed with an Invite button.
//   GET    /api/admin/hf/invite-creators                       -> { ok, items:[{platform,handle,name,avatar,followers,votes,source,hidden,reels,lastLookupAt}] }
//   POST   /api/admin/hf/invite-creators { platform, handle }  -> { ok, creator, reels }   look-up + fetch up to 6 reels now (409 already_on_network, 404 not_found, 503 provider_*)
//   PATCH  /api/admin/hf/invite-creators/:platform/:handle { hidden:boolean } -> { ok, hidden }   hide / unhide
// Embeds only: details of public videos, never a video file. Secrets are never returned.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { trackException } from "../hooks";
import { BRAND } from "../lib/brand";
import { isAdminUid } from "../lib/preview";
import { lookupChannel, ProviderError, type ChannelPlatform } from "../lib/hf_channel_providers";
import { upsertInviteCreator, fetchInviteReels, type FetchProviders } from "../lib/hf_invite_reels";
import { normHandle } from "./hf_search";

const NO_STORE = { "cache-control": "private, no-store" };
const err = (status: number, error: string, message?: string) => json({ ok: false, error, message: message ?? error }, status, NO_STORE);

/** "@x", "x", youtube.com/@x or instagram.com/x -> lowercase handle without @, or null. */
export function adminHandle(raw: string): string | null {
  let s = String(raw ?? "").trim();
  const m = s.match(/(?:youtube|instagram)\.com\/(@?[A-Za-z0-9._-]+)/i);
  if (m) s = m[1];
  return normHandle(s);
}

export async function hfInviteAdminRoute(req: Request, env: Env, p: string, prov: FetchProviders = {}): Promise<Response | null> {
  const m = p.match(/^\/api\/admin\/hf\/invite-creators(?:\/(instagram|youtube)\/([^/]{2,64}))?$/);
  if (!m) return null;
  const method = req.method;
  if (m[1] ? method !== "PATCH" : method !== "GET" && method !== "POST") return err(405, "method_not_allowed");
  try {
    const u = await requireUser(req, env);
    if (isFail(u)) return err(u.status, u.error);
    if (!isAdminUid(env, u.uid)) return err(403, "forbidden");

    if (method === "GET") {
      const rows = (await env.DB_META.prepare(
        `SELECT c.platform, c.handle, c.display_name, c.avatar_url, c.followers, c.source, c.hidden, c.last_lookup_at,
           (SELECT COUNT(*) FROM hf_invite_reels r WHERE r.platform=c.platform AND r.handle=c.handle) AS reels,
           (SELECT COUNT(*) FROM hf_invite_votes v WHERE v.platform=c.platform AND v.handle=c.handle) AS votes
         FROM hf_invite_creators c ORDER BY c.hidden ASC, votes DESC, c.last_lookup_at DESC LIMIT 300`,
      ).all<any>()).results ?? [];
      return json({ ok: true, items: rows.map((r) => ({
        platform: r.platform, handle: "@" + r.handle, name: r.display_name ?? "", avatar: r.avatar_url ?? null, followers: Number(r.followers ?? 0),
        votes: Number(r.votes ?? 0), source: r.source, hidden: r.hidden === 1, reels: Number(r.reels ?? 0), lastLookupAt: Number(r.last_lookup_at ?? 0),
      })) }, 200, NO_STORE);
    }

    if (m[1]) { // PATCH hide / unhide
      const handle = normHandle(decodeURIComponent(m[2]));
      let b: any = null;
      try { b = JSON.parse((await req.text().catch(() => "")) || "null"); } catch { b = null; }
      if (!handle || !b || typeof b.hidden !== "boolean") return err(400, "invalid_field", "Say whether to hide this creator.");
      const r = await env.DB_META.prepare("UPDATE hf_invite_creators SET hidden=?3 WHERE platform=?1 AND handle=?2").bind(m[1], handle, b.hidden ? 1 : 0).run();
      if (!Number((r as any)?.meta?.changes ?? 0)) return err(404, "not_found", "That creator is not on the list.");
      return json({ ok: true, hidden: b.hidden }, 200, NO_STORE);
    }

    // POST add
    let b: any = null;
    try { b = JSON.parse((await req.text().catch(() => "")) || "null"); } catch { b = null; }
    const platform = b?.platform === "youtube" || b?.platform === "instagram" ? (b.platform as ChannelPlatform) : null;
    const handle = platform ? adminHandle(b.handle) : null;
    if (!platform || !handle) return err(400, "invalid_field", "Choose YouTube or Instagram and type the creator's handle.");
    let lk;
    try {
      lk = await (prov.lookup ?? lookupChannel)(env, platform, handle, prov.f);
    } catch (e) {
      if (e instanceof ProviderError) return err(503, e.code, e.code === "provider_not_configured" ? "The look-up key for that platform is not set on the server yet." : "That platform did not answer. Try again in a minute.");
      throw e;
    }
    if (!lk.exists) return err(404, "not_found", "We could not find that account.");
    if (lk.isPrivate) return err(400, "private", "That account is private, so it has no public reels.");
    const added = await upsertInviteCreator(env, { platform, handle, source: "admin", followers: lk.followers, platformUserId: lk.platformUserId, name: lk.displayName, avatar: lk.avatarUrl ?? null });
    if (!added) return err(409, "already_on_network", "This creator is already on Hello Fraands.");
    await env.DB_META.prepare("UPDATE hf_invite_creators SET hidden=0, source='admin' WHERE platform=?1 AND handle=?2").bind(platform, handle).run();
    const reels = await fetchInviteReels(env, platform, handle, { ...prov, force: true });
    return json({ ok: true, creator: { platform, handle: "@" + handle, name: lk.displayName ?? "", followers: lk.followers }, reels }, 200, NO_STORE);
  } catch (e) {
    await trackException(env, e, { route: p, method, handled: true, app_name: BRAND.slug, extra: { area: "hf_invite_admin" } });
    return err(500, "internal_error", "Something went wrong. Please try again.");
  }
}
