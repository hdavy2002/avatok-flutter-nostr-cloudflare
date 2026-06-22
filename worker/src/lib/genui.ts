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
import type { Affordance } from "./capabilities";
import { resolveAffordances } from "./capabilities";
import { redisGetJson, redisSetJson } from "./redis";
import {
  composeTemplate, cacheKey, isRenderable, type Template,
} from "./genui_compose";

const TEMPLATE_TTL = 60 * 60 * 24 * 30; // 30 days — templates are stable

export interface RenderResult {
  surface: A2uiSurface | null;
  cache: "hit" | "miss" | "none";
}

export async function renderData(
  env: Env, input: { request: string; tool: string; data: unknown; affordances?: Affordance[] },
): Promise<RenderResult> {
  if (!isRenderable(input.data)) return { surface: null, cache: "none" };

  // Resolve the toolkit's affordances (rename/delete/move/share/create/…) so the
  // composed card is FUNCTIONAL, not just a readout. Best-effort: if the catalog
  // is unreachable we still render the (display-only) card. Caller may pass them
  // in to avoid a duplicate lookup.
  let affordances = input.affordances;
  if (!affordances) {
    try { affordances = (await resolveAffordances(env, input.tool))?.affordances ?? []; }
    catch { affordances = []; }
  }

  const key = cacheKey(input.tool, input.data);
  let tpl = await redisGetJson<Template>(env, key);
  let cache: "hit" | "miss" = tpl ? "hit" : "miss";

  if (!tpl) {
    tpl = await composeTemplate(env, { ...input, affordances });
    if (!tpl) return { surface: null, cache: "none" };
    // Best-effort global cache write (no user data — template only).
    await redisSetJson(env, key, tpl, TEMPLATE_TTL);
  }

  const surface: A2uiSurface = {
    version: "v0.9",
    surfaceId: `gx_${Date.now()}`,
    root: tpl.root,
    components: tpl.components,
    data: input.data, // per-request hydration; never cached
  };
  return { surface, cache };
}
