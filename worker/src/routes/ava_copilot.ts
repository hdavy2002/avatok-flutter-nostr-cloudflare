// ava_copilot.ts — Ava Copilot Phases A+B (server): doc actions + per-chat toggle.
// Specs/AVA-COPILOT-FINAL-PLAN-2026-07-08.md Part II §5–§9 (decisions D2/D5/D7/D19/D29).
//
//   POST /api/ava/doc/summarize      { conv, text?, media_ref? }      → { text, cached } + PRIVATE-lane post
//   POST /api/ava/doc/translate      { conv, text, to }               → { text, to, cached }   (inline only)
//   POST /api/ava/doc/translate-file { conv, text, to, name? }        → { format:"pdf"|"text", … } + PRIVATE-lane post
//   GET  /api/ava/chat-toggle?conv=… → { on }                          (D29 "Ava in this chat")
//   POST /api/ava/chat-toggle        { conv, on }                     → { ok, on }
//
// GATES (in order): config flags (503 {flag} — mirrors groupTranslationEnabled in
// ai_chat.ts) → requireUser → per-chat Ava toggle (403 {reason:"ava_off_chat"}).
// Every LLM call goes through avaReason() with {role, capability, trigger} — the
// sacred rule (Specs/AVA-ENGINEERING-LAW.md; scripts/check_ava_reason.sh enforces).
//
// EXTRACTION (plan §7): server-readable files extract in consumers; E2EE media
// extracts ON-DEVICE and the client uploads TEXT ONLY. This route therefore
// accepts client-supplied `text` as the primary input. `media_ref` without text
// is rejected with 422 need_text — the client runs its extractor and retries
// (a server-side extractor lands with the consumers pipeline; no worker dep now).
//
// CACHE (D7): derived content in KV env.TOKENS under `doc:<conv>|<sha256(text)>|<op>|<lang>`,
// TTL 30 days — re-summarize/re-translate of the same doc is free.
//
// PRIVATE LANE (D2/D19): results that Ava "says" go ONLY to the requester's own
// InboxDO via postAvaPrivate (lib/ava_lane.ts). Translate (inline) never posts.

import type { Env } from "../types";
import { json, sha256Hex } from "../util";
import { requireUser, isFail } from "../authz";
import { trackUser } from "../hooks";
import { emailFor } from "../lib/identity";
import { readConfig } from "./config";
import { avaReason, avaReasonRaw } from "../lib/ava_reason";
import { orText, usageTokens } from "../lib/ava_reason/types";
import { docSummarizeModel, docTranslateModel } from "../lib/ava_reason/policy";
import { postAvaPrivate } from "../lib/ava_lane";
// [AVA-MEDIA-AUTHZ-1] B6 fix: avaDocTranslateFile used to write the translated
// PDF straight to the PUBLIC BLOBS/blossom bucket with no user_media row at
// all (no quota, no library entry, no visibility record) — a private
// document became a publicly fetchable URL. Route it through the SAME
// authorization-gated private path the [AVA-MEDIA-JOB-1] artifact pipeline
// uses. media.ts is owned by another agent this wave — import only, no edits.
import { registerArtifactMedia, presignDigitalReadUrl } from "./media";

const DOC_TTL = 30 * 24 * 3600;      // D7 derived-content cache: 30 days
const MAX_SUMMARIZE_CHARS = 24_000;  // summary reads the head of very large docs
const MAX_TRANSLATE_CHARS = 8_000;   // inline translate (one avaReason call)
const MAX_FILE_CHARS = 120_000;      // translate-file total budget (~200 pages of text, plan §7 cap)
const CHUNK_CHARS = 8_000;           // translate-file per-call chunk size

// ---------------------------------------------------------------------------
// Per-chat "Ava in this chat" toggle (D29). Per-ACCOUNT per-conversation, ON by
// default. Stored in KV as avatoggle:<uid>:<conv> = "0" when OFF; absence = ON.
// (KV is fine here: one tiny key per explicit user tap, read-mostly. Exported so
// the ODL — Phase C — checks it before any wake.)
// ---------------------------------------------------------------------------
export async function avaChatToggleOn(env: Env, uid: string, conv: string): Promise<boolean> {
  try {
    const v = await env.TOKENS.get(`avatoggle:${uid}:${conv}`);
    return v !== "0"; // absence (or any other value) = ON by default
  } catch { return true; } // fail-open: a KV blip never silences/blocks Ava features
}

