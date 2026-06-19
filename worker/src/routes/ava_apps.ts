// ava_apps.ts — AvaApps (PREMIUM, Powered by Composio). Browse the full Composio
// app catalog, connect/disconnect per app (OAuth), and ask Ava to act across them.
// Two-mode model: browsing the catalog is free; connecting + running are PREMIUM
// (top up). The model runs on OUR Google key (BYOK removed).
//   GET  /api/ava/apps/catalog?search=   → { apps:[{slug,name,logo,categories}] }
//   GET  /api/ava/apps/status            → { connected:[slugs] }
//   POST /api/ava/apps/connect  { slug? | slugs? }  → { oauthUrls }
//   POST /api/ava/apps/disconnect { slug }           → { removed }
//   POST /api/ava/apps/run      { query }            → { answer }

import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { isPremiumAI, premiumUpsell } from "../lib/premium";
import { chargeFeature } from "../feature_pricing";
import { track } from "../hooks";
import {
  GOOGLE_TOOLKITS, connectToolkits, connectedToolkits, disconnectToolkit,
  listToolkits, runAppsToolLoop,
} from "../lib/composio";

// GET /api/ava/apps/catalog — the full Composio app catalog (free to browse).
export async function avaAppsCatalog(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  if (!env.COMPOSIO_API_KEY) return json({ ok: true, apps: [], configured: false, powered_by: "composio" });
  const u = new URL(req.url);
  const apps = await listToolkits(env, u.searchParams.get("search") || undefined);
  return json({ ok: true, apps, configured: true, powered_by: "composio" });
}

// GET /api/ava/apps/status — which apps the user has connected.
export async function avaAppsStatus(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  if (!env.COMPOSIO_API_KEY) return json({ ok: true, connected: [], configured: false });
  try {
    const connected = await connectedToolkits(env, ctx.uid);
    return json({ ok: true, connected, configured: true });
  } catch (e: any) {
    return json({ error: "status failed", detail: String(e?.message ?? e).slice(0, 200) }, 502);
  }
}

// POST /api/ava/apps/connect — PREMIUM. Start OAuth for the given app(s).
export async function avaAppsConnect(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  if (!env.COMPOSIO_API_KEY) return json({ error: "AvaApps not configured" }, 503);
  const { premium } = await isPremiumAI(req, env, ctx.uid);
  if (!premium) return premiumUpsell(env, ctx.uid, "connect_app");

  let b: any = {}; try { b = await req.json(); } catch { /* default below */ }
  const slugs: string[] = Array.isArray(b.slugs) ? b.slugs.map(String)
    : (b.slug ? [String(b.slug)] : GOOGLE_TOOLKITS);
  try {
    const oauthUrls = await connectToolkits(env, ctx.uid, slugs);
    track(env, ctx.uid, "ava_app_connect", "avaapps", { slugs });
    return json({ ok: true, oauthUrls });
  } catch (e: any) {
    track(env, ctx.uid, "ai_error", "avaapps", { route: "connect", detail: String(e?.message ?? e).slice(0, 200) });
    return json({ error: "connect failed", detail: String(e?.message ?? e).slice(0, 200) }, 502);
  }
}

// POST /api/ava/apps/disconnect — PREMIUM. Remove the user's connection for one app.
export async function avaAppsDisconnect(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  if (!env.COMPOSIO_API_KEY) return json({ error: "AvaApps not configured" }, 503);
  const { premium } = await isPremiumAI(req, env, ctx.uid);
  if (!premium) return premiumUpsell(env, ctx.uid, "connect_app");
  let b: any = {}; try { b = await req.json(); } catch { /* */ }
  const slug = String(b.slug ?? "").trim();
  if (!slug) return json({ error: "slug required" }, 400);
  try {
    const removed = await disconnectToolkit(env, ctx.uid, slug);
    track(env, ctx.uid, "ava_app_disconnect", "avaapps", { slug, removed });
    return json({ ok: true, removed });
  } catch (e: any) {
    return json({ error: "disconnect failed", detail: String(e?.message ?? e).slice(0, 200) }, 502);
  }
}

// POST /api/ava/apps/run — PREMIUM. Natural-language action across connected apps
// (runs on OUR Google key; coin-metered).
export async function avaAppsRun(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  if (!env.COMPOSIO_API_KEY) return json({ error: "AvaApps not configured" }, 503);
  const { premium } = await isPremiumAI(req, env, ctx.uid);
  if (!premium) return premiumUpsell(env, ctx.uid, "apps_run");

  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const query = String(b.query ?? "").trim();
  if (!query) return json({ error: "query required" }, 400);

  try {
    const answer = await runAppsToolLoop(env, ctx.uid, query);
    await chargeFeature(env, ctx.uid, "ava_mcp_tool", crypto.randomUUID()).catch(() => ({ ok: false }));
    track(env, ctx.uid, "ava_apps_run", "avaapps", {});
    return json({ ok: true, answer });
  } catch (e: any) {
    track(env, ctx.uid, "ai_error", "avaapps", { route: "run", detail: String(e?.message ?? e).slice(0, 200) });
    return json({ error: "apps run failed", detail: String(e?.message ?? e).slice(0, 200) }, 502);
  }
}
