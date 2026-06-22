// genui.ts — orchestrator for generative in-chat UI. Turns a Composio tool
// result into an A2UI surface, using a GLOBAL Redis cache of the design TEMPLATE
// (the "design layer") so repeat shapes skip the LLM entirely.
//
//   data → shape key → Redis GET template
//     hit  → hydrate with this user's data (no LLM)         [~ms]
//     miss → Gemini composeTemplate → cache it → hydrate    [~1s, once per shape globally]
//
// The cached value is the TEMPLATE ONLY (bindings + list, no user data), so it is
// safe to share across all users and contains no PII.

import type { Env } from "../types";
import type { A2uiSurface } from "./a2ui";
import type { Affordance, CapsDiag } from "./capabilities";
import { resolveAffordances, toolkitOf } from "./capabilities";
import { redisGetJson, redisSetJson } from "./redis";
import {
  composeTemplate, cacheKey, isRenderable, type Template,
} from "./genui_compose";
import { planSurface, buildPlannedSurface, buildDriveSurface, findListPath } from "./genui_planner";

const TEMPLATE_TTL = 60 * 60 * 24 * 30; // 30 days — templates are stable

// Full server-side diagnostics for the compose step — every sub-latency + cache
// outcome the caller stamps onto `genui_render` so the intent→presentation
// pipeline is measurable end-to-end.
export interface RenderDiag {
  gid: string;                              // correlation id for the whole trace
  renderable: boolean;
  template_cache: "hit" | "miss" | "none";  // Redis template cache outcome
  template_write: boolean;                  // did we write the template back to Redis?
  compose_ms: number;                       // Gemini compose time (0 on cache hit)
  resolve_ms: number;                       // affordance resolve time (own + catalog)
  catalog_cache: CapsDiag["catalog_cache"] | "skip";
  catalog_ms: number;
  catalog_tools: number;
  affordances: number;
  affordances_item: number;
  affordances_surface: number;
  entity: string;
  components: number;
  total_ms: number;
  // which presenter produced the surface + its plan-cache outcome
  path: "planner" | "planner_drive" | "template" | "none";
  plan_cache: "hit" | "miss" | "none";
}

export interface RenderResult {
  surface: A2uiSurface | null;
  cache: "hit" | "miss" | "none";
  diag: RenderDiag;
}

function newGid(): string { return `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }

export async function renderData(
  env: Env, input: { request: string; tool: string; data: unknown; affordances?: Affordance[] },
): Promise<RenderResult> {
  const t0 = Date.now();
  const gid = newGid();
  const diag: RenderDiag = {
    gid, renderable: true, template_cache: "none", template_write: false,
    compose_ms: 0, resolve_ms: 0, catalog_cache: "skip", catalog_ms: 0, catalog_tools: 0,
    affordances: 0, affordances_item: 0, affordances_surface: 0, entity: "", components: 0, total_ms: 0,
    path: "none", plan_cache: "none",
  };

  if (!isRenderable(input.data)) {
    diag.renderable = false; diag.total_ms = Date.now() - t0;
    return { surface: null, cache: "none", diag };
  }

  // Resolve the toolkit's affordances (rename/delete/move/share/create/…) so the
  // composed card is FUNCTIONAL, not just a readout. Best-effort: if the catalog
  // is unreachable we still render the (display-only) card. Caller may pass them
  // in to avoid a duplicate lookup.
  let affordances = input.affordances;
  let entity = "";
  if (!affordances) {
    try {
      const resolved = await resolveAffordances(env, input.tool);
      affordances = resolved?.affordances ?? [];
      if (resolved) {
        entity = resolved.entity;
        diag.catalog_cache = resolved.diag.catalog_cache;
        diag.catalog_ms = resolved.diag.catalog_ms;
        diag.catalog_tools = resolved.diag.catalog_tools;
        diag.resolve_ms = resolved.diag.catalog_ms + resolved.diag.resolve_ms;
        diag.affordances_item = resolved.diag.item;
        diag.affordances_surface = resolved.diag.surface;
        diag.entity = resolved.entity;
      }
    } catch { affordances = []; }
  }
  diag.affordances = affordances.length;

  // Google Drive gets a dedicated, app-aware presenter: files grouped by type
  // into sections, type badge + pretty size + modified date, long names
  // truncated, per-file action bundle. Fully deterministic (no LLM hop).
  if (toolkitOf(input.tool) === "googledrive" && findListPath(input.data)) {
    try {
      const surface = buildDriveSurface(input.data, affordances ?? [], { tool: input.tool, gid });
      if (surface) {
        diag.path = "planner_drive";
        diag.components = Object.keys(surface.components).length;
        diag.total_ms = Date.now() - t0;
        return { surface, cache: "none", diag };
      }
    } catch { /* fall through to the generic planner */ }
  }

  // PRIMARY PATH — the planner "brain" + deterministic builder. The LLM decides
  // semantics (app identity, which fields to show, which of the resolved actions
  // to offer for this intent); code assembles a consistent A2UI surface. Plan is
  // cached per app+shape. Falls through to the freeform template composer only if
  // there's no list-shaped data to plan over.
  if (findListPath(input.data)) {
    try {
      const { plan, cache: planCache } = await planSurface(env, {
        request: input.request, toolkit: toolkitOf(input.tool), entity, tool: input.tool,
        data: input.data, affordances,
      });
      diag.plan_cache = planCache;
      if (plan) {
        const surface = buildPlannedSurface(plan, affordances, input.data, { tool: input.tool, gid });
        diag.path = "planner";
        diag.components = Object.keys(surface.components).length;
        diag.total_ms = Date.now() - t0;
        return { surface, cache: planCache === "hit" ? "hit" : "miss", diag };
      }
    } catch { /* fall through to template composer */ }
  }

  const key = cacheKey(input.tool, input.data);
  let tpl = await redisGetJson<Template>(env, key);
  const cache: "hit" | "miss" = tpl ? "hit" : "miss";
  diag.template_cache = cache;

  if (!tpl) {
    const c0 = Date.now();
    tpl = await composeTemplate(env, { ...input, affordances });
    diag.compose_ms = Date.now() - c0;
    if (!tpl) { diag.total_ms = Date.now() - t0; return { surface: null, cache: "none", diag }; }
    // Best-effort global cache write (no user data — template only).
    try { await redisSetJson(env, key, tpl, TEMPLATE_TTL); diag.template_write = true; } catch { /* best-effort */ }
  }

  diag.components = Object.keys(tpl.components).length;
  diag.path = "template";
  diag.total_ms = Date.now() - t0;

  const surface: A2uiSurface = {
    version: "v0.9",
    surfaceId: `gx_${Date.now()}`,
    gid,
    tool: input.tool,
    ts: Date.now(),
    root: tpl.root,
    components: tpl.components,
    data: input.data, // per-request hydration; never cached
  };
  return { surface, cache, diag };
}