// GET  /api/ava/chat-toggle?conv=…   → { on }
// POST /api/ava/chat-toggle {conv,on} → { ok, on }
export async function avaChatToggle(req: Request, env: Env): Promise<Response> {
  const cfg = await readConfig(env);
  const copilotOn = (cfg as any).avaCopilotEnabled === true;

  // AVA-CHATTOGGLE-503: the toggle READ is a pure default lookup. When the
  // copilot master switch is OFF we must NOT 503 the GET — the client's
  // documented fallback is already "ON by default" (see AvaChatToggle.fetch),
  // so a disabled copilot has every GET resolve to {on:true} regardless. The old
  // 503 changed nothing behaviourally but produced a steady prod error-storm:
  // clients re-fetch on every chat open, each 503 re-hitting the worker (PostHog
  // 2026-07-17: 157×/week across 4 users). Answer the read gracefully; keep the
  // WRITE hard-gated so no opt-out can be persisted while the feature is dark.
  if (req.method === "GET") {
    if (!copilotOn) return json({ on: true, disabled: true });
    const gctx = await requireUser(req, env);
    if (isFail(gctx)) return json({ error: gctx.error }, gctx.status);
    const conv = String(new URL(req.url).searchParams.get("conv") ?? "").trim();
    if (!conv) return json({ error: "conv required" }, 400);
    return json({ on: await avaChatToggleOn(env, gctx.uid, conv) });
  }

  // POST (write): the master switch still hard-gates persisting a toggle.
  if (!copilotOn) {
    return json({ error: "ava copilot disabled", flag: "avaCopilotEnabled" }, 503);
  }
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  let b: any; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const conv = String(b?.conv ?? "").trim();
  if (!conv) return json({ error: "conv required" }, 400);
  const on = b?.on !== false; // default ON
  const key = `avatoggle:${ctx.uid}:${conv}`;
  try {
    // ON is the default → store nothing (delete) so KV only holds opt-outs.
    if (on) await env.TOKENS.delete(key);
    else await env.TOKENS.put(key, "0");
  } catch (e: any) {
    return json({ error: "toggle write failed", detail: String(e?.message ?? e).slice(0, 160) }, 502);
  }
  const email = await emailFor(env, ctx.uid);
  trackUser(env, ctx.uid, email, "ava_chat_toggle", "ava_core", { conv, on });
  return json({ ok: true, on });
}

// ---------------------------------------------------------------------------
// Shared request plumbing for the three doc actions: flag gate → auth → body →
// toggle gate. Returns either an error Response or the parsed context.
// ---------------------------------------------------------------------------
interface DocCtx { uid: string; email: string | null; conv: string; body: any; }

async function docGate(req: Request, env: Env, extraFlag?: string): Promise<Response | DocCtx> {
  const cfg = await readConfig(env);
  if ((cfg as any).avaCopilotEnabled !== true) {
    return json({ error: "ava copilot disabled", flag: "avaCopilotEnabled" }, 503);
  }
  if ((cfg as any).avaDocActionsEnabled !== true) {
    return json({ error: "doc actions disabled", flag: "avaDocActionsEnabled" }, 503);
  }
  if (extraFlag && (cfg as any)[extraFlag] !== true) {
    return json({ error: "feature disabled", flag: extraFlag }, 503);
  }
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const email = await emailFor(env, ctx.uid);

  let body: any; try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const conv = String(body?.conv ?? "").trim();
  if (!conv) return json({ error: "conv required" }, 400);

  // D29: the per-chat toggle silences EVERY copilot avaReason path for this conv.
  if (!(await avaChatToggleOn(env, ctx.uid, conv))) {
    return json({ error: "Ava is off for this chat", reason: "ava_off_chat" }, 403);
  }
  return { uid: ctx.uid, email, conv, body };
}

/** D7 cache key: doc:<conv>|<sha256(text)>|<op>|<lang>. */
async function docKey(conv: string, text: string, op: string, lang: string): Promise<string> {
  return `doc:${conv}|${await sha256Hex(text)}|${op}|${lang || "-"}`;
}

