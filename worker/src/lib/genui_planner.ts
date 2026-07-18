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
import type { A2uiNode, A2uiSurface, A2uiAction } from "./a2ui";
import { affordanceToAction, type Affordance } from "./capabilities";
import { redisGetJson, redisSetJson } from "./redis";
import { signThumbUrl } from "./genui_thumb_sign";
import { avaReason } from "./ava_reason"; // One Brain B1: unified reasoning gateway
import { sha256Hex } from "../util"; // One Brain B1: KV cache key = hash(planning input)

// Hard ceiling on how many records we put into ONE card. The trim layer already
// caps the data, but the builder bounds it again so a huge list can NEVER blow up
// the A2UI payload — we show the first MAX_DISPLAY and a "Showing N of M" footer
// instead of breaking or dropping to text.
const MAX_DISPLAY = 50;

// True record count from the result (trim stamps `_total` when it caps).
function totalCount(data: any, shown: number): number {
  const t = Number(data?._total);
  return Number.isFinite(t) && t > shown ? t : shown;
}

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
  group_by?: string;          // optional element field to group rows into sections
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

// Telemetry about the planning step — lets us pinpoint whether Claude (via
// OpenRouter) actually ran, fell back to Gemini, or to the heuristic, and how long.
export interface LlmCall { provider: "openrouter" | "gemini" | "none"; model: string; ms: number; ok: boolean; status: number; }
export interface PlanDiag extends LlmCall {
  source: "cache" | "llm" | "heuristic";
  item_actions: number;
  surface_actions: number;
  group_by: string;
}

