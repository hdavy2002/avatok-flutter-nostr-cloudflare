// [AVA-MEDIA-JOB-1] Background consumer + producer-side enqueue helper for
// the durable AI media job queue. SELF-CONSUMED by this worker (avatok-api),
// the SAME pattern as money-settlements / liveness-verify / contacts-chunk in
// worker/src/index.ts — NOT the separate `consumers/` package, because
// ai_media_jobs.ts needs this worker's D1 (DB_MEDIA) + WalletDO bindings,
// which the consumers/worker split forbids importing across (see
// worker/wrangler.toml's LIVE-QUEUE-1 comment for the identical rationale).
//
// SCOPE OF [AVA-MEDIA-JOB-1] (original): this file wires the CLAIM ->
// DISPATCH -> COMPLETE/FAIL state machine end-to-end and proves it
// round-trips (reservation taken -> job claimed -> job fails cleanly ->
// reservation released) for all five kinds.
//
// [AVA-DOC-ARTIFACT-1 / AVA-AUDIO-ARTIFACT-1, 2026-07-25] STATUS UPDATE:
// audio_transcribe/audio_translate/doc_summarize/doc_translate are now REAL
// handlers (routes/stt.ts's transcribeAudioBuffer() + routes/ava_copilot.ts's
// extraction/summarize/translate functions + the pinned attachment text
// model from lib/ava_reason/policy.ts) — see KIND_HANDLERS below.
// image_generate used to be route-owned because its prompt was not persisted.
// It now uses the queue with an encrypted input record; plaintext prompts
// still never enter D1 or the queue body.
//
// ARCHITECTURE DECISION (documents, [AVA-DOC-ARTIFACT-1]): doc_summarize/
// doc_translate are QUEUE-DRIVEN, exactly like audio_transcribe/
// audio_translate — NOT "owning route does it inline". A document job's
// source is a DURABLY STORED file (job.source_media_id -> R2, resolved and
// authorized by createAiMediaJob() before this queue ever sees the job), the
// SAME shape as an audio job's source — nothing sensitive (extracted text,
// prompts) is ever stored in the job row or queue message, only the media id
// (§41/§42). A redelivery safely re-fetches and re-extracts from R2. This is
// the coherent middle ground the prior parked attempt didn't take: it treated
// ALL of image/doc/audio as "unreachable, route does it inline" even though
// only image_generate actually has the ephemeral-prompt problem that
// justifies that shape.
//
// QUEUE BINDING (Q_AI_MEDIA / queue "ai-media-jobs"): declared in
// worker/wrangler.toml / worker/src/types.ts's Env by [AVA-MEDIA-JOB-1]/M1.
import type { Env } from "../types";
import {
  claimAiMediaJob, completeAiMediaJob, failAiMediaJob, requeueAiMediaJob,
  resolveArtifactSensitivity, updateAiMediaJobProgress, linkJobRendition,
  type AiMediaJobKind, type AiMediaJobRecord,
} from "../lib/ai_media_jobs";
import { trackException } from "../hooks";
import { mediaSession } from "../db/shard";
import { registerArtifactMedia } from "../routes/media";
import { transcribeAudioBuffer, sttFormatFor, bytesToBase64 } from "../routes/stt";
// [AVA-IMG-TIERS-1 / WS-10] The image_upgrade handler reuses ava_image.ts's
// ONE provider call rather than opening a second, drifting copy of the
// OpenRouter Images request — telemetry, error classification, usage/cost
// extraction and the resolution parameter all stay in one place.
import { generateImage, imageResolutionForTier, fulfilQueuedImage } from "../routes/ava_image";
import { loadQueuedImageInput } from "../lib/ai_media_inputs";
import { imageModel } from "../lib/ava_reason/policy";
import { readConfig } from "../routes/config";
import {
  extractDocumentText, summarizeDocumentForArtifact, translateDocumentForArtifact,
  buildDocumentArtifactBytes,
} from "../routes/ava_copilot";
// [VENICE-VID-1 / VENICE-MUS-1] The shared Q_AI_MEDIA queue now also carries
// Venice video/music POLL messages — see queues/venice_media.ts's header for
// why they reuse this queue rather than a new binding, and
// lib/venice_media_jobs.ts's header for why they are a SEPARATE small job
// table rather than a new AiMediaJobKind. isVeniceMediaKind()/
// runVeniceMediaJobMessage() are the discriminator + handler this file
// dispatches to below, before ANY ai_media_jobs.ts lookup.
import { isVeniceMediaKind, runVeniceMediaJobMessage } from "./venice_media";
import type { VeniceMediaJobKind } from "../lib/venice_media_jobs";

