// GIF search / trending — Tenor proxy (STREAM E, AI Messenger Batch).
//
// The Tenor API key MUST stay server-side, so the app never talks to Tenor
// directly. The client hits these two routes; we forward to Tenor with the
// secret TENOR_API_KEY and normalise the response to a compact shape the GIF
// tab can render (id + a muted-autoplay preview URL + the full-size media URL).
//
//   GET /api/gif/search?q=<query>&pos=<cursor>   → { results:[…], next }
//   GET /api/gif/trending?pos=<cursor>           → { results:[…], next }
//
//   result item: { id, url, preview, width, height, desc }
//     - preview : small looping MP4/GIF for the grid (muted autoplay)
//     - url     : full media the client downloads → encrypts → uploads to R2,
//                 exactly like any picked image (recipients never hit Tenor).
//
// Degrades gracefully: if TENOR_API_KEY is unset we return 503 with
// { error:"gifs_unavailable" } so the tab can show "GIFs unavailable" instead
// of erroring the whole picker.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { rateLimit } from "../money";
import { track, metric } from "../hooks";

const APP = "avagif";
const TENOR_BASE = "https://tenor.googleapis.com/v2";
// Media formats Tenor returns; we prefer a small looping MP4 for the grid
// preview (cheap, muted autoplay) and the full gif/mp4 for the actual send.
const LIMIT = 24;

type TenorItem = {
  id: string;
  content_description?: string;
  media_formats?: Record<string, { url: string; dims?: [number, number] }>;
};

function shape(items: TenorItem[]) {
  const out: Array<Record<string, unknown>> = [];
  for (const it of items || []) {
    const mf = it.media_formats || {};
    // Grid preview: prefer a tiny looping MP4, then a reduced GIF.
    const prev =
      mf.tinymp4 || mf.nanomp4 || mf.tinygif || mf.nanogif || mf.gifpreview;
    // Full media to actually send: prefer mp4 (smaller) then gif.
    const full = mf.mp4 || mf.gif || mf.mediumgif || mf.tinygif;
    if (!prev?.url || !full?.url) continue;
    const dims = full.dims || prev.dims || [0, 0];
    out.push({
      id: it.id,
      preview: prev.url,
      url: full.url,
      width: dims[0] || 0,
      height: dims[1] || 0,
      desc: (it.content_description || "").slice(0, 120),
    });
  }
  return out;
}

async function callTenor(
  req: Request,
  env: Env,
  path: string,
  extra: Record<string, string>,
): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  const key = (env as any).TENOR_API_KEY as string | undefined;
  if (!key) return json({ error: "gifs_unavailable", reason: "TENOR_API_KEY unset" }, 503);

  // Light abuse guard: 120 GIF lookups / 5 min / user (search-as-you-type).
  const limited = await rateLimit(env, `gif:${ctx.uid}`, 120, 300);
  if (limited) return limited;

  const params = new URLSearchParams({
    key,
    client_key: "avatok",
    limit: String(LIMIT),
    media_filter: "tinymp4,nanomp4,mp4,tinygif,nanogif,gif,mediumgif,gifpreview",
    contentfilter: "high", // family-safe (this is a mixed parent/child app)
    ...extra,
  });

  const t0 = Date.now();
  try {
    const res = await fetch(`${TENOR_BASE}/${path}?${params.toString()}`);
    const ms = Date.now() - t0;
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      metric(env, "gif_fetch_fail", [ms, res.status], [path]);
      track(env, ctx.uid, "gif_fetch", APP, { ok: false, status: res.status, ms, path });
      return json({ error: "gif_fetch_failed", status: res.status, detail }, 502);
    }
    const body = (await res.json().catch(() => ({}))) as any;
    const results = shape(body.results as TenorItem[]);
    metric(env, "gif_fetch_ok", [ms, results.length], [path]);
    track(env, ctx.uid, "gif_fetch", APP, { ok: true, ms, path, count: results.length });
    return json({ results, next: String(body.next || "") });
  } catch (e: any) {
    const ms = Date.now() - t0;
    metric(env, "gif_fetch_error", [ms], [path]);
    track(env, ctx.uid, "gif_fetch", APP, { ok: false, error: String(e).slice(0, 200), ms, path });
    return json({ error: "gif_fetch_error", detail: String(e).slice(0, 200) }, 502);
  }
}

export async function gifSearch(req: Request, env: Env): Promise<Response> {
  const u = new URL(req.url);
  const q = (u.searchParams.get("q") || "").trim().slice(0, 100);
  const pos = (u.searchParams.get("pos") || "").trim();
  if (!q) return json({ results: [], next: "" });
  return callTenor(req, env, "search", { q, ...(pos ? { pos } : {}) });
}

export async function gifTrending(req: Request, env: Env): Promise<Response> {
  const u = new URL(req.url);
  const pos = (u.searchParams.get("pos") || "").trim();
  return callTenor(req, env, "featured", { ...(pos ? { pos } : {}) });
}