// ---- the PLANNER: LLM decides semantics, validated against real data + tools --
export async function planSurface(
  env: Env,
  input: { request: string; toolkit: string; entity: string; tool: string; data: unknown; affordances: Affordance[] },
): Promise<{ plan: UiPlan | null; cache: "hit" | "miss" | "none"; diag: PlanDiag }> {
  const noDiag: PlanDiag = { source: "heuristic", provider: "none", model: "", ms: 0, ok: false, status: 0, item_actions: 0, surface_actions: 0, group_by: "" };
  const found = findListPath(input.data);
  if (!found) return { plan: null, cache: "none", diag: noDiag };
  const fields = elementFields(found.items);

  // Cache the PLAN by app+entity+shape (NOT by intent) so similar later requests
  // reuse the same design — the owner's "bundle into one A2UI design".
  const shapeKey = hash(`${input.toolkit}|${input.entity}|${found.path}|${Object.entries(fields).map(([k, t]) => `${k}:${t}`).sort().join(",")}|${input.affordances.map((a) => a.id).sort().join(",")}`);
  const key = `genui:plan:v1:${shapeKey}`;

  const cached = await redisGetJson<UiPlan>(env, key);
  if (cached) {
    return { plan: cached, cache: "hit", diag: { ...noDiag, source: "cache", ok: true, item_actions: cached.item_actions?.length ?? 0, surface_actions: cached.surface_actions?.length ?? 0, group_by: cached.group_by ?? "" } };
  }

  const { plan: llm, call } = await llmPlan(env, input, found.path, fields);
  const plan = llm ?? heuristicPlan(humanApp(input.toolkit), found.path, found.items, input.affordances);
  // Validate field paths exist; fall back per-field to the heuristic if not.
  const fieldSet = new Set(Object.keys(fields));
  const heur = heuristicPlan(humanApp(input.toolkit), found.path, found.items, input.affordances);
  if (!fieldSet.has(plan.item_title)) plan.item_title = heur.item_title;
  plan.item_subtitle = (plan.item_subtitle ?? []).filter((f) => fieldSet.has(f)).slice(0, 2);
  if (!plan.item_subtitle.length) plan.item_subtitle = heur.item_subtitle;
  if (plan.item_badge && !fieldSet.has(plan.item_badge)) plan.item_badge = undefined;
  if (plan.group_by && !fieldSet.has(plan.group_by)) plan.group_by = undefined;
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
  const diag: PlanDiag = {
    ...call,
    source: llm ? "llm" : "heuristic",
    item_actions: plan.item_actions.length,
    surface_actions: plan.surface_actions.length,
    group_by: plan.group_by ?? "",
  };
  return { plan, cache: "miss", diag };
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
): Promise<{ plan: UiPlan | null; call: LlmCall }> {
  const affLines = input.affordances.map((a) =>
    `  - id:"${a.id}" label:"${a.label}" verb:${a.verb} scope:${a.scope}${a.destructive ? " [destructive]" : ""}`).join("\n");
  const sys =
    "You are a senior product designer. You design the SEMANTICS of an in-chat card that shows a user's data from one of their connected apps (Drive, Calendar, Gmail, Sheets, Notion, …) as a clean, premium little native-app screen. " +
    "You do NOT write UI markup — you choose which fields to display, how to group them, and which of the user's available actions to offer; code renders it consistently from your plan. " +
    "Return ONLY JSON matching: {app_label, list_path, item_title, item_subtitle:[..≤2..], item_badge?, item_open?, group_by?, item_actions:[ids], surface_actions:[ids], empty_text}. " +
    "Rules: item_title/subtitle/badge/open/group_by MUST be field names from the element fields given (or omit). " +
    "item_actions/surface_actions MUST be ids from the affordance list (never invent a tool). " +
    "Choose item_actions matching what the user most likely wants to DO next given their request (e.g. files: open, rename, move, delete, share). " +
    "DESIGN FOR A NARROW PHONE SCREEN (~360dp wide), NOT a desktop: pick only the 2–3 most useful item_actions (more buttons get cramped or pushed off the edge), keep item_title short and item_subtitle to 1–2 short fields, and never assume wide horizontal space. " +
    "Prefer a concise title and 1–2 informative subtitle fields. If a field holds a URL, use it as item_open. " +
    "If the rows have a natural category field (type/status/kind/folder/label), set group_by so the list is organised into sections instead of one long flat list. Make app_label and empty_text human and friendly.";
  const usr =
    `User request (their intent): "${String(input.request).slice(0, 300)}"\n` +
    `App: ${humanApp(input.toolkit)} (${input.entity})\n` +
    `Array path: ${listPath}\n` +
    `Element fields (name:type): ${JSON.stringify(fields)}\n` +
    `Available actions (affordances):\n${affLines || "  (none)"}\n\n` +
    "Return the plan JSON now.";
  const r = await llmJson(env, sys, usr);
  const call: LlmCall = { provider: r.provider, model: r.model, ms: r.ms, ok: r.ok, status: r.status };
  if (!r.text) return { plan: null, call };
  try {
    const p = JSON.parse(r.text);
    if (!p || typeof p !== "object") return { plan: null, call };
    return {
      plan: {
        app_label: String(p.app_label ?? ""),
        list_path: listPath,
        item_title: String(p.item_title ?? ""),
        item_subtitle: Array.isArray(p.item_subtitle) ? p.item_subtitle.map(String).slice(0, 2) : [],
        item_badge: p.item_badge ? String(p.item_badge) : undefined,
        item_open: p.item_open ? String(p.item_open) : undefined,
        item_actions: Array.isArray(p.item_actions) ? p.item_actions.map(String) : [],
        surface_actions: Array.isArray(p.surface_actions) ? p.surface_actions.map(String) : [],
        empty_text: String(p.empty_text ?? ""),
        group_by: p.group_by ? String(p.group_by) : undefined,
      },
      call: { ...call, ok: true },
    };
  } catch { return { plan: null, call }; }
}