export interface AiMediaJobQueueMsg {
  job_id: string;
  // Widened (not just AiMediaJobKind) because this ONE queue message shape is
  // now shared with venice_media_jobs' own kind values — see the import
  // comment above. Env.Q_AI_MEDIA (worker/src/types.ts) already types `kind`
  // as a plain `string`, so this was always safe to widen; nothing about the
  // wire format changed.
  kind: AiMediaJobKind | VeniceMediaJobKind;
}

/** Thrown by a kind handler to request a queue-level retry (CF redelivers up
 * to the consumer's configured max_retries). Any OTHER thrown/caught error is
 * treated as terminal — failAiMediaJob() runs once and the message is acked,
 * never retried. */
class RetryableJobError extends Error {}

const PROVIDER_TIMEOUT_MS = 45_000; // outage guard, mirrors this codebase's existing per-step ceiling (Part V §30d)

// ---------------------------------------------------------------------------
// Per-kind handlers. Each is a pure "do the provider work, return the
// artifact + settlement usage" function — completeAiMediaJob()/
// failAiMediaJob() are called ONCE by the dispatcher below, never by a
// handler directly, so "call complete/fail exactly once" holds by
// construction rather than by every handler remembering to do it.
// ---------------------------------------------------------------------------
interface HandlerResult {
  artifact: { mediaId: string; mimeType?: string | null; fileName?: string | null; language?: string | null };
  settlement: {
    modelActual: string;
    usage: { inputTokens?: number; outputTokens?: number; images?: number; imageOutputTokens?: number; ocrPages?: number; avSeconds?: number };
    providerCostUsdMicro?: number;
  };
}

type KindHandler = (env: Env, job: AiMediaJobRecord) => Promise<HandlerResult>;

// [§41/§42 error-code vocabulary] The SAFE, lower_snake_case codes
// app/lib/features/avatok/widgets/ai_media_job_card.dart's _friendlyError()
// recognises: provider_timeout, provider_unavailable, unsupported_format,
// input_too_large, insufficient_balance, cancelled_by_user. Handlers below
// signal one by throwing `new Error("<code>: detail")`; classifyJobError()
// (used by the dispatcher's catch, further down) extracts the prefix —
// never the raw provider/error message as the code itself.
const KNOWN_JOB_ERROR_CODES = new Set([
  "provider_timeout", "provider_unavailable", "unsupported_format",
  "input_too_large", "insufficient_balance", "cancelled_by_user",
]);
function classifyJobError(e: unknown): string {
  const msg = String((e as any)?.message ?? e ?? "");
  const m = /^([a-z_]+):/.exec(msg);
  if (m && KNOWN_JOB_ERROR_CODES.has(m[1])) return m[1];
  return "provider_unavailable"; // safe generic fallback — never the raw message (§41/§42)
}

// [AVA-IMAGE-UX-1 / §44] Legacy fallback for malformed/old messages. Normal
// image messages are intercepted by runAiMediaJobMessage after their encrypted
// input is loaded, then fulfilled by routes/ava_image.ts.
async function unreachableDirectRouteKind(_env: Env, job: AiMediaJobRecord): Promise<HandlerResult> {
  throw new Error(`provider_unavailable: ${job.kind} is fulfilled directly by its owning route, not this queue — this stub should be unreachable`);
}
const handleImageGenerate: KindHandler = unreachableDirectRouteKind;

