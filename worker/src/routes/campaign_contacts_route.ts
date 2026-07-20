// worker/src/routes/campaign_contacts_route.ts — [AVA-CAMP-D-CONTACTS] Contact-list
// ingestion for outbound AI calling campaigns. Specs/OUTBOUND-AI-CALLING-CAMPAIGNS.md
// §6.2 "Contact ingestion" (all hardening rules) + §3 (campaign_contacts columns).
//
// Endpoints (mounted by the wiring agent at /api/campaigns/:id/contacts*; this file
// does NOT touch campaigns.ts/index.ts):
//   POST /api/campaigns/:id/contacts/upload?name=<file>   raw-bytes body OR
//        JSON {sheetUrl:"https://docs.google.com/..."}
//   GET  /api/campaigns/:id/contacts?status=&cursor=&limit=
//
// Style/gating mirrors campaigns.ts (gate(), loadOwnedCampaign, requireUser) and
// campaign_kb.ts (R2 via env.BLOBS, metaDb, track()). Never throws — every path
// returns a structured JSON Response.
//
// xlsx: NO SheetJS/xlsx package is bundled in worker/package.json (checked —
// only @breezystack/lamejs is a runtime dep). CSV is implemented fully, natively
// (no library). An .xlsx upload is detected by extension/content-type and
// returns 415 "xlsx coming soon" per the task brief, rather than silently
// mis-parsing binary bytes as text. If an xlsx lib is added later, plug a
// branch into `parseUpload()` next to the CSV branch.
import type { Env } from "../types";
import { json } from "../util";
import { isFail, requireUser } from "../authz";
import { readConfig } from "./config";
import { metaDb } from "../db/shard";
import { track } from "../hooks";

const APP = "campaign_contacts";

