// ava_apps.ts — AvaApps (PREMIUM): operate the user's Google apps from natural
// language via Composio, with the model on the user's own Gemini key.
//   POST /api/ava/apps/connect  {}          → { oauthUrls, servers }
//   GET  /api/ava/apps/status               → { connected: [slugs], servers }
//   POST /api/ava/apps/run      { query }   → { answer }    (X-Ava-Gemini-Key)

import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { GOOGLE_TOOLKITS, connectToolkits, connectedToolkits, runAppsToolLoop } from "../lib/composio";

function geminiKey(req: Request): string {
  return (req.headers.get("x-ava-gemini-key") || "").trim();
}

// POST /api/ava/apps/connect — start OAuth for any not-yet-connected Google app.
export async function avaAppsConnect(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  if (!env.COMPOSIO_API_KEY) return json({ error: "AvaApps not configured" }, 503);
  try {
    const oauthUrls = await connectToolkits(env, ctx.uid, GOOGLE_TOOLKITS);
    return json({ ok: true, oauthUrls, servers: GOOGLE_TOOLKITS });
  } catch (e: any) {
    return json({ error: "connect failed", detail: String(e?.message ?? e).slice(0, 200) }, 502);
  }
}

// GET /api/ava/apps/status — which Google apps the user has connected.
export async function avaAppsStatus(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  if (!env.COMPOSIO_API_KEY) return json({ ok: true, connected: [], servers: GOOGLE_TOOLKITS, configured: false });
  try {
    const connected = await connectedToolkits(env, ctx.uid);
    return json({ ok: true, connected, servers: GOOGLE_TOOLKITS, configured: true });
  } catch (e: any) {
    return json({ error: "status failed", detail: String(e?.message ?? e).slice(0, 200) }, 502);
  }
}

// POST /api/ava/apps/run — natural-language action across the connected apps.
export async function avaAppsRun(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  if (!env.COMPOSIO_API_KEY) return json({ error: "AvaApps not configured" }, 503);
  const key = geminiKey(req);
  if (!key) return json({ error: "connect Google AI Studio first (no key)" }, 400);

  let b: any;
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const query = String(b.query ?? "").trim();
  if (!query) return json({ error: "query required" }, 400);

  try {
    const answer = await runAppsToolLoop(env, key, ctx.uid, query);
    return json({ ok: true, answer });
  } catch (e: any) {
    return json({ error: "apps run failed", detail: String(e?.message ?? e).slice(0, 200) }, 502);
  }
}
