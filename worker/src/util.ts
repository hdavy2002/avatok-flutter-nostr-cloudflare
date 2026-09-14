// Shared helpers: HTTP/CORS, hashing, hex, phone normalization.
import { avaReason } from "./lib/ava_reason"; // One Brain B1: unified reasoning gateway

/**
 * [UPLOAD-CORS-1 2026-08-30] The allow-headers list is the browser's whitelist, and a
 * request carrying ANY header not on it is rejected at preflight — the fetch never
 * reaches the Worker, so there is no status code and no log line, only "Failed to fetch".
 *
 * `/upload/public` and `/upload/private` read x-file-name, x-app, x-folder, x-uncommitted,
 * x-encrypted, x-real-mime, x-source-media-id and the two x-ava-* approval headers
 * (routes/media.ts). Only x-content-type was listed here, so a BROWSER could never upload
 * a file with a name or an app tag — the very first web upload attempt failed at the
 * preflight. The Flutter app never hit it because native HTTP has no preflight, which is
 * exactly why this survived: the feature worked on the platform that was tested.
 *
 * Keep this in step with the headers routes/media.ts actually reads.
 */
export const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
  "access-control-allow-headers": [
    "content-type",
    "authorization",
    "idempotency-key",
    // upload metadata — see routes/media.ts
    "x-content-type",
    "x-file-name",
    "x-app",
    "x-folder",
    "x-uncommitted",
    "x-encrypted",
    "x-real-mime",
    "x-source-media-id",
    "x-ava-readable",
    "x-ava-approval",
  ].join(","),
};

export function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...CORS, ...extra },
  });
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

// Robust text extraction across Workers AI chat shapes: `{response}` (Llama/Gemma3)
// or `{choices:[{message:{content,reasoning}}]}` (Gemma 4 OpenAI-style; `reasoning`
// is the thinking chain, `content` the final answer). Prefer content.
export function aiText(out: any): string {
  if (!out) return "";
  if (typeof out.response === "string") return out.response;
  const m = out.choices?.[0]?.message;
  if (m) return (m.content ?? m.reasoning ?? "") as string;
  return (out.description ?? "") as string;
}

// Extract answer text from a Gemini (candidates/parts) response, dropping any
// "thought" parts so raw reasoning never leaks. Falls back to aiText for other
// (OpenAI / Workers-AI) shapes, so it's safe on any env.AI.run result.
export function geminiText(out: any): string {
  const parts = out?.candidates?.[0]?.content?.parts
    ?? out?.response?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    return parts
      .filter((p: any) => p?.thought !== true)
      .map((p: any) => String(p?.text ?? ""))
      .join("")
      .trim();
  }
  return aiText(out).trim();
}

// Per-model "thinking off" config for LOW LATENCY. Gemini 3 spends ~5s reasoning
// silently by default (thinkingLevel "medium"), which dominates @ava latency and
// defeats streaming (no visible token until thinking ends). We turn it down:
// Gemini 3 uses `thinkingLevel` ("low"); Gemini 2.x uses `thinkingBudget:0`.
// NOTE: sending `thinkingBudget` to a Gemini-3 model returns HTTP 400 — never mix
// the two. Returns a generationConfig fragment to merge into the request body.
export function thinkingCfg(model: string): Record<string, unknown> {
  return model.startsWith("gemini-3")
    ? { thinkingConfig: { thinkingLevel: "low" } }
    : { thinkingConfig: { thinkingBudget: 0 } };
}

// Build a Gemini-native request body — one user turn, system as systemInstruction.
export function geminiBody(system: string, user: string, maxTokens = 700, temperature = 0.7): any {
  const body: any = {
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: { maxOutputTokens: maxTokens, temperature },
  };
  if (system && system.trim()) body.systemInstruction = { parts: [{ text: system }] };
  return body;
}