// The thinking/design brain. Prefers Claude Opus 4.8 via OpenRouter (a stronger
// designer) when OPENROUTER_API_KEY is set; otherwise falls back to Gemini. Both
// return a JSON object as a string.
const OPENROUTER_PLANNER_MODEL = "anthropic/claude-opus-4.8";
// Returns the JSON text PLUS which provider/model actually answered, latency and
// HTTP status — so telemetry can show whether Claude(OpenRouter) ran or it fell
// back to Gemini, and surface OpenRouter failures (the key thing to pinpoint).
async function llmJson(env: Env, sys: string, usr: string): Promise<{ text: string; provider: "openrouter" | "gemini" | "none"; model: string; ms: number; ok: boolean; status: number }> {
  const orKey = (env as any).OPENROUTER_API_KEY as string | undefined;
  const orModel = (env as any).OPENROUTER_PLANNER_MODEL || OPENROUTER_PLANNER_MODEL;
  if (orKey) {
    const t0 = Date.now();
    try {
      // One Brain B1 (SPEC §4): the Claude-Opus design call now goes through the
      // shared avaReason gateway. Model still pinned via `legacyModel` (single
      // OpenRouter call, no reasoner-ladder fallback), JSON mode, temperature 0.2,
      // max_tokens 900, same 20s abort — behaviour-identical to the old raw fetch.
      // NEW: a KV response cache keyed on a hash of the planning input (sys+usr+
      // model) — GenUI plans for the same surface are deterministic, so identical
      // requests now skip a ~2-6s Opus round-trip (24h TTL, via the gateway's
      // gen:<cacheKey> cache). The gateway emits ava_reason_call automatically; the
      // private LlmCall telemetry (provider/model/ms/ok/status) below is preserved.
      const cacheKey = await sha256Hex(`genui | ${orModel} | ${sys} | ${usr}`);
      const text = await avaReason(env, {
        role: "genui", capability: "plan", trigger: "plan_surface",
        feature: "genui", legacyModel: orModel,
        system: sys, user: usr, json: true,
        temperature: 0.2, maxTokens: 900, timeoutMs: 20000,
        cacheKey, cacheTtl: 86400,
      });
      if (text) return { text: String(text), provider: "openrouter", model: orModel, ms: Date.now() - t0, ok: true, status: 200 };
    } catch { /* fall back to Gemini */ }
    // OpenRouter failed — record it but continue to Gemini (don't break the card).
    // (provider stays openrouter so the failure is attributable; ok=false.)
  }
  // Gemini fallback
  const key = env.GEMINI_API_KEY ?? "";
  if (!key) return { text: "", provider: "none", model: "", ms: 0, ok: false, status: 0 };
  const g0 = Date.now();
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
    if (!res.ok) return { text: "", provider: "gemini", model: PLAN_MODEL, ms: Date.now() - g0, ok: false, status: res.status };
    const out: any = await res.json().catch(() => null);
    const text = out?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text).filter(Boolean).join("") ?? "";
    return { text, provider: "gemini", model: PLAN_MODEL, ms: Date.now() - g0, ok: !!text, status: res.status };
  } catch { return { text: "", provider: "gemini", model: PLAN_MODEL, ms: Date.now() - g0, ok: false, status: 0 }; }
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
  const allItems = found ? found.items : [];
  const displayItems = allItems.slice(0, MAX_DISPLAY);
  const count = displayItems.length;
  const total = totalCount(data, allItems.length);
  let surfaceData: unknown = data; // rebound to a bounded slice / {_groups} below

  const headerId = add({ type: "pill", label: `${plan.app_label} · ${total} ${total === 1 ? "item" : "items"}`, icon: "tray", fill: "lime", fg: "ink" });

  const kids: string[] = [headerId, add({ type: "spacer", size: 8 })];

  if (count === 0) {
    kids.push(add({ type: "card", child: add({ type: "text", value: plan.empty_text, variant: "sub", color: "inkSoft" }), fill: "card" }));
  } else {
    // ---- the repeating row template (bound per element) ----
    const titleId = add({ type: "text", value: `\${${plan.item_title}}`, variant: "title", maxLines: 1 });
    const rowKids: string[] = [titleId];
    if (plan.item_subtitle.length) {
      const sub = plan.item_subtitle.map((f) => `\${${f}}`).join("  ·  ");
      rowKids.push(add({ type: "text", value: sub, variant: "sub", color: "inkSoft" }));
    }
    // badge + open chip line
    const chipRow: string[] = [];
    if (plan.item_badge) chipRow.push(add({ type: "pill", label: `\${${plan.item_badge}}`, fill: "paper2", fg: "ink" }));
    if (plan.item_open) chipRow.push(add({ type: "button", label: "Open", icon: "arrow-square-out", fill: "card", iconOnly: true, action: { type: "link", url: `\${${plan.item_open}}` } }));
    if (chipRow.length) rowKids.push(add({ type: "row", children: chipRow, gap: 8, align: "start", wrap: true }));

    // per-row action bundle (composio) — compact ICON-ONLY buttons in a WRAPPING
    // row so they never stack into a full-width tower on a phone screen.
    const itemActs = plan.item_actions.map((aid) => byId.get(aid)).filter((a): a is Affordance => !!a);
    if (itemActs.length) {
      const btns = itemActs.map((a) => add({
        type: "button", label: a.label, icon: a.icon, fill: a.destructive ? "coral" : "card",
        iconOnly: true, action: affordanceToAction(a),
      }));
      rowKids.push(add({ type: "row", children: btns, gap: 8, align: "start", wrap: true }));
    }

    const itemCard = add({ type: "card", child: add({ type: "column", children: rowKids, gap: 4 }), accent: "blue" });

    // Grouped (Claude chose a category field) vs flat list. Grouping uses nested
    // A2UI lists (already client-supported) and rebinds the data to {_groups}.
    if (plan.group_by && found) {
      const groups = groupItems(displayItems, plan.group_by);
      surfaceData = { _groups: groups };
      const inner = add({ type: "list", path: "items", item: itemCard, gap: 7 });
      const section = add({ type: "column", children: [
        add({ type: "pill", label: "${_label} · ${_count}", icon: "tray", fill: "ink", fg: "paper" }),
        add({ type: "spacer", size: 6 }),
        inner,
        add({ type: "spacer", size: 10 }),
      ], gap: 0 });
      kids.push(add({ type: "list", path: "_groups", item: section, gap: 0 }));
    } else {
      // Bound the rendered slice: rebind data to {items: first N} so a huge list
      // never bloats the A2UI payload.
      surfaceData = { items: displayItems };
      kids.push(add({ type: "list", path: "items", item: itemCard, gap: 7 }));
    }

    // "Showing N of M" when the list was capped — never silently drop records.
    if (total > count) {
      kids.push(add({ type: "spacer", size: 8 }));
      kids.push(add({ type: "card", child: add({ type: "text", value: `Showing first ${count} of ${total} — ask me to filter or search to narrow it down.`, variant: "sub", color: "inkSoft" }), fill: "paper2" }));
    }
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
    root, components: comps, data: surfaceData,
  };
}

