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
// xlsx: [AVA-CAMP-P-CONTACTS] parsed with `fflate` (tiny, Workers-safe pure-JS
// zip lib — no Node builtins, ~8KB min). worker/package.json gained a new dep
// ("fflate") — the orchestrator must `npm install` in worker/ before deploy.
// An .xlsx is a ZIP of XML parts; we unzip with fflate.unzipSync and hand-parse
// just the two parts we need (xl/worksheets/sheetN.xml + xl/sharedStrings.xml)
// with small regexes rather than pulling in a full XML DOM parser (Workers has
// no DOMParser). Parsed rows feed into the SAME buildContacts()/normalization/
// dedupe pipeline the CSV path already uses — no duplicated business logic.
// A parse failure returns 400 with a clear message; it never falls through to
// mis-parsing binary bytes as text and never 500s.
//
// Large lists (>CHUNK_THRESHOLD parsed rows): instead of a synchronous D1
// batch insert on the request, rows are split into CHUNK_SIZE-row chunks and
// enqueued to env.Q_CONTACTS ({kind:'campaign_contacts_chunk', ...}) for the
// consumer branch in index.ts's queue() handler to insert asynchronously.
// contacts_hash is computed once, over the FULL normalized/deduped set,
// before any chunking decision — chunking only affects how the rows are
// persisted, never what counts toward the audit hash.
import type { Env } from "../types";
import { json } from "../util";
import { isFail, requireUser } from "../authz";
import { readConfig } from "./config";
import { metaDb } from "../db/shard";
import { track } from "../hooks";
import { unzipSync, strFromU8 } from "fflate";

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
// XLSX parsing (native — `fflate` for unzip, hand-rolled regex XML reads).
// Produces the SAME string[][] row shape parseCsv() produces, so it feeds
// straight into detectColumns()/buildContacts() unchanged.
// ---------------------------------------------------------------------------
function xmlDecodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

/** "AB12" -> "AB" -> 0-based column index (A=0, Z=25, AA=26, ...). */
function colLettersToIndex(letters: string): number {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
}

/** xl/sharedStrings.xml -> ordered array of strings, indexed by <si> position.
 *  Rich-text runs (multiple <t> per <si>) are concatenated. */
function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml))) {
    const block = m[1];
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let tm: RegExpExecArray | null;
    let text = "";
    while ((tm = tRe.exec(block))) text += xmlDecodeEntities(tm[1]);
    out.push(text);
  }
  return out;
}

/** xl/worksheets/sheetN.xml -> string[][], gaps filled with "" so column
 *  indexes line up even when a row skips cells (e.g. "A1,C1" with B1 empty). */
function parseSheetXml(xml: string, sharedStrings: string[]): string[][] {
  const rows: string[][] = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(xml))) {
    const rowXml = rm[1];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm: RegExpExecArray | null;
    const cells: { idx: number; value: string }[] = [];
    let nextIdx = 0;
    while ((cm = cellRe.exec(rowXml))) {
      const attrs = cm[1] || "";
      const inner = cm[2] || "";
      const refMatch = attrs.match(/\br="([A-Z]+)\d+"/);
      const typeMatch = attrs.match(/\bt="([a-zA-Z]+)"/);
      const type = typeMatch ? typeMatch[1] : "n";
      const idx = refMatch ? colLettersToIndex(refMatch[1]) : nextIdx;
      nextIdx = idx + 1;

      let value = "";
      if (type === "inlineStr") {
        const tMatch = inner.match(/<t\b[^>]*>([\s\S]*?)<\/t>/);
        value = tMatch ? xmlDecodeEntities(tMatch[1]) : "";
      } else {
        const vMatch = inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
        const raw = vMatch ? xmlDecodeEntities(vMatch[1]) : "";
        if (type === "s") {
          const si = Number(raw);
          value = Number.isFinite(si) ? (sharedStrings[si] ?? "") : "";
        } else if (type === "b") {
          value = raw === "1" ? "TRUE" : "FALSE";
        } else {
          value = raw; // numeric cell or cached formula-string result (t="str")
        }
      }
      cells.push({ idx, value });
    }
    if (cells.length === 0) { rows.push([]); continue; }
    const maxIdx = cells.reduce((mx, c) => Math.max(mx, c.idx), 0);
    const row = new Array<string>(maxIdx + 1).fill("");
    for (const c of cells) row[c.idx] = c.value;
    rows.push(row);
  }
  return rows;
}