// ---------------------------------------------------------------------------
// [AVA-IMG-TIERS-1 / WS-10] image_upgrade — the on-demand 2K rendition.
//
// WHY THIS ONE *IS* QUEUE-DRIVEN. Image generation now uses the same queue
// with an encrypted prompt input. An upgrade has neither half of that
// problem. Its input is the PREVIEW ARTIFACT, already durably stored in R2 and
// referenced by `source_media_id` (authorized once, at createAiMediaJob time),
// and its prompt is UPSCALE_INSTRUCTION below — a fixed, non-sensitive
// constant that is not derived from anything the user typed. A redelivery can
// safely re-fetch and redo it. That is precisely the shape doc_summarize and
// audio_transcribe already have, so it takes the same lane.
//
// HOW THE PREVIEW REACHES THE PROVIDER — and why there is no presigned-URL
// gamble here. OpenRouter's Image API documents `input_references` as
// accepting "HTTP(S) URLs or base64 data URLs". We take the data-URL branch:
// the worker reads the preview bytes back out of R2 itself and inlines them.
// That removes the entire unverifiable question of whether xAI's fetcher can
// retrieve a SigV4-presigned private R2 URL before it expires — nobody has to
// fetch anything. It also means no presigned URL for a user's private image is
// ever handed to a third party, which the URL branch would have required.
// ---------------------------------------------------------------------------

// A FIXED instruction, deliberately not the user's original prompt (which is
// never persisted, §41/§42, and is not needed: the reference image already
// carries the content). Its only job is to tell the model "reproduce this,
// larger" rather than "reinterpret this" — the result has to match the preview
// the user already saw, or the download is a different picture from the one
// they asked to download.
const UPSCALE_INSTRUCTION =
  "Reproduce this exact image at the highest available fidelity. Preserve the composition, " +
  "subject, colours, lighting and every detail precisely as they are. Do not add, remove, " +
  "restyle or reinterpret anything — this is a resolution increase, not a new image.";

/** Grok Imagine's `input_references` cap is 3 (verified against the live
 *  per-endpoint descriptor). We send exactly one: the preview. */
const UPGRADE_MAX_REFERENCE_BYTES = 8 * 1024 * 1024;

const handleImageUpgrade: KindHandler = async (env, job) => {
  if (!job.source_media_id) throw new Error("unsupported_format: image_upgrade job has no source image");
  const key = (env as unknown as { OPENROUTER_API_KEY?: string }).OPENROUTER_API_KEY;
  if (!key) throw new Error("provider_unavailable: image generation key is not configured");

  const src = await fetchSourceMediaBytes(env, job.source_media_id);
  if (!String(src.mime || "").toLowerCase().startsWith("image/")) {
    throw new Error("unsupported_format: source is not an image");
  }
  // A reference image has to travel inline in the request body. Guard the size
  // rather than letting a pathological artifact build a request that the
  // provider rejects opaquely 40 s later.
  if (src.bytes.byteLength > UPGRADE_MAX_REFERENCE_BYTES) {
    throw new Error("input_too_large: this image is too large to upgrade");
  }

  const cfg = await readConfig(env);
  const resolution = imageResolutionForTier(cfg.imageFullResolutionTier);
  const dataUrl = `data:${src.mime};base64,${bytesToBase64(src.bytes)}`;

  const gen = await generateImage(env, key, UPSCALE_INSTRUCTION, job.owner_uid, dataUrl, { resolution });

  const sensitivity = await resolveArtifactSensitivity(env, job.source_media_id);
  const fileName = `${stripExt(src.fileName)}.${resolution.toLowerCase()}.png`;
  const artifact = await registerArtifactMedia(env, {
    uid: job.owner_uid, bytes: gen.bytes, mimeType: "image/png",
    fileName, category: "image", sensitivity,
  });

  // Cross-link the new rendition onto the ORIGINAL image_generate job, so the
  // client — which holds the PREVIEW's job id, not this upgrade job's — can
  // find it with one indexed lookup. Best-effort by design: the artifact is
  // already durably stored and reachable through this upgrade job either way,
  // so a failed index write must not fail a delivered image.
  if (job.upgrade_of_job_id) {
    await linkJobRendition(env, {
      jobId: job.upgrade_of_job_id,
      ownerUid: job.owner_uid,
      mediaId: artifact.id,
      rendition: "full",
      resolution,
      mimeType: "image/png",
      fileName,
      sourceMediaId: job.source_media_id,
    });
  }

  return {
    artifact: { mediaId: artifact.id, mimeType: "image/png", fileName, rendition: "full", resolution },
    settlement: {
      modelActual: imageModel(env),
      usage: { images: 1, imageOutputTokens: gen.imageOutputTokens },
      providerCostUsdMicro: gen.costUsd != null ? Math.round(gen.costUsd * 1_000_000) : undefined,
    },
  };
};