// Bucket records by a field's value into ordered sections (largest first).
function groupItems(items: any[], field: string): Array<{ _label: string; _count: number; items: any[] }> {
  const map = new Map<string, any[]>();
  for (const it of items) {
    const label = String((it?.[field] ?? "Other")).trim() || "Other";
    (map.get(label) ?? map.set(label, []).get(label)!).push(it);
  }
  return [...map.entries()]
    .map(([_label, arr]) => ({ _label, _count: arr.length, items: arr }))
    .sort((a, b) => b._count - a._count);
}

// ============================================================================
// Google Drive — a dedicated, app-aware presenter. Drive results are long lists
// of raw filenames (backups, db dumps, zips) that look like noise as a flat
// list. This groups files by TYPE into sections, shows a type badge + pretty
// size + modified date, truncates long names (maxLines), and attaches the
// per-file action bundle. Fully deterministic (no LLM) → fast + reliable.
// Renders via NESTED lists (groups → files), which the client already supports.
// ============================================================================

function prettyBytes(v: unknown): string {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0; let x = n;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return `${x >= 10 || i === 0 ? Math.round(x) : x.toFixed(1)} ${u[i]}`;
}

function shortDate(v: unknown): string {
  if (!v) return "";
  const d = new Date(String(v));
  if (isNaN(d.getTime())) return "";
  try { return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(d); }
  catch { return ""; }
}