/** Full .xlsx (zip) bytes -> string[][] using the FIRST worksheet found
 *  (xl/worksheets/sheet1.xml, or the lowest-numbered sheetN.xml present).
 *  Throws on any structural problem — callers must catch and return 400. */
function parseXlsx(buf: ArrayBuffer): string[][] {
  const unzipped = unzipSync(new Uint8Array(buf));
  const sheetNames = Object.keys(unzipped).filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k));
  if (sheetNames.length === 0) throw new Error("no worksheet found in xlsx");
  sheetNames.sort((a, b) => {
    const na = Number(a.match(/sheet(\d+)\.xml/)?.[1] ?? "0");
    const nb = Number(b.match(/sheet(\d+)\.xml/)?.[1] ?? "0");
    return na - nb;
  });
  const sheetXml = strFromU8(unzipped[sheetNames[0]]);

  let sharedStrings: string[] = [];
  const sstBytes = unzipped["xl/sharedStrings.xml"];
  if (sstBytes) sharedStrings = parseSharedStrings(strFromU8(sstBytes));

  const rows = parseSheetXml(sheetXml, sharedStrings);
  // Drop fully-empty trailing rows, same as parseCsv().
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
export interface ParsedContact {
  source_row: number;
  name: string | null;
  e164_raw: string | null;
  e164: string | null; // null => invalid
  extra: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Large-list chunking (§6.2 "large lists chunk through the contacts-chunk
// queue"). An inline upload of CHUNK_THRESHOLD rows or fewer inserts
// synchronously (unchanged UX); above that, rows are split into
// CHUNK_SIZE-row messages on env.Q_CONTACTS for the queue consumer to insert.
// ---------------------------------------------------------------------------
const CHUNK_THRESHOLD = 500;
const CHUNK_SIZE = 200;

export interface CampaignContactsChunkMsg {
  kind: "campaign_contacts_chunk";
  campaign_id: string;
  uid: string;
  rows: ParsedContact[];
  source_row_offset: number;
}

/** Shared insert logic — used by BOTH the synchronous inline upload path and
 *  the async queue consumer (index.ts queue() -> "campaign_contacts_chunk").
 *  Never throws-to-500 on a single bad row; a D1 batch failure propagates so
 *  the caller (inline: 500 response; consumer: msg.retry()) can react. */
export async function insertCampaignContacts(
  env: Env,
  campaignId: string,
  _uid: string,
  rows: ParsedContact[],
): Promise<{ inserted: number; invalid: number }> {
  const db = metaDb(env);
  const stmts = rows.map((row) => {
    const id = crypto.randomUUID();
    const status = row.e164 ? "pending" : "invalid";
    return db.prepare(
      `INSERT INTO campaign_contacts
         (id, campaign_id, name, e164_raw, e164, extra, source_row, status, attempts)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0)`,
    ).bind(id, campaignId, row.name, row.e164_raw, row.e164, JSON.stringify(row.extra), row.source_row, status);
  });

  // D1 batch caps out well above CHUNK_SIZE(200)/maxContacts, but split
  // defensively in case either constant is bumped past a single batch.
  const BATCH = 100;
  for (let i = 0; i < stmts.length; i += BATCH) {
    await db.batch(stmts.slice(i, i + BATCH));
  }

  const inserted = rows.filter((r) => r.e164 !== null).length;
  return { inserted, invalid: rows.length - inserted };
}

/** Splits the full parsed+deduped contact set into CHUNK_SIZE-row messages
 *  and enqueues them to env.Q_CONTACTS. Falls back to inserting synchronously
 *  (chunk-by-chunk, still bounded batches) if the queue binding is absent —
 *  same "queue when bound, else run inline" pattern as contacts_backup.ts's
 *  scheduleChunk(), so this path degrades gracefully rather than 500ing. */
async function enqueueOrInsertChunks(
  env: Env,
  campaignId: string,
  uid: string,
  rows: ParsedContact[],
): Promise<{ queued: boolean; inserted: number; invalid: number }> {
  const chunks: ParsedContact[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) chunks.push(rows.slice(i, i + CHUNK_SIZE));

  if (env.Q_CONTACTS) {
    try {
      for (let i = 0; i < chunks.length; i++) {
        const msg: CampaignContactsChunkMsg = {
          kind: "campaign_contacts_chunk",
          campaign_id: campaignId,
          uid,
          rows: chunks[i],
          source_row_offset: i * CHUNK_SIZE,
        };
        await env.Q_CONTACTS.send(msg);
      }
      const inserted = rows.filter((r) => r.e164 !== null).length;
      return { queued: true, inserted, invalid: rows.length - inserted };
    } catch {
      // fall through to synchronous fallback below
    }
  }

  // No queue bound (or send failed) — insert synchronously in the same
  // chunk-sized batches so a huge list still can't blow one giant D1 call.
  let inserted = 0;
  let invalid = 0;
  for (const chunk of chunks) {
    const r = await insertCampaignContacts(env, campaignId, uid, chunk);
    inserted += r.inserted;
    invalid += r.invalid;
  }
  return { queued: false, inserted, invalid };
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
  let xlsxRows: string[][] | null = null;
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
    // ---- Path B: raw-bytes body — CSV natively; XLSX via fflate (see header comment). ----
    const buf = await req.arrayBuffer();
    if (buf.byteLength === 0) return json({ error: "empty body" }, 400);
    if (buf.byteLength > MAX_BODY_BYTES) return json({ error: `max ${MAX_BODY_BYTES} bytes` }, 413);

    const lowerName = nameParam.toLowerCase();
    const isXlsx = lowerName.endsWith(".xlsx") || lowerName.endsWith(".xls")
      || contentType.includes("spreadsheetml") || contentType.includes("ms-excel");

    if (isXlsx) {
      try {
        xlsxRows = parseXlsx(buf);
      } catch (e) {
        // Never mis-parse binary bytes as text, and never 500 on a bad
        // upload — a malformed/unsupported .xlsx is a 400 with a clear
        // message, same tier as a broken CSV below.
        return json({ error: "xlsx parse failed — file may be corrupted or an unsupported format", detail: String(e).slice(0, 200) }, 400);
      }
      sourceLabel = sourceLabel === "upload" ? "xlsx_upload" : sourceLabel;
    } else {
      csvText = new TextDecoder("utf-8").decode(buf);
    }
  }

  let rows: string[][];
  if (xlsxRows !== null) {
    rows = xlsxRows;
  } else {
    if (csvText === null) return json({ error: "no parseable content" }, 400);
    csvText = stripBom(csvText);
    try {
      rows = parseCsv(csvText);
    } catch (e) {
      return json({ error: "csv parse failed", detail: String(e).slice(0, 200) }, 400);
    }
  }
  if (rows.length === 0) return json({ error: "no rows found" }, 400);

  const result = await buildContacts(rows, maxContacts);
  if (result.contacts.length === 0) {
    return json({ error: "no usable rows (no name/phone columns detected)", mapping: result.mapping }, 400);
  }

  // contacts_hash is computed by buildContacts() over the FULL normalized/
  // deduped set (already true regardless of the sync/chunked decision below —
  // buildContacts runs once, up-front, over every row up to maxContacts).
  const db = metaDb(env);
  const large = result.contacts.length > CHUNK_THRESHOLD;

  let insertedValid: number;
  let queued = false;

  if (large) {
    const r = await enqueueOrInsertChunks(env, campaignId, uid, result.contacts);
    insertedValid = r.inserted;
    queued = r.queued;
  } else {
    try {
      const r = await insertCampaignContacts(env, campaignId, uid, result.contacts);
      insertedValid = r.inserted;
    } catch (e) {
      return json({ error: "insert failed", detail: String(e).slice(0, 200) }, 500);
    }
  }

  try {
    await db.prepare(`UPDATE campaigns SET contacts_hash=?1, n_total=?2 WHERE id=?3`)
      .bind(result.contactsHash, insertedValid, campaignId)
      .run();
  } catch { /* best-effort — the row insert(s) above are the source of truth */ }

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
    queued,
  });

  if (queued) {
    return json({
      ok: true,
      queued: true,
      total: result.contacts.length,
      invalid: result.invalidCount,
      duplicates: result.duplicateCount,
      mapping: result.mapping,
    });
  }

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