// ---------------------------------------------------------------------------
// Shared source-media fetch — used by ALL FOUR handlers below. Authorization
// already happened once, at createAiMediaJob() time (worker/src/lib/
// ai_media_jobs.ts: conversation-membership check, B1/B2 fixes) — the id
// stored on the job is already the canonical, authorized user_media.id, which
// may legitimately belong to ANOTHER conversation member (a document/voice
// note someone SENT the job owner). Re-checking `row.uid === job.owner_uid`
// here would be exactly the B2 bug the new contract fixes, so this function
// deliberately does NOT do that — it trusts job.source_media_id and fetches
// by id only. Picks the bucket from the row's OWN `storage` column
// ('digital' -> env.DIGITAL, the private/server-readable bucket
// uploadPrivate's x-encrypted:0 path and registerArtifactMedia's private path
// both use; anything else -> env.BLOBS, the public/E2E-ciphertext bucket) —
// a prior version of this fetch always read env.BLOBS, which silently 404'd
// every private, server-readable voice note/document (wrong bucket).
// ---------------------------------------------------------------------------
interface SourceMediaBytes { bytes: Uint8Array; mime: string; fileName: string }

async function fetchSourceMediaBytes(env: Env, mediaId: string): Promise<SourceMediaBytes> {
  const mdb = mediaSession(env);
  const row = await mdb.prepare(
    "SELECT key, mime_type, file_name, encrypted, storage FROM user_media WHERE id=?1",
  ).bind(mediaId).first<any>();
  if (!row) throw new Error("unsupported_format: source media not found");
  // [MVP voice-note decision 2026-07-25] `encrypted=1` is E2E ciphertext — the
  // server never holds the key, so it genuinely cannot read this file. This is
  // the HONEST degrade for an older voice note/DM attachment sent before
  // voiceNoteEncryptionEnabled=false shipped: a clear unsupported_format, not
  // a hang. `encrypted=0` (private, server-readable — 'digital' storage) is
  // the new MVP shape and IS supported below.
  if (Number(row.encrypted) === 1) {
    throw new Error("unsupported_format: this file was sent end-to-end encrypted and cannot be processed on the server — ask the sender to resend it");
  }
  const bucket = row.storage === "digital" ? env.DIGITAL : env.BLOBS;
  const obj = await bucket.get(row.key);
  if (!obj) throw new Error("unsupported_format: source media blob missing");
  const bytes = new Uint8Array(await obj.arrayBuffer());
  return { bytes, mime: String(row.mime_type || "application/octet-stream"), fileName: String(row.file_name || "file") };
}

/** Strip a trailing `.ext` for building `<name>.<suffix>.<ext>` artifact file names. */
function stripExt(name: string): string {
  return (name || "file").replace(/\.[a-z0-9]{1,6}$/i, "");
}