// type label + order rank + per-file ICON + contextual "open" verb, from
// mimeType (preferred) or filename extension. The icon names map to glyphs in
// the Flutter renderer (file-pdf, file-xls, image, film-strip, music-notes, …).
function driveType(file: any): { label: string; rank: number; icon: string; open: { label: string; icon: string } } {
  const mime = String(file?.mimeType ?? "").toLowerCase();
  const name = String(file?.name ?? "").toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  const open = { label: "Open", icon: "arrow-square-out" };
  const view = { label: "View", icon: "eye" };
  const play = { label: "Play", icon: "play" };
  const T = (label: string, rank: number, icon: string, o = open) => ({ label, rank, icon, open: o });
  if (mime.includes("folder")) return T("Folders", 0, "folder");
  if (mime.includes("document") || ext === "doc" || ext === "docx") return T("Docs", 1, "file-doc");
  if (mime.includes("spreadsheet") || ext === "xls" || ext === "xlsx" || ext === "csv") return T("Sheets", 2, "file-xls");
  if (mime.includes("presentation") || ext === "ppt" || ext === "pptx") return T("Slides", 3, "file-ppt");
  if (mime.includes("pdf") || ext === "pdf") return T("PDFs", 4, "file-pdf", view);
  if (mime.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "heic", "svg"].includes(ext)) return T("Images", 5, "image", view);
  if (mime.startsWith("video/") || ["mp4", "mov", "mkv", "webm", "avi"].includes(ext)) return T("Videos", 6, "film-strip", play);
  if (mime.startsWith("audio/") || ["mp3", "m4a", "wav", "aac", "ogg"].includes(ext)) return T("Audio", 7, "music-notes", play);
  if (/(^|[_-])backup/.test(name) || ext === "gz" || ext === "tgz" || /\.sql/.test(name) || ext === "avbk") return T("Backups", 8, "file-zip");
  if (["zip", "rar", "7z", "tar"].includes(ext) || mime.includes("zip") || mime.includes("compressed")) return T("Archives", 9, "file-zip");
  if (["json", "txt", "md", "log", "yaml", "yml", "xml"].includes(ext)) return T("Text & code", 10, "file-text");
  return T("Files", 11, "file");
}

function driveFileId(f: any): string {
  return String(f?.id ?? f?.fileId ?? f?.fileID ?? f?.documentId ?? "");
}

// Bind an affordance's id arg(s) to a CONCRETE row id (we unroll Drive cards, so
// there's no per-element ${id} scope to resolve at render time).
function concreteAction(a: Affordance, idVal: string): A2uiAction {
  const act = affordanceToAction(a);
  if (act.type === "composio" && act.args) {
    const args: Record<string, string> = {};
    for (const [k, v] of Object.entries(act.args)) args[k] = (typeof v === "string" && v.includes("${")) ? idVal : v;
    return { ...act, args };
  }
  return act;
}

// Google Drive presenter. UNROLLED per file (bounded to MAX_DISPLAY) so EACH
// file gets its own type icon + contextual primary action (Play video, View
// image/PDF, Open doc) — things a flat list/template can't do because icons
// aren't data-bound. Grouped into type sections, with a "Showing N of M" footer
// when the list is capped. Deterministic, never falls back to text.
export interface DriveDiag { total: number; shown: number; groups: number; types: string; capped: boolean; item_actions: number; }

