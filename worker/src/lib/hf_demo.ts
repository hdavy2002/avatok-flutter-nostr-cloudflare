// [HF-WIRE-14] Demo influencers (HF-REEL-34). The owner pastes YouTube links; we make a demo host (hf_hosts + hf_demo_hosts) and embed-only reels.
// A demo host never takes a real call or a booking, never receives money (isDemoHost guards in hf_calls / hf_bookings).
import type { Env } from "../types";
import { ensureSlug } from "./hf_host_store";
import { youtubeVideoDetails, saveDetails, type ImportedReel } from "./hf_reels_import";

export const DEMO_MESSAGE = "This is a demo profile. Calls open soon.";

export async function isDemoHost(env: Env, hostUid: string): Promise<boolean> {
  try { return !!(await env.DB_META.prepare("SELECT 1 AS x FROM hf_demo_hosts WHERE host_uid=?1").bind(hostUid).first()); } catch { return false; }
}

const ID = /^[A-Za-z0-9_-]{11}$/;
/** YouTube video id from watch?v=, youtu.be/, shorts/, embed/, live/ or a bare 11-character id. null when the line is not a YouTube video. */
export function parseYoutubeVideoId(line: string): string | null {
  const s = String(line ?? "").trim();
  if (!s) return null;
  if (ID.test(s)) return s;
  let u: URL;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : "https://" + s); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^(www\.|m\.|music\.)/, "");
  if (host === "youtu.be") { const id = u.pathname.split("/")[1] ?? ""; return ID.test(id) ? id : null; }
  if (host !== "youtube.com" && host !== "youtube-nocookie.com") return null;
  const v = u.searchParams.get("v");
  if (v && ID.test(v)) return v;
  const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

export function parseYoutubeLines(lines: string[]): { ids: string[]; bad: string[] } {
  const ids: string[] = [];
  const bad: string[] = [];
  for (const raw of lines) {
    const t = String(raw ?? "").trim();
    if (!t) continue;
    const id = parseYoutubeVideoId(t);
    if (!id) bad.push(t.slice(0, 120));
    else if (!ids.includes(id)) ids.push(id);
  }
  return { ids, bad };
}

export interface DemoInput { uid?: string; name: string; ratePaise: number; urls: string[]; handle?: string; followers?: number }
export interface DemoResult { uid: string; slug: string | null; name: string; added: number; skipped: number; missing: string[]; bad: string[] }

const rupeesOf = (paise: number) => Math.max(1, Math.round(paise / 100));