function isDocumentMime(mime: string): boolean {
  const m = String(mime || "").toLowerCase();
  return !(m.startsWith("image/") || m.startsWith("audio/") || m.startsWith("video/"));
}
function isAudioMime(mime: string): boolean {
  return String(mime || "").toLowerCase().startsWith("audio/");
}

// ---------------------------------------------------------------------------
// [AVA-DOC-ARTIFACT-1 / §38/§45] doc_summarize — fetch source doc -> extract
// text (routes/ava_copilot.ts's extractDocumentText, Workers AI toMarkdown
// binding) -> summarize (summarizeDocumentForArtifact, pinned model from
// lib/ava_reason/policy.ts) -> register a NEW markdown artifact (never an
// inline-only dialog result) -> settle on REAL provider usage.
// ---------------------------------------------------------------------------
const handleDocSummarize: KindHandler = async (env, job) => {
  if (!job.source_media_id) throw new Error("unsupported_format: doc_summarize job has no source document");
  const src = await fetchSourceMediaBytes(env, job.source_media_id);
  if (!isDocumentMime(src.mime)) throw new Error("unsupported_format: source is not a document");
  const extracted = await extractDocumentText(env, src.bytes.buffer as ArrayBuffer, src.mime, src.fileName);
  if (!extracted.text.trim()) throw new Error("unsupported_format: could not extract any text from this document");

  const result = await summarizeDocumentForArtifact(env, { uid: job.owner_uid, email: null, text: extracted.text });
  const bytes = new TextEncoder().encode(result.text);
  const fileName = `${stripExt(src.fileName)}.summary.md`;
  const sensitivity = await resolveArtifactSensitivity(env, job.source_media_id);
  const artifact = await registerArtifactMedia(env, {
    uid: job.owner_uid, bytes, mimeType: "text/markdown; charset=utf-8",
    fileName, category: "document", sensitivity,
  });
  return {
    artifact: { mediaId: artifact.id, mimeType: "text/markdown", fileName },
    settlement: {
      modelActual: result.modelActual,
      usage: { inputTokens: result.inputTokens ?? undefined, outputTokens: result.outputTokens ?? undefined },
      providerCostUsdMicro: result.providerCostUsdMicro,
    },
  };
};

// ---------------------------------------------------------------------------
// [AVA-DOC-ARTIFACT-1 / §38/§45] doc_translate — same fetch+extract, then
// translateDocumentForArtifact (chunked). Output: a Latin-1-safe PDF
// (buildDocumentArtifactBytes) or, for non-Latin scripts, honest UTF-8 plain
// text — never a corrupted Latin-1 PDF (§38).
// ---------------------------------------------------------------------------
const handleDocTranslate: KindHandler = async (env, job) => {
  if (!job.source_media_id) throw new Error("unsupported_format: doc_translate job has no source document");
  const targetLang = job.target_language || "en";
  const src = await fetchSourceMediaBytes(env, job.source_media_id);
  if (!isDocumentMime(src.mime)) throw new Error("unsupported_format: source is not a document");
  const extracted = await extractDocumentText(env, src.bytes.buffer as ArrayBuffer, src.mime, src.fileName);
  if (!extracted.text.trim()) throw new Error("unsupported_format: could not extract any text from this document");

  const result = await translateDocumentForArtifact(env, { uid: job.owner_uid, email: null, text: extracted.text, to: targetLang });
  const built = buildDocumentArtifactBytes(`${stripExt(src.fileName)} — ${targetLang}`, result.text);
  const fileName = `${stripExt(src.fileName)}.${targetLang.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.${built.ext}`;
  const sensitivity = await resolveArtifactSensitivity(env, job.source_media_id);
  const artifact = await registerArtifactMedia(env, {
    uid: job.owner_uid, bytes: built.bytes, mimeType: built.mimeType,
    fileName, category: "document", sensitivity,
  });
  return {
    artifact: { mediaId: artifact.id, mimeType: built.mimeType, fileName, language: targetLang },
    settlement: {
      modelActual: result.modelActual,
      usage: { inputTokens: result.inputTokens ?? undefined, outputTokens: result.outputTokens ?? undefined },
      providerCostUsdMicro: result.providerCostUsdMicro,
    },
  };
};

