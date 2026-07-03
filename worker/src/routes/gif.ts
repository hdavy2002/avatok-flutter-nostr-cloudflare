// GIF / sticker search + trending — GIPHY proxy (STREAM E, Tenor→GIPHY migration).
//
// Tenor was shut down. The PRIMARY picker in the app is now the native GIPHY
// Flutter SDK (which talks to GIPHY directly with a client SDK key). These routes
// remain as a lightweight server-side FALLBACK grid data source: the app can hit
// them for a plain thumbnail grid without the native dialog. The GIPHY *server*
// REST key MUST stay server-side, so the app never talks to GIPHY's REST API
// directly here; we forward with the secret GIPHY_API_KEY and normalise to a
// compact shape (id + a muted-autoplay preview URL + the full-size media URL).
//
//   GET /api/gif/search?q=<query>&pos=<cursor>   → { results:[…], next }
//   GET /api/gif/trending?pos=<cursor>           → { results:[…], next }
//
//   result item: { id, url, preview, width, height, desc }
//     - preview : small looping WebP/GIF/MP4 for the grid (muted autoplay)
//     - url     : full media the client downloads → encrypts → uploads to R2,
//                 exactly like any picked image (recipients never hit GIPHY).
//
// Degrades gracefully: if GIPHY_API_KEY is unset we return 503 with
// { error:"gifs_unavailable" } so the fallback grid can degrade quietly (the SDK
// path is unaffected — it uses the client SDK key, not this server key).
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { rateLimit } from "../money";
import { track, metric } from "../hooks";

const APP = "avagif";
const GIPHY_BASE = "https://api.giphy.com/v1";
const LIMIT = 24;

// GIPHY's REST rendition object: each rendition may carry url/webp/mp4 + dims.
type GiphyRendition = {
  url?: string;
  webp?: string;
  mp4?: string;
  width?: string;
  height?: string;
};
type GiphyItem = {
  id: string;
  title?: string;
  is_sticker?: number;
  images?: Record<string, GiphyRendition>;
};

function pick(...vals: (string | undefined)[]): string {
  for (const v of vals) if (v) return v;
  return "";
}

function shape(items: GiphyItem[]) {
  const out: Array<Record<string, unknown>> = [];
  for (const it of items || []) {
    const im = it.images || {};
    // Grid preview: prefer a small looping WebP/MP4, then a downsampled GIF.
    const prevR =
      im.fixed_width_downsampled ||
      im.fixed_width_small ||
      im.fixed_width ||
      im.preview_gif ||
      im.downsized_still;
    const preview = pick(prevR?.webp, prevR?.mp4, prevR?.url);
    // Full media to actually send: prefer a compact GIF/WebP then the original.
    const fullR = im.downsized_medium || im.downsized || im.fixed_width || im.original;
    const full = pick(fullR?.url, fullR?.webp, fullR?.mp4);
    if (!preview || !full) continue;
    const dimsR = im.fixed_width || im.original || fullR;
    out.push({
      id: it.id,
      preview,
      url: full,
      width: Number(dimsR?.width || 0) || 0,
      height: Number(dimsR?.height || 0) || 0,
      desc: (it.title || "").slice(0, 120),
      ct: it.is_sticker ? "sticker" : "gif",
    });
  }
  return out;
}

async function callGiphy(
  req: Request,
  env: Env,
  path: string,
  extra: Record<string, string>,
): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  const key = (env as any).GIPHY_API_KEY as string | undefined;
  if (!key) return json({ error: "gifs_unavailable", reason: "GIPHY_API_KEY unset" }, 503);

  // Light abuse guard: 120 GIF lookups / 5 min / user (search-as-you-type).
  const limited = await rateLimit(env, `gif:${ctx.uid}`, 120, 300);
  if (limited) return limited;

  const params = new URLSearchParams({
    api_key: key,
    limit: String(LIMIT),
    rating: "pg-13", // family-safe (this is a mixed parent/child app)
    bundle: "messaging_non_clips",
    ...extra,
  });

  const t0 = Date.now();
  try {
    const res = await fetch(`${GIPHY_BASE}/${path}?${params.toString()}`);
    const ms = Date.now() - t0;
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      metric(env, "gif_fetch_fail", [ms, res.status], [path]);
      track(env, ctx.uid, "gif_fetch", APP, { ok: false, status: res.status, ms, path });
      return json({ error: "gif_fetch_failed", status: res.status, detail }, 502);
    }
    const body = (await res.json().catch(() => ({}))) as any;
    const results = shape(body.data as GiphyItem[]);
    // GIPHY pagination cursor: pagination.offset + count → next offset.
    const pg = body.pagination || {};
    const nextOffset = Number(pg.offset || 0) + Number(pg.count || 0);
    const hasMore = nextOffset < Number(pg.total_count || 0);
    metric(env, "gif_fetch_ok", [ms, results.length], [path]);
    track(env, ctx.uid, "gif_fetch", APP, { ok: true, ms, path, count: results.length });
    return json({ results, next: hasMore ? String(nextOffset) : "" });
  } catch (e: any) {
    const ms = Date.now() - t0;
    metric(env, "gif_fetch_error", [ms], [path]);
    track(env, ctx.uid, "gif_fetch", APP, { ok: false, error: String(e).slice(0, 200), ms, path });
    return json({ error: "gif_fetch_error", detail: String(e).slice(0, 200) }, 502);
  }
}

// Exported names are KEPT (gifSearch / gifTrending) so the existing index.ts
// mounts stay valid — do NOT rename these.
export async function gifSearch(req: Request, env: Env): Promise<Response> {
  const u = new URL(req.url);
  const q = (u.searchParams.get("q") || "").trim().slice(0, 100);
  const pos = (u.searchParams.get("pos") || "").trim();
  if (!q) return json({ results: [], next: "" });
  // GIPHY paginates by numeric `offset`; the app carries it back opaquely as pos.
  return callGiphy(req, env, "gifs/search", { q, ...(pos ? { offset: pos } : {}) });
}

export async function gifTrending(req: Request, env: Env): Promise<Response> {
  const u = new URL(req.url);
  const pos = (u.searchParams.get("pos") || "").trim();
  return callGiphy(req, env, "gifs/trending", { ...(pos ? { offset: pos } : {}) });
}
