// Ava generative image route (Phase 9 — Generative · async present-in-thread).
//
//   POST /api/ava/image   { conv, prompt, edit?: { media_ref } }
//
// THE SIGNATURE MOVE — async, in-thread. On request we IMMEDIATELY drop the
// transient "Ava is generating an image…" working chip into the conversation
// (via the caller's AvaAgentDO, exactly like a normal Ava turn), return fast,
// and let the humans keep chatting. When the image is ready we post it as a
// normal `ava` message carrying a `media_ref` into the SAME conversation — the
// frozen chat_thread.dart already renders `ava` bubbles with media + the chip.
//
// Pipeline:
//   1. dual-auth (requireUser → Clerk JWT / NIP-98).
//   2. FLAG-GATED moderation on the prompt (P2 `guardInput`, llama-guard —
//      the call site is `guardInput(env, prompt)` in runAvaImage() below,
//      ~line 532). It is NOT unconditional, whatever earlier revisions of this
//      comment claimed: lib/ai_gate.ts short-circuits every guardInput /
//      guardOutput / safetyVerdict to "safe, provider not called" when
//      `cfg.aiContentModerationEnabled` is false, and that flag shipped DARK
//      (false in prod KV as of 2026-08-07). So on the image path today the
//      guard is a no-op and a disallowed prompt is generated.
//      [AVA-MOD-ON-1 / WS-1] is flipping `aiContentModerationEnabled=true` in
//      production, which turns this call site into a real llama-guard round
//      trip and makes the refusal below reachable. Read the LIVE value from
//      prod KV before asserting anything about it (CLAUDE.md: DEFAULTS in
//      routes/config.ts tells you nothing about production) — and never
//      disable moderation on the image path specifically, whatever is decided
//      about the plain chat lane's output-side guard.
//   3. post the working chip into `conv` (transient ava_status) — since
//      [AVA-IMG-CHIP-EARLY-1 / WS-8] this happens FIRST, before step 2 and
//      before every other gate, so the placeholder appears immediately.
//   4. generate with Gemini "Nano Banana 2" (gemini-3.1-flash-image-preview),
//      same REST shape as routes/affiliate_assets.ts.
//   5. upload the PNG to the PUBLIC blob bucket (same layout as /upload/public:
//      content-addressed `u/<uid>/public/<sha256>`, served by blossom + the
//      /cdn-cgi/image CDN) and register a user_media row so the Avatar/image
//      widgets render it.
//   6. post the final `ava` image message into `conv` (postAvaMessage, P3).
//
// KEY SOURCE: the SERVER key `env.GEMINI_API_KEY` (already used by translate +
// affiliate_assets) is preferred. If unset, we fall back to the caller's BYO
// key on the `X-Ava-Gemini-Key` header (P2 convention). If neither exists we
// 503 (and never post a chip we can't fulfil).
//
// PREMIUM: generation is metered client-side via PaidFeature (image.generate is
// paid:true; the wallet hook is a Phase-0 stub that routes to the top-up sheet
// today). This route does not itself debit the wallet (no server wallet-spend
// authority is wired for Ava yet) — see INTEGRATION-NOTES Phase 9.
//
// [AVA-IMAGE-UX-1 / §44, 2026-07-25] BILLING/STATE UPDATE: the paragraph above
// is historical — generation now DOES reserve/settle real wallet spend, once,
// via a durable AiMediaJob (worker/src/lib/ai_media_jobs.ts). runAvaImage()
// creates the job and returns `job_id` immediately; fulfil() below claims it,
// generates, uploads, and completes/fails it exactly once. The legacy
// ava_status "working chip" (postChip/endChip, step 3/pipeline note above)
// is kept ONLY as a best-effort secondary signal for pre-job-card clients —
// the job (and its `artifact_url`, resolved fresh on every read) is the
// PRIMARY, authoritative state a job-hydrated client reconciles against.
//
// image_generate is the ONE AiMediaJob kind that stays route-owned rather than
// queue-dispatched (worker/src/queues/ai_media.ts's handleImageGenerate is a
// deliberate unreachable stub): its input is an ephemeral PROMPT that must
// never be persisted to the job row or a queue message (§41/§42 privacy
// rule), so a job_id-only redelivery could never safely redo the work. fulfil()
// below claims and completes/fails the job directly, in the same request's
// closure where the prompt still legitimately lives.

import type { Env } from "../types";
import { json, sha256Hex } from "../util";
import { requireUser, isFail } from "../authz";
import { guardInput, friendlyAiError } from "../lib/ai_gate";
import { track, trackUser, trackException } from "../hooks";
import { readConfig } from "./config";
import { tierOf, PLANS, type TierId } from "./plans";
import { enforceAllowance } from "../lib/usage";
import { mediaSession } from "../db/shard";
import { postAvaMessage } from "./ava_thread";
import type { MessageScope } from "../lib/ava_kinds";
import { imageModel } from "../lib/ava_reason/policy"; // One Brain B1: env-overridable image model
// [AVA-IMAGE-UX-1 / §44] Durable job/message state machine — the PRIMARY
// mechanism a job-hydrated client (AiMediaJobRepository/AiMediaJobCard, M4)
// reads. postChip()/endChip() below are kept as a best-effort SECONDARY
// signal only, for any app build that hasn't picked up the job card yet.
import {
  createAiMediaJob, claimAiMediaJob, completeAiMediaJob, failAiMediaJob,
  resolveArtifactSensitivity, updateAiMediaJobProgress,
  // [AVA-IMG-TIERS-1 / WS-10] The on-demand 2K rendition path.
  getAiMediaJob, findUpgradeJobFor, getJobRendition, flatPriceTokensFor,
} from "../lib/ai_media_jobs";
// [AVA-IMG-TIERS-1 / WS-10] The upgrade is queue-dispatched (see
// queues/ai_media.ts's handleImageUpgrade for why it can be, when
// image_generate cannot). This is a deliberate import cycle with that module —
// the same shape lib/ai_media_jobs.ts <-> routes/media.ts and
// routes/config.ts <-> lib/ai_billing.ts already have. It is safe because
// nothing here is used at module-evaluation time: every binding on both sides
// is a hoisted function declaration called only at request time.
import { enqueueAiMediaJob } from "../queues/ai_media";
import { registerArtifactMedia } from "./media";
import { emailFor } from "../lib/identity";
// [AVA-VOICE-STYLE-1 / WS-14e] The ONE table of user-visible canned strings.
// The image chip is the string the owner asked for by name ("hold karo, mein 2K
// la raha hoon" — it surfaces verbatim in ai_media_job_card.dart's job.label).
import { readVoiceStyle, avaString, type AvaVoiceStyle } from "../lib/ava_persona";

