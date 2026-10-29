// [HF-SUPPORT-1] Small, dependency-free MIME parser for inbound support mail.
//
// postal-mime is not in worker/package.json and new dependencies are not allowed here, so this parses exactly what the
// support desk needs: headers (folded, RFC 2047 encoded words), multipart/* recursion, text/plain + text/html bodies,
// base64 / quoted-printable / 7bit / 8bit transfer encodings, charsets (via TextDecoder), attachments (RFC 2231 names too),
// and address lists. It never throws on malformed mail: unreadable parts are skipped.
//
// Works on a "binary string" (one char per byte) so header and boundary scanning is cheap and byte-exact; bodies are
// converted back to bytes before charset decoding.

export interface MailAddress { name: string; email: string }

export interface MimeAttachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
  size: number;
  contentId: string | null;
  inline: boolean;
}

export interface ParsedMail {
  /** lower-case header name -> raw (unfolded, still RFC 2047 encoded) values in order of appearance */
  headers: Map<string, string[]>;
  subject: string;
  from: MailAddress | null;
  replyTo: MailAddress | null;
  to: MailAddress[];
  cc: MailAddress[];
  messageId: string | null;      // without angle brackets
  inReplyTo: string | null;      // first id, without angle brackets
  references: string[];           // ids without angle brackets
  date: number | null;           // ms
  text: string;
  html: string;
  attachments: MimeAttachment[];
}

const MAX_DEPTH = 8;
const MAX_PARTS = 200;

// ---------------------------------------------------------------------------------------------------------------------
// bytes <-> binary string
// ---------------------------------------------------------------------------------------------------------------------
export function bytesToBinary(u8: Uint8Array): string {
  let out = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) out += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + CHUNK)));
  return out;
}

export function binaryToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function decodeCharset(bytes: Uint8Array, charset: string): string {
  const cs = (charset || "utf-8").trim().toLowerCase().replace(/^"|"$/g, "");
  const label = cs === "utf8" ? "utf-8" : cs === "us-ascii" || cs === "ascii" ? "windows-1252" : cs;
  try { return new TextDecoder(label).decode(bytes); }
  catch { try { return new TextDecoder("utf-8").decode(bytes); } catch { return bytesToBinary(bytes); } }
}

// ---------------------------------------------------------------------------------------------------------------------
// transfer encodings
// ---------------------------------------------------------------------------------------------------------------------
export function decodeBase64(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/=_-]/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = clean + "=".repeat((4 - (clean.length % 4)) % 4);
  try { return binaryToBytes(atob(padded)); } catch { return new Uint8Array(0); }
}

/** Quoted-printable (RFC 2045) to bytes. */
export function decodeQuotedPrintable(s: string): Uint8Array {
  const joined = s.replace(/=\r?\n/g, "");
  const out: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    const c = joined.charCodeAt(i);
    if (c === 0x3d && i + 2 < joined.length + 0 && /^[0-9A-Fa-f]{2}$/.test(joined.slice(i + 1, i + 3))) {
      out.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(c & 0xff);
  }
  return Uint8Array.from(out);
}

function decodeBody(body: string, encoding: string): Uint8Array {
  const enc = (encoding || "").trim().toLowerCase();
  if (enc === "base64") return decodeBase64(body);
  if (enc === "quoted-printable") return decodeQuotedPrintable(body);
  return binaryToBytes(body);
}

// ---------------------------------------------------------------------------------------------------------------------
// RFC 2047 encoded words
// ---------------------------------------------------------------------------------------------------------------------
const ENCODED_WORD = /=\?([^?\s]+)\?([bBqQ])\?([^?]*)\?=/g;

