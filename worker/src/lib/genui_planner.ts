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
  const affLines = input.affordances.map((a) =>
    `  - id:"${a.id}" label:"${a.label}" verb:${a.verb} scope:${a.scope}${a.destructive ? " [destructive]" : ""}`).join("\n");
  const sys =
    "You are a senior product designer. You design the SEMANTICS of an in-chat card that shows a user's data from one of their connected apps (Drive, Calendar, Gmail, Sheets, Notion, …) as a clean, premium little native-app screen. " +
    "You do NOT write UI markup — you choose which fields to display, how to group them, and which of the user's available actions to offer; code renders it consistently from your plan. " +
    "Return ONLY JSON matching: {app_label, list_path, item_title, item_subtitle:[..≤2..], item_badge?, item_open?, group_by?, item_actions:[ids], surface_actions:[ids], empty_text}. " +
    "Rules: item_title/subtitle/badge/open/group_by MUST be field names from the element fields given (or omit). " +
    "item_actions/surface_actions MUST be ids from the affordance list (never invent a tool). " +
    "Choose item_actions matching what the user most likely wants to DO next given their request (e.g. files: open, rename, move, delete, share). " +
    "Prefer a concise title and 1–2 informative subtitle fields. If a field holds a URL, use it as item_open. " +
    "If the rows have a natural category field (type/status/kind/folder/label), set group_by so the list is organised into sections instead of one long flat list. Make app_label and empty_text human and friendly.";
  const usr =
    `User request (their intent): "${String(input.request).slice(0, 300)}"\n` +
    `App: ${humanApp(input.toolkit)} (${input.entity})\n` +
    `Array path: ${listPath}\n` +
    `Element fields (name:type): ${JSON.stringify(fields)}\n` +
    `Available actions (affordances):\n${affLines || "  (none)"}\n\n` +
    "Return the plan JSON now.";
  try {
    const text = await llmJson(env, sys, usr);
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
      group_by: p.group_by ? String(p.group_by) : undefined,
    };
  } catch { return null; }
}