// ---------------------------------------------------------------------------
// [AVA-IMG-KEEPALIVE-1 / WS-3] Detached-work lifetime.
//
// THE BUG: this route's heavy work (fulfil(), below) is deliberately detached
// so the HTTP request returns immediately and the humans keep chatting. It was
// fired as a bare `void fulfil(...)`. On the plain-Worker path that is a
// promise the runtime was never told about: once the Response is returned the
// request context can be torn down and the in-flight generation is cancelled
// mid-way — the job sits at 'running' forever, no image ever arrives, and
// NOTHING is logged, because the code that would have logged it was cancelled
// too. That is a prime suspect for "my image never came".
//
// THE TWO CALL PATHS ARE GENUINELY DIFFERENT AND ONE MECHANISM DOES NOT COVER
// BOTH — which is why the lifetime source is an explicit parameter here rather
// than something this file tries to infer:
//
//   • HTTP route (`avaImage`, wired at worker/src/index.ts:697) runs in a
//     plain Worker fetch handler and HAS an `ExecutionContext`. Its
//     `ctx.waitUntil(p)` is the ONLY thing that keeps `p` alive past the
//     Response. index.ts already threads `ctx` into other routes
//     (avaAppsRun, aiMediaJobsCreate) — the same wiring is now used here.
//
//   • Agent lane (`AvaAgentDO` → onImage → runAvaImage, do/ava_agent.ts:1174)
//     runs INSIDE a Durable Object, which has no `ExecutionContext` at all.
//     A DO's equivalent is `DurableObjectState.waitUntil(p)`: the DO instance
//     is kept from being evicted while the promise is outstanding. Passing an
//     ExecutionContext there is impossible; assuming the DO "just keeps
//     promises alive" is how a hibernating DO drops one.
//
// Both `ExecutionContext` and `DurableObjectState` structurally satisfy the
// one-method interface below, so each caller passes its OWN lifetime source
// and neither has to know about the other's.
//
// ⚠️ do/ava_agent.ts is another agent's file ownership this wave, so its
// `runAvaImage(this.env, {...})` call does NOT yet pass one. `keepAlive` is
// therefore OPTIONAL: when absent we fall back to today's bare `void`
// behaviour (no regression, and inside a DO the promise usually does survive)
// — but the agent lane should be updated to pass `keepAlive: this.state` in a
// follow-up. That is reported, not silently assumed.
// ---------------------------------------------------------------------------
export interface AvaImageKeepAlive {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Run `p` as detached work under the caller's lifetime guarantee. Never
 * rejects (a rejected promise handed to waitUntil is an unhandled rejection);
 * failures are reported to Error Tracking instead of vanishing — the whole
 * point of WS-3 is that silent disappearance stops being possible.
 */
function detach(env: Env, keepAlive: AvaImageKeepAlive | undefined, p: Promise<unknown>, where: string, uid?: string): void {
  const guarded = p.catch((e) => {
    void trackException(env, e, { uid, route: "ava_image", method: where, handled: true, app_name: "avaai" });
  });
  if (keepAlive) {
    try { keepAlive.waitUntil(guarded); return; } catch { /* fall through to void */ }
  }
  void guarded;
}

// Image generation is metered by the Phase-1 SUBSCRIPTION ALLOWANCE (plans.ts):
// every tier — including Free — gets a daily image grant (Free 3, Plus 30,
// Pro 100, Max unlimited), enforced server-side via enforceAllowance("image").
// PROVIDER: OpenRouter's dedicated Image API (POST /api/v1/images) on xAI Grok —
// the Google Gemini image model hit a hard 429 quota on our free key (owner
// decision 2026-06-24: switch to OpenRouter). Returns base64 PNG bytes.
//
// One Brain B1 (SPEC §4): this is the OpenRouter *image-generation* endpoint
// (/v1/images), which is NOT chat/vision-shaped and has no avaReason verb/adapter,
// so it stays a direct fetch by design. What B1 fixes here: the model is no longer
// hard-coded — it comes from policy.imageModel(env) (OPENROUTER_IMAGE_MODEL env
// override → the default below) so it is flippable without a code deploy, and the
// call now emits an `ava_reason_call`-compatible telemetry event so image spend is
// attributable in the same PostHog schema as every gateway call.
// Default model id lives in policy.imageModel(env); no module-level const here.

function inboxOf(env: Env, uid: string) {
  return env.INBOX.get(env.INBOX.idFromName(uid));
}

// ---- imageDailyCap: global per-account/day emergency cost circuit breaker ---
// [AI-FLAG-CONTRACT-1] `cfg.imageDailyCap` (routes/config.ts DEFAULTS + numericKeys)
// used to be an ORPHAN — writable via KV once in numericKeys, but read by NOTHING,
// so tuning it did nothing (ROOT-CAUSE §18). This is the fix: a hard backstop
// enforced IN ADDITION TO the per-tier plan allowance above, so it also catches
// the Max/unlimited tier — which PLANS[tier].caps.image === null and
// usage.ts#enforceAllowance short-circuits BEFORE it ever reads or bumps its
// per-tier "image" counter (see enforceAllowance: `if (cap === null) return
// {allowed:true, used:0, ...}` — an unlimited tier is never counted there).
// A global cap that only ever consulted that same counter would therefore never
// see (or bound) an unlimited-tier account, defeating the point of an emergency
// circuit breaker. So this keeps its OWN counter, independent of tier/plan,
// matching the exact storage pattern usage.ts already uses (KV `env.TOKENS`,
// one key per uid per UTC day, self-evicting TTL) rather than inventing new
// storage — just under its own key prefix (`imgcap:`) so it counts every image
// this uid generates regardless of tier.
const IMG_CAP_TTL_SECONDS = 2 * 24 * 60 * 60; // mirrors usage.ts TTL_SECONDS

function imgCapDayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10); // UTC day, same as usage.ts#dayKey
}
function imgCapKvKey(uid: string, day = imgCapDayKey()): string {
  return `imgcap:${uid}:${day}`;
}

async function readGlobalImageCount(env: Env, uid: string): Promise<number> {
  try {
    const raw = await env.TOKENS.get(imgCapKvKey(uid));
    return raw ? Math.max(0, parseInt(raw, 10) || 0) : 0;
  } catch {
    return 0; // fail open — never block generation because a KV read hiccuped
  }
}

async function bumpGlobalImageCount(env: Env, uid: string): Promise<number> {
  const key = imgCapKvKey(uid);
  let used = 0;
  try {
    const raw = await env.TOKENS.get(key);
    used = (raw ? Math.max(0, parseInt(raw, 10) || 0) : 0) + 1;
    await env.TOKENS.put(key, String(used), { expirationTtl: IMG_CAP_TTL_SECONDS });
  } catch {
    /* fail open — never block a generation on a counter write failure */
  }
  return used;
}

// [AI-FLAG-CONTRACT-1] existing "staging vs prod" signal in this codebase
// (clock.ts uses the same `TEST_CLOCK_ALLOWED === "1"` check, set ONLY in
// `[env.staging.vars]` — see wrangler.toml). Reused here rather than inventing a
// new environment tag, since none currently exists in Env.
function environmentTag(env: Env): "staging" | "prod" {
  return env.TEST_CLOCK_ALLOWED === "1" ? "staging" : "prod";
}

/**
 * Global per-account/day image-gen circuit breaker. Runs AFTER the per-tier
 * plan-allowance gate (so a plan_limit block is reported as that, not this) and
 * BEFORE any provider call. `cap` is `cfg.imageDailyCap`; non-finite/<=0
 * disables the backstop (fails OPEN on a misconfigured value, matching the
 * rest of this route's fail-open KV posture) rather than blocking everyone.
 */
async function checkGlobalImageCap(
  env: Env, uid: string, tier: TierId, cap: unknown,
): Promise<{ blocked: boolean; used: number; cap: number | null }> {
  const capNum = typeof cap === "number" && Number.isFinite(cap) && cap > 0 ? cap : null;
  if (capNum === null) return { blocked: false, used: 0, cap: null };
  const used = await readGlobalImageCount(env, uid);
  if (used >= capNum) {
    track(env, uid, "ava_image_global_cap_blocked", "avaai", {
      cap: capNum, used, tier, environment: environmentTag(env),
    });
    return { blocked: true, used, cap: capNum };
  }
  return { blocked: false, used, cap: capNum };
}

// Resolve conversation members — mirrors AvaAgentDO.members() (P3) so a DM with
// no conversation_members rows still fans out and a group reads DB_META.
async function membersOf(env: Env, conv: string, caller: string): Promise<string[]> {
  if (conv.startsWith("dm_")) {
    const parts = conv.slice(3).split("__");
    if (parts.length === 2) return Array.from(new Set([parts[0], parts[1], caller]));
  }
  try {
    const rows = await env.DB_META
      .prepare("SELECT uid FROM conversation_members WHERE conv_id = ?1").bind(conv).all<{ uid: string }>();
    const list = (rows.results || []).map((r) => r.uid);
    if (!list.includes(caller)) list.push(caller);
    return list;
  } catch {
    return [caller];
  }
}

// Append a payload to one member's InboxDO (mirrors AvaAgentDO.appendTo).
async function appendTo(env: Env, owner: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await inboxOf(env, owner).fetch("https://inbox/append", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, owner }),
    });
  } catch { /* best-effort; never throw out of a fan-out */ }
}

// Fire the transient ava_status broadcast (mirrors AvaAgentDO.statusBroadcast).
async function statusBroadcast(env: Env, owner: string, conv: string, label: string, statusId: string, phase: "start" | "end"): Promise<void> {
  try {
    await inboxOf(env, owner).fetch("https://inbox/ava_status", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ conv, label, status_id: statusId, phase }),
    });
  } catch { /* best-effort */ }
}