/** Create a demo host, or add videos to an existing one (input.uid). Throws Error('not_demo') / ('no_videos'). */
export async function upsertDemoInfluencer(env: Env, input: DemoInput, f: typeof fetch = fetch): Promise<DemoResult> {
  const { ids, bad } = parseYoutubeLines(input.urls);
  if (!ids.length) throw new Error("no_videos");
  const details = await youtubeVideoDetails(env, ids, f);
  const byId = new Map<string, ImportedReel>(details.map((d) => [d.platformVideoId, d]));
  const missing = ids.filter((i) => !byId.has(i));
  if (!details.length) throw new Error("no_videos");
  const now = Date.now();
  let uid = input.uid ?? "";
  if (uid) {
    if (!(await isDemoHost(env, uid))) throw new Error("not_demo");
    await env.DB_META.prepare("UPDATE hf_hosts SET display_name=COALESCE(NULLIF(?2,''),display_name), price_per_min=?3, updated_at=?4 WHERE uid=?1")
      .bind(uid, input.name, rupeesOf(input.ratePaise), now).run();
  } else {
    uid = "demo_" + crypto.randomUUID().replace(/-/g, "").slice(0, 10);
    await env.DB_META.prepare("INSERT INTO hf_hosts (uid, status, display_name, price_per_min, presence, created_at, updated_at) VALUES (?1,'approved',?2,?3,'online',?4,?4)")
      .bind(uid, input.name, rupeesOf(input.ratePaise), now).run();
  }
  const slug = await ensureSlug(env, uid, input.name);
  const handle = (input.handle ?? "").replace(/^@/, "").trim() || (slug ?? uid).replace(/-[a-z0-9]{4}$/, "");
  const followers = Math.max(0, Math.trunc(Number(input.followers ?? 0)) || 0);
  await env.DB_META.prepare("INSERT INTO hf_demo_hosts (host_uid, handle, followers, created_at) VALUES (?1,?2,?3,?4) ON CONFLICT(host_uid) DO UPDATE SET handle=CASE WHEN ?5=1 THEN excluded.handle ELSE handle END, followers=CASE WHEN ?6=1 THEN excluded.followers ELSE followers END")
    .bind(uid, handle, followers, now, input.handle ? 1 : 0, input.followers != null ? 1 : 0).run();
  let added = 0;
  let skipped = 0;
  for (const id of ids) {
    const d = byId.get(id);
    if (!d) continue;
    const ex = await env.DB_META.prepare("SELECT id FROM hf_reels WHERE host_uid=?1 AND platform='youtube' AND platform_video_id=?2").bind(uid, id).first<{ id: string }>();
    if (ex) { skipped++; continue; }
    const rid = "hfrl_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
    await env.DB_META.prepare(
      "INSERT INTO hf_reels (id, host_uid, channel_id, platform, platform_video_id, url, embed_url, video_url, thumb_url, caption, likes, comments, views, published_at, visible, is_demo, imported_at) VALUES (?1,?2,NULL,'youtube',?3,?4,?5,NULL,?6,?7,?8,?9,?10,?11,1,1,?12)",
    ).bind(rid, uid, id, d.url, d.embedUrl, d.thumbUrl, d.caption, d.likes, d.comments, d.views, d.publishedAt, now).run();
    await saveDetails(env, rid, d, now);
    added++;
  }
  return { uid, slug, name: input.name, added, skipped, missing, bad };
}

export async function listDemoInfluencers(env: Env): Promise<unknown[]> {
  const rows = (await env.DB_META.prepare(
    `SELECT d.host_uid AS uid, d.handle, d.followers, h.slug, h.display_name AS name, h.price_per_min AS rupees, d.created_at AS createdAt,
            (SELECT COUNT(*) FROM hf_reels r WHERE r.host_uid=d.host_uid) AS videos
       FROM hf_demo_hosts d LEFT JOIN hf_hosts h ON h.uid=d.host_uid ORDER BY d.created_at DESC LIMIT 200`,
  ).all<{ uid: string; handle: string | null; followers: number; slug: string | null; name: string | null; rupees: number | null; createdAt: number; videos: number }>()).results ?? [];
  return rows.map((r) => ({ uid: r.uid, slug: r.slug, name: r.name ?? "", handle: r.handle, followers: Number(r.followers ?? 0), ratePaise: Math.round(Number(r.rupees ?? 0) * 100), videos: Number(r.videos ?? 0), createdAt: r.createdAt }));
}

/** Delete one demo influencer for good (host, marker, reels, cached details). false when it is not a demo host. */
export async function deleteDemoInfluencer(env: Env, uid: string): Promise<boolean> {
  if (!(await isDemoHost(env, uid))) return false;
  try { await env.DB_META.prepare("DELETE FROM hf_reel_details WHERE reel_id IN (SELECT id FROM hf_reels WHERE host_uid=?1)").bind(uid).run(); } catch { /* table not applied */ }
  await env.DB_META.prepare("DELETE FROM hf_reels WHERE host_uid=?1 AND is_demo=1").bind(uid).run();
  await env.DB_META.prepare("DELETE FROM hf_hosts WHERE uid=?1").bind(uid).run();
  await env.DB_META.prepare("DELETE FROM hf_demo_hosts WHERE host_uid=?1").bind(uid).run();
  return true;
}