// ===========================================================================
// POST /api/ava/doc/summarize { conv, text?, media_ref? }
// Context-menu "Summarize ✨" — result goes to the requester's PRIVATE lane
// (only they see it) AND is returned inline for instant render.
// ===========================================================================
export async function avaDocSummarize(req: Request, env: Env): Promise<Response> {
  const g = await docGate(req, env);
  if (g instanceof Response) return g;
  const { uid, email, conv, body } = g;
  const t0 = Date.now();

  const text = String(body?.text ?? "").trim().slice(0, MAX_SUMMARIZE_CHARS);
  const mediaRef = String(body?.media_ref ?? "").trim();
  const name = String(body?.name ?? "").trim().slice(0, 120);
  if (!text) {
    // Plan §7: E2EE media extracts on-device; server-readable extraction lands in
    // consumers. Until then the client always supplies extracted text.
    return json({ error: "text required (extract on-device and resend)", reason: "need_text", media_ref: mediaRef || null }, 422);
  }

  const key = await docKey(conv, text, "summary", "");
  let summary: string | null = null;
  let cacheHit = false;
  try {
    summary = await env.TOKENS.get(key);
    if (summary) cacheHit = true;
  } catch { /* cache miss */ }

  if (!summary) {
    const system = [
      "You summarise a document a user long-pressed in their chat. Produce a tight summary:",
      "1–2 sentence overview, then up to 5 short bullets of the key points (amounts, dates,",
      "names, obligations). Mirror the document's language. No preamble, no invented facts.",
    ].join(" ");
    try {
      summary = await avaReason(env, {
        role: "copilot", capability: "doc_summarize", trigger: "context_menu",
        system, user: text, maxTokens: 500, temperature: 0.2,
        uid, email, appName: "ava_core",
      });
    } catch (e: any) {
      trackUser(env, uid, email, "ava_doc_summarize_error", "ava_core", { conv, len: text.length, latency_ms: Date.now() - t0, reason: String(e?.message ?? e).slice(0, 160) });
      return json({ error: "summary failed", detail: String(e?.message ?? e).slice(0, 200) }, 502);
    }
    try { await env.TOKENS.put(key, summary, { expirationTtl: DOC_TTL }); } catch { /* best-effort */ }
  }

  // D2/D19: drop the result into the requester's private lane so it persists as
  // an Ava bubble with follow-up affordance. Lane failure never fails the call.
  await postAvaPrivate(env, {
    uid, conv, text: summary, capability: "doc_summarize", email,
    sources: name || mediaRef ? [{ name: name || undefined, media_ref: mediaRef || undefined }] : undefined,
  }).catch(() => ({ ok: false }));

  trackUser(env, uid, email, "ava_doc_summarize_used", "ava_core", { conv, len: text.length, cache_hit: cacheHit, latency_ms: Date.now() - t0 });
  return json({ text: summary, cached: cacheHit });
}

// ===========================================================================
// POST /api/ava/doc/translate { conv, text, to }
// Context-menu "Translate ✨" — INLINE result only (no lane post): it renders
// under the original message, like ai_chat's inline translate but doc-cached.
// ===========================================================================
export async function avaDocTranslate(req: Request, env: Env): Promise<Response> {
  const g = await docGate(req, env);
  if (g instanceof Response) return g;
  const { uid, email, conv, body } = g;
  const t0 = Date.now();

  const text = String(body?.text ?? "").trim().slice(0, MAX_TRANSLATE_CHARS);
  const to = String(body?.to ?? "").trim().slice(0, 40);
  if (!text) return json({ error: "text required", reason: "need_text" }, 422);
  if (!to) return json({ error: "to (target language) required" }, 400);

  const key = await docKey(conv, text, "translate", to.toLowerCase());
  let translated: string | null = null;
  let cacheHit = false;
  try {
    translated = await env.TOKENS.get(key);
    if (translated) cacheHit = true;
  } catch { /* cache miss */ }

  if (!translated) {
    try {
      translated = await avaReason(env, {
        role: "copilot", capability: "doc_translate", trigger: "context_menu",
        system: `Translate the document text into ${to}. Preserve meaning, tone and paragraph breaks. Output ONLY the translation.`,
        user: text, maxTokens: 1200, temperature: 0.2,
        uid, email, appName: "ava_core",
      });
    } catch (e: any) {
      return json({ error: "translate failed", detail: String(e?.message ?? e).slice(0, 200) }, 502);
    }
    try { await env.TOKENS.put(key, translated, { expirationTtl: DOC_TTL }); } catch { /* best-effort */ }
  }

  trackUser(env, uid, email, "ava_doc_translate_used", "ava_core", { conv, lang: to, len: text.length, cache_hit: cacheHit, latency_ms: Date.now() - t0 });
  return json({ text: translated, to, cached: cacheHit });
}

