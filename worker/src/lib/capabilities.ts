// capabilities.ts — the AUTOMATIC capability layer that makes GenUI cards
// functional for ANY Composio app, with zero per-app code.
//
// Problem it solves: the GenUI composer used to see only the ONE tool that
// produced the data (e.g. GOOGLEDRIVE_FIND_FILE) and the raw result — so it could
// only PAINT data. It had no idea a file can be renamed/moved/deleted, or that a
// calendar can create an event, and no way to wire a button to actually do it.
// Every action button degraded to a free-text "prompt" round-trip (the cause of
// the "Schedule a meeting" loop and the action-less Drive list).
//
// This module, given the tool that produced a result, fetches the FULL Composio
// tool catalog for that toolkit (not the curated 4–6), classifies every tool by
// VERB (create/update/delete/move/copy/share/…) and target ENTITY (file/event/
// email/…), and resolves a set of AFFORDANCES: the actions that apply to what is
// on screen, each with the form FIELDS it needs and the id ARGS to prefill from
// the row. The composer turns those into real buttons + forms; the client
// executes them via the server-validated /api/ava/genui/action route.
//
// Generic by construction: a brand-new connected app (Notion, Slack, Linear, …)
// automatically gets affordances from its own catalog — nothing to hand-write.

import type { Env } from "../types";
import type { A2uiAction, A2uiField } from "./a2ui";
import { listToolkitTools } from "./composio";

// Bump to invalidate cached catalogs AND GenUI templates when the affordance
// shape changes (the GenUI cache key folds this in via genui_compose).
// v2: fixed entity classification (calendar-management tools were misclassified
// as "event", wiring "Schedule a meeting" to CALENDAR_LIST_INSERT). Bumping this
// abandons the stale KV catalog cache AND invalidates cached GenUI templates that
// baked in the wrong affordance (cacheKey folds CAPS_VERSION in).
export const CAPS_VERSION = "v2";
const CATALOG_TTL = 60 * 60 * 24 * 7; // 7 days — toolkit catalogs are stable

export type Verb =
  | "create" | "list" | "get" | "update" | "rename" | "delete"
  | "move" | "copy" | "share" | "send" | "reply" | "download" | "other";

export interface CapTool {
  slug: string;        // e.g. GOOGLEDRIVE_RENAME_FILE
  name: string;
  description: string;
  params: any;         // sanitized JSON-schema object
  verb: Verb;
  entity: string;      // file|folder|event|email|draft|document|spreadsheet|row|contact|generic
  destructive: boolean;
}

export interface AffordanceField {
  name: string;        // the Composio arg name
  label: string;       // human label for the form
  kind: "text" | "textarea" | "number" | "date" | "time" | "datetime" | "select" | "checkbox";
  required: boolean;
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
  value?: string;      // default; may contain a ${path} binding
}

export interface Affordance {
  id: string;
  label: string;       // "Rename", "Delete", "Move", "Schedule a meeting"
  icon?: string;       // A2UI icon name
  tool: string;        // Composio slug to execute (server re-validates membership)
  verb: Verb;
  scope: "item" | "surface"; // per list-element vs whole surface
  destructive: boolean;
  confirm?: string;    // confirmation text (destructive); may contain ${path}
  args: Record<string, string>;     // static / ${path}-binding args (e.g. ids)
  fields: AffordanceField[];        // user-supplied inputs
}

// Per-call telemetry so the whole intent→presentation pipeline is measurable.
export interface CapsDiag {
  catalog_cache: "hit" | "miss" | "skip" | "empty"; // KV catalog cache outcome
  catalog_ms: number;        // time to obtain the catalog (KV read or Composio fetch + classify)
  catalog_tools: number;     // tools in the toolkit catalog
  resolve_ms: number;        // time to classify + rank affordances
  item: number;              // per-row affordances kept
  surface: number;           // per-surface affordances kept
}

export interface ResolvedCapabilities {
  toolkit: string;
  entity: string;
  affordances: Affordance[];
  diag: CapsDiag;
}

// Composio slugs are `${TOOLKIT}_${ACTION}` in upper snake-case; the toolkit
// slug is the lowercased prefix (GOOGLEDRIVE_… → "googledrive").
export function toolkitOf(toolSlug: string): string {
  const s = String(toolSlug ?? "");
  const i = s.indexOf("_");
  return (i > 0 ? s.slice(0, i) : s).toLowerCase();
}
function actionOf(toolSlug: string): string {
  const s = String(toolSlug ?? "");
  const i = s.indexOf("_");
  return (i > 0 ? s.slice(i + 1) : s).toLowerCase();
}