/** Decode "=?UTF-8?B?...?=" / "=?ISO-8859-1?Q?...?=" words in a header value. Adjacent encoded words join without the space between them. */
export function decodeEncodedWords(value: string): string {
  if (!value || value.indexOf("=?") === -1) return value;
  const collapsed = value.replace(/(\?=)\s+(=\?)/g, "$1$2");
  return collapsed.replace(ENCODED_WORD, (_m, charset: string, enc: string, text: string) => {
    try {
      const star = charset.indexOf("*");
      const cs = star === -1 ? charset : charset.slice(0, star); // RFC 2231 language suffix
      if (enc.toLowerCase() === "b") return decodeCharset(decodeBase64(text), cs);
      return decodeCharset(decodeQuotedPrintable(text.replace(/_/g, " ")), cs);
    } catch { return text; }
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// headers
// ---------------------------------------------------------------------------------------------------------------------
function splitHead(s: string, start: number, end: number): { head: string; bodyStart: number } {
  const region = s.slice(start, end);
  // A part may have an empty header block (body starts right away with a blank line).
  if (region.startsWith("\r\n")) return { head: "", bodyStart: start + 2 };
  if (region.startsWith("\n")) return { head: "", bodyStart: start + 1 };
  const a = region.indexOf("\r\n\r\n");
  const b = region.indexOf("\n\n");
  if (a === -1 && b === -1) return { head: region, bodyStart: end };
  if (a !== -1 && (b === -1 || a < b)) return { head: region.slice(0, a), bodyStart: start + a + 4 };
  return { head: region.slice(0, b), bodyStart: start + b + 2 };
}

function parseHeaders(head: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const unfolded = head.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    if (!/^[!-9;-~]+$/.test(name)) continue;
    const value = line.slice(i + 1).trim();
    const list = map.get(name);
    if (list) list.push(value); else map.set(name, [value]);
  }
  return map;
}

interface ParamValue { value: string; params: Record<string, string> }

/** "text/plain; charset=utf-8; name*0*=UTF-8''a%20; name*1=b" -> { value:'text/plain', params:{charset:'utf-8', name:'a b'} } */
export function parseParams(header: string | undefined): ParamValue {
  const out: ParamValue = { value: "", params: {} };
  if (!header) return out;
  const parts: string[] = [];
  let cur = "", quoted = false;
  for (let i = 0; i < header.length; i++) {
    const ch = header[i];
    if (ch === "\\" && quoted && i + 1 < header.length) { cur += header[++i]; continue; }
    if (ch === '"') { quoted = !quoted; cur += ch; continue; }
    if (ch === ";" && !quoted) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  parts.push(cur);
  out.value = (parts.shift() ?? "").trim().toLowerCase();
  const pieces: Record<string, Array<{ idx: number; star: boolean; v: string }>> = {};
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq <= 0) continue;
    let name = p.slice(0, eq).trim().toLowerCase();
    let val = p.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) val = val.slice(1, -1);
    let idx = 0, star = false;
    const m = /^(.+?)(?:\*(\d+))?(\*)?$/.exec(name);
    if (m && (m[2] !== undefined || m[3])) { name = m[1]; idx = m[2] ? parseInt(m[2], 10) : 0; star = !!m[3]; }
    (pieces[name] ||= []).push({ idx, star, v: val });
  }
  for (const [name, list] of Object.entries(pieces)) {
    list.sort((a, b) => a.idx - b.idx);
    if (list.length === 1 && !list[0].star) { out.params[name] = list[0].v; continue; }
    // RFC 2231: charset'lang'percent-encoded (only the first piece carries the charset)
    let charset = "utf-8", joined = "";
    list.forEach((piece, n) => {
      let v = piece.v;
      if (piece.star) {
        if (n === 0) { const m2 = /^([^']*)'[^']*'(.*)$/.exec(v); if (m2) { charset = m2[1] || "utf-8"; v = m2[2]; } }
        const bytes: number[] = [];
        for (let i = 0; i < v.length; i++) {
          if (v[i] === "%" && /^[0-9A-Fa-f]{2}$/.test(v.slice(i + 1, i + 3))) { bytes.push(parseInt(v.slice(i + 1, i + 3), 16)); i += 2; }
          else bytes.push(v.charCodeAt(i) & 0xff);
        }
        joined += decodeCharset(Uint8Array.from(bytes), charset);
      } else joined += v;
    });
    out.params[name] = joined;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// addresses
// ---------------------------------------------------------------------------------------------------------------------
export function parseAddressList(value: string | undefined | null): MailAddress[] {
  if (!value) return [];
  const decoded = decodeEncodedWords(value);
  const items: string[] = [];
  let cur = "", quoted = false, angle = 0, comment = 0;
  for (let i = 0; i < decoded.length; i++) {
    const ch = decoded[i];
    if (ch === '"' && comment === 0) quoted = !quoted;
    else if (!quoted && ch === "(") comment++;
    else if (!quoted && ch === ")" && comment > 0) comment--;
    else if (!quoted && comment === 0 && ch === "<") angle++;
    else if (!quoted && comment === 0 && ch === ">" && angle > 0) angle--;
    if (ch === "," && !quoted && angle === 0 && comment === 0) { items.push(cur); cur = ""; continue; }
    if (ch === ";" && !quoted && angle === 0 && comment === 0 && /:\s*$/.test(cur)) { cur = ""; continue; } // end of "group:" syntax
    cur += ch;
  }
  items.push(cur);
  const out: MailAddress[] = [];
  for (const raw of items) {
    const item = raw.trim();
    if (!item) continue;
    const m = /^(.*?)<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/.exec(item);
    if (m) {
      out.push({ name: m[1].trim().replace(/^"(.*)"$/, "$1").replace(/\\(.)/g, "$1").trim(), email: m[2].trim().toLowerCase() });
      continue;
    }
    const bare = /([^\s<>()"]+@[^\s<>()",;]+)/.exec(item);
    if (bare) out.push({ name: "", email: bare[1].toLowerCase() });
  }
  return out;
}

export function parseMessageIds(value: string | undefined | null): string[] {
  if (!value) return [];
  const ids: string[] = [];
  const re = /<([^<>\s]+)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) ids.push(m[1]);
  return ids;
}

// ---------------------------------------------------------------------------------------------------------------------
// body structure
// ---------------------------------------------------------------------------------------------------------------------
interface WalkState { text: string[]; html: string[]; attachments: MimeAttachment[]; parts: number }

const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/heic": "heic",
  "application/pdf": "pdf", "text/plain": "txt", "message/rfc822": "eml", "text/calendar": "ics", "application/zip": "zip",
};

function walk(s: string, start: number, end: number, depth: number, st: WalkState, inheritedHeaders?: Map<string, string[]>): Map<string, string[]> {
  const { head, bodyStart } = splitHead(s, start, end);
  const headers = inheritedHeaders ?? parseHeaders(head);
  if (st.parts++ > MAX_PARTS || depth > MAX_DEPTH) return headers;
  const ct = parseParams(headers.get("content-type")?.[0]);
  const type = ct.value || "text/plain";
  const body = s.slice(bodyStart, end);

  if (type.startsWith("multipart/") && ct.params.boundary) {
    const delim = "--" + ct.params.boundary;
    let pos = body.indexOf(delim);
    const starts: number[] = [];
    const ends: number[] = [];
    while (pos !== -1) {
      const lineStart = pos === 0 || body[pos - 1] === "\n";
      const after = pos + delim.length;
      if (lineStart) {
        if (body.startsWith("--", after)) { if (starts.length > ends.length) ends.push(pos); break; }
        if (starts.length > ends.length) ends.push(pos);
        const nl = body.indexOf("\n", after);
        starts.push(nl === -1 ? body.length : nl + 1);
      }
      pos = body.indexOf(delim, after);
    }
    if (starts.length > ends.length) ends.push(body.length);
    for (let i = 0; i < starts.length; i++) {
      let e = ends[i];
      if (body[e - 1] === "\n") e--;
      if (body[e - 1] === "\r") e--; // the CRLF before the delimiter belongs to the delimiter
      walk(body, starts[i], Math.max(starts[i], e), depth + 1, st);
    }
    return headers;
  }

  const disp = parseParams(headers.get("content-disposition")?.[0]);
  const encoding = headers.get("content-transfer-encoding")?.[0] ?? "";
  const rawName = disp.params.filename ?? ct.params.name;
  const filename = rawName ? decodeEncodedWords(rawName) : "";
  const isAttachment = disp.value === "attachment" || !!filename || (!type.startsWith("text/") && !type.startsWith("multipart/"));

  if (!isAttachment && (type === "text/plain" || type === "text/html")) {
    const text = decodeCharset(decodeBody(body, encoding), ct.params.charset ?? "utf-8");
    (type === "text/html" ? st.html : st.text).push(text);
    return headers;
  }
  if (!isAttachment && type.startsWith("text/")) {
    st.text.push(decodeCharset(decodeBody(body, encoding), ct.params.charset ?? "utf-8"));
    return headers;
  }

  const content = decodeBody(body, encoding);
  const ext = EXT_BY_TYPE[type] ?? "bin";
  const contentId = (headers.get("content-id")?.[0] ?? "").replace(/^<|>$/g, "") || null;
  st.attachments.push({
    filename: filename || `attachment-${st.attachments.length + 1}.${ext}`,
    contentType: type || "application/octet-stream",
    content,
    size: content.length,
    contentId,
    inline: disp.value === "inline" && !!contentId,
  });
  return headers;
}

function first(headers: Map<string, string[]>, name: string): string | undefined { return headers.get(name)?.[0]; }

/** Parse a whole RFC 5322 message. Accepts bytes or an already-decoded binary string. */
export function parseMime(input: Uint8Array | ArrayBuffer | string): ParsedMail {
  const s = typeof input === "string" ? input : bytesToBinary(input instanceof Uint8Array ? input : new Uint8Array(input));
  const st: WalkState = { text: [], html: [], attachments: [], parts: 0 };
  const headers = walk(s, 0, s.length, 0, st);

  const fromList = parseAddressList(first(headers, "from"));
  const replyToList = parseAddressList(first(headers, "reply-to"));
  const refs = parseMessageIds(headers.get("references")?.join(" "));
  const dateMs = Date.parse(first(headers, "date") ?? "");
  return {
    headers,
    subject: decodeEncodedWords(first(headers, "subject") ?? "").trim(),
    from: fromList[0] ?? null,
    replyTo: replyToList[0] ?? null,
    to: parseAddressList(headers.get("to")?.join(",")),
    cc: parseAddressList(headers.get("cc")?.join(",")),
    messageId: parseMessageIds(first(headers, "message-id"))[0] ?? null,
    inReplyTo: parseMessageIds(first(headers, "in-reply-to"))[0] ?? null,
    references: refs,
    date: Number.isFinite(dateMs) ? dateMs : null,
    text: st.text.join("\n\n").replace(/\r\n/g, "\n"),
    html: st.html.join("\n"),
    attachments: st.attachments,
  };
}

/** Cheap HTML to text for mail that has no text/plain part. */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n")
    .trim();
}