// Our online brain model. gemini-3-flash-preview is NOT a valid Workers-AI
// partner id ('google/gemini-3-flash-preview' → 7003 "User Input Error", which
// wasted a failed round-trip on every turn). It DOES work via the DIRECT Google
// API (same path AvaVision + the Composio tool-loop use), so we call it there.
export const GEMINI_MODEL = "gemini-3-flash-preview";
export const GEMINI_FALLBACK_MODEL = "gemini-2.5-flash-lite";

/// Run a single-turn Gemini generation via the DIRECT generativelanguage API using
/// env.GEMINI_API_KEY. Tries gemini-3, falls back to gemini-2.5; returns the answer
/// text (or "" on total failure). One real call, no 7003 penalty.
///
/// One Brain B1 (SPEC §4): now a THIN SHIM over the shared avaReason gateway via the
/// `gemini_direct` route. Behaviour is preserved EXACTLY for all 6 call sites
/// (ava_agent ×3, conversation, user_brain, ava_delegate): system → systemInstruction,
/// per-model thinking-off (geminiThinkingOff), the gemini-3 → gemini-2.5-flash-lite
/// two-model empty-text ladder (now in the google adapter, models from policy),
/// answer text with "thought" parts dropped, and the "never throw, return '' on any
/// failure" contract. The public signature is unchanged. The model ladder now lives
/// in ava_reason/policy.ts (env-overridable via GEMINI_DIRECT_MODEL / _ALT_MODEL) and
/// each call now emits a unified `ava_reason_call` telemetry event.
export async function geminiRun(
  env: any, system: string, user: string,
  maxTokens = 700, temperature = 0.7,
): Promise<string> {
  if (!env?.GEMINI_API_KEY) return ""; // no key → "" without a gateway call (as before)
  try {
    return await avaReason(env, {
      role: "reasoner", capability: "reason", trigger: "gemini_run",
      feature: "gemini_direct",
      system, user, maxTokens, temperature,
      geminiThinkingOff: true, // per-model thinking off for ~1s latency (was thinkingCfg)
    });
  } catch { return ""; } // preserve geminiRun's total-failure "" (never throws)
}

// D1 caps bound parameters at 100 per query. Split arrays into safe batches.
export function chunk<T>(arr: T[], size = 90): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export async function sha256Bytes(data: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return new Uint8Array(buf);
}

export async function sha256Hex(input: string | ArrayBuffer | Uint8Array): Promise<string> {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  return hex(await sha256Bytes(data));
}

// Best-effort E.164 normalization. Client should send +CC numbers; we strip the rest.
export function normalizePhone(raw: string): string {
  const t = raw.trim().replace(/[^\d+]/g, "");
  return t.startsWith("+") ? t : "+" + t;
}

/** Canonical, chronologically-sortable message id: 13-digit zero-padded epoch ms
 *  + a short random suffix → lexical sort == time order, collision-safe. Used as
 *  the message serial, the R2 archive key, and the client dedupe key. (Relocated
 *  from the deleted routes/ably.ts — it was never Ably-specific.) */