// Composio slugs + arg names are snake_case (create_event, start_datetime). A
// regex like /\bcreate\b/ does NOT match "create_event" because "_" is a word
// char, so classification must run on an underscore-normalised string.
function norm(s: string): string { return String(s ?? "").toLowerCase().replace(/[_.]+/g, " ").trim(); }

// ---- classification (verb + entity) — keyword heuristics, app-agnostic -------
function classifyVerb(action: string, desc: string): Verb {
  const a = norm(action);
  const d = norm(desc);
  const has = (re: RegExp) => re.test(a) || re.test(d);
  if (has(/\b(delete|remove|trash|destroy|drop)\b/)) return "delete";
  if (has(/\brename\b/)) return "rename";
  if (has(/\b(move|relocate)\b/)) return "move";
  if (has(/\b(copy|duplicate|clone)\b/)) return "copy";
  if (has(/\b(share|permission|grant|invite)\b/)) return "share";
  if (has(/\breply\b/)) return "reply";
  if (has(/\bsend\b/)) return "send";
  if (has(/\b(create|add|new|insert|make|compose|schedule|quick_add)\b/)) return "create";
  if (has(/\b(update|edit|modify|patch|set|change)\b/)) return "update";
  if (has(/\b(list|fetch|find|search|get_all|enumerate)\b/)) return "list";
  if (has(/\b(download|export)\b/)) return "download";
  if (has(/\b(get|read|info|by_id|retrieve|details)\b/)) return "get";
  return "other";
}

// Order matters — first match wins. "event" MUST be checked before "calendar":
// a calendar event's slug/description ("create_event", "events_list") mentions
// both words, and we want it classified as an EVENT. Conversely a calendar-
// management tool (GOOGLECALENDAR_CALENDAR_LIST_INSERT — add a calendar to the
// sidebar) is the "calendar" entity, NOT "event". Folding "calendar" into "event"
// was the bug that wired "Schedule a meeting" to calendarList.insert (id/hidden/
// selected/background-colour fields) instead of CREATE_EVENT.
const ENTITY_KEYS: Array<[string, RegExp]> = [
  ["event", /\b(event|events|meeting|appointment)\b/],
  ["calendar", /\b(calendar|calendarlist|calendar_list)\b/],
  ["folder", /\bfolder\b/],
  ["file", /\bfile\b/],
  ["draft", /\bdraft\b/],
  ["email", /\b(email|gmail|mail|thread|message)\b/],
  ["document", /\b(document|doc)\b/],
  ["spreadsheet", /\b(spreadsheet|sheet)\b/],
  ["row", /\b(row|record|cell)\b/],
  ["contact", /\b(contact|person)\b/],
  ["page", /\bpage\b/],
  ["task", /\b(task|issue|ticket)\b/],
];
function classifyEntity(action: string, desc: string): string {
  const hay = `${norm(action)} ${norm(desc)}`;
  for (const [ent, re] of ENTITY_KEYS) if (re.test(hay)) return ent;
  return "generic";
}

function classify(t: { slug: string; name: string; description: string; params: any }): CapTool {
  const action = actionOf(t.slug);
  const verb = classifyVerb(action, t.description);
  const entity = classifyEntity(action, t.description);
  return {
    slug: t.slug, name: t.name, description: t.description, params: t.params,
    verb, entity, destructive: verb === "delete",
  };
}

// ---- catalog (full, cached per toolkit) -------------------------------------
// Instrumented variant: returns the catalog PLUS the KV cache outcome + timing
// so callers can prove the catalog cache is doing its job (a "miss" hits Composio
// + the classifier, a "hit" is a single KV read).
export async function getToolkitCapabilitiesDiag(
  env: Env, toolkit: string,
): Promise<{ caps: CapTool[]; cache: CapsDiag["catalog_cache"]; ms: number }> {
  const t0 = Date.now();
  const key = `ava_caps:${CAPS_VERSION}:${toolkit}`;
  try {
    const cached = await env.TOKENS.get(key);
    if (cached) return { caps: JSON.parse(cached) as CapTool[], cache: "hit", ms: Date.now() - t0 };
  } catch { /* fall through */ }
  const raw = await listToolkitTools(env, toolkit);
  const caps = raw.map(classify);
  if (caps.length) { try { await env.TOKENS.put(key, JSON.stringify(caps), { expirationTtl: CATALOG_TTL }); } catch { /* best-effort */ } }
  return { caps, cache: caps.length ? "miss" : "empty", ms: Date.now() - t0 };
}