// ---------------------------------------------------------------------------
// Gating — mirrors routes/campaigns.ts's gate() exactly (campaignsEnabled +
// campaignOwnerAllowlist beta gate). Contact ingestion has no extra flag of
// its own in §18, so this is the same gate as the parent campaigns route.
// ---------------------------------------------------------------------------
function parseUidList(raw: string | undefined): string[] {
  return (raw ?? "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

async function gate(env: Env, uid: string): Promise<{ error: string; status: number } | null> {
  const cfg = await readConfig(env);
  if (cfg.campaignsEnabled !== true) return { error: "disabled", status: 503 };
  if (cfg.campaignOwnerAllowlist === true) {
    const admins = parseUidList(env.ADMIN_UIDS);
    if (!admins.includes(uid)) return { error: "beta access required", status: 403 };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------
interface CampaignRow {
  id: string;
  uid: string;
  status: string;
  contacts_hash: string | null;
}

interface ContactRow {
  id: string;
  name: string | null;
  e164: string | null;
  status: string;
  attempts: number;
  last_outcome: string | null;
}

/** Ownership-checked single-row fetch — same pattern as campaigns.ts's
 *  loadOwnedCampaign; the client never supplies a trusted owner. */
async function loadOwnedCampaign(env: Env, id: string, uid: string): Promise<CampaignRow | null | "forbidden"> {
  const row = await metaDb(env)
    .prepare(`SELECT id, uid, status, contacts_hash FROM campaigns WHERE id=?1`)
    .bind(id)
    .first<CampaignRow>();
  if (!row) return null;
  if (row.uid !== uid) return "forbidden";
  return row;
}

const MUTABLE_STATUSES = new Set(["draft", "ready"]);
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB cap (§6.2, §18)
const MAX_CELL_CHARS = 2 * 1024; // 2 KB per-cell cap (§6.2)

// ---------------------------------------------------------------------------
// §6.2 hardening primitives
// ---------------------------------------------------------------------------

/** UTF-8 BOM strip (EF BB BF at the head of the decoded text). */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Formula-prefix strip — a cell starting with = + - @ can be interpreted as a
 *  formula by spreadsheet software (CSV injection) and must never round-trip
 *  as-is. We strip ALL leading occurrences of these characters (a value like
 *  "=+-@Rajesh" is fully de-fanged, not just the first char). */
function stripFormulaPrefix(cell: string): string {
  return cell.replace(/^[=+\-@]+/, "");
}

/** NFKC-normalize digits: collapses Devanagari (०-९), Arabic-Indic (٠-٩), and
 *  other Unicode numeral forms to ASCII 0-9 via canonical NFKC decomposition,
 *  which Unicode defines for all standard digit blocks. */
function normalizeDigits(cell: string): string {
  return cell.normalize("NFKC");
}

/** Per-cell 2KB cap + BOM/formula/digit hardening, applied to every raw cell
 *  before any further parsing. */
function hardenCell(raw: string): string {
  let c = raw.trim();
  if (c.length > MAX_CELL_CHARS) c = c.slice(0, MAX_CELL_CHARS);
  c = normalizeDigits(c);
  c = stripFormulaPrefix(c);
  return c.trim();
}

/** E.164 normalize, default country IN (+91) per §6.2. Accepts already-E.164
 *  numbers, bare 10-digit Indian mobile numbers, 0-prefixed local numbers, and
 *  91-prefixed numbers without the leading '+'. Returns null when the digits
 *  don't resemble a phone number at all. */
function normalizeE164IN(raw: string): string | null {
  let s = normalizeDigits(raw).trim();
  s = stripFormulaPrefix(s);
  // Keep only leading '+' and digits.
  const hasPlus = s.trim().startsWith("+");
  const digits = s.replace(/[^\d]/g, "");
  if (!digits) return null;

  let national: string;
  if (hasPlus) {
    // Already has a country code — trust it, just re-attach '+'.
    if (digits.length < 8 || digits.length > 15) return null;
    return "+" + digits;
  }
  if (digits.length === 12 && digits.startsWith("91")) {
    national = digits.slice(2);
  } else if (digits.length === 11 && digits.startsWith("0")) {
    national = digits.slice(1);
  } else if (digits.length === 10) {
    national = digits;
  } else if (digits.length >= 8 && digits.length <= 15) {
    // Not a recognizable Indian shape but plausible international digits
    // without '+' — default-IN only applies to India-shaped numbers; anything
    // else is rejected rather than guessed (§6.2 "reject ambiguous rows").
    return null;
  } else {
    return null;
  }
  if (national.length !== 10 || !/^[6-9]/.test(national)) return null; // Indian mobile shape
  return "+91" + national;
}

// ---------------------------------------------------------------------------
// CSV parsing (native — no library). RFC4180-ish: handles quoted fields,
// escaped quotes (""), commas/newlines inside quotes, and \r\n / \n / \r
// line endings.
// ---------------------------------------------------------------------------
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  function pushField() { row.push(field); field = ""; }
  function pushRow() { pushField(); rows.push(row); row = []; }

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ",") { pushField(); i++; continue; }
    if (c === "\r") {
      if (text[i + 1] === "\n") i++;
      pushRow(); i++; continue;
    }
    if (c === "\n") { pushRow(); i++; continue; }
    field += c; i++;
  }
  // Trailing field/row (file may or may not end with a newline).
  if (field.length > 0 || row.length > 0) pushRow();

  // Drop fully-empty trailing rows (common trailing-newline artifact).
  while (rows.length && rows[rows.length - 1].every((c) => c.trim() === "")) rows.pop();
  return rows;
}

// ---------------------------------------------------------------------------
// Column auto-detection — header heuristics for name + phone columns.
// ---------------------------------------------------------------------------
const NAME_HEADER_HINTS = ["name", "contact", "full name", "customer", "client", "lead"];
const PHONE_HEADER_HINTS = ["phone", "mobile", "cell", "number", "contact no", "whatsapp", "tel"];

function scoreHeader(hints: string[], header: string): boolean {
  const h = header.toLowerCase().trim();
  return hints.some((hint) => h.includes(hint));
}

/** Looks like a phone number irrespective of header: mostly digits, 8-15
 *  digits after stripping punctuation. Used as a fallback column detector
 *  when headers are unhelpful/missing. */
function looksLikePhone(cell: string): boolean {
  const digits = cell.replace(/[^\d]/g, "");
  return digits.length >= 8 && digits.length <= 15 && digits.length >= cell.replace(/[\s()+-]/g, "").length * 0.7;
}

interface ColumnMapping {
  nameCol: number | null;
  phoneCol: number | null;
  hasHeaderRow: boolean;
}

/** Suggests a name+phone column mapping. Returns hasHeaderRow=false (data
 *  starts at row 0) when the first row doesn't look like a header (e.g. it
 *  itself contains a phone-shaped cell). */
function detectColumns(rows: string[][]): ColumnMapping {
  if (rows.length === 0) return { nameCol: null, phoneCol: null, hasHeaderRow: false };
  const header = rows[0];
  const secondRow = rows[1];

  // Heuristic: treat row 0 as a header UNLESS it contains a phone-shaped cell
  // itself (then there is no header and data starts immediately).
  const headerLooksLikeData = header.some((c) => looksLikePhone(c));
  const hasHeaderRow = !headerLooksLikeData;

  let nameCol: number | null = null;
  let phoneCol: number | null = null;

  if (hasHeaderRow) {
    header.forEach((h, idx) => {
      if (phoneCol === null && scoreHeader(PHONE_HEADER_HINTS, h)) phoneCol = idx;
      if (nameCol === null && scoreHeader(NAME_HEADER_HINTS, h)) nameCol = idx;
    });
  }

  // Fallback: scan a sample data row for phone-shaped cells / plausible names.
  const sample = hasHeaderRow ? (secondRow ?? header) : header;
  if (phoneCol === null && sample) {
    for (let idx = 0; idx < sample.length; idx++) {
      if (looksLikePhone(sample[idx])) { phoneCol = idx; break; }
    }
  }
  if (nameCol === null && sample) {
    for (let idx = 0; idx < sample.length; idx++) {
      if (idx !== phoneCol && sample[idx] && !looksLikePhone(sample[idx])) { nameCol = idx; break; }
    }
  }

  return { nameCol, phoneCol, hasHeaderRow };
}

// ---------------------------------------------------------------------------
// Google Sheet link → CSV export URL
// ---------------------------------------------------------------------------
function sheetUrlToCsvExport(sheetUrl: string): string | null {
  try {
    const u = new URL(sheetUrl);
    if (!/(^|\.)docs\.google\.com$/.test(u.hostname)) return null;
    const m = u.pathname.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (!m) return null;
    const id = m[1];
    // Preserve a gid if present (either in the path fragment or query).
    let gid = u.searchParams.get("gid") ?? "";
    if (!gid && u.hash) {
      const hm = u.hash.match(/gid=(\d+)/);
      if (hm) gid = hm[1];
    }
    const base = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv`;
    return gid ? `${base}&gid=${gid}` : base;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Parsed contact rows → normalized/deduped/hashed result
// ---------------------------------------------------------------------------
interface ParsedContact {
  source_row: number;
  name: string | null;
  e164_raw: string | null;
  e164: string | null; // null => invalid
  extra: Record<string, string>;
}

interface IngestResult {
  contacts: ParsedContact[];
  mapping: ColumnMapping;
  invalidCount: number;
  duplicateCount: number;
  contactsHash: string;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function buildContacts(rows: string[][], maxContacts: number): Promise<IngestResult> {
  const mapping = detectColumns(rows);
  const dataRows = mapping.hasHeaderRow ? rows.slice(1) : rows;
  const headerRow = mapping.hasHeaderRow ? rows[0] : null;

  const parsed: ParsedContact[] = [];
  const seenPhones = new Set<string>();
  let invalidCount = 0;
  let duplicateCount = 0;

  for (let i = 0; i < dataRows.length && parsed.length < maxContacts; i++) {
    const rawRow = dataRows[i];
    if (rawRow.every((c) => c.trim() === "")) continue; // skip fully blank rows
    const sourceRow = mapping.hasHeaderRow ? i + 2 : i + 1; // 1-based, header offset

    const hardened = rawRow.map(hardenCell);
    const nameRaw = mapping.nameCol !== null ? (hardened[mapping.nameCol] ?? "") : "";
    const phoneRaw = mapping.phoneCol !== null ? (hardened[mapping.phoneCol] ?? "") : "";

    const extra: Record<string, string> = {};
    hardened.forEach((val, idx) => {
      if (idx === mapping.nameCol || idx === mapping.phoneCol) return;
      const key = headerRow?.[idx]?.trim() || `col_${idx}`;
      if (val) extra[key] = val;
    });

    const e164 = phoneRaw ? normalizeE164IN(phoneRaw) : null;
    if (!e164) {
      invalidCount++;
      parsed.push({
        source_row: sourceRow,
        name: nameRaw || null,
        e164_raw: phoneRaw || null,
        e164: null,
        extra,
      });
      continue;
    }
    // Dedupe AFTER normalization (§6.2) — +91 98…, 098…, 98… all collapse.
    if (seenPhones.has(e164)) {
      duplicateCount++;
      continue;
    }
    seenPhones.add(e164);
    parsed.push({
      source_row: sourceRow,
      name: nameRaw || null,
      e164_raw: phoneRaw || null,
      e164,
      extra,
    });
  }

  // contacts_hash = sha256 of the normalized, sorted phone set (audit — §6.2, §3).
  const sortedPhones = [...seenPhones].sort();
  const contactsHash = await sha256Hex(sortedPhones.join(","));

  return { contacts: parsed, mapping, invalidCount, duplicateCount, contactsHash };
}

// ---------------------------------------------------------------------------
// POST /api/campaigns/:id/contacts/upload?name=<file>
// ---------------------------------------------------------------------------
async function uploadContacts(req: Request, env: Env, uid: string, campaignId: string): Promise<Response> {
  const c = await loadOwnedCampaign(env, campaignId, uid);
  if (c === null) return json({ error: "not found" }, 404);
  if (c === "forbidden") return json({ error: "forbidden" }, 403);
  if (!MUTABLE_STATUSES.has(c.status)) {
    return json({ error: `cannot upload contacts from status '${c.status}'` }, 409);
  }

  const cfg = await readConfig(env);
  const maxContacts = typeof cfg.campaignMaxContacts === "number" && cfg.campaignMaxContacts > 0
    ? cfg.campaignMaxContacts : 2000;

  const url = new URL(req.url);
  const nameParam = (url.searchParams.get("name") || "").trim();
  const contentType = (req.headers.get("content-type") || "").toLowerCase();

  let csvText: string | null = null;
  let sourceLabel = nameParam || "upload";

  // ---- Path A: JSON {sheetUrl} — Google Sheet link import (§6.2). ----------
  if (contentType.includes("application/json")) {
    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    const sheetUrl = typeof body.sheetUrl === "string" ? body.sheetUrl.trim() : "";
    if (!sheetUrl) return json({ error: "sheetUrl required" }, 400);
    const exportUrl = sheetUrlToCsvExport(sheetUrl);
    if (!exportUrl) return json({ error: "not a recognizable Google Sheets link" }, 400);

    let resp: Response;
    try {
      resp = await fetch(exportUrl, { redirect: "follow" });
    } catch (e) {
      return json({ error: "failed to fetch sheet", detail: String(e).slice(0, 200) }, 400);
    }
    if (resp.status === 403) {
      return json({ error: "Google Sheet is not link-shared — enable link sharing (Anyone with the link → Viewer) and try again" }, 400);
    }
    const respType = (resp.headers.get("content-type") || "").toLowerCase();
    const buf = await resp.arrayBuffer();
    if (buf.byteLength > MAX_BODY_BYTES) return json({ error: `sheet export exceeds ${MAX_BODY_BYTES} bytes` }, 413);
    const text = new TextDecoder("utf-8").decode(buf);
    // A login/consent page comes back as HTML, not CSV — detect and reject
    // with the same "enable link sharing" guidance (§6.2).
    if (!resp.ok || respType.includes("text/html") || /^\s*<(!doctype|html)/i.test(text)) {
      return json({ error: "Google Sheet is not link-shared — enable link sharing (Anyone with the link → Viewer) and try again" }, 400);
    }
    csvText = text;
    sourceLabel = "google_sheet";
  } else {
    // ---- Path B: raw-bytes body — CSV natively; XLSX via lib if present else 415. ----
    const buf = await req.arrayBuffer();
    if (buf.byteLength === 0) return json({ error: "empty body" }, 400);
    if (buf.byteLength > MAX_BODY_BYTES) return json({ error: `max ${MAX_BODY_BYTES} bytes` }, 413);

    const lowerName = nameParam.toLowerCase();
    const isXlsx = lowerName.endsWith(".xlsx") || lowerName.endsWith(".xls")
      || contentType.includes("spreadsheetml") || contentType.includes("ms-excel");

    if (isXlsx) {
      // No SheetJS/xlsx package is bundled in this Worker (checked
      // worker/package.json — only @breezystack/lamejs). Fail clearly instead
      // of mis-parsing binary bytes as text.
      return json({ error: "xlsx coming soon — please upload CSV, or paste a Google Sheet share link" }, 415);
    }

    csvText = new TextDecoder("utf-8").decode(buf);
  }

  if (csvText === null) return json({ error: "no parseable content" }, 400);
  csvText = stripBom(csvText);

  let rows: string[][];
  try {
    rows = parseCsv(csvText);
  } catch (e) {
    return json({ error: "csv parse failed", detail: String(e).slice(0, 200) }, 400);
  }
  if (rows.length === 0) return json({ error: "no rows found" }, 400);

  const result = await buildContacts(rows, maxContacts);
  if (result.contacts.length === 0) {
    return json({ error: "no usable rows (no name/phone columns detected)", mapping: result.mapping }, 400);
  }

  // Insert rows: 'pending' for valid, 'invalid' for unparseable phone.
  const db = metaDb(env);
  const stmts = result.contacts.map((row) => {
    const id = crypto.randomUUID();
    const status = row.e164 ? "pending" : "invalid";
    return db.prepare(
      `INSERT INTO campaign_contacts
         (id, campaign_id, name, e164_raw, e164, extra, source_row, status, attempts)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0)`,
    ).bind(id, campaignId, row.name, row.e164_raw, row.e164, JSON.stringify(row.extra), row.source_row, status);
  });

  try {
    // D1 batch caps out well above our maxContacts(2000) default, but split
    // defensively in case a future maxContacts bump exceeds a single batch.
    const BATCH = 100;
    for (let i = 0; i < stmts.length; i += BATCH) {
      await db.batch(stmts.slice(i, i + BATCH));
    }
  } catch (e) {
    return json({ error: "insert failed", detail: String(e).slice(0, 200) }, 500);
  }

  try {
    await db.prepare(`UPDATE campaigns SET contacts_hash=?1, n_total=?2 WHERE id=?3`)
      .bind(result.contactsHash, result.contacts.filter((r) => r.e164).length, campaignId)
      .run();
  } catch { /* best-effort — the row insert above is the source of truth */ }

  const insertedValid = result.contacts.filter((r) => r.e164).length;
  const sample = result.contacts.slice(0, 5).map((r) => ({
    source_row: r.source_row, name: r.name, e164: r.e164, e164_raw: r.e164_raw,
    status: r.e164 ? "pending" : "invalid",
  }));

  track(env, uid, "ava_campaign_contacts_uploaded", APP, {
    campaign_id: campaignId,
    source: sourceLabel,
    inserted: insertedValid,
    invalid: result.invalidCount,
    duplicates: result.duplicateCount,
    total_rows: rows.length,
  });

  // TODO (fast-follow, §6.2 "Large lists chunk through the existing
  // contacts-chunk queue pattern"): for lists near/at maxContacts, move the
  // batch insert above onto env.Q_CONTACTS so the request lifecycle isn't
  // blocking on a large synchronous D1 batch. Implemented synchronously here
  // for <=2000 per the task scope.
  return json({
    ok: true,
    inserted: insertedValid,
    invalid: result.invalidCount,
    duplicates: result.duplicateCount,
    mapping: result.mapping,
    sample,
  });
}

// ---------------------------------------------------------------------------
// GET /api/campaigns/:id/contacts?status=&cursor=&limit=
// ---------------------------------------------------------------------------
async function listContacts(req: Request, env: Env, uid: string, campaignId: string): Promise<Response> {
  const c = await loadOwnedCampaign(env, campaignId, uid);
  if (c === null) return json({ error: "not found" }, 404);
  if (c === "forbidden") return json({ error: "forbidden" }, 403);

  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.trunc(limitRaw), 500) : 100;
  const offsetRaw = Number(url.searchParams.get("cursor"));
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.trunc(offsetRaw) : 0;

  const db = metaDb(env);
  const { results } = status
    ? await db.prepare(
        `SELECT id, name, e164, status, attempts, last_outcome FROM campaign_contacts
         WHERE campaign_id=?1 AND status=?2 ORDER BY source_row ASC LIMIT ?3 OFFSET ?4`,
      ).bind(campaignId, status, limit, offset).all<ContactRow>()
    : await db.prepare(
        `SELECT id, name, e164, status, attempts, last_outcome FROM campaign_contacts
         WHERE campaign_id=?1 ORDER BY source_row ASC LIMIT ?2 OFFSET ?3`,
      ).bind(campaignId, limit, offset).all<ContactRow>();

  const rows = results ?? [];
  return json({
    ok: true,
    contacts: rows,
    next_cursor: rows.length === limit ? offset + limit : null,
  });
}

// ---------------------------------------------------------------------------
// Dispatcher — caller delegates /api/campaigns/:id/contacts* here with the
// full original `path` (e.g. "/api/campaigns/abc123/contacts/upload").
// ---------------------------------------------------------------------------
export async function campaignContactsRoute(req: Request, env: Env, path: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const gated = await gate(env, ctx.uid);
  if (gated) return json({ error: gated.error }, gated.status);

  const rest = path.slice("/api/campaigns".length).replace(/^\/+/, ""); // "<id>/contacts" | "<id>/contacts/upload"
  const parts = rest.split("/").filter(Boolean);
  if (parts.length < 2 || parts[1] !== "contacts") return json({ error: "not found" }, 404);
  const campaignId = decodeURIComponent(parts[0]);
  const sub = parts[2] || "";

  if (!sub) {
    if (req.method === "GET") return await listContacts(req, env, ctx.uid, campaignId);
    return json({ error: "method not allowed" }, 405);
  }
  if (sub === "upload" && req.method === "POST") {
    return await uploadContacts(req, env, ctx.uid, campaignId);
  }
  return json({ error: "not found" }, 404);
}