// Post the working chip into the conversation. `label` is the caller's ONE
// resolved chip string for this request ([AVA-VOICE-STYLE-1 / WS-14e]) — it is
// no longer the English literal "Ava is generating an image…", because the
// user's Ava voice style decides it (Hinglish by default). Same
// mechanism the spine uses (P3.postStatus, which is private to the DO): a
// transient broadcast PLUS a persisted {t:'ava_status'} envelope so the FROZEN
// chat_thread.dart renders the chip today.
//
// [AVA-IMG-CHIP-EARLY-1 / WS-8] `statusId` is now MINTED BY THE CALLER and
// passed IN, instead of being generated here and returned. That is the whole
// trick that lets the chip move to the front of runAvaImage(): this function
// fans out per conversation member (membersOf → one InboxDO broadcast + one
// append EACH), so awaiting it to learn the id would put a whole fan-out on
// the critical path — exactly the kind of round trip WS-8 exists to remove.
// With the id minted locally the caller can fire this and carry on, and still
// has the id it needs for endChip() on any later failure. Returns void
// deliberately: there is nothing left to wait for.
async function postChip(env: Env, uid: string, conv: string, label: string, priv: boolean, statusId: string): Promise<void> {
  try {
    // PRIVACY: a @ava (private) request must NEVER reach the other participant —
    // target ONLY the requester's InboxDO with scope to:<uid>. #ava (public) fans
    // out to all members.
    const targets = priv ? [uid] : await membersOf(env, conv, uid);
    const scope: MessageScope = priv ? `to:${uid}` : "thread";
    const envelope = JSON.stringify({ t: "ava_status", label, status_id: statusId, phase: "start", source: "image" });
    const payload = { conv, sender: "ava", kind: "ava_status", body: envelope, created_at: Date.now(), scope };
    await Promise.all(targets.map((m) => statusBroadcast(env, m, conv, label, statusId, "start")));
    await Promise.all(targets.map((m) => appendTo(env, m, payload)));
  } catch {
    /* best-effort; the final image still lands either way */
  }
}

// Close the working chip (phase:'end') once the image has been posted.
//
// ⚠️ [AVA-VOICE-STYLE-1 / WS-14e] `label` is a REQUIRED parameter, not a
// convenience. It used to be the hardcoded literal "Ava is generating an
// image…" here while the 'start' phase used runAvaImage's `chipLabel` — which
// were only ever equal by coincidence, and were ALREADY different for an edit
// ("Ava is editing your image…"). The client keys a chip by (status_id, label)
// when reconciling, so the two phases MUST carry the identical string or the
// chip cannot be closed. Passing it in makes that structural instead of
// accidental; there is now exactly one chip string per image request.
async function endChip(env: Env, uid: string, conv: string, statusId: string | undefined, priv: boolean, label: string): Promise<void> {
  if (!statusId) return;
  try {
    const targets = priv ? [uid] : await membersOf(env, conv, uid);
    const scope: MessageScope = priv ? `to:${uid}` : "thread";
    const envelope = JSON.stringify({ t: "ava_status", label, status_id: statusId, phase: "end", source: "image" });
    const payload = { conv, sender: "ava", kind: "ava_status", body: envelope, created_at: Date.now(), scope };
    await Promise.all(targets.map((m) => statusBroadcast(env, m, conv, "", statusId, "end")));
    await Promise.all(targets.map((m) => appendTo(env, m, payload)));
  } catch { /* best-effort */ }
}

// One OpenRouter Image API call → PNG bytes. `key` is the OPENROUTER_API_KEY.
// `editRef` (optional) supplies an existing public image URL to edit ("make it
// blue") — passed as an input_reference for image-to-image. Errors emit
// `ava_image_error` telemetry so the real provider message is visible in PostHog.
// [§46/§48] Best-effort provider usage/cost captured off the Images API
// response for billing ground truth (completeAiMediaJob's settlement prefers
// this over a catalog estimate) — NEVER fabricated: absent fields stay
// undefined, never defaulted to 0/a guess.
export interface GeneratedImage {
  bytes: Uint8Array;
  imageOutputTokens?: number;
  costUsd?: number;
  /** [AVA-IMG-PROGRESS-1 / WS-9] Wall-clock of the provider call itself, so the
   *  caller can attribute end-to-end latency without re-deriving it. Same
   *  number as the `ava_reason_call.latency_ms` emitted below. */
  providerMs: number;
  /** The resolution actually requested (echoed back for telemetry). */
  resolution: string;
}

/** [AVA-IMG-TIERS-1 / WS-10 groundwork] Per-call generation options. Resolution
 *  used to be hard-coded `"2K"` inline; it is now a parameter with that same
 *  default, so WS-10's fast small preview + on-demand 2K rendition only has to
 *  supply a value and add a second call — no surgery on this function.
 *  ⚠️ Legal values for Grok Imagine's `resolution` field are NOT documented
 *  anywhere in this repo; only "2K" has ever been sent. Verify accepted values
 *  against the provider docs before passing anything else. `aspectRatio` is
 *  listed by the provider as supported but is not sent unless set. */
export interface GenerateImageOptions {
  resolution?: string;
  aspectRatio?: string;
}

const DEFAULT_IMAGE_RESOLUTION = "2K";

// ---------------------------------------------------------------------------
// [AVA-IMG-TIERS-1 / WS-10] Resolution tier -> provider resolution string.
//
// VERIFIED AGAINST THE LIVE PROVIDER, 2026-08-07 — not assumed, and not the
// same list the OpenRouter docs print. The generic docs list four tiers
// (`512`, `1K`, `2K`, `4K`), but the tiers are per-MODEL and the authoritative
// source is the per-endpoint capability descriptor:
//
//   curl https://openrouter.ai/api/v1/images/models/x-ai/grok-imagine-image-quality/endpoints
//   -> supported_parameters.resolution = { type: "enum", values: ["1K","2K"] }
//      supported_parameters.input_references = { type: "range", min: 0, max: 3 }
//      supported_parameters.n = { type: "range", min: 1, max: 1 }
//
// ⚠️ SO THERE IS NO 512 ON THIS MODEL. `imagePreviewResolutionTier` documents
// tier 0 as "512px", but sending "512" to grok-imagine-image-quality would be
// a HARD 400 from the provider, not a graceful downgrade to the nearest
// supported size. Tier 0 therefore clamps to "1K" — the smallest thing this
// model can actually produce — rather than being passed through to fail. If
// the image model is ever changed via OPENROUTER_IMAGE_MODEL, re-read that
// endpoint descriptor before assuming this map still holds.
//
// The speed win is real even without a 512: the preview is displayed in a
// 240 px bubble, so 1K is already ~4x the pixels anyone sees, and 1K is both
// faster to generate and cheaper ($0.05/image vs $0.07 at 2K).
const RESOLUTION_BY_TIER: Record<number, string> = {
  0: "1K", // documented as 512, clamped — grok-imagine has no 512 tier (see above)
  1: "1K",
  2: "2K",
};

/**
 * Map a numeric config tier to a provider resolution string.
 *
 * The tiers are numbers rather than strings because `config.ts` accepts only
 * `number` and `boolean` — `putConfig` has no string branch, so a
 * `imagePreviewResolution: "1K"` key would be impossible to declare, let alone
 * flip. The numeric enum is the workaround, and this is the one place that
 * knows what the numbers mean.
 *
 * Unknown/garbage tiers fall back to the safe default rather than sending an
 * unsupported value the provider would reject outright.
 */
export function imageResolutionForTier(tier: unknown): string {
  const n = Math.trunc(Number(tier));
  return RESOLUTION_BY_TIER[n] ?? DEFAULT_IMAGE_RESOLUTION;
}