export function canonicalMsgId(createdMs: number): string {
  return `${String(createdMs).padStart(13, "0")}.${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * [UPLOAD-UTF8-1 2026-09-13] HTTP HEADER VALUES ARE ISO-8859-1 (Latin-1) ONLY.
 *
 * A header value is a ByteString in the fetch spec, so a browser throws BEFORE the
 * request is sent the moment a value carries a code point above U+00FF:
 *
 *     TypeError: Failed to execute 'fetch': Failed to read the 'headers' property
 *     from 'RequestInit': String contains non ISO-8859-1 code point.
 *
 * The clients put the raw picked filename into `x-file-name`. Reproduced live against
 * production, in a real browser:
 *     plain.png       -> 200
 *     पूजा.png         -> TypeError (above) - no request, no status code, no server log
 *     photo-dash.png  -> same TypeError when the dash is U+2013 EN DASH (a macOS/Word
 *                        autocorrect artefact, so this is trivially easy to hit)
 *     emoji.png       -> same TypeError when the name carries an emoji
 *     café.png        -> 200 (é IS in Latin-1, which is why casual accent testing passed)
 *
 * Because the web upload is a raw `fetch()` and not the `request()` helper, the throw did
 * not even produce an `api_error` telemetry event - the user saw only the generic
 * "Could not upload that photo." For an Indian marketplace this is critical: every
 * Devanagari filename was unuploadable from the web.
 *
 * THE ASYMMETRY THAT LET THIS SURVIVE is exactly the one already documented in the
 * [UPLOAD-CORS-1 2026-08-30] block at the top of this file: the Flutter app's native HTTP
 * stack has no browser preflight and no ByteString check on header values, so it happily
 * sent UTF-8 bytes and the feature "worked" on the platform that gets tested. A web-only
 * failure on the platform that is NOT the one usually exercised - the same shape, twice,
 * on the same two headers. Whenever a header carries user-typed text, assume the browser
 * will reject it and the app will not tell you.
 *
 * THE WIRE CONTRACT: clients now send `x-file-name` percent-encoded
 * (`encodeURIComponent(name)`), which is always pure ASCII and therefore always a legal
 * header value. This is the server half: it decodes.
 */

/**
 * Decode one percent-encoded header value, with a hard length cap.
 *
 * `decodeURIComponent` THROWS a URIError on a malformed sequence - a legacy client that
 * sent a literal `%` in a filename (`100%.png`), or any stray `%zz` - which would
 * otherwise turn a working upload into a 500. We catch it and fall back to the RAW
 * value: that is the whole reason for the try/catch. An already-shipped client that
 * sends a plain unencoded name keeps working byte-for-byte, because a plain ASCII
 * string decodes to itself.
 *
 * The cap is applied AFTER decoding, so a cap is never spent on percent-escapes
 * (`%E0%A4%AA` is 9 characters on the wire but one character once decoded).
 */
export function decodeHeaderText(raw: string | null | undefined, maxLen = 255): string {
  if (!raw) return "";
  let out: string;
  try {
    out = decodeURIComponent(raw);
  } catch {
    out = raw; // malformed escape (legacy client / literal '%') - never fail the request
  }
  // Control characters (incl. NUL, CR, LF) are never legitimate here and are a
  // log/JSON/header-injection shape once the value is stored and echoed back.
  out = out.replace(/[\x00-\x1F\x7F]/g, "");
  return out.slice(0, maxLen).trim();
}

/**
 * Decode a percent-encoded `x-file-name` into a name that is safe to STORE.
 *
 * Beyond decodeHeaderText: this value lands in `user_media.file_name`, is used as an R2
 * key segment on some routes (agent_docs, commercial attachments), and is echoed straight
 * back to clients. Percent-encoding means a decoded name can now contain anything at all
 * - including `%2F` -> `/` and `%2E%2E` -> `..`, which was NOT reachable before this
 * change - so path separators and dot-runs are neutralised here, once, for every reader,
 * and a decoded name can never be read as a path.
 *
 * Returns "" when nothing usable survives, so the existing `|| defaultName(...)`
 * fallbacks at the call sites keep behaving exactly as they do today.
 */
export function decodeFileNameHeader(raw: string | null | undefined, maxLen = 255): string {
  const decoded = decodeHeaderText(raw, maxLen);
  if (!decoded) return "";
  return decoded
    .replace(/[\/\\]/g, "_") // no path separators - one flat name, never a path
    .replace(/\.{2,}/g, ".") // no `..` traversal segment
    .trim();
}

/**
 * Percent-encode a value we put into a header OURSELVES. Same ISO-8859-1 constraint as
 * above, but server-side: `Headers.set()` in the Worker runtime throws on a non-Latin-1
 * value, which surfaces as a 500 instead of a client TypeError. Pair it with
 * decodeHeaderText() on the reader; both halves ship together, so there is no
 * old-client compatibility window on these internal headers.
 */
export function encodeHeaderText(value: string | null | undefined): string {
  return encodeURIComponent(value ?? "");
}
