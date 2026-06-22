// genui_thumb.ts — GET /api/ava/genui/thumb : signed preview-thumbnail proxy.
//
// Auth is via the HMAC-signed query (mint side: lib/genui_thumb_sign.ts), NOT a
// Clerk JWT — so the client can load it as a plain <img>/Image.network. We then
// fetch the actual (auth-gated) thumbnail with the user's stored Google token
// and stream the bytes back, cached. On any failure we 404 and the client falls
// back to the file-type icon.

import type { Env } from "../types";
import { verifyThumb } from "../lib/genui_thumb_sign";
import { driveThumbnailById } from "../lib/drive";

export async function avaGenuiThumb(req: Request, env: Env): Promise<Response> {
  const u = new URL(req.url);
  const i = u.searchParams.get("i") || "";
  const uid = u.searchParams.get("u") || "";
  const e = u.searchParams.get("e") || "";
  const s = u.searchParams.get("s") || "";
  if (!(await verifyThumb(env, i, uid, e, s))) return new Response("forbidden", { status: 403 });

  const w = Math.min(Math.max(Number(u.searchParams.get("w") || "320") || 320, 64), 1024);
  try {
    const thumb = await driveThumbnailById(env, uid, i, w);
    if (!thumb) return new Response("not found", { status: 404 });
    return new Response(thumb.bytes, {
      status: 200,
      headers: {
        "content-type": thumb.contentType,
        // Private (per-user) but cacheable on-device + at the edge for the URL's
        // signed lifetime.
        "cache-control": "private, max-age=3600",
        "access-control-allow-origin": "*",
      },
    });
  } catch {
    return new Response("error", { status: 502 });
  }
}
