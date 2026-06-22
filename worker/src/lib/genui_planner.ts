// genui_planner.ts — the "brain in the middle" of the GenUI pipeline.
//
// Flow:  user intent + raw Composio data + the app's capability catalog
//        → PLANNER (LLM, cached): "this data is Google Drive files; show name +
//          modified time; the user will want Open / Rename / Move / Delete / Share"
//        → BUILDER (deterministic): turns that plan + data + the resolved (safe)
//          affordances into a polished, CONSISTENT A2UI surface.
//
// Why split it this way: the LLM only decides SEMANTICS (what the data is, which
// fields to surface, which of the app's tools to offer). The actual A2UI is then
// assembled by code from a fixed, tested layout — so cards look like a real app
// screen every time and the model can NEVER emit broken/garbage layout (the thing
// that made earlier cards look bad). The plan is cached per app+shape, so a later
// similar request reuses the same design instantly (the "bundle into one design"
// the owner asked for). The actual app tools come from the deterministic
// capability catalog (capabilities.ts), so a hallucinated tool can't slip in —
// the planner may only PICK from affordances we already resolved.

import type { Env } from "../types";
import type { A2uiNode, A2uiSurface } from "./a2ui";
import { affordanceToAction, type Affordance } from "./capabilities";
import { redisGetJson, redisSetJson } from "./redis";

const PLAN_MODEL = "gemini-2.5-flash";
const PLAN_TTL = 60 * 60 * 24 * 30; // 30 days — plans are stable per app+shape

export interface UiPlan {
  app_label: string;          // human app name, e.g. "Google Drive"
  list_path: string;          // dot-path to the primary array in the data
  item_title: string;         // element field path for the row title
  item_subtitle: string[];    // up to 2 element field paths for the secondary line
  item_badge?: string;        // optional element field path shown as a pill
  item_open?: string;         // optional element field path holding an http(s) link
  item_actions: string[];     // affordance ids to show per row (the response-tool bundle)
  surface_actions: string[];  // affordance ids shown full-width under the list
  empty_text: string;         // shown when the array is empty
}

export interface PlanResult { surface: A2uiSurface | null; planCache: "hit" | "miss" | "none"; }

// ---- locate the primary array of records in a (possibly nested) tool result --
export function findListPath(data: unknown, maxDepth = 3): { path: string; items: any[] } | null {
  let best: { path: string; items: any[] } | null = null;
  const visit = (v: any, path: string, depth: number) => {
    if (best || depth > maxDepth || v == null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      if (v.length && typeof v[0] === "object" && v[0] !== null && !Array.isArray(v[0])) best = { path, items: v };
      return;
    }
    for (const k of Object.keys(v)) visit(v[k], path ? `${path}.${k}` : k, depth + 1);
  };
  visit(data, "", 0);
  return best;
}

