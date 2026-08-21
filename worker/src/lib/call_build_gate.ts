// call_build_gate.ts — [STREAM-AUTH-1 2026-08-21]
//
// The "update required" build floor, extracted from routes/api.ts `call()` so
// the legacy Cloudflare dial and the new Stream authorisation endpoint
// (routes/stream_video_calls.ts `streamCallPlace`) read the SAME number from
// the SAME header and cannot drift apart.
//
// Spec: Specs/PLAN-STREAM-ONLY-CALLS-2026-08-21.md §2.1 option C + owner
// decision 4b.2 (hard cutover, Worker-side refusal, no Cloudflare media path).
//
// INERT BY DEFAULT. `callMinBuild` is 0 in routes/config.ts DEFAULTS, and
// [callMinBuildFrom] normalises anything non-positive or unparseable to 0,
// which every caller treats as "gate disabled". Nothing changes until the
// owner arms it in KV — and per plan §7 it must NOT be armed until shipped
// clients actually send `x-app-build` (blocker §8.6).
//
// These are pure functions on purpose: no env, no I/O, no telemetry. The two
// call sites keep their own (different) telemetry and their own (different)
// refusal bodies — only the arithmetic is shared.

/** The header a cutover client sends. Body `app_build` is the fallback. */
export const APP_BUILD_HEADER = "x-app-build";

/**
 * The armed build floor, or 0 when the gate is disabled.
 *
 * Matches the original inline behaviour in api.ts exactly: a missing key, a
 * non-numeric value, NaN/Infinity and any value <= 0 all disable the gate.
 */
export function callMinBuildFrom(
  config: { callMinBuild?: number } | null | undefined,
): number {
  const value = Number(config?.callMinBuild ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The build the client CLAIMS to be running.
 *
 * `x-app-build` wins; a body field is accepted as a fallback for a client that
 * cannot easily set a header. Absent or unparseable → 0, i.e. "did not tell
 * us", which is what every pre-cutover build does (the header is introduced BY
 * the cutover build).
 */
export function clientBuildFrom(headerValue: string | null, bodyValue?: unknown): number {
  const headerBuild = Number.parseInt(headerValue ?? "", 10);
  if (Number.isFinite(headerBuild) && headerBuild > 0) return headerBuild;
  const bodyBuild = Number.parseInt(String(bodyValue ?? ""), 10);
  return Number.isFinite(bodyBuild) && bodyBuild > 0 ? bodyBuild : 0;
}

/** The one sentence a refused caller is shown, on either lane. */
export const UPDATE_REQUIRED_MESSAGE =
  "Update AvaTOK to make calls. This version can no longer place calls.";