export async function buildDriveSurface(
  data: unknown, affordances: Affordance[], opts: { tool: string; gid: string; env?: Env; uid?: string },
): Promise<{ surface: A2uiSurface | null; diag: DriveDiag }> {
  const empty: DriveDiag = { total: 0, shown: 0, groups: 0, types: "", capped: false, item_actions: 0 };
  const found = findListPath(data);
  if (!found) return { surface: null, diag: empty };
  const all = found.items;
  const total = totalCount(data, all.length);
  const files = all.slice(0, MAX_DISPLAY);

  // group by type, preserving type order
  const groupsMap = new Map<string, { rank: number; icon: string; files: any[] }>();
  for (const f of files) {
    const t = driveType(f);
    const g = groupsMap.get(t.label) ?? { rank: t.rank, icon: t.icon, files: [] };
    g.files.push(f);
    groupsMap.set(t.label, g);
  }
  const groups = [...groupsMap.entries()].sort((a, b) => a[1].rank - b[1].rank);

  const comps: Record<string, A2uiNode> = {};
  let n = 0;
  const add = (node: A2uiNode): string => { const i = `d${n++}_${(node as any).type}`; comps[i] = node; return i; };
  const itemActs = affordances.filter((a) => a.scope === "item");
  const surfaceActs = affordances.filter((a) => a.scope === "surface");

  const kids: string[] = [
    add({ type: "pill", label: `Google Drive · ${total} ${total === 1 ? "file" : "files"}`, icon: "folder", fill: "lime", fg: "ink" }),
    add({ type: "spacer", size: 10 }),
  ];

  for (const [label, g] of groups) {
    kids.push(add({ type: "pill", label: `${label} · ${g.files.length}`, icon: g.icon, fill: "ink", fg: "paper" }));
    kids.push(add({ type: "spacer", size: 6 }));
    for (const f of g.files) {
      const t = driveType(f);
      const idVal = driveFileId(f);
      const link = String(f?.webViewLink ?? f?.webContentLink ?? "");
      const sizeMod = [prettyBytes(f?.size), shortDate(f?.modifiedTime ?? f?.createdTime)].filter(Boolean).join("  ·  ");

      const col: string[] = [add({ type: "text", value: String(f?.name ?? "Untitled"), variant: "title", maxLines: 1 })];
      if (sizeMod) col.push(add({ type: "text", value: sizeMod, variant: "sub", color: "inkSoft", maxLines: 1 }));
      const actRow: string[] = [];
      // Compact ICON-ONLY actions (label → tooltip) in a WRAPPING row, so they
      // never stack into a full-width tower that eats the screen on a phone.
      if (link) actRow.push(add({ type: "button", label: t.open.label, icon: t.open.icon, fill: "card", iconOnly: true, action: { type: "link", url: link } }));
      for (const a of itemActs) actRow.push(add({ type: "button", label: a.label, icon: a.icon, fill: a.destructive ? "coral" : "card", iconOnly: true, action: concreteAction(a, idVal) }));
      if (actRow.length) col.push(add({ type: "row", children: actRow, gap: 8, align: "start", wrap: true }));

      // Leading visual: a real PREVIEW thumbnail for files that have one (photos,
      // video, PDF, docs) via the signed thumbnail proxy; the type icon otherwise.
      let lead: string;
      if (f?.hasThumbnail === true && idVal && opts.env && opts.uid) {
        const turl = await signThumbUrl(opts.env, opts.uid, idVal);
        lead = add({ type: "image", url: turl, w: 46, h: 46, radius: 10, fallbackIcon: t.icon });
      } else {
        lead = add({ type: "icon", name: t.icon, size: 22, color: "ink" });
      }

      // leading visual + the text/action column (column EXPANDS so long file
      // names ellipsize instead of pushing the row off-screen).
      const body = add({ type: "row", children: [
        lead,
        add({ type: "expanded", child: add({ type: "column", children: col, gap: 4 }) }),
      ], gap: 10, align: "start" });
      kids.push(add({ type: "card", child: body, accent: "blue" }));
      kids.push(add({ type: "spacer", size: 6 }));
    }
    kids.push(add({ type: "spacer", size: 6 }));
  }

  if (total > files.length) {
    kids.push(add({ type: "card", child: add({ type: "text", value: `Showing first ${files.length} of ${total} — ask me to filter (e.g. "only PDFs" or "from last week").`, variant: "sub", color: "inkSoft" }), fill: "paper2" }));
  }

  for (const a of surfaceActs) {
    kids.push(add({ type: "spacer", size: 6 }));
    kids.push(add({ type: "button", label: a.label, icon: a.icon ?? "plus", fill: "lime", full: true, action: affordanceToAction(a) }));
  }

  const root = add({ type: "column", children: kids, gap: 0 });
  // Unrolled → all values are literal; no data model needed.
  const surface: A2uiSurface = { version: "v0.9", surfaceId: `gx_${Date.now()}`, gid: opts.gid, tool: opts.tool, ts: Date.now(), root, components: comps, data: {} };
  const diag: DriveDiag = {
    total, shown: files.length, groups: groups.length,
    types: groups.map(([label]) => label).join(","), capped: total > files.length, item_actions: itemActs.length,
  };
  return { surface, diag };
}