// ===========================================================================
// POST /api/ava/doc/translate-file { conv, text, to, name? }
// Context-menu "Auto-translate file ✨" — translate the WHOLE extracted text
// (chunked), then deliver a clean fresh document into the PRIVATE lane.
//
// pdf-lib is NOT in worker/package.json and adding deps is out of scope, so:
//   • text that fits Latin-1 → a minimal hand-rolled text-only PDF (Helvetica,
//     WinAnsi), uploaded to the public content-addressed blob path (the same
//     `u/<uid>/public/<sha256>` layout ava_image.ts uses — unguessable URL).
//   • non-Latin scripts (Hindi, Arabic, CJK, …) → format:"text": the full
//     translated text is returned and posted; the client renders/saves it.
//     TODO(pdf-lib): once pdf-lib + a Unicode font ship, always emit a PDF.
// Gated additionally by avaAutoTranslateFileEnabled (cost: many chunks).
// ===========================================================================
export async function avaDocTranslateFile(req: Request, env: Env): Promise<Response> {
  const g = await docGate(req, env, "avaAutoTranslateFileEnabled");
  if (g instanceof Response) return g;
  const { uid, email, conv, body } = g;
  const t0 = Date.now();

  const text = String(body?.text ?? "").trim().slice(0, MAX_FILE_CHARS);
  const to = String(body?.to ?? "").trim().slice(0, 40);
  const name = (String(body?.name ?? "").trim() || "document").slice(0, 120);
  if (!text) return json({ error: "text required (extract on-device and resend)", reason: "need_text" }, 422);
  if (!to) return json({ error: "to (target language) required" }, 400);

  // D7 cache holds the TRANSLATED TEXT (the expensive part); the PDF is cheap to
  // re-emit from it on a repeat request.
  const key = await docKey(conv, text, "trfile", to.toLowerCase());
  let translated: string | null = null;
  let cacheHit = false;
  let chunks = 0;
  try {
    translated = await env.TOKENS.get(key);
    if (translated) cacheHit = true;
  } catch { /* cache miss */ }

  if (!translated) {
    const parts = chunkText(text, CHUNK_CHARS);
    chunks = parts.length;
    const out: string[] = [];
    for (const part of parts) {
      try {
        out.push(await avaReason(env, {
          role: "copilot", capability: "doc_translate", trigger: "context_menu",
          system: `Translate this document section into ${to}. Preserve meaning, tone, layout hints and paragraph breaks. Output ONLY the translation.`,
          user: part, maxTokens: 2000, temperature: 0.2,
          uid, email, appName: "ava_core",
        }));
      } catch (e: any) {
        trackUser(env, uid, email, "ava_translate_file_used", "ava_core", { conv, lang: to, len: text.length, chunks, ok: false, latency_ms: Date.now() - t0, reason: String(e?.message ?? e).slice(0, 160) });
        return json({ error: "translation failed", detail: String(e?.message ?? e).slice(0, 200) }, 502);
      }
    }
    translated = out.join("\n\n");
    try { await env.TOKENS.put(key, translated, { expirationTtl: DOC_TTL }); } catch { /* best-effort */ }
  }

  // Emit the artifact. Latin-1-safe → minimal PDF registered through the SAME
  // private, authorization-gated path the [AVA-MEDIA-JOB-1] artifact pipeline
  // uses (registerArtifactMedia, sensitivity:'private' → env.DIGITAL + a real
  // user_media row: quota, library entry, soft-delete, visibility — all of it).
  // NEVER the public BLOBS/blossom bucket. mediaRef is a short-lived presigned
  // read URL (private storage is never exposed as a stable public URL); fine
  // here because postAvaPrivate posts it immediately below.
  // Otherwise the plain translated text (client renders/saves it) — never
  // stored server-side.
  let format: "pdf" | "text" = "text";
  let mediaRef: string | undefined;
  if (isLatin1(translated)) {
    try {
      const pdf = buildSimplePdf(`${name} — ${to}`, translated);
      const docFileName = `${name.replace(/\.[a-z0-9]{1,6}$/i, "")}-${to.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.pdf`;
      const artifact = await registerArtifactMedia(env, {
        uid, bytes: pdf, mimeType: "application/pdf", fileName: docFileName, category: "document", sensitivity: "private",
      });
      mediaRef = (await presignDigitalReadUrl(env, artifact.key)) || undefined;
      format = "pdf";
    } catch { format = "text"; mediaRef = undefined; } // fall back to text on any storage hiccup
  }

  const fileName = `${name.replace(/\.[a-z0-9]{1,6}$/i, "")}-${to.toLowerCase().replace(/[^a-z0-9]+/g, "-")}${format === "pdf" ? ".pdf" : ".txt"}`;
  await postAvaPrivate(env, {
    uid, conv, email, capability: "doc_translate_file",
    text: format === "pdf"
      ? `Here's "${name}" translated to ${to} 📄 (formatting simplified).`
      : `Here's "${name}" translated to ${to}. I couldn't build a PDF for this script yet, so the full text is attached below.\n\n${translated.slice(0, 3000)}${translated.length > 3000 ? "…" : ""}`,
    media_ref: mediaRef,
    sources: [{ name, format, file_name: fileName }],
  }).catch(() => ({ ok: false }));

  trackUser(env, uid, email, "ava_translate_file_used", "ava_core", { conv, lang: to, len: text.length, chunks, format, cache_hit: cacheHit, ok: true, latency_ms: Date.now() - t0 });
  return json({
    ok: true, format, to, cached: cacheHit, file_name: fileName,
    ...(mediaRef ? { media_ref: mediaRef } : { text: translated, note: "TODO(pdf-lib): non-Latin scripts ship as text until a Unicode-font PDF path lands" }),
  });
}