// ---------------------------------------------------------------------------
// [AVA-AUDIO-ARTIFACT-1 / §39/§46] audio_transcribe / audio_translate — the
// source is an ALREADY-DURABLY-STORED media object (job.source_media_id ->
// user_media/R2), a plain foreign-key reference rather than sensitive inline
// content, so a redelivery can safely re-fetch it and redo the work.
// PRIVACY BOUNDARY: an E2E-encrypted DM voice note (`encrypted=1`) fails fast
// with unsupported_format via fetchSourceMediaBytes above — matching the
// product rule that private/E2E content is read on-device only. Only
// server-readable audio (the MVP's unencrypted voice notes, or any other
// private/public non-E2E audio) works this wave.
// ---------------------------------------------------------------------------
const handleAudioTranscribe: KindHandler = async (env, job) => {
  if (!job.source_media_id) throw new Error("unsupported_format: audio_transcribe job has no source media");
  const src = await fetchSourceMediaBytes(env, job.source_media_id);
  if (!isAudioMime(src.mime)) throw new Error("unsupported_format: source is not audio");
  const b64 = bytesToBase64(src.bytes);
  const result = await transcribeAudioBuffer(env, b64, { format: sttFormatFor(src.mime) });
  if (!result.text.trim()) throw new Error("provider_unavailable: empty transcript");
  const bytes = new TextEncoder().encode(result.text);
  const fileName = `${stripExt(src.fileName)}.transcript.txt`;
  const sensitivity = await resolveArtifactSensitivity(env, job.source_media_id);
  const artifact = await registerArtifactMedia(env, {
    uid: job.owner_uid, bytes, mimeType: "text/plain; charset=utf-8",
    fileName, category: "document", sensitivity,
  });
  return {
    artifact: { mediaId: artifact.id, mimeType: "text/plain", fileName, language: result.language },
    settlement: { modelActual: result.model, usage: { avSeconds: result.seconds }, providerCostUsdMicro: result.costUsdMicro ?? undefined },
  };
};

const handleAudioTranslate: KindHandler = async (env, job) => {
  if (!job.source_media_id) throw new Error("unsupported_format: audio_translate job has no source media");
  const targetLang = job.target_language || "en";
  const src = await fetchSourceMediaBytes(env, job.source_media_id);
  if (!isAudioMime(src.mime)) throw new Error("unsupported_format: source is not audio");
  const b64 = bytesToBase64(src.bytes);
  const transcribed = await transcribeAudioBuffer(env, b64, { format: sttFormatFor(src.mime) });
  if (!transcribed.text.trim()) throw new Error("provider_unavailable: empty transcript");

  // [§46] Text-translation sub-step on the pinned, low-reasoning/fast
  // attachment model (lib/ava_reason/policy.ts's mediaTextModel — the SAME
  // lane doc_translate uses). NOTE (scope): this ships the translated
  // TRANSCRIPT as the artifact. A synthesized translated-AUDIO artifact (TTS)
  // needs a TTS adapter, which §46 only requires "if the existing server-side
  // voice adapter cannot synthesize the requested target language" — that
  // wiring is a fast-follow (see this wave's HANDOFF), not this pass.
  const translated = await translateDocumentForArtifact(env, { uid: job.owner_uid, email: null, text: transcribed.text, to: targetLang });
  const bytes = new TextEncoder().encode(translated.text);
  const fileName = `${stripExt(src.fileName)}.${targetLang.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.txt`;
  const sensitivity = await resolveArtifactSensitivity(env, job.source_media_id);
  const artifact = await registerArtifactMedia(env, {
    uid: job.owner_uid, bytes, mimeType: "text/plain; charset=utf-8", fileName, category: "document", sensitivity,
  });

  // [§48] Combine BOTH real provider costs (Whisper + the translate call)
  // into ONE ground-truth settlement figure — never re-derived from a
  // single-model catalog rate, which would misprice whichever leg it wasn't
  // fit for. Only reported when BOTH legs have a real provider cost (see
  // translateDocumentForArtifact's doc comment on why a partial miss falls
  // back to the catalog estimate for the WHOLE job instead of averaging in a
  // silent $0 leg).
  const haveCost = transcribed.costUsdMicro != null && translated.providerCostUsdMicro != null;
  const providerCostUsdMicro = haveCost ? (transcribed.costUsdMicro as number) + (translated.providerCostUsdMicro as number) : undefined;

  return {
    artifact: { mediaId: artifact.id, mimeType: "text/plain", fileName, language: targetLang },
    settlement: {
      modelActual: `${transcribed.model}+${translated.modelActual}`,
      usage: { avSeconds: transcribed.seconds, inputTokens: translated.inputTokens ?? undefined, outputTokens: translated.outputTokens ?? undefined },
      providerCostUsdMicro,
    },
  };
};