// [AVA-IMG-TIERS-1 / WS-10] EXPORTED so queues/ai_media.ts's image_upgrade
// handler can make the second (2K) provider call through this SAME function.
// A second copy of the OpenRouter Images request would drift on telemetry,
// error classification, usage/cost extraction and the supported-field list —
// the exact drift this file's header warns about.
//
// `editRef` accepts either an https URL or a base64 `data:` URL; the upgrade
// path uses the latter, so no presigned private-R2 URL is ever handed to the
// provider. See handleImageUpgrade for the full reasoning.
export async function generateImage(
  env: Env, key: string, prompt: string, uid: string, editRef?: string, opts: GenerateImageOptions = {},
): Promise<GeneratedImage> {
  // One Brain B1: model is env-overridable (OPENROUTER_IMAGE_MODEL) via policy.
  const model = imageModel(env);
  const resolution = opts.resolution || DEFAULT_IMAGE_RESOLUTION;
  const t0 = Date.now();
  // ava_reason_call-compatible telemetry (same schema as the gateway) so image
  // spend is attributable alongside every other AI call. verb "see" tags this as a
  // vision/image op; provider "openrouter". Emitted best-effort on ok and error.
  const emitReason = (ok: boolean, error: string | null) => {
    try {
      track(env, uid, "ava_reason_call", "avaai", {
        role: "ava_image", capability: "image_generate", trigger: editRef ? "image_edit" : "image_create",
        opportunity: null, feature: "ava_image", verb: "see", provider: "openrouter",
        model, primary_model: null, ok, fallback_used: false, cache_hit: false,
        latency_ms: Date.now() - t0, tokens_in: null, tokens_out: null, error,
        resolution,
      });
    } catch { /* telemetry best-effort */ }
  };
  // Grok Imagine supports: resolution, aspect_ratio, n, input_references (no
  // output_format) — send only supported fields so the endpoint doesn't reject.
  const body: any = { model, prompt, resolution };
  if (opts.aspectRatio) body.aspect_ratio = opts.aspectRatio;
  if (editRef) {
    body.input_references = [{ type: "image_url", image_url: { url: editRef } }];
  }
  const r = await fetch("https://openrouter.ai/api/v1/images", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
      "HTTP-Referer": "https://avatok.ai",
      "X-Title": "AvaTOK",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const j = (await r.json().catch(() => ({}))) as any;
  if (!r.ok) {
    const msg = String(j?.error?.message ?? j?.error ?? "unknown").slice(0, 300);
    track(env, uid, "ava_image_error", "avaai", { stage: "generate", status: r.status, model, provider: "openrouter", resolution, error: msg });
    emitReason(false, `openrouter ${r.status}: ${msg}`);
    throw new Error(`openrouter ${r.status}: ${msg}`);
  }
  // Response: { data: [{ b64_json }] }. Some providers may return a data URL.
  const item = Array.isArray(j?.data) ? j.data[0] : null;
  let b64 = String(item?.b64_json ?? "");
  if (!b64 && typeof item?.url === "string" && item.url.startsWith("data:")) {
    b64 = item.url.slice(item.url.indexOf(",") + 1);
  }
  if (!b64) {
    track(env, uid, "ava_image_error", "avaai", { stage: "no_image", model, provider: "openrouter", resolution });
    emitReason(false, "openrouter returned no image");
    throw new Error("openrouter returned no image");
  }
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  emitReason(true, null);
  // [§46/§48] Best-effort real usage/cost off the SAME response — never
  // fabricated. Different OpenRouter image providers report this
  // differently (or not at all); read only what's actually present.
  const usage = j?.usage ?? {};
  const imageOutputTokens = typeof usage?.image_tokens === "number" ? usage.image_tokens
    : typeof usage?.completion_tokens === "number" ? usage.completion_tokens : undefined;
  const costUsd = typeof usage?.cost === "number" ? usage.cost : undefined;
  return { bytes, imageOutputTokens, costUsd, providerMs: Date.now() - t0, resolution };
}

// LEGACY sync-path storage: the PUBLIC blob bucket (same layout + CDN path as
// /upload/public), unchanged. Used ONLY by generateAvaImageSync() below (the
// ChatAVA companion path, which is intentionally NOT migrated onto the job/
// wallet system this wave — see that function's header note). The job-based
// path (fulfil(), below) uses storeImageArtifact() instead, which goes
// through the shared content-addressed artifact store and respects the
// required public/private sensitivity contract.
async function storePublicImage(env: Env, uid: string, bytes: Uint8Array): Promise<string> {
  const hash = await sha256Hex(bytes);
  const r2Key = `u/${uid}/public/${hash}`;
  const url = `${env.BLOSSOM_BASE_URL}/${r2Key}`;
  const mdb = mediaSession(env);
  const existing = await mdb.prepare("SELECT id FROM user_media WHERE key=?1").bind(r2Key).first<any>();
  if (!existing) {
    await env.BLOBS.put(r2Key, bytes, { httpMetadata: { contentType: "image/png" } });
    await mdb.prepare(
      `INSERT INTO user_media (id, uid, media_type, storage, visibility, encrypted, key, display_url, mime_type, size_bytes, original_app, created_at, moderation_status, category, file_name, source_kind)
       VALUES (?1,?2,'image','blossom','public',0,?3,?4,'image/png',?5,'avatok',?6,'live','image',?7,'sent')`,
    ).bind(crypto.randomUUID(), uid, r2Key, url, bytes.byteLength, Date.now(), `ava-image-${hash.slice(0, 8)}.png`).run();
  }
  return url;
}

// [AVA-IMAGE-UX-1 / §44] Job-based storage: delegates to media.ts's
// registerArtifactMedia — the ONE shared content-addressed-store +
// user_media-insert path every AI media artifact (image/doc/audio) now goes
// through. image_generate jobs never have a validated source_media_id (a bare
// prompt, or an edit_ref that is a public URL rather than a user_media id) —
// resolveArtifactSensitivity(env, null) always returns 'private', so a
// generated image always lands in the DIGITAL (private, presign-on-read)
// bucket. Do NOT force it public — that is the §44 contract M1 built
// ai_media_jobs.ts against.
async function storeImageArtifact(env: Env, uid: string, bytes: Uint8Array): Promise<{ id: string; url: string | null }> {
  const hash = await sha256Hex(bytes);
  const sensitivity = await resolveArtifactSensitivity(env, null);
  const r = await registerArtifactMedia(env, {
    uid, bytes, mimeType: "image/png", fileName: `ava-image-${hash.slice(0, 8)}.png`, category: "image", sensitivity,
  });
  return { id: r.id, url: r.url };
}

// [§46 error-code vocabulary] Maps a thrown Error to ONE of the SAFE,
// lower_snake_case codes app/lib/features/avatok/widgets/ai_media_job_card.dart's
// _friendlyError() recognises (provider_timeout, provider_unavailable,
// unsupported_format, input_too_large, insufficient_balance,
// cancelled_by_user) — never the raw provider message (§41/§42). A handler
// that wants a SPECIFIC code throws `new Error("<code>: detail")`
// (registerArtifactMedia's storage-quota check does this); anything else (a
// raw provider/network error) falls back to the generic
// 'provider_unavailable'. Duplicated (identically) in queues/ai_media.ts —
// no shared job-utils module in this wave's file ownership.
const KNOWN_JOB_ERROR_CODES = new Set([
  "provider_timeout", "provider_unavailable", "unsupported_format",
  "input_too_large", "insufficient_balance", "cancelled_by_user",
]);
function classifyImageJobError(e: unknown): string {
  const msg = String((e as any)?.message ?? e ?? "");
  const m = /^([a-z_]+):/.exec(msg);
  if (m && KNOWN_JOB_ERROR_CODES.has(m[1])) return m[1];
  if (/timeout|abort/i.test(msg)) return "provider_timeout";
  return "provider_unavailable";
}

// Do the heavy work: claim the job → generate → upload → complete the job →
// post the ava image message → (best-effort legacy) end the chip. Runs after
// the HTTP response has been sent (detached) so the request returns fast and
// the humans keep chatting; the image arrives in-thread when ready.
//
// [AVA-IMAGE-UX-1 / §44] This function (not queues/ai_media.ts's generic
// KIND_HANDLERS dispatcher) claims and completes the job directly, because
// the PROMPT — the one thing this function actually needs to do the work —
// must NEVER be persisted to the job row or a queue message (§41/§42
// privacy rule). It lives only in this call's arguments/closure. See
// queues/ai_media.ts's `handleImageGenerate` doc comment for the same note
// from the dispatcher side.
//
// [AVA-IMG-KEEPALIVE-1 / WS-3] This promise MUST be handed to the caller's
// lifetime source (detach(), above) — never fired as a bare `void`. On the
// HTTP path the runtime cancels un-registered work as soon as the Response is
// returned, which silently strands the job at 'running' forever.
//
// [AVA-IMG-PROGRESS-1 / WS-9] Also the measurement point: this is the only
// place that sees the whole path, so `end_to_end_ms` and its component parts
// (`time_to_placeholder_ms`, `gate_chain_ms`, `provider_ms`, `store_ms`,
// `settle_ms`) are emitted from here, on BOTH the success and failure paths.
interface FulfilArgs {
  env: Env;
  uid: string;
  conv: string;
  prompt: string;
  key: string;
  tier: TierId;
  jobId: string;
  statusId: string | undefined;
  editRef: string | undefined;
  priv: boolean;
  /** WS-10 groundwork: which rendition this call is producing. */
  genOptions: GenerateImageOptions;
  /** [AVA-VOICE-STYLE-1 / WS-14e] THE chip string for this request — the SAME
   *  one postChip() already sent as 'start'. Threaded through rather than
   *  re-derived so the 'end' envelope can never disagree with its own 'start'. */
  chipLabel: string;
  /** The (unawaited) chip fan-out. Awaited before endChip so an 'end' can
   *  never overtake its own 'start' — the one ordering hazard WS-8's
   *  fire-and-forget chip introduces. */
  chipPosted: Promise<void>;
  /** In-flight email lookup, started at the top of runAvaImage so it costs
   *  nothing on the gate chain. CLAUDE.md: every new telemetry event carries
   *  the user's email so a future pull can identify whose device this was. */
  emailP: Promise<string | null>;
  /** Timings measured by runAvaImage before this work started. */
  t0: number;
  timeToPlaceholderMs: number;
  gateChainMs: number;
}

async function fulfil(a: FulfilArgs): Promise<void> {
  const {
    env, uid, conv, prompt, key, tier, jobId, statusId, editRef, priv,
    genOptions, chipPosted, emailP, t0, timeToPlaceholderMs, gateChainMs, chipLabel,
  } = a;
  const endChipOnce = async () => {
    await chipPosted.catch(() => {});
    await endChip(env, uid, conv, statusId, priv, chipLabel).catch(() => {});
  };

  // Idempotent claim by job_id — a second concurrent trigger (there shouldn't
  // be one; kept for safety/symmetry with the queue-driven kinds) is a safe
  // no-op, never a double generation/double charge.
  const claimed = await claimAiMediaJob(env, jobId);
  if (!claimed.ok) { await endChipOnce(); return; }
  // Phase markers, NOT a percentage — no image provider reports a real
  // fraction. See updateAiMediaJobProgress() in lib/ai_media_jobs.ts for the
  // full reasoning and for why the client should render elapsed time.
  await updateAiMediaJobProgress(env, jobId, "claimed");

  let providerMs = 0;
  let storeMs = 0;
  let settleMs = 0;
  try {
    await updateAiMediaJobProgress(env, jobId, "provider_called");
    const gen = await generateImage(env, key, prompt, uid, editRef, genOptions);
    providerMs = gen.providerMs;
    await updateAiMediaJobProgress(env, jobId, "provider_returned");
    // OUTPUT-INTENT moderation: the prompt is llama-guarded BEFORE generation
    // (the gate in avaImage). Pixel-level scanning of the produced image is not
    // run inline here (we write the user_media row directly rather than through
    // /upload/public's async Workers-AI scan); the prompt guard is the
    // enforced gate. A follow-up could enqueue Q_MODERATION on the new r2_key.
    const tStore = Date.now();
    const stored = await storeImageArtifact(env, uid, gen.bytes);
    storeMs = Date.now() - tStore;
    await updateAiMediaJobProgress(env, jobId, "stored");
    // Consume ONE image from today's per-tier allowance only AFTER a successful
    // delivery, so a failed generation never burns the user's daily grant. The
    // global imageDailyCap counter is bumped the same way, for the same reason.
    await enforceAllowance(env, uid, tier, "image", 1, { commit: true }).catch(() => {});
    await bumpGlobalImageCount(env, uid).catch(() => {});

    const tSettle = Date.now();
    // [AVA-IMAGE-UX-1 / §44] Settle ONCE by job_id — completeAiMediaJob calls
    // ai_billing.ts's settleAiJob internally; this is the ONLY billing call
    // for this job (no second/duplicate settlement anywhere in this route).
    const completed = await completeAiMediaJob(env, {
      jobId,
      // [AVA-IMG-TIERS-1 / WS-10] rendition:'primary' — under the two-tier
      // flag this artifact is the fast PREVIEW; with the flag off it is simply
      // the image, at the unchanged 2K default. Either way it is the artifact
      // this job produced, and `resolution` records which it actually was, so
      // the two renditions are told apart by fact rather than by assumption.
      artifact: {
        mediaId: stored.id, mimeType: "image/png", fileName: `ava-image-${jobId.slice(0, 8)}.png`,
        rendition: "primary", resolution: gen.resolution,
      },
      settlement: {
        modelActual: imageModel(env),
        usage: { images: 1, imageOutputTokens: gen.imageOutputTokens },
        providerCostUsdMicro: gen.costUsd != null ? Math.round(gen.costUsd * 1_000_000) : undefined,
      },
    });

    const caption = editRef ? "Here's the edited image ✨" : "Here's your image ✨";
    // [B3 contract] The completed job's `artifact_url` is resolved FRESH by
    // completeAiMediaJob/fetchJob — a public CDN URL, or (the normal case for
    // image_generate: always PRIVATE, see storeImageArtifact) a freshly-minted
    // 900s presigned URL. Reuse THAT here as the legacy chat bubble's
    // media_ref, rather than re-deriving one, so the message renders
    // immediately for a pre-job-card client too. This is a best-effort
    // SECONDARY affordance (§44): the presigned link can go stale after 15
    // minutes in old chat history, but the job's own artifact_url (fetched via
    // GET /api/ai/jobs/:job_id, re-minted every read) is the durable,
    // authoritative way to open/download/share the result once a job-hydrated
    // client (M4) reads it.
    const mediaRef = completed.ok ? (completed.job.artifact_url ?? undefined) : undefined;
    // PRIVACY: private:true posts ONLY to the requester (kind ava_private, scope
    // to:<uid>) — a @ava image never reaches the other participant.
    await postAvaMessage(env, {
      ownerUid: uid, conv, text: caption, media_ref: mediaRef, source: "image", private: priv,
      meta: { job_id: jobId },
    });
    settleMs = Date.now() - tSettle;

    // [AVA-IMG-PROGRESS-1 / WS-9] THE end-to-end image latency metric — there
    // was none at all before this. AWAITED, not fire-and-forget: this file's
    // detached work is exactly the place where an unawaited telemetry send is
    // dropped by the runtime and the event silently "isn't in the taxonomy"
    // (memory: avatok-worker-error-path-telemetry-dropped). Carries the user's
    // email (CLAUDE.md) so a future PostHog pull can identify whose device a
    // slow/missing image was on.
    await trackUser(env, uid, await emailP, "ava_image_completed", "avaai", {
      ok: true, job_id: jobId, tier, edit: !!editRef, private: priv,
      resolution: gen.resolution, model: imageModel(env),
      bytes: gen.bytes.byteLength,
      time_to_placeholder_ms: timeToPlaceholderMs,
      gate_chain_ms: gateChainMs,
      provider_ms: providerMs,
      store_ms: storeMs,
      settle_ms: settleMs,
      end_to_end_ms: Date.now() - t0,
      posted: true,
      environment: environmentTag(env),
    }).catch(() => {});
  } catch (e: any) {
    // Never leak raw provider errors, and NEVER post an unrelated new chat
    // message on failure — update the SAME job to 'failed' (a job-hydrated
    // client renders the Retry state from error_code) and stop there. This is
    // the exact bug Part VI exists for: a later message wiping pending state.
    console.error("ava image generation failed:", String(e?.message ?? e));
    const cls = friendlyAiError(e);
    const errorCode = classifyImageJobError(e);
    await failAiMediaJob(env, { jobId, errorCode, reason: cls.kind }).catch(() => {});
    // AWAITED — see the success-path note above. This is precisely an
    // "early-return error path", the shape whose unawaited telemetry the
    // runtime drops.
    await trackUser(env, uid, await emailP, "ava_image_error", "avaai", {
      stage: "fulfil", reason: cls.kind, error_code: errorCode, tier,
      edit: !!editRef, private: priv, job_id: jobId,
      time_to_placeholder_ms: timeToPlaceholderMs,
      gate_chain_ms: gateChainMs,
      provider_ms: providerMs,
      store_ms: storeMs,
      end_to_end_ms: Date.now() - t0,
      environment: environmentTag(env),
      error: String(e?.message ?? e).slice(0, 200),
    }).catch(() => {});
  } finally {
    await endChipOnce();
  }
}

// Structured result so BOTH callers (the HTTP route and the @ava agent tool)
// share ONE gate + pipeline. `httpStatus` is what the HTTP route returns;
// `message` is the user-facing line the agent relays into chat on a block.
export type AvaImageResult = {
  ok: boolean;
  blocked?: boolean;
  reason?: string;
  message?: string;
  conv?: string;
  status_id?: string | null;
  /** [AVA-IMAGE-UX-1] The durable job id — the PRIMARY handle a job-hydrated
   *  client (AiMediaJobRepository/AiMediaJobCard, M4) reconciles against.
   *  Always set on a successful async start; null on any blocked/error
   *  result. Callers must return this to the user immediately — never make
   *  the caller (HTTP client or the @ava agent tool) wait for generation. */
  job_id?: string | null;
  async?: boolean;
  tier?: string;
  httpStatus: number;
};

// THE shared gate + async pipeline for in-thread image generation. Per-CALLER:
// every check and the coin spend key on [uid] (never the conversation), so in a
// group each member's own package/wallet is what's gated — one member exhausting
// their quota can't draw on another's, and the "unlimited" member only ever
// spends their own allowance. The image still posts into the shared `conv` for
// everyone to see; the cost/quota always lands on whoever invoked it.
export async function runAvaImage(
  env: Env,
  a: {
    uid: string; conv: string; prompt: string; editRef?: string; private?: boolean;
    req?: Request; body?: any;
    /** [AVA-IMG-KEEPALIVE-1 / WS-3] The CALLER's lifetime source for the
     *  detached generation work — an `ExecutionContext` on the HTTP path, a
     *  `DurableObjectState` on the agent path. See AvaImageKeepAlive above:
     *  these are NOT interchangeable and neither is inferable from inside this
     *  function, which is why it is an explicit parameter. Omitting it falls
     *  back to the old bare-`void` behaviour. */
    keepAlive?: AvaImageKeepAlive;
    /** [AVA-IMG-CHIP-EARLY-1 / WS-8] When a gate blocks AFTER the placeholder
     *  chip has already been posted, also post the human-readable reason into
     *  the thread, so the chip does not merely blink out with no explanation.
     *  DEFAULT false, on purpose: the agent lane (do/ava_agent.ts's onImage)
     *  already relays `message` back through the model into the same
     *  conversation, so posting here too would double up. The HTTP route
     *  (`avaImage`) sets it true — its `message` surfaces in the request
     *  sheet, not in the thread the chip lives in. */
    notifyBlockInThread?: boolean;
    /** WS-10 groundwork: rendition options for the provider call. */
    genOptions?: GenerateImageOptions;
    /** [AVA-VOICE-STYLE-1 / WS-14] The caller's ALREADY-RESOLVED Ava voice
     *  style. Optional, and the reason it exists is WS-8: the placeholder chip
     *  is deliberately the first thing this function does, so anything needed
     *  to LABEL it sits in front of the chip. The agent lane (do/ava_agent.ts)
     *  has already read the style for its own turn, so passing it here costs
     *  nothing and keeps the chip exactly as early as WS-8 made it. When it is
     *  absent (the HTTP route, which has no turn context) we pay one KV get —
     *  measured against the ~15 sequential round trips WS-8 moved the chip in
     *  front of, that is noise, and a chip in the wrong language is worse. */
    style?: AvaVoiceStyle;
  },
): Promise<AvaImageResult> {
  const t0 = Date.now();
  const { uid, conv } = a;
  const prompt = String(a.prompt ?? "").trim();
  // PRIVACY: @ava = private (only the requester sees the chip + image); #ava =
  // public (fans out to all members). Defaults to PRIVATE when unspecified so a
  // caller that forgets the flag can never accidentally leak into a shared chat.
  const priv = a.private !== false;
  // Resolved below, once the config has been read: under
  // `avaImageTwoTierEnabled` this becomes the small, fast PREVIEW tier. An
  // explicit caller-supplied genOptions always wins (nothing passes one today
  // — it exists so a future caller can pin a rendition deliberately).
  let genOptions = a.genOptions ?? {};

  // -------------------------------------------------------------------------
  // [AVA-IMG-CHIP-EARLY-1 / WS-8] THE PLACEHOLDER GOES FIRST — before the
  // config read, the moderation guard, the tier lookup, the allowance peek,
  // the global-cap read, the email lookup and createAiMediaJob(). Those are
  // roughly fifteen sequential round trips, and until this change the user
  // stared at a generic "Ava is working…" pill for all of them with no signal
  // that an IMAGE was on its way.
  //
  // Two things make this safe to do before the gates:
  //   1. The status id is minted HERE and passed into postChip(), so we never
  //      have to await the per-member fan-out to learn it (see postChip's
  //      comment). The fan-out is fired and left running.
  //   2. Every early return below goes through blockedResult(), which ends the
  //      chip. A chip must NEVER be able to orphan just because a gate said
  //      no — including the kill-switch gates, which now also flash a chip.
  //
  // `conv` is the one prerequisite: with no conversation there is nowhere to
  // put a chip, so that single check happens before it.
  // -------------------------------------------------------------------------
  const statusId = conv ? crypto.randomUUID() : undefined;
  // [AVA-VOICE-STYLE-1 / WS-14e] ONE chip string per request, resolved once and
  // reused for the 'start' (postChip), the durable job's `label`, and every
  // 'end' (endChip, via FulfilArgs.chipLabel and blockedResult below). Two
  // separate avaString() calls would be two separate strings the moment the
  // table or the user's style changes mid-flight — and a mismatched 'end' is a
  // chip the client can never close.
  const style: AvaVoiceStyle = a.style ?? await readVoiceStyle(env, uid);
  const chipLabel = avaString(a.editRef ? "chip_image_editing" : "chip_image_generating", style, prompt);
  const chipPosted: Promise<void> = statusId
    ? postChip(env, uid, conv, chipLabel, priv, statusId)
    : Promise.resolve();
  detach(env, a.keepAlive, chipPosted, "postChip", uid);
  const timeToPlaceholderMs = Date.now() - t0;

  // Email lookup started NOW, in parallel, rather than sitting in the gate
  // chain just above createAiMediaJob() where it used to be. It is needed by
  // every telemetry event below (CLAUDE.md: new telemetry carries the user's
  // email so a future pull can identify whose device the problem was on) and
  // by the job's billing linkage, and it never blocks anything again.
  const emailP: Promise<string | null> = emailFor(env, uid).catch(() => null);

  // Every blocked/failed exit routes through here: close the chip (after the
  // fan-out that started it, so 'end' can never overtake 'start'), optionally
  // explain in-thread, and emit AWAITED telemetry — an early-return error path
  // is exactly where the runtime drops an unawaited send and the event later
  // looks like it "isn't in the taxonomy" (memory:
  // avatok-worker-error-path-telemetry-dropped).
  const blockedResult = async (r: AvaImageResult): Promise<AvaImageResult> => {
    const gateChainMs = Date.now() - t0;
    if (statusId) {
      await chipPosted.catch(() => {});
      await endChip(env, uid, conv, statusId, priv, chipLabel).catch(() => {});
      if (a.notifyBlockInThread && r.message) {
        await postAvaMessage(env, {
          ownerUid: uid, conv, text: r.message, source: "image", private: priv,
        }).catch(() => {});
      }
    }
    await trackUser(env, uid, await emailP, "ava_image_blocked", "avaai", {
      reason: r.reason ?? null, blocked: !!r.blocked, http_status: r.httpStatus,
      tier: r.tier ?? null, edit: !!a.editRef, private: priv,
      chip_shown: !!statusId,
      time_to_placeholder_ms: timeToPlaceholderMs,
      gate_chain_ms: gateChainMs,
      end_to_end_ms: gateChainMs,
      environment: environmentTag(env),
    }).catch(() => {});
    return r;
  };

  if (!conv) return blockedResult({ ok: false, reason: "conv_required", message: "Missing conversation.", httpStatus: 400 });

  // Master kill-switches.
  const cfg = await readConfig(env);
  if (cfg.generativeEnabled === false) {
    return blockedResult({ ok: false, reason: "generative_disabled", message: "Image generation is currently turned off.", httpStatus: 503 });
  }
  if (cfg.aiEnabled === false) {
    return blockedResult({ ok: false, reason: "ai_disabled", message: "Ava is currently turned off.", httpStatus: 503 });
  }
  // [AVA-IMAGE-UX-1] THE DARK GATE — must run FIRST, before moderation, the
  // allowance peek, and (above all) before createAiMediaJob() below, which is
  // what actually reserves wallet spend. Mirrors routes/ai_media_jobs.ts's
  // aiMediaJobsCreate() gate exactly, so this route can never charge for a
  // feature the generic job API itself refuses to serve. Do not move this
  // below any check that can reserve money, and do not weaken it to a
  // warning — a dark feature must be structurally impossible to bill.
  if (!cfg.aiMediaJobsEnabled) {
    return blockedResult({ ok: false, reason: "ai_media_not_live", message: "Image generation is currently turned off.", httpStatus: 503 });
  }

  // -------------------------------------------------------------------------
  // [AVA-IMG-TIERS-1 / WS-10] THE SPEED LEVER. Generation was pinned at 2K
  // (10-25 s) and then displayed in a 240 px bubble — paying for roughly 70x
  // the pixels anyone actually looks at. Under the two-tier flag we generate
  // the PREVIEW at `imagePreviewResolutionTier` (default 1K) and produce the
  // full-resolution rendition only when someone taps download
  // (POST /api/ava/image/:job_id/upgrade, below).
  //
  // SHIPS DARK: `avaImageTwoTierEnabled` defaults false, so behaviour is
  // byte-for-byte unchanged (2K, single rendition) until the owner flips it.
  // A caller that pinned its own resolution keeps it.
  // -------------------------------------------------------------------------
  if (cfg.avaImageTwoTierEnabled === true && !genOptions.resolution) {
    genOptions = { ...genOptions, resolution: imageResolutionForTier(cfg.imagePreviewResolutionTier) };
  }
  if (!prompt) return blockedResult({ ok: false, reason: "prompt_required", message: "Tell me what to draw.", httpStatus: 400 });
  if (prompt.length > 2000) return blockedResult({ ok: false, reason: "prompt_too_long", message: "That prompt is too long.", httpStatus: 400 });

  // (2) Moderation on the prompt — refuse disallowed (deepfake/abuse, incl.
  // minors) BEFORE we generate. llama-guard via P2. NOTE: this is a NO-OP
  // whenever `cfg.aiContentModerationEnabled` is false (lib/ai_gate.ts
  // short-circuits to safe) — see the file header. [AVA-MOD-ON-1] turns it on
  // in prod. WS-8 moved the placeholder chip AHEAD of this check, so a refusal
  // now closes an already-visible chip rather than never showing one; that is
  // handled by blockedResult() and is the correct trade for showing the user
  // an image placeholder ~15 round trips sooner.
  const gin = await guardInput(env, prompt);
  if (!gin.ok) {
    return blockedResult({ ok: false, blocked: true, reason: gin.reason ?? "input_unsafe",
      message: "I can't create that image. Let's keep things safe — try a different idea.", httpStatus: 200 });
  }

  // SUBSCRIPTION ALLOWANCE GATE (Phase 1, per-caller): image generation is metered
  // per tier per UTC day. EVERY tier — including Free — gets a daily grant
  // (PLANS[tier].caps.image); image gen is NOT premium-only. When the grant is
  // spent we return an upgrade prompt (not a hard wall). We PEEK here (commit:false)
  // and only consume the unit after a successful delivery (in fulfil).
  const tier = await tierOf(env, uid);
  const allow = await enforceAllowance(env, uid, tier, "image", 1, { commit: false });
  if (!allow.allowed) {
    // AWAITED — early-return error path (see blockedResult's comment).
    await track(env, uid, "ava_image_capped", "avaai", { used: allow.used, cap: allow.cap, tier }).catch(() => {});
    const up = allow.upsell;
    const upCap = up ? PLANS[up.tier].caps.image : null;
    const upText = up
      ? ` Upgrade to ${PLANS[up.tier].name} ($${up.price_usd}/mo) for ${upCap === null ? "unlimited" : upCap} images a day.`
      : "";
    return blockedResult({
      ok: false, blocked: true, reason: "plan_limit", tier: PLANS[tier].key,
      message: `You've used all ${allow.cap} of today's AI images on your ${PLANS[tier].name} plan — it resets tomorrow.${upText}`,
      httpStatus: 200,
    });
  }

  // GLOBAL EMERGENCY CAP (imageDailyCap): a per-account/day backstop enforced ON
  // TOP OF the plan allowance above — including the unlimited/Max tier, which the
  // plan gate never counts. See checkGlobalImageCap for why this needs its own
  // counter rather than reusing the plan-tier "image" usage dim.
  const globalCap = await checkGlobalImageCap(env, uid, tier, cfg.imageDailyCap);
  if (globalCap.blocked) {
    return blockedResult({
      ok: false, blocked: true, reason: "global_cap", tier: PLANS[tier].key,
      message: "You've hit today's image-generation limit — it resets tomorrow.",
      httpStatus: 200,
    });
  }

  // Image gen runs on OpenRouter (xAI Grok) via our OPENROUTER_API_KEY.
  const key = (env as any).OPENROUTER_API_KEY as string | undefined;
  if (!key) return blockedResult({ ok: false, reason: "no_image_key", message: "Image generation is unavailable right now.", httpStatus: 503 });

  // [AVA-IMAGE-UX-1 / §44] Create the durable job FIRST — this (not the
  // legacy chip below) is the PRIMARY state mechanism a job-hydrated client
  // reconciles against, and it is what reserves the wallet spend (§41: never
  // call a paid provider before the reservation succeeds). sourceMediaId is
  // always null: a bare prompt (or an edit_ref, which is a public URL, not a
  // validated user_media id) has no source we can authorize — M1's
  // resolveArtifactSensitivity() defaults that to PRIVATE (DIGITAL bucket),
  // which is the correct, safe default for a Messenger-conversation artifact.
  // WS-8: the email lookup that used to sit here (one more round trip on the
  // gate chain, in front of the chip) was started at the top of this function
  // and is already in flight — this await is normally free.
  const email = await emailP;
  const created = await createAiMediaJob(env, {
    ownerUid: uid, convId: conv, kind: "image_generate",
    sourceMediaId: null,
    label: chipLabel,
    estimate: { images: 1 },
    email,
  });
  if (!created.ok) {
    // AWAITED — early-return error path (see blockedResult's comment).
    await trackUser(env, uid, email, "ava_image_error", "avaai", {
      stage: "reserve", reason: created.error, tier, edit: !!a.editRef, private: priv,
      time_to_placeholder_ms: timeToPlaceholderMs, gate_chain_ms: Date.now() - t0,
      environment: environmentTag(env),
    }).catch(() => {});
    if (created.error === "AI_INSUFFICIENT_TOKENS") {
      // [AVA-VOICE-STYLE-1 / WS-14e] The canonical out-of-tokens line. Unit is a
      // TOKEN and the symbol is ₹ — the string table says so; never "coin", never $.
      return blockedResult({ ok: false, blocked: true, reason: "insufficient_balance", tier: PLANS[tier].key,
        message: avaString("err_out_of_tokens", style, prompt), httpStatus: 200 });
    }
    return blockedResult({ ok: false, reason: created.error, message: avaString("err_image_start", style, prompt), httpStatus: created.status });
  }
  const jobId = created.job.job_id;

  // The whole gate chain, measured. This is the number WS-8 exists to make
  // invisible to the user (the chip is already on screen) and WS-9 exists to
  // make visible to us.
  const gateChainMs = Date.now() - t0;
  detach(env, a.keepAlive, trackUser(env, uid, email, "ava_image_request", "avaai", {
    edit: !!a.editRef, tier, private: priv, job_id: jobId,
    resolution: genOptions.resolution ?? DEFAULT_IMAGE_RESOLUTION,
    time_to_placeholder_ms: timeToPlaceholderMs,
    gate_chain_ms: gateChainMs,
    environment: environmentTag(env),
  }), "trackRequest", uid);

  // (4–6) heavy work runs detached — return now while the image is produced,
  // the job is completed, and the image is posted into the SAME conversation
  // when ready. The caller must NOT wait behind this: runAvaImage() returns
  // job_id immediately, below.
  //
  // [AVA-IMG-KEEPALIVE-1 / WS-3] detach(), NOT a bare `void`: on the HTTP path
  // the runtime cancels work it was never told about the moment the Response
  // is returned, which is very likely why images sometimes simply never
  // arrived. See AvaImageKeepAlive at the top of this file for why the two
  // call paths need different lifetime sources.
  detach(env, a.keepAlive, fulfil({
    env, uid, conv, prompt, key, tier, jobId, statusId, editRef: a.editRef, priv,
    genOptions, chipPosted, emailP, t0, timeToPlaceholderMs, gateChainMs, chipLabel,
  }), "fulfil", uid);

  return { ok: true, conv, job_id: jobId, status_id: statusId ?? null, async: true, tier: PLANS[tier].key, httpStatus: 200 };
}

// SYNCHRONOUS image generation for request/response surfaces (ChatAVA companion).
// Same gate as runAvaImage (kill-switches, moderation, per-tier daily allowance —
// Free 3/day, shared with Messenger), but instead of posting into a conv it RETURNS
// the public image URL so the caller can render it inline in its own reply. The
// allowance unit is consumed only on a successful generation.
//
// [AVA-IMAGE-UX-1 / §44] NOT MIGRATED onto the AiMediaJob/wallet path this
// wave, deliberately — flagging per the work order rather than half-migrating
// it. This path is a synchronous request/response call (it RETURNS a URL for
// the caller to render inline), while createAiMediaJob()/fulfil() is
// fundamentally asynchronous (job_id now, artifact later) — bridging that
// would mean either (a) blocking this request on the full job lifecycle
// (defeats the point of a sync path and risks the caller's own timeout), or
// (b) reworking the ChatAVA companion's response contract to poll a job,
// which is outside this file-pair's ownership (client changes) and this
// task's scope. Net effect, unchanged from before this wave: this path stays
// UNMETERED (no wallet reserve/settle, only the pre-existing per-tier daily
// allowance + the imageDailyCap circuit breaker below) and its output is
// always PUBLIC via the legacy storePublicImage() helper, not the private
// job-artifact path. A follow-up issue should either give ChatAVA a
// poll-friendly job flow or an explicit "sync-tier" wallet reservation.
export async function generateAvaImageSync(
  env: Env,
  a: { uid: string; prompt: string; editRef?: string },
): Promise<{ ok: boolean; url?: string; message?: string; blocked?: boolean }> {
  const { uid } = a;
  const prompt = String(a.prompt ?? "").trim();

  const cfg = await readConfig(env);
  if (cfg.generativeEnabled === false) return { ok: false, message: "Image generation is currently turned off." };
  if (cfg.aiEnabled === false) return { ok: false, message: "Ava is currently turned off." };
  if (!prompt) return { ok: false, message: "Tell me what to draw." };
  if (prompt.length > 2000) return { ok: false, message: "That prompt is too long." };

  const gin = await guardInput(env, prompt);
  if (!gin.ok) return { ok: false, blocked: true, message: "I can't create that image. Let's keep things safe — try a different idea." };

  const tier = await tierOf(env, uid);
  const allow = await enforceAllowance(env, uid, tier, "image", 1, { commit: false });
  if (!allow.allowed) {
    track(env, uid, "ava_image_capped", "avaai", { used: allow.used, cap: allow.cap, tier, surface: "chatava" });
    const up = allow.upsell;
    const upCap = up ? PLANS[up.tier].caps.image : null;
    const upText = up
      ? ` Upgrade to ${PLANS[up.tier].name} ($${up.price_usd}/mo) for ${upCap === null ? "unlimited" : upCap} images a day.`
      : "";
    return { ok: false, blocked: true, message: `You've used all ${allow.cap} of today's AI images on your ${PLANS[tier].name} plan — it resets tomorrow.${upText}` };
  }

  // GLOBAL EMERGENCY CAP (imageDailyCap) — same backstop as runAvaImage, in
  // addition to the plan allowance above; see checkGlobalImageCap.
  const globalCap = await checkGlobalImageCap(env, uid, tier, cfg.imageDailyCap);
  if (globalCap.blocked) {
    return { ok: false, blocked: true, message: "You've hit today's image-generation limit — it resets tomorrow." };
  }

  const key = (env as any).OPENROUTER_API_KEY as string | undefined;
  if (!key) return { ok: false, message: "Image generation is unavailable right now." };

  try {
    const gen = await generateImage(env, key, prompt, uid, a.editRef);
    const url = await storePublicImage(env, uid, gen.bytes);
    // Consume ONE image from the per-tier allowance AND the global cap counter,
    // same rationale as fulfil(): only after a successful delivery.
    await enforceAllowance(env, uid, tier, "image", 1, { commit: true }).catch(() => {});
    await bumpGlobalImageCount(env, uid).catch(() => {});
    track(env, uid, "ava_image_request", "avaai", { edit: !!a.editRef, tier, surface: "chatava", sync: true });
    return { ok: true, url };
  } catch (e: any) {
    const cls = friendlyAiError(e);
    track(env, uid, "ava_image_error", "avaai", {
      stage: "sync", reason: cls.kind, tier, surface: "chatava",
      error: String(e?.message ?? e).slice(0, 200),
    });
    return {
      ok: false,
      message: cls.kind === "quota"
        ? "Ava's image service is at capacity right now — please try again in a few minutes."
        : "I couldn't create that image just now — please try again in a moment.",
    };
  }
}

// ---- POST /api/ava/image ----------------------------------------------------
// [AVA-IMG-KEEPALIVE-1 / WS-3] `exeCtx` is the Worker's ExecutionContext,
// threaded in from worker/src/index.ts. It is what keeps the detached
// generation alive past this Response — without it the runtime is free to
// cancel fulfil() mid-flight and the job never finishes. Optional only so an
// older/other caller can't break; index.ts always passes it.
export async function avaImage(req: Request, env: Env, exeCtx?: ExecutionContext): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  let b: any;
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  const conv = String(b.conv ?? "").trim();
  const prompt = String(b.prompt ?? "").trim();
  const editRef = b.edit && b.edit.media_ref ? String(b.edit.media_ref) : undefined;

  // PRIVACY: honour the body's `private` flag; default to PRIVATE (only the
  // requester) when unspecified so the sheet/tool can never leak into a shared chat.
  // notifyBlockInThread: this surface shows `message` in the request SHEET, not
  // in the conversation the placeholder chip lives in, so a blocked gate must
  // also explain itself in-thread or the chip just blinks out (WS-8).
  const r = await runAvaImage(env, {
    uid: ctx.uid, conv, prompt, editRef, private: b.private !== false, req, body: b,
    keepAlive: exeCtx, notifyBlockInThread: true,
  });
  // Preserve the route's historical response shapes: hard errors → {error};
  // soft blocks / upsell / success → the structured body at 200.
  if (!r.ok && (r.httpStatus === 400 || r.httpStatus === 503)) {
    return json({ error: r.message, reason: r.reason }, r.httpStatus);
  }
  if (!r.ok) {
    return json({ ok: false, blocked: !!r.blocked, reason: r.reason, message: r.message, answer: r.message }, r.httpStatus);
  }
  // [AVA-IMAGE-UX-1] job_id is the PRIMARY handle the client now hydrates
  // against; status_id (the legacy chip) stays for a pre-job-card build only.
  return json({ ok: true, conv: r.conv, job_id: r.job_id ?? null, status_id: r.status_id ?? null, async: true, tier: r.tier }, r.httpStatus);
}