export async function getToolkitCapabilities(env: Env, toolkit: string): Promise<CapTool[]> {
  return (await getToolkitCapabilitiesDiag(env, toolkit)).caps;
}

// ---- schema → form fields ---------------------------------------------------
const ID_NAME = /(^|_)(id|ids|file_id|fileid|event_id|eventid|message_id|messageid|document_id|documentid|spreadsheet_id|spreadsheetid|thread_id|threadid|page_id|folder_id|item_id|resource_id|drive_id)(_|$)/i;
function isIdName(name: string): boolean { return ID_NAME.test(name); }

function fieldKind(name: string, schema: any): AffordanceField["kind"] {
  const fmt = String(schema?.format ?? "").toLowerCase();
  const n = norm(name); // underscore-normalised: "start_datetime" → "start datetime"
  if (Array.isArray(schema?.enum) && schema.enum.length) return "select";
  if (schema?.type === "boolean") return "checkbox";
  if (schema?.type === "number" || schema?.type === "integer") return "number";
  if (fmt.includes("date-time") || /\b(datetime|timestamp)\b/.test(n) || /\b(start|end)\b/.test(n)) return "datetime";
  if (fmt === "date" || /\bdate\b/.test(n)) return "date";
  if (fmt === "time" || /\btime\b/.test(n)) return "time";
  if (/\b(body|message|description|content|notes?)\b/.test(n)) return "textarea";
  return "text";
}