const KIND_HANDLERS: Record<AiMediaJobKind, KindHandler> = {
  image_generate: handleImageGenerate,
  image_upgrade: handleImageUpgrade,
  doc_summarize: handleDocSummarize,
  doc_translate: handleDocTranslate,
  audio_transcribe: handleAudioTranscribe,
  audio_translate: handleAudioTranslate,
};

// Add a kind only in the same commit that replaces its stub with a tested
// provider pipeline. The route (worker/src/routes/ai_media_jobs.ts, M1-owned)
// checks this before creating/reserving a job. [AVA-DOC-ARTIFACT-1 /
// AVA-AUDIO-ARTIFACT-1] adds all four text/audio kinds here in this commit;
// image_generate is dispatched by runAvaImage after sealing its input.
// [AVA-IMG-TIERS-1 / WS-10] image_upgrade joins in the SAME commit that gives
// it a real handler (handleImageUpgrade above), per the rule stated here.
const IMPLEMENTED_KINDS = new Set<AiMediaJobKind>(["image_upgrade", "doc_summarize", "doc_translate", "audio_transcribe", "audio_translate"]);

export function isAiMediaKindImplemented(kind: AiMediaJobKind): boolean {
  return IMPLEMENTED_KINDS.has(kind);
}

/** Queue-only producer. Long provider work must outlive the request and must
 * not silently fall back to waitUntil when infrastructure is missing. */
export async function enqueueAiMediaJob(env: Env, _ctx: ExecutionContext | undefined, jobId: string, kind: AiMediaJobKind): Promise<void> {
  await env.Q_AI_MEDIA.send({ job_id: jobId, kind });
}

/**
 * The queue consumer entrypoint — worker/src/index.ts's queue() dispatches
 * every "ai-media-jobs" message here (and enqueueAiMediaJob()'s ctx.waitUntil
 * fallback calls it directly when the queue binding doesn't exist yet).
 *
 * Claims before work (never runs a provider call against an unclaimed job).
 * On success, calls completeAiMediaJob() exactly once. On a non-retryable
 * failure, calls failAiMediaJob() exactly once and returns normally (message
 * acked, no retry). On a RETRYABLE failure (provider timeout / transient
 * network error), reverts the job to 'queued' and RETHROWS so
 * worker/src/index.ts's existing queue() catch -> msg.retry() path
 * redelivers it (same idiom as money-settlements/liveness-verify there).
 */