// The thinking/design brain. Prefers Claude Opus 4.8 via OpenRouter (a stronger
// designer) when OPENROUTER_API_KEY is set; otherwise falls back to Gemini. Both
// return a JSON object as a string.
const OPENROUTER_PLANNER_MODEL = "anthropic/claude-opus-4.8";
async function llmJson(env: Env, sys: string, usr: string): Promise<string> {
  const orKey = (env as any).OPENROUTER_API_KEY as string | undefined;
  if (orKey) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${orKey}`,
          "HTTP-Referer": "https://avatok.ai",
          "X-Title": "AvaTOK GenUI",
        },
        body: JSON.stringify({
          model: (env as any).OPENROUTER_PLANNER_MODEL || OPENROUTER_PLANNER_MODEL,
          messages: [{ role: "system", content: sys }, { role: "user", content: usr }],
          response_format: { type: "json_object" },
          temperature: 0.2,
          max_tokens: 900,
        }),
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) {
        const out: any = await res.json().catch(() => null);
        const text = out?.choices?.[0]?.message?.content ?? "";
        if (text) return String(text);
      }
    } catch { /* fall back to Gemini */ }
  }
  // Gemini fallback
  const key = env.GEMINI_API_KEY ?? "";
  if (!key) return "";
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
    if (!res.ok) return "";
    const out: any = await res.json().catch(() => null);
    return out?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text).filter(Boolean).join("") ?? "";
  } catch { return ""; }
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
  let surfaceData: unknown = data; // rebound to {_groups} when grouping

  const headerId = add({ type: "pill", label: `${plan.app_label} · ${count} ${count === 1 ? "item" : "items"}`, icon: "tray", fill: "lime", fg: "ink" });

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

    // Grouped (Claude chose a category field) vs flat list. Grouping uses nested
    // A2UI lists (already client-supported) and rebinds the data to {_groups}.
    if (plan.group_by && found) {
      const groups = groupItems(found.items, plan.group_by);
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
      kids.push(add({ type: "list", path: plan.list_path, item: itemCard, gap: 7 }));
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

// type label + order rank + icon, from mimeType (preferred) or filename ext.
function driveType(file: any): { label: string; rank: number; icon: string } {
  const mime = String(file?.mimeType ?? "").toLowerCase();
  const name = String(file?.name ?? "").toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  const T = (label: string, rank: number, icon: string) => ({ label, rank, icon });
  if (mime.includes("folder")) return T("Folders", 0, "folder");
  if (mime.includes("document") || ext === "doc" || ext === "docx") return T("Docs", 1, "tray");
  if (mime.includes("spreadsheet") || ext === "xls" || ext === "xlsx" || ext === "csv") return T("Sheets", 2, "tray");
  if (mime.includes("presentation") || ext === "ppt" || ext === "pptx") return T("Slides", 3, "tray");
  if (mime.includes("pdf") || ext === "pdf") return T("PDFs", 4, "tray");
  if (mime.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "heic", "svg"].includes(ext)) return T("Images", 5, "tray");
  if (mime.startsWith("video/") || ["mp4", "mov", "mkv", "webm", "avi"].includes(ext)) return T("Videos", 6, "video-camera");
  if (mime.startsWith("audio/") || ["mp3", "m4a", "wav", "aac", "ogg"].includes(ext)) return T("Audio", 7, "tray");
  // backups: db dumps + the long "backup_*" archives
  if (/(^|[_-])backup/.test(name) || ext === "gz" || ext === "tgz" || /\.sql/.test(name) || ext === "avbk") return T("Backups", 8, "tray");
  if (["zip", "rar", "7z", "tar"].includes(ext) || mime.includes("zip") || mime.includes("compressed")) return T("Archives", 9, "tray");
  return T("Files", 10, "tray");
}

export function buildDriveSurface(
  data: unknown, affordances: Affordance[], opts: { tool: string; gid: string },
): A2uiSurface | null {
  const found = findListPath(data);
  if (!found) return null;
  const files = found.items;

  // group + decorate
  const groupsMap = new Map<string, { label: string; rank: number; icon: string; files: any[] }>();
  for (const f of files) {
    const t = driveType(f);
    const decorated = { ...f, _type: t.label.replace(/s$/, ""), _size: prettyBytes(f?.size), _modified: shortDate(f?.modifiedTime ?? f?.createdTime) };
    const g = groupsMap.get(t.label) ?? { label: t.label, rank: t.rank, icon: t.icon, files: [] };
    g.files.push(decorated);
    groupsMap.set(t.label, g);
  }
  const groups = [...groupsMap.values()].sort((a, b) => a.rank - b.rank)
    .map((g) => ({ _label: g.label, _count: g.files.length, files: g.files }));
  const grouped = { _groups: groups };

  const comps: Record<string, A2uiNode> = {};
  let n = 0;
  const add = (node: A2uiNode): string => { const i = `d${n++}_${(node as any).type}`; comps[i] = node; return i; };
  const itemActs = affordances.filter((a) => a.scope === "item");
  const surfaceActs = affordances.filter((a) => a.scope === "surface");

  // file card (bound to a file element inside group.files)
  const fileKids: string[] = [add({ type: "text", value: "${name}", variant: "title", maxLines: 1 })];
  const meta: string[] = [];
  meta.push(add({ type: "pill", label: "${_type}", fill: "paper2", fg: "ink" }));
  // size · modified subtitle
  fileKids.push(add({ type: "text", value: "${_size}  ·  ${_modified}", variant: "sub", color: "inkSoft", maxLines: 1 }));
  // open chip + actions row
  const chip: string[] = [...meta];
  chip.push(add({ type: "button", label: "Open", icon: "arrow-square-out", fill: "card", action: { type: "link", url: "${webViewLink}" } }));
  fileKids.splice(1, 0, add({ type: "row", children: chip, gap: 6, align: "start" }));
  if (itemActs.length) {
    const btns = itemActs.map((a) => add({ type: "button", label: a.label, icon: a.icon, fill: a.destructive ? "coral" : "card", action: affordanceToAction(a) }));
    fileKids.push(add({ type: "row", children: btns, gap: 6, align: "start" }));
  }
  const fileCard = add({ type: "card", child: add({ type: "column", children: fileKids, gap: 4 }), accent: "blue" });
  const fileList = add({ type: "list", path: "files", item: fileCard, gap: 7 });

  // group section = header pill + the file list
  const groupCol = add({ type: "column", children: [
    add({ type: "pill", label: "${_label} · ${_count}", icon: "tray", fill: "ink", fg: "paper" }),
    add({ type: "spacer", size: 6 }),
    fileList,
    add({ type: "spacer", size: 10 }),
  ], gap: 0 });
  const groupList = add({ type: "list", path: "_groups", item: groupCol, gap: 0 });

  const kids: string[] = [
    add({ type: "pill", label: `Google Drive · ${files.length} ${files.length === 1 ? "file" : "files"}`, icon: "tray", fill: "lime", fg: "ink" }),
    add({ type: "spacer", size: 10 }),
    groupList,
  ];
  for (const a of surfaceActs) {
    kids.push(add({ type: "button", label: a.label, icon: a.icon ?? "plus", fill: "lime", full: true, action: affordanceToAction(a) }));
  }
  const root = add({ type: "column", children: kids, gap: 0 });
  return { version: "v0.9", surfaceId: `gx_${Date.now()}`, gid: opts.gid, tool: opts.tool, ts: Date.now(), root, components: comps, data: grouped };
}
