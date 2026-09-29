// [SAATHUM-UPI-3LAYER 2026-09-29] Pure helpers for the third-party SMS-forwarder webhook
// (routes/sms_forwarder.ts). Lenient on FORMAT (JSON of any nesting, form, multipart, text/plain,
// query string), strict on CONTENT (decided in the route with the existing HDFC parsers).

export const MAX_FORWARD_BODY = 16384;
const MAX_LEAVES = 400;

export type Leaf = { key: string; path: string; value: string };
export type ForwardPayload = {
  contentType: string;
  raw: string;
  /** top-level key names of the body plus the query string (for capture). */
  topKeys: string[];
  leaves: Leaf[];
};

const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Keys that may hold the SMS/notification text, best first (normalised: lower-case, alnum only). */
export const MESSAGE_KEYS = [
  "message", "msg", "body", "text", "bigtext", "notificationtext", "notificationbody", "content",
  "sms", "smsbody", "messagebody", "messagetext", "textmessage", "notificationmessage", "smstext",
];
export const SENDER_KEYS = ["from", "sender", "number", "address", "phone", "title", "app", "originatingaddress", "fromnumber", "senderaddress", "notificationtitle"];
export const TIME_KEYS = ["timestamp", "time", "date", "receivedat", "sentstamp", "sentat", "datetime", "posttime", "when"];

function walk(v: unknown, path: string[], out: Leaf[], depth = 0): void {
  if (out.length >= MAX_LEAVES || depth > 8 || v === null || v === undefined) return;
  if (Array.isArray(v)) { v.slice(0, 50).forEach((x, i) => walk(x, [...path, String(i)], out, depth + 1)); return; }
  if (typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, [...path, k], out, depth + 1);
    return;
  }
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    const key = norm(path[path.length - 1] ?? "");
    out.push({ key, path: norm(path.filter((p) => !/^\d+$/.test(p)).join("")), value: String(v) });
  }
}

function tryJson(s: string): unknown | undefined {
  const t = s.trim();
  if (!t || (t[0] !== "{" && t[0] !== "[")) return undefined;
  try { return JSON.parse(t); } catch { return undefined; }
}

async function readCapped(req: Request): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_FORWARD_BODY) return null;
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.length;
      if (size > MAX_FORWARD_BODY) { await reader.cancel(); return null; }
      chunks.push(r.value);
    }
  } catch { return null; }
  const bytes = new Uint8Array(size); let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.length; }
  return bytes;
}

/** Read whatever the app sent. Returns null only when the body is over the size cap. */
export async function readForwardPayload(req: Request): Promise<ForwardPayload | null> {
  const url = new URL(req.url);
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  const bytes = req.method === "GET" || req.method === "HEAD" ? new Uint8Array(0) : await readCapped(req);
  if (!bytes) return null;
  const raw = new TextDecoder().decode(bytes);
  const leaves: Leaf[] = []; const topKeys: string[] = [];
  const addObject = (o: Record<string, unknown>) => { for (const k of Object.keys(o)) topKeys.push(k); walk(o, [], leaves); };

  let parsed = false;
  if (raw) {
    if (contentType.includes("multipart/form-data")) {
      try {
        const fd = await new Response(bytes, { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData();
        const o: Record<string, unknown> = {};
        fd.forEach((v, k) => { o[k] = typeof v === "string" ? v : `[file:${(v as File).name ?? ""}]`; });
        addObject(o); parsed = true;
      } catch { /* fall through to raw text */ }
    } else if (contentType.includes("application/x-www-form-urlencoded")) {
      const o: Record<string, unknown> = {};
      new URLSearchParams(raw).forEach((v, k) => { o[k] = v; });
      addObject(o); parsed = true;
    }
    if (!parsed) {
      // JSON regardless of the declared type (forwarders often say text/plain for JSON bodies).
      const j = tryJson(raw);
      if (j !== undefined) {
        if (j && typeof j === "object" && !Array.isArray(j)) addObject(j as Record<string, unknown>);
        else { walk(j, [], leaves); }
        parsed = true;
      }
    }
    if (!parsed && !contentType.includes("json") && /^[^\s=&]+=[^]*$/.test(raw.trim()) && raw.includes("&") ) {
      const o: Record<string, unknown> = {};
      new URLSearchParams(raw.trim()).forEach((v, k) => { o[k] = v; });
      addObject(o); parsed = true;
    }
  }
  // Query string (GET-only forwarders, or extra fields). The path token is not in the query.
  const q: Record<string, unknown> = {};
  url.searchParams.forEach((v, k) => { q[k] = v; });
  if (Object.keys(q).length) { for (const k of Object.keys(q)) topKeys.push(`?${k}`); walk(q, [], leaves); }
  return { contentType, raw, topKeys: [...new Set(topKeys)].slice(0, 60), leaves };
}

function pick(leaves: Leaf[], keys: string[]): string[] {
  const out: string[] = [];
  for (const want of keys) {
    for (const l of leaves) {
      if ((l.key === want || l.path === want || l.path.endsWith(want)) && l.value.trim() && !out.includes(l.value)) out.push(l.value);
    }
  }
  return out;
}

/** Message-text candidates in priority order; the whole raw body is always the last resort. */
export function messageCandidates(p: ForwardPayload): string[] {
  const c = pick(p.leaves, MESSAGE_KEYS).map((s) => s.slice(0, 4096));
  if (p.raw.trim()) c.push(p.raw.trim().slice(0, 4096));
  return c;
}
export function senderCandidates(p: ForwardPayload): string[] {
  return pick(p.leaves, SENDER_KEYS).map((s) => s.trim().slice(0, 128)).filter(Boolean);
}

/** Epoch seconds/ms (number or numeric string) or a date string -> epoch ms, else null. */
export function parseTimestampMs(v: string): number | null {
  const s = v.trim();
  if (!s) return null;
  if (/^\d{9,14}$/.test(s)) { const n = Number(s); return n < 1e11 ? n * 1000 : n; }
  if (/^\d{9,14}\.\d+$/.test(s)) { const n = Number(s); return n < 1e11 ? Math.round(n * 1000) : Math.round(n); }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}
export function timestampCandidates(p: ForwardPayload): string[] { return pick(p.leaves, TIME_KEYS); }

/** Whitespace-collapsed, trimmed text used for the synthetic message hash. */
export const normaliseText = (s: string) => s.replace(/\s+/g, " ").trim();

/** Keep only the last 4 digits of any run of 10+ digits (accounts, phones, UPI refs). */
export function redact(s: string): string {
  return s.replace(/\d{10,}/g, (m) => `${"*".repeat(m.length - 4)}${m.slice(-4)}`);
}