// ===========================================================================
// [AVA-DOC-ARTIFACT-1] Worker-callable document pipeline for the ai_media_jobs
// queue consumer (worker/src/queues/ai_media.ts). ADDITIVE — the existing
// avaDocSummarize/avaDocTranslate/avaDocTranslateFile HTTP routes above are
// UNCHANGED (client-supplied text, inline/private-lane result, no durable
// artifact — the pre-[AVA-MEDIA-JOB-1] Ava Copilot Phase A/B feature; kept
// per this issue's "do not delete existing extraction functions" instruction,
// and still useful for a quick already-extracted-text dialog result). This
// section is the NEW, durable, artifact-producing path: the job consumer
// fetches the SOURCE FILE from R2 by source_media_id, extracts its text HERE
// (never persisted to the job table/queue message — only the media id is,
// per §41/§42), summarizes/translates it, and hands bytes back to the queue
// to register as a real AvaLibrary artifact (routes/media.ts's
// registerArtifactMedia — called by the queue, not here, to keep storage
// decisions in one place).
// ===========================================================================

export interface ExtractedDoc { text: string; truncated: boolean }

const EXTRACT_MAX_CHARS = 120_000; // matches MAX_FILE_CHARS — the largest any doc capability below reads

/**
 * Document bytes -> plain text/markdown. Mirrors consumers/src/brain.ts's
 * extractDocumentBuffer EXACTLY (worker/ and consumers/ are separate
 * deployables that cannot import across one another — see worker/wrangler.toml's
 * LIVE-QUEUE-1 comment / ai_media_jobs.ts's file header for the identical
 * rationale) via the SAME Workers AI `toMarkdown` binding — no PDF npm
 * dependency required or added; worker/package.json stays untouched.
 */
export async function extractDocumentText(env: Env, buf: ArrayBuffer, mime: string, name: string): Promise<ExtractedDoc> {
  const lower = String(mime || "").toLowerCase();
  if (lower.startsWith("text/") || /\.(md|txt)$/i.test(name || "")) {
    try {
      const full = new TextDecoder().decode(buf);
      return { text: full.slice(0, EXTRACT_MAX_CHARS), truncated: full.length > EXTRACT_MAX_CHARS };
    } catch { return { text: "", truncated: false }; }
  }
  try {
    const blob = new Blob([buf], { type: lower || "application/octet-stream" });
    const md = await (env.AI as any).toMarkdown?.([{ name, blob }]);
    const first = Array.isArray(md) ? md[0] : md;
    const full = String(first?.data || first?.markdown || "");
    return { text: full.slice(0, EXTRACT_MAX_CHARS), truncated: full.length > EXTRACT_MAX_CHARS };
  } catch {
    return { text: "", truncated: false };
  }
}