function prettyLabel(name: string): string {
  return name.replace(/[_.]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

// Turn an input schema into compact form fields, skipping anything we prefill
// (ids) and anything not worth asking a human (deep objects/arrays). Required
// fields first; capped so forms stay short and beautiful.
function schemaToFields(params: any, skip: Set<string>, max = 6): AffordanceField[] {
  const props = (params && typeof params === "object" && params.properties) || {};
  const required: string[] = Array.isArray(params?.required) ? params.required.map(String) : [];
  const out: AffordanceField[] = [];
  for (const [name, schemaRaw] of Object.entries(props)) {
    if (skip.has(name)) continue;                                  // already bound / defaulted
    if (isIdName(name) && !required.includes(name)) continue;      // hide optional ids; keep required ones (else the call would fail)
    const schema: any = schemaRaw;
    const type = schema?.type;
    if (type === "object" || type === "array") continue; // too complex for a chat form
    const kind = fieldKind(name, schema);
    out.push({
      name,
      label: prettyLabel(name),
      kind,
      required: required.includes(name),
      ...(Array.isArray(schema?.enum) && schema.enum.length
        ? { options: schema.enum.slice(0, 12).map((v: any) => ({ value: String(v), label: prettyLabel(String(v)) })) }
        : {}),
      ...(schema?.description ? { placeholder: String(schema.description).slice(0, 80) } : {}),
    });
  }
  // required first, then the rest, capped.
  out.sort((a, b) => Number(b.required) - Number(a.required));
  return out.slice(0, max);
}

// Container-id args are NOT the row's id — they scope WHERE the action runs and
// have stable defaults (verified against Composio docs: calendar_id is REQUIRED
// and must be "primary" for the user's main calendar). Binding these to the
// row's id (the old bug) would corrupt the call. Defaults applied first.
const CONTAINER_ID_DEFAULTS: Record<string, string> = {
  calendar_id: "primary",
};
function isContainerId(name: string): boolean {
  const n = name.toLowerCase();
  return n === "calendar_id" || n === "drive_id" || n === "parent_id" || n === "parent" || n === "folder_id";
}

// The arg that identifies the ROW the action targets. Composio names it after the
// entity (event_id, file_id, message_id, document_id) or plain `id`; we bind it
// to the rendered element's id. The id binding lists candidate element fields
// (id|<entity>_id|messageId) — the client resolves the first that exists, so a
// Gmail row (messageId) and a Drive row (id) both work without per-app code.
function entityIdArg(params: any, entity: string): string | null {
  const props = Object.keys((params && typeof params === "object" && params.properties) || {});
  const want = [`${entity}_id`, `${entity}id`, "id"];
  for (const w of want) { const hit = props.find((p) => p.toLowerCase() === w); if (hit) return hit; }
  // else first singular, non-container id arg.
  for (const p of props) if (isIdName(p) && !/ids$/i.test(p) && !isContainerId(p)) return p;
  return null;
}
const ROW_ID_BINDING = "${id|eventId|event_id|messageId|message_id|fileId|file_id|documentId}";

const VERB_ICON: Record<string, string> = {
  rename: "pencil-simple", update: "pencil-simple", delete: "trash", move: "folder",
  copy: "copy", share: "share-network", send: "paper-plane-right", reply: "arrow-bend-up-left",
  download: "download-simple", create: "plus", get: "arrow-square-out",
};
const VERB_LABEL: Record<string, string> = {
  rename: "Rename", update: "Edit", delete: "Delete", move: "Move", copy: "Duplicate",
  share: "Share", send: "Send", reply: "Reply", download: "Download", create: "New", get: "Open",
};

// Which verbs make sense AS A ROW ACTION on a listed entity vs a SURFACE action.
const ITEM_VERBS: Verb[] = ["rename", "update", "share", "move", "copy", "delete", "download", "send", "reply"];
const SURFACE_VERBS: Verb[] = ["create"];

function affordanceFrom(t: CapTool, scope: "item" | "surface"): Affordance {
  const props = (t.params && typeof t.params === "object" && t.params.properties) || {};
  const args: Record<string, string> = {};
  // 1) container ids get their stable default (calendar_id → "primary").
  for (const name of Object.keys(props)) {
    if (isContainerId(name) && CONTAINER_ID_DEFAULTS[name.toLowerCase()]) args[name] = CONTAINER_ID_DEFAULTS[name.toLowerCase()];
  }
  // 2) per-item actions bind the entity's own id arg to the rendered row.
  if (scope === "item") {
    const idArg = entityIdArg(t.params, t.entity);
    if (idArg) args[idArg] = ROW_ID_BINDING;
  }
  const skip = new Set(Object.keys(args));
  const fields = schemaToFields(t.params, skip);
  const label = t.verb === "create"
    ? createLabel(t)
    : (VERB_LABEL[t.verb] ?? prettyLabel(actionOf(t.slug)));
  return {
    id: t.slug.toLowerCase(),
    label,
    icon: VERB_ICON[t.verb],
    tool: t.slug,
    verb: t.verb,
    scope,
    destructive: t.destructive,
    ...(t.destructive ? { confirm: `${label} this ${t.entity === "generic" ? "item" : t.entity}?` } : {}),
    args,
    fields,
  };
}

function createLabel(t: CapTool): string {
  switch (t.entity) {
    case "event": return "Schedule a meeting";
    case "file": return "New file";
    case "folder": return "New folder";
    case "document": return "New document";
    case "spreadsheet": return "New spreadsheet";
    case "email": case "draft": return "Compose email";
    default: return prettyLabel(actionOf(t.slug));
  }
}

// Rank within a scope so we keep the highest-value, lowest-friction actions.
const VERB_RANK: Verb[] = ["rename", "update", "share", "send", "reply", "move", "copy", "download", "create", "get", "delete"];
function rank(a: Affordance): number {
  const i = VERB_RANK.indexOf(a.verb);
  return i < 0 ? 99 : i;
}

// THE resolver: given the tool that produced the on-screen data, return the
// affordances that apply to it. `entityHint` lets callers (e.g. the calendar
// pilot) force the entity when they already know it.
export async function resolveAffordances(
  env: Env, producingTool: string, opts?: { entityHint?: string; maxItem?: number; maxSurface?: number },
): Promise<ResolvedCapabilities | null> {
  const toolkit = toolkitOf(producingTool);
  if (!toolkit) return null;
  const cat = await getToolkitCapabilitiesDiag(env, toolkit);
  const caps = cat.caps;
  const baseDiag: CapsDiag = {
    catalog_cache: cat.cache, catalog_ms: cat.ms, catalog_tools: caps.length,
    resolve_ms: 0, item: 0, surface: 0,
  };
  if (!caps.length) return null;

  const r0 = Date.now();
  // Entity rendered = what the producing (list/get) tool acts on, unless hinted.
  const producer = caps.find((c) => c.slug === producingTool);
  const entity = opts?.entityHint ?? producer?.entity ?? dominantEntity(caps);

  // Prefer tools whose entity EXACTLY matches what's on screen; only fall back to
  // "generic" tools when the producing entity is itself unknown. This stops a
  // sibling entity's create/edit tool (e.g. calendar-management vs. event) from
  // leaking into the card.
  const matches = (c: CapTool) =>
    c.entity === entity || (entity === "generic" && c.entity === "generic") || (entity !== "generic" && c.entity === "generic");

  // Collapse affordances that would render as the same button (same label) — e.g.
  // CREATE_EVENT and QUICK_ADD both label "Schedule a meeting"; keep the best-ranked.
  const dedupe = (list: Affordance[]): Affordance[] => {
    const seen = new Set<string>();
    const out: Affordance[] = [];
    for (const a of list) {
      const key = a.label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key); out.push(a);
    }
    return out;
  };

  const itemAff = dedupe(caps
    .filter((c) => ITEM_VERBS.includes(c.verb) && matches(c))
    .map((c) => affordanceFrom(c, "item"))
    .sort((a, b) => rank(a) - rank(b)))
    .slice(0, opts?.maxItem ?? 4);

  const surfaceAff = dedupe(caps
    .filter((c) => SURFACE_VERBS.includes(c.verb) && matches(c))
    .map((c) => affordanceFrom(c, "surface"))
    .sort((a, b) => rank(a) - rank(b)))
    .slice(0, opts?.maxSurface ?? 2);

  const affordances = [...itemAff, ...surfaceAff];
  const diag: CapsDiag = { ...baseDiag, resolve_ms: Date.now() - r0, item: itemAff.length, surface: surfaceAff.length };
  return { toolkit, entity, affordances, diag };
}

// Convert a resolved affordance into the A2UI `composio` action the client
// fires. Single source of truth so the calendar pilot, the GenUI composer and
// any future caller all wire actions identically.
export function affordanceToAction(a: Affordance): A2uiAction {
  return {
    type: "composio",
    tool: a.tool,
    label: a.label,
    ...(a.args && Object.keys(a.args).length ? { args: a.args } : {}),
    ...(a.fields && a.fields.length ? { fields: a.fields as A2uiField[] } : {}),
    ...(a.confirm ? { confirm: a.confirm } : {}),
  };
}

function dominantEntity(caps: CapTool[]): string {
  const counts = new Map<string, number>();
  for (const c of caps) if (c.entity !== "generic") counts.set(c.entity, (counts.get(c.entity) ?? 0) + 1);
  let best = "generic"; let n = 0;
  for (const [e, c] of counts) if (c > n) { best = e; n = c; }
  return best;
}

// Server-side guard for /api/ava/genui/action: a card may only execute a tool
// that actually belongs to one of the toolkits the catalog knows AND is a real
// slug in that toolkit's catalog. Stops a tampered/hallucinated surface from
// invoking an arbitrary Composio tool.
export async function isExecutableTool(env: Env, toolSlug: string): Promise<boolean> {
  const toolkit = toolkitOf(toolSlug);
  if (!toolkit) return false;
  const caps = await getToolkitCapabilities(env, toolkit);
  return caps.some((c) => c.slug === toolSlug);
}

// Coerce/validate args against the tool's input schema before execution: keep
// only known properties, cast primitive types, drop empties. Defensive — never
// throws; returns the cleaned args object.
export async function coerceArgs(env: Env, toolSlug: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const toolkit = toolkitOf(toolSlug);
  const caps = await getToolkitCapabilities(env, toolkit);
  const tool = caps.find((c) => c.slug === toolSlug);
  const props = (tool?.params && tool.params.properties) || {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    if (v == null || v === "") continue;
    const schema: any = props[k];
    if (!schema && Object.keys(props).length) continue; // unknown arg — drop when we know the schema
    if (schema?.type === "number" || schema?.type === "integer") {
      const n = Number(v); if (Number.isFinite(n)) out[k] = n; continue;
    }
    if (schema?.type === "boolean") { out[k] = v === true || v === "true" || v === 1 || v === "1"; continue; }
    out[k] = v;
  }
  return out;
}
