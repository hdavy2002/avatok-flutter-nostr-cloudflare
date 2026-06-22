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
import { trackUserContact } from "../hooks";
import { contactFor } from "../lib/identity";
import {
  GOOGLE_TOOLKITS, connectToolkits, connectedToolkits, disconnectToolkit,
  listToolkits, runAppsToolLoop, executeTool,
} from "../lib/composio";
import { toolkitOf, isExecutableTool, coerceArgs } from "../lib/capabilities";
import { renderData } from "../lib/genui";

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
  const { email, phone } = await contactFor(env, ctx.uid);
  try {
    const oauthUrls = await connectToolkits(env, ctx.uid, slugs);
    trackUserContact(env, ctx.uid, email, phone, "ava_app_connect", "avaapps", { slugs });
    return json({ ok: true, oauthUrls });
  } catch (e: any) {
    trackUserContact(env, ctx.uid, email, phone, "ai_error", "avaapps", { route: "connect", detail: String(e?.message ?? e).slice(0, 200) });
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
    const { email, phone } = await contactFor(env, ctx.uid);
    trackUserContact(env, ctx.uid, email, phone, "ava_app_disconnect", "avaapps", { slug, removed });
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

  const { email, phone } = await contactFor(env, ctx.uid);
  try {
    const answer = await runAppsToolLoop(env, ctx.uid, query);
    await chargeFeature(env, ctx.uid, "ava_mcp_tool", crypto.randomUUID()).catch(() => ({ ok: false }));
    trackUserContact(env, ctx.uid, email, phone, "ava_apps_run", "avaapps", { answer_len: answer.length });
    return json({ ok: true, answer });
  } catch (e: any) {
    trackUserContact(env, ctx.uid, email, phone, "ai_error", "avaapps", { route: "run", detail: String(e?.message ?? e).slice(0, 200) });
    return json({ error: "apps run failed", detail: String(e?.message ?? e).slice(0, 200) }, 502);
  }
}

// POST /api/ava/genui/action — PREMIUM. Execute ONE Composio tool fired from a
// GenUI card (a `composio` action button/form). This is the executable backbone
// that makes cards functional: "Rename", "Delete", "Schedule a meeting", etc.
//
// SECURITY — the body is UNTRUSTED (a card could be tampered with), so the server
// re-derives and enforces everything:
//   • premium gate + coin charge (same as apps/run),
//   • the tool's toolkit MUST be one the user has actually connected,
//   • the tool slug MUST exist in that toolkit's catalog (isExecutableTool),
//   • args are coerced/whitelisted against the tool's real input schema.
// On success we render the result back into a fresh GenUI surface (e.g. the
// updated list / the created event) so the chat reflects the new state.
//   Body: { tool: string, args?: object, request?: string }
//   → { ok, answer, a2ui? }
export async function avaGenuiAction(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  if (!env.COMPOSIO_API_KEY) return json({ error: "AvaApps not configured" }, 503);
  const { premium } = await isPremiumAI(req, env, ctx.uid);
  if (!premium) return premiumUpsell(env, ctx.uid, "genui_action");

  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const tool = String(b.tool ?? "").trim();
  const args: Record<string, unknown> = (b.args && typeof b.args === "object" && !Array.isArray(b.args)) ? b.args : {};
  const request = String(b.request ?? tool).slice(0, 300);
  // gid: correlation id from the surface the action was fired on (client passes
  // it) so the action stitches onto the same trace as its source presentation.
  const gid = String(b.gid ?? "").slice(0, 48);
  if (!tool) return json({ error: "tool required" }, 400);

  const toolkit = toolkitOf(tool);
  const { email, phone } = await contactFor(env, ctx.uid);
  const t0 = Date.now();
  try {
    // Gate: connected toolkit + real, executable tool slug. (validate_ms covers
    // both the connected-account lookup and the catalog membership check.)
    const v0 = Date.now();
    const connected = await connectedToolkits(env, ctx.uid);
    if (!connected.includes(toolkit)) {
      trackUserContact(env, ctx.uid, email, phone, "genui_action_exec", "avaai", { gid, tool, toolkit, ok: false, stage: "blocked_not_connected", validate_ms: Date.now() - v0, ms: Date.now() - t0 });
      return json({ error: "app not connected", toolkit }, 403);
    }
    if (!(await isExecutableTool(env, tool))) {
      trackUserContact(env, ctx.uid, email, phone, "genui_action_exec", "avaai", { gid, tool, toolkit, ok: false, stage: "blocked_unknown_tool", validate_ms: Date.now() - v0, ms: Date.now() - t0 });
      return json({ error: "unknown tool" }, 400);
    }
    const validateMs = Date.now() - v0;

    const cz0 = Date.now();
    const clean = await coerceArgs(env, tool, args);
    const coerceMs = Date.now() - cz0;

    const ex0 = Date.now();
    const r = await executeTool(env, ctx.uid, tool, clean);
    const execMs = Date.now() - ex0;
    const ok = !(r && (r.successful === false || r.error));
    await chargeFeature(env, ctx.uid, "ava_mcp_tool", crypto.randomUUID()).catch(() => ({ ok: false }));

    // Re-render the result so the card reflects the new state (best-effort) —
    // capture its own compose timing + cache so we see whether the refresh hit
    // the template/catalog caches too.
    let surface: unknown = null;
    let renderMs = 0; let reTemplateCache = "skip"; let reCatalogCache = "skip"; let reComponents = 0;
    if (ok && (env as any).GENUI_OFF !== "1") {
      const rd0 = Date.now();
      try {
        const rr = await renderData(env, { request, tool, data: (r as any)?.data ?? r });
        surface = rr.surface;
        if (surface) { (surface as any).gid = gid || (surface as any).gid; }
        reTemplateCache = rr.diag.template_cache; reCatalogCache = rr.diag.catalog_cache; reComponents = rr.diag.components;
      } catch { /* text fallback */ }
      renderMs = Date.now() - rd0;
    }
    trackUserContact(env, ctx.uid, email, phone, "genui_action_exec", "avaai", {
      gid, tool, toolkit, ok, stage: ok ? "executed" : "tool_failed",
      // per-step latency: validate → coerce → exec → re-render
      ms: Date.now() - t0, validate_ms: validateMs, coerce_ms: coerceMs, exec_ms: execMs, render_ms: renderMs,
      // cache visibility on the refresh render
      rendered: !!surface, render_template_cache: reTemplateCache, render_catalog_cache: reCatalogCache, render_components: reComponents,
      args_keys: Object.keys(clean).slice(0, 12), args_count: Object.keys(clean).length,
      ...(ok ? {} : { error: String((r as any)?.error ?? "tool error").slice(0, 200) }),
    });
    const answer = ok ? "Done." : `That didn't go through: ${String((r as any)?.error ?? "the app rejected it").slice(0, 160)}`;
    return json({ ok, answer, gid, ...(surface ? { a2ui: surface } : {}) }, ok ? 200 : 502);
  } catch (e: any) {
    trackUserContact(env, ctx.uid, email, phone, "genui_action_exec", "avaai", { gid, tool, toolkit, ok: false, stage: "exception", ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 200) });
    return json({ error: "action failed", detail: String(e?.message ?? e).slice(0, 200) }, 502);
  }
}