export async function runAiMediaJobMessage(env: Env, msg: AiMediaJobQueueMsg, attempts = 1): Promise<void> {
  const jobId = String(msg?.job_id || "");
  if (!jobId) return; // malformed message — nothing to do, ack and move on

  // [VENICE-VID-1 / VENICE-MUS-1] Discriminate BEFORE any ai_media_jobs.ts
  // lookup: a venice_* kind would 404 against THAT table (claimAiMediaJob ->
  // "not_found" -> silent return below) and the job would never be polled
  // again. See queues/venice_media.ts for the actual poll/deliver logic.
  if (isVeniceMediaKind(msg.kind)) {
    await runVeniceMediaJobMessage(env, { job_id: jobId, kind: msg.kind });
    return;
  }

  const claimed = await claimAiMediaJob(env, jobId);
  if (!claimed.ok) return; // already claimed/terminal — safe no-op (at-least-once redelivery)
  const job = claimed.job;

  // Image prompts are sealed in D1 before enqueue. This removes the last
  // provider path that depended on a request/DO lifetime and could strand a
  // paid row at 15% forever.
  if (job.kind === "image_generate") {
    const input = await loadQueuedImageInput(env, job.job_id, job.owner_uid);
    if (!input) {
      await failAiMediaJob(env, { jobId, errorCode: "INPUT_EXPIRED", reason: "image_input_missing" });
      return;
    }
    await fulfilQueuedImage(env, job, input);
    return;
  }

  const handler = KIND_HANDLERS[job.kind];
  // [AVA-IMG-PROGRESS-1 / WS-9] Phase markers, not a percentage — see
  // updateAiMediaJobProgress()'s doc comment in lib/ai_media_jobs.ts for why a
  // real fraction is unavailable from every provider on these lanes and why the
  // honest client presentation is elapsed time. Best-effort: never awaited into
  // the failure path, never able to fail the job. `provider_returned`/`stored`
  // are not written here because these handlers do their provider call and
  // their artifact registration inside one opaque function; `completeAiMediaJob`
  // writes 100 immediately after.
  await updateAiMediaJobProgress(env, jobId, "claimed");
  try {
    await updateAiMediaJobProgress(env, jobId, "provider_called");
    const result = await Promise.race([
      handler(env, job),
      new Promise<never>((_, reject) => setTimeout(() => reject(new RetryableJobError("provider_timeout")), PROVIDER_TIMEOUT_MS)),
    ]);
    await completeAiMediaJob(env, { jobId, artifact: result.artifact, settlement: result.settlement });
  } catch (e: any) {
    if (e instanceof RetryableJobError) {
      if (attempts >= 3) {
        // [§41/§42] `reason` is a SAFE, structured code only — never raw error
        // text. A prior review found failAiMediaJob's free-text `reason`
        // reaching PostHog (ai_media_jobs.ts's ai_media_job_failed track call)
        // and possibly echoing input fragments; the full exception detail
        // still reaches Error Tracking below via trackException, which is the
        // scrubbed, purpose-built channel for that.
        await failAiMediaJob(env, {
          jobId,
          errorCode: "provider_timeout",
          reason: "provider_timeout_max_attempts",
        });
        void trackException(env, e, {
          uid: job.owner_uid, route: "queues.ai_media", handled: true,
          extra: { job_id: jobId, kind: job.kind, retryable: false, attempts },
        });
        return;
      }
      await requeueAiMediaJob(env, jobId);
      void trackException(env, e, { uid: job.owner_uid, route: "queues.ai_media", handled: true, extra: { job_id: jobId, kind: job.kind, retryable: true } });
      throw e; // let index.ts's existing catch -> msg.retry() redeliver
    }
    // [§41/§42 error-code vocabulary] lower_snake_case, matching what
    // ai_media_job_card.dart's _friendlyError() actually recognises — see
    // classifyJobError()'s doc comment above (KIND_HANDLERS section). `reason`
    // is deliberately just the classified code, not the raw handler error
    // message — see the retryable branch's comment above for why.
    const errorCode = classifyJobError(e);
    await failAiMediaJob(env, { jobId, errorCode, reason: errorCode });
    void trackException(env, e, { uid: job.owner_uid, route: "queues.ai_media", handled: true, extra: { job_id: jobId, kind: job.kind, retryable: false } });
    // return normally — ack, no retry: the job has a clean terminal state.
  }
}