// Field names + types of a sample element (NO values — keeps the plan cache PII-free).
function elementFields(items: any[]): Record<string, string> {
  const el = items[0] ?? {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(el)) {
    out[k] = Array.isArray(v) ? "array" : v === null ? "null" : typeof v;
    if (Object.keys(out).length >= 30) break;
  }
  return out;
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// ---- heuristic fallback plan (used when the LLM is unavailable/invalid) -------
const TITLE_HINTS = ["name", "title", "summary", "subject", "filename", "displayName", "label"];
const SUB_HINTS = ["mimeType", "modifiedTime", "createdTime", "status", "date", "start", "from", "sender", "owner", "size", "updatedAt"];
const LINK_HINTS = ["webViewLink", "webContentLink", "htmlLink", "url", "link", "permalink"];

function heuristicPlan(appLabel: string, listPath: string, items: any[], affordances: Affordance[]): UiPlan {
  const fields = Object.keys(elementFields(items));
  const pick = (hints: string[]) => hints.find((h) => fields.includes(h));
  const title = pick(TITLE_HINTS) ?? fields.find((f) => /name|title|subject/i.test(f)) ?? fields[0] ?? "id";
  const subs = SUB_HINTS.filter((h) => fields.includes(h)).slice(0, 2);
  const link = LINK_HINTS.find((h) => fields.includes(h));
  return {
    app_label: appLabel,
    list_path: listPath,
    item_title: title,
    item_subtitle: subs,
    item_open: link,
    item_actions: affordances.filter((a) => a.scope === "item").map((a) => a.id),
    surface_actions: affordances.filter((a) => a.scope === "surface").map((a) => a.id),
    empty_text: `No ${appLabel} items.`,
  };
}

// ---- the PLANNER: LLM decides semantics, validated against real data + tools --
export async function planSurface(
  env: Env,
  input: { request: string; toolkit: string; entity: string; tool: string; data: unknown; affordances: Affordance[] },
): Promise<{ plan: UiPlan | null; cache: "hit" | "miss" | "none" }> {
  const found = findListPath(input.data);
  if (!found) return { plan: null, cache: "none" };
  const fields = elementFields(found.items);

  // Cache the PLAN by app+entity+shape (NOT by intent) so similar later requests
  // reuse the same design — the owner's "bundle into one A2UI design".
  const shapeKey = hash(`${input.toolkit}|${input.entity}|${found.path}|${Object.entries(fields).map(([k, t]) => `${k}:${t}`).sort().join(",")}|${input.affordances.map((a) => a.id).sort().join(",")}`);
  const key = `genui:plan:v1:${shapeKey}`;

  const cached = await redisGetJson<UiPlan>(env, key);
  if (cached) return { plan: cached, cache: "hit" };

  const llm = await llmPlan(env, input, found.path, fields);
  const plan = llm ?? heuristicPlan(humanApp(input.toolkit), found.path, found.items, input.affordances);
  // Validate field paths exist; fall back per-field to the heuristic if not.
  const fieldSet = new Set(Object.keys(fields));
  const heur = heuristicPlan(humanApp(input.toolkit), found.path, found.items, input.affordances);
  if (!fieldSet.has(plan.item_title)) plan.item_title = heur.item_title;
  plan.item_subtitle = (plan.item_subtitle ?? []).filter((f) => fieldSet.has(f)).slice(0, 2);
  if (!plan.item_subtitle.length) plan.item_subtitle = heur.item_subtitle;
  if (plan.item_badge && !fieldSet.has(plan.item_badge)) plan.item_badge = undefined;
  if (plan.item_open && !fieldSet.has(plan.item_open)) plan.item_open = heur.item_open;
  if (!plan.item_open) plan.item_open = heur.item_open;
  plan.list_path = found.path;
  // Affordance ids must be ones we actually resolved (safety).
  const valid = new Set(input.affordances.map((a) => a.id));
  plan.item_actions = (plan.item_actions ?? []).filter((id) => valid.has(id));
  plan.surface_actions = (plan.surface_actions ?? []).filter((id) => valid.has(id));
  if (!plan.item_actions.length) plan.item_actions = heur.item_actions;
  if (!plan.surface_actions.length) plan.surface_actions = heur.surface_actions;
  if (!plan.app_label) plan.app_label = heur.app_label;
  if (!plan.empty_text) plan.empty_text = heur.empty_text;

  await redisSetJson(env, key, plan, PLAN_TTL).catch(() => {});
  return { plan, cache: "miss" };
}

function humanApp(toolkit: string): string {
  const m: Record<string, string> = {
    googledrive: "Google Drive", googlecalendar: "Google Calendar", gmail: "Gmail",
    googledocs: "Google Docs", googlesheets: "Google Sheets", notion: "Notion", supabase: "Supabase",
  };
  return m[toolkit] ?? (toolkit.charAt(0).toUpperCase() + toolkit.slice(1));
}

async function llmPlan(
  env: Env,
  input: { request: string; toolkit: string; entity: string; affordances: Affordance[] },
  listPath: string, fields: Record<string, string>,
): Promise<UiPlan | null> {
  const key = env.GEMINI_API_KEY ?? "";
  if (!key) return null;
  const affLines = input.affordances.map((a) =>
    `  - id:"${a.id}" label:"${a.label}" verb:${a.verb} scope:${a.scope}${a.destructive ? " [destructive]" : ""}`).join("\n");
  const sys =
    "You design the SEMANTICS of an in-chat card that shows a user's data from one of their connected apps, like a small native app screen. " +
    "You do NOT write UI — you choose which fields to display and which of the user's available actions to offer. " +
    "Return ONLY JSON matching: {app_label, list_path, item_title, item_subtitle:[..≤2..], item_badge?, item_open?, item_actions:[ids], surface_actions:[ids], empty_text}. " +
    "Rules: item_title/subtitle/badge/open MUST be field names from the element fields given. " +
    "item_actions/surface_actions MUST be ids from the affordance list (never invent). " +
    "Pick item_actions that match what the user most likely wants to DO next given their request (e.g. for files: open, rename, move, delete, share). " +
    "Prefer a concise title field and 1–2 informative subtitle fields. If a field holds a URL, use it as item_open.";
  const usr =
    `User request (their intent): "${String(input.request).slice(0, 300)}"\n` +
    `App: ${humanApp(input.toolkit)} (${input.entity})\n` +
    `Array path: ${listPath}\n` +
    `Element fields (name:type): ${JSON.stringify(fields)}\n` +
    `Available actions (affordances):\n${affLines || "  (none)"}\n\n` +
    "Return the plan JSON now.";
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${PLAN_MODEL}:generateContent`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: sys }] },
        contents: [{ role: "user", parts: [{ text: usr }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2, thinkingConfig: { thinkingBudget: 0 } },
      }),
    });
    if (!res.ok) return null;
    const out: any = await res.json().catch(() => null);
    const text = out?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text).filter(Boolean).join("") ?? "";
    if (!text) return null;
    const p = JSON.parse(text);
    if (!p || typeof p !== "object") return null;
    return {
      app_label: String(p.app_label ?? ""),
      list_path: listPath,
      item_title: String(p.item_title ?? ""),
      item_subtitle: Array.isArray(p.item_subtitle) ? p.item_subtitle.map(String).slice(0, 2) : [],
      item_badge: p.item_badge ? String(p.item_badge) : undefined,
      item_open: p.item_open ? String(p.item_open) : undefined,
      item_actions: Array.isArray(p.item_actions) ? p.item_actions.map(String) : [],
      surface_actions: Array.isArray(p.surface_actions) ? p.surface_actions.map(String) : [],
      empty_text: String(p.empty_text ?? ""),
    };
  } catch { return null; }
}

// ---- the BUILDER: deterministic, consistent, premium A2UI from the plan -------
const ROW_ACCENTS = ["blue", "lime", "mint", "lilac", "coral"];

export function buildPlannedSurface(
  plan: UiPlan, affordances: Affordance[], data: unknown, opts: { tool: string; gid: string },
): A2uiSurface {
  const comps: Record<string, A2uiNode> = {};
  let n = 0;
  const id = (p: string) => `p${n++}_${p}`;
  const add = (node: A2uiNode): string => { const i = id((node as any).type); comps[i] = node; return i; };
  const byId = new Map(affordances.map((a) => [a.id, a]));

  const found = findListPath(data);
  const count = found ? found.items.length : 0;

  const headerId = add({ type: "pill", label: `${plan.app_label} · ${count} ${count === 1 ? "item" : "items"}`, icon: "tray", fill: "ink", fg: "paper" });

  const kids: string[] = [headerId, add({ type: "spacer", size: 8 })];

  if (count === 0) {
    kids.push(add({ type: "card", child: add({ type: "text", value: plan.empty_text, variant: "sub", color: "inkSoft" }), fill: "card" }));
  } else {
    // ---- the repeating row template (bound per element) ----
    const titleId = add({ type: "text", value: `\${${plan.item_title}}`, variant: "title" });
    const rowKids: string[] = [titleId];
    if (plan.item_subtitle.length) {
      const sub = plan.item_subtitle.map((f) => `\${${f}}`).join("  ·  ");
      rowKids.push(add({ type: "text", value: sub, variant: "sub", color: "inkSoft" }));
    }
    // badge + open chip line
    const chipRow: string[] = [];
    if (plan.item_badge) chipRow.push(add({ type: "pill", label: `\${${plan.item_badge}}`, fill: "paper2", fg: "ink" }));
    if (plan.item_open) chipRow.push(add({ type: "button", label: "Open", icon: "arrow-square-out", fill: "card", action: { type: "link", url: `\${${plan.item_open}}` } }));
    if (chipRow.length) rowKids.push(add({ type: "row", children: chipRow, gap: 6, align: "start" }));

    // per-row action bundle (composio) — small buttons
    const itemActs = plan.item_actions.map((aid) => byId.get(aid)).filter((a): a is Affordance => !!a);
    if (itemActs.length) {
      const btns = itemActs.map((a) => add({
        type: "button", label: a.label, icon: a.icon, fill: a.destructive ? "coral" : "card",
        action: affordanceToAction(a),
      }));
      rowKids.push(add({ type: "row", children: btns, gap: 6, align: "start" }));
    }

    const itemCard = add({ type: "card", child: add({ type: "column", children: rowKids, gap: 4 }), accent: "blue" });
    kids.push(add({ type: "list", path: plan.list_path, item: itemCard, gap: 7 }));
  }

  // surface-level actions (e.g. New / Schedule a meeting) — full-width
  const surfaceActs = plan.surface_actions.map((aid) => byId.get(aid)).filter((a): a is Affordance => !!a);
  if (surfaceActs.length) {
    kids.push(add({ type: "spacer", size: 8 }));
    for (const a of surfaceActs) {
      kids.push(add({ type: "button", label: a.label, icon: a.icon ?? "plus", fill: "lime", full: true, action: affordanceToAction(a) }));
    }
  }

  const root = add({ type: "column", children: kids, gap: 0 });
  return {
    version: "v0.9", surfaceId: `gx_${Date.now()}`, gid: opts.gid, tool: opts.tool, ts: Date.now(),
    root, components: comps, data,
  };
}