export interface DocModelResult {
  text: string;
  modelActual: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Prefer this over any catalog estimate at settle time — only set when the
   *  provider actually reported usage.cost (see ai_billing.ts's settleAiJob). */
  providerCostUsdMicro?: number;
}

/**
 * Summarize extracted document text — the SAME system prompt as
 * avaDocSummarize's inline route above, factored out so the queue consumer
 * can call it without an HTTP round-trip and without duplicating the prompt.
 * Uses avaReasonRaw (not avaReason) so real provider usage/cost reach the
 * billing layer instead of being discarded — the string-only avaReason() the
 * inline route uses has no settlement need, but a paid artifact job does.
 */
export async function summarizeDocumentForArtifact(env: Env, args: { uid: string; email: string | null; text: string }): Promise<DocModelResult> {
  const system = [
    "You summarise a document a user long-pressed in their chat. Produce a tight summary:",
    "1–2 sentence overview, then up to 5 short bullets of the key points (amounts, dates,",
    "names, obligations). Mirror the document's language. No preamble, no invented facts.",
  ].join(" ");
  const raw = await avaReasonRaw(env, {
    role: "media_job", capability: "media_doc_summarize", feature: "media_doc_summarize", trigger: "job_consumer",
    system, user: args.text.slice(0, MAX_SUMMARIZE_CHARS), maxTokens: 500, temperature: 0.2,
    uid: args.uid, email: args.email, appName: "ai_media_jobs",
  });
  const text = orText(raw);
  if (!text.trim()) throw new Error("provider_unavailable: empty summary");
  const [inputTokens, outputTokens] = usageTokens(raw);
  const providerCostUsdMicro = typeof raw?.usage?.cost === "number" ? Math.round(raw.usage.cost * 1_000_000) : undefined;
  return { text, modelActual: docSummarizeModel(env), inputTokens, outputTokens, providerCostUsdMicro };
}

/**
 * Translate document text (chunked via the SAME chunkText() helper
 * avaDocTranslateFile's inline route uses below) into `to`. Shared by the
 * doc_translate job handler AND the audio_translate job's transcript-
 * translation sub-step (a transcript is just text) — one chunking/aggregation
 * implementation instead of two. Aggregates usage/cost across chunks; only
 * reports providerCostUsdMicro when EVERY chunk that ran reported a real
 * provider cost, so a partial miss never silently under-charges by averaging
 * in a $0 chunk (ai_billing.ts's settleAiJob then correctly falls back to the
 * catalog estimate for the whole job instead).
 */
export async function translateDocumentForArtifact(env: Env, args: { uid: string; email: string | null; text: string; to: string }): Promise<DocModelResult> {
  const parts = chunkText(args.text, CHUNK_CHARS);
  if (!parts.length) throw new Error("provider_unavailable: nothing to translate");
  const outs: string[] = [];
  let inTok = 0, outTok = 0, haveTokens = false;
  let costMicro = 0, haveCost = true;
  for (const part of parts) {
    const raw = await avaReasonRaw(env, {
      role: "media_job", capability: "media_doc_translate", feature: "media_doc_translate", trigger: "job_consumer",
      system: `Translate this document section into ${args.to}. Preserve meaning, tone, layout hints and paragraph breaks. Output ONLY the translation.`,
      user: part, maxTokens: 2000, temperature: 0.2,
      uid: args.uid, email: args.email, appName: "ai_media_jobs",
    });
    const t = orText(raw);
    if (!t.trim()) throw new Error("provider_unavailable: empty translation");
    outs.push(t);
    const [ti, to_] = usageTokens(raw);
    if (ti != null) { inTok += ti; haveTokens = true; }
    if (to_ != null) { outTok += to_; haveTokens = true; }
    if (typeof raw?.usage?.cost === "number") costMicro += Math.round(raw.usage.cost * 1_000_000);
    else haveCost = false;
  }
  return {
    text: outs.join("\n\n"), modelActual: docTranslateModel(env),
    inputTokens: haveTokens ? inTok : null, outputTokens: haveTokens ? outTok : null,
    providerCostUsdMicro: haveCost ? costMicro : undefined,
  };
}

export interface DocumentArtifactBytes { bytes: Uint8Array; mimeType: string; ext: string }

/**
 * [§38/§45] Never silently emit corrupted Latin-1 PDF output. Latin-1-safe
 * text gets the existing minimal-PDF path (buildSimplePdf below — no
 * embedded-Unicode-font PDF library is available; pdf-lib is not a worker/
 * dependency and adding one is out of this issue's scope, matching
 * avaDocTranslateFile's existing TODO(pdf-lib) below). Anything else —
 * Hindi/Arabic/CJK/etc — is emitted as UTF-8 plain text instead of a garbled
 * PDF. Used only by the doc_translate artifact (doc_summarize always emits
 * markdown/text per §38's "Summarize → .summary.md or .txt").
 */
export function buildDocumentArtifactBytes(title: string, text: string): DocumentArtifactBytes {
  if (isLatin1(text)) {
    try {
      return { bytes: buildSimplePdf(title, text), mimeType: "application/pdf", ext: "pdf" };
    } catch { /* fall through to UTF-8 text on any PDF-build hiccup */ }
  }
  return { bytes: new TextEncoder().encode(text), mimeType: "text/plain; charset=utf-8", ext: "txt" };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Split on paragraph boundaries into ≤max-char chunks (hard-split only when a single paragraph exceeds max). */
function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let cur = "";
  for (const para of text.split(/\n{2,}/)) {
    const p = para.length > max ? para.match(new RegExp(`[\\s\\S]{1,${max}}`, "g"))! : [para];
    for (const piece of p) {
      if (cur.length + piece.length + 2 > max && cur) { out.push(cur); cur = ""; }
      cur = cur ? `${cur}\n\n${piece}` : piece;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** True when every char fits Latin-1 (WinAnsi-encodable for the minimal PDF). */
function isLatin1(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0xff) return false;
  return true;
}

/** Escape a string for a PDF literal string: \, (, ) and normalize newlines away. */
function pdfEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** Greedy-wrap a paragraph to ~maxCols columns (Helvetica is proportional; 95 cols @10pt fits A4 safely). */
function wrapLines(text: string, maxCols: number): string[] {
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    let line = raw.replace(/\s+$/g, "");
    while (line.length > maxCols) {
      let cut = line.lastIndexOf(" ", maxCols);
      if (cut < maxCols * 0.5) cut = maxCols; // no space near the edge → hard cut
      lines.push(line.slice(0, cut));
      line = line.slice(cut).replace(/^\s+/, "");
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Minimal hand-rolled text-only PDF (no deps — pdf-lib is not in worker/package.json).
 * A4 pages, Helvetica 10pt WinAnsi, ~52 lines/page, title line first. Valid PDF 1.4
 * with a correct xref table. Latin-1 input ONLY (caller checks isLatin1).
 */
function buildSimplePdf(title: string, body: string): Uint8Array {
  const FONT_SIZE = 10, LEADING = 14, MARGIN = 50;
  const PAGE_W = 595, PAGE_H = 842;                       // A4 points
  const linesPerPage = Math.floor((PAGE_H - 2 * MARGIN) / LEADING) - 2;
  const allLines = [title, "", ...wrapLines(body, 95)];
  const pages: string[][] = [];
  for (let i = 0; i < allLines.length; i += linesPerPage) pages.push(allLines.slice(i, i + linesPerPage));
  if (!pages.length) pages.push([title]);

  // Objects: 1 catalog, 2 pages tree, 3 font, then per page: page obj + stream obj.
  const objs: string[] = [];
  const pageObjIds = pages.map((_, i) => 4 + i * 2);
  objs.push(`<< /Type /Catalog /Pages 2 0 R >>`);
  objs.push(`<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  objs.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`);
  for (let i = 0; i < pages.length; i++) {
    const contentId = 5 + i * 2;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`);
    // Content stream: begin text, set font/leading, position at top margin, one T* per line.
    const ops = [`BT`, `/F1 ${FONT_SIZE} Tf`, `${LEADING} TL`, `${MARGIN} ${PAGE_H - MARGIN} Td`];
    for (const line of pages[i]) { ops.push(`(${pdfEscape(line)}) Tj`, `T*`); }
    ops.push(`ET`);
    const stream = ops.join("\n");
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }

  // Assemble with a correct xref. Latin-1 text ⇒ 1 char = 1 byte (byte offsets safe).
  let out = `%PDF-1.4\n`;
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xrefAt = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;

  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}
