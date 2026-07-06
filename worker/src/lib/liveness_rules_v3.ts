// Liveness V3 — deterministic rules engine (Trust Engine "no single AI decides"
// + LLM-free invariant; LIVENESS-V3 plan §2/§4-A.3). Pure functions over the
// normalized provider signals (worker/src/lib/liveness_provider.ts) plus the math
// motion/sequence checks. Every rule emits a machine-readable REASON CODE on both
// PASS and FAIL, and the whole ruleset is stamped with a version constant so any
// verdict is reproducible ("why did this pass in March?" — Sentinel provenance).
//
// NOTHING in this file calls a provider, a queue, or an LLM. It takes already-
// normalized frames + session facts and returns a verdict + reason codes +
// per-rule pass map. The caller (routes/liveness_v3.ts) owns all IO.
import type { NormalizedFace } from "./liveness_provider";

// Bump on ANY threshold/logic change. Old verdicts keep their stamped version so
// they remain explainable after this constant moves forward.
export const LIVENESS_RULESET_V3_0 = "LIVENESS_RULESET_V3_0";

// V3_1 (2026-07-06): adds the AI-avatar / second-phone / injected-camera defense
// layer (lib/liveness_avatar_defense.ts). Its weighted suspicion signals fold in
// via the caller as REVIEW-class / informational reason codes — the core rules
// engine below is UNCHANGED. Verdicts stamped with whichever ruleset was live.
export const LIVENESS_RULESET_V3_1 = "LIVENESS_RULESET_V3_1";

// Machine-readable reason codes (LIVENESS-V3 plan §4-A.3). Every verdict lists
// the codes that fired; PASS verdicts carry the positive/`OK` codes so analytics
// and appeals can group on either outcome.
export type ReasonCode =
  | "FACE_NOT_FOUND"
  | "MULTIPLE_PEOPLE"
  | "FACE_TOO_SMALL"
  | "LOW_BRIGHTNESS"
  | "BLUR"
  | "PHONE_SCREEN"
  | "REPLAY_ATTACK"
  | "SEQUENCE_MISMATCH"
  | "EXTRACTION_FAILED"
  | "ATTESTATION_FAIL"
  | "MOTION_IMPLAUSIBLE"
  | "PROVIDER_DEGRADED"
  // AI-avatar / second-phone / injected-camera defense layer (ruleset V3_1).
  // ALL of these are REVIEW-class or informational — NONE are FAIL-class. They
  // are emitted by lib/liveness_avatar_defense.ts and merged by the caller; a
  // high combined suspicion escalates to REVIEW (or policy escalation), never a
  // standalone automatic FAIL.
  | "DISPLAY_SUSPECTED"          // weighted display-attack suspicion ≥ threshold
  | "FLASH_MISMATCH"            // face didn't brighten to the screen flash sequence
  | "SENSOR_MISMATCH"          // bbox grew but the device never moved (flat rig)
  | "CAMERA_PATH_COMPROMISED"  // rooted/emulator/virtual-camera/instrumentation
  | "TIMING_ANOMALY"           // implausibly instant / machine-uniform reactions
  | "DEVICE_CONTEXT_CHANGED"   // informational: new device + new country (Trust Engine consumes)
  | "OK";

export type Verdict = "PASS" | "REVIEW" | "FAIL";

// Rule ids in the per-rule pass map (stable keys for analytics/appeals). Each maps
// to the reason code emitted when it FAILS.
export interface RulePass { id: string; pass: boolean; reason?: ReasonCode; detail?: string; }

export interface RuleThresholds {
  minConfidence: number;   // face confidence floor (0..100)
  minSharpness: number;    // below → BLUR
  minBrightness: number;   // below → LOW_BRIGHTNESS
  minFaceArea: number;     // primary face box area fraction (w*h) floor → FACE_TOO_SMALL
  maxFaces: number;        // above → MULTIPLE_PEOPLE
}

// Launch thresholds (config-tunable later per Trust Engine §11; kept here as the
// versioned default that ships with LIVENESS_RULESET_V3_0).
export const DEFAULT_THRESHOLDS: RuleThresholds = {
  minConfidence: 92,
  minSharpness: 25,
  minBrightness: 25,
  minFaceArea: 0.06, // ~ a face filling >6% of the frame area (head-and-neck close-up)
  maxFaces: 1,
};

export interface FrameEvidence {
  normalized: NormalizedFace;
  degraded: boolean; // true when this frame was scored by the Workers AI fallback
}

export interface RulesInput {
  frames: FrameEvidence[];               // sampled, in capture order (early→close)
  // Anti-spoof / integrity facts computed by the caller (IO side):
  replayHashSeen: boolean;               // content-hash dedupe hit → REPLAY_ATTACK
  extractionFailed: boolean;             // decode/frame-extract failure → EXTRACTION_FAILED (REVIEW)
  attestationOk: boolean | null;         // Play Integrity/App Attest; null = not evaluated (dark)
  sequenceMatched: boolean | null;       // client-reported challenge order matched nonce; null = not evaluated
  sameFaceOk: boolean | null;            // CompareFaces across frames + vs existing proof; null = skipped
  motionMonotonicOk: boolean | null;     // face box growth plausible across approach; null = skipped
  anyProviderDegraded: boolean;          // any frame scored by Workers AI fallback (breaker open)
  thresholds?: RuleThresholds;
}

export interface RulesVerdict {
  verdict: Verdict;
  reason_codes: ReasonCode[];
  rule_pass_map: RulePass[];
  ruleset_version: string;
}

const uniq = (a: ReasonCode[]): ReasonCode[] => [...new Set(a)];

/**
 * Evaluate the full V3 ruleset. Deterministic; never throws. Returns the verdict,
 * the ordered reason codes, the per-rule pass map, and the ruleset version.
 *
 * Verdict policy (aligned with Trust Engine breaker rule — NEVER FAIL on our
 * infrastructure problems):
 *   - Hard spoof/quality failures → FAIL.
 *   - Idempotency replay → FAIL (REPLAY_ATTACK) — cheap, no provider spend.
 *   - Extraction failure / provider degraded / unresolved checks → REVIEW.
 *   - All required rules pass → PASS.
 */
export function evaluateV3(input: RulesInput): RulesVerdict {
  const t = input.thresholds ?? DEFAULT_THRESHOLDS;
  const map: RulePass[] = [];
  const codes: ReasonCode[] = [];
  const add = (id: string, pass: boolean, reason: ReasonCode, detail?: string) => {
    map.push({ id, pass, reason: pass ? "OK" : reason, detail });
    if (!pass) codes.push(reason);
  };

  // ── 0. Replay dedupe (cheapest, no provider spend) → hard FAIL. ─────────────
  if (input.replayHashSeen) {
    map.push({ id: "replay_dedupe", pass: false, reason: "REPLAY_ATTACK" });
    return {
      verdict: "FAIL",
      reason_codes: ["REPLAY_ATTACK"],
      rule_pass_map: map,
      ruleset_version: LIVENESS_RULESET_V3_0,
    };
  }
  map.push({ id: "replay_dedupe", pass: true, reason: "OK" });

  // ── 1. Extraction / poison-pill → REVIEW (never FAIL on decode failure). ─────
  if (input.extractionFailed) {
    map.push({ id: "frame_extraction", pass: false, reason: "EXTRACTION_FAILED" });
    return {
      verdict: "REVIEW",
      reason_codes: ["EXTRACTION_FAILED"],
      rule_pass_map: map,
      ruleset_version: LIVENESS_RULESET_V3_0,
    };
  }
  map.push({ id: "frame_extraction", pass: true, reason: "OK" });

  // ── 2. Attestation (dark until wired: null = not evaluated, treated as pass). ─
  if (input.attestationOk === false) {
    add("attestation", false, "ATTESTATION_FAIL");
  } else {
    map.push({ id: "attestation", pass: true, reason: "OK" });
  }

  const frames = input.frames ?? [];
  // Use the sharpest non-degraded frame as the primary reference for face rules;
  // fall back to the first frame if all are degraded.
  const measured = frames.filter((f) => !f.degraded && f.normalized.sharpness >= 0);
  const ref = (measured[0] ?? frames[0])?.normalized;

  // ── 3. Face present. ────────────────────────────────────────────────────────
  const faceFound = !!ref && ref.face_found && ref.confidence >= t.minConfidence;
  add("face_found", faceFound, "FACE_NOT_FOUND",
    ref ? `confidence=${ref.confidence}` : "no_frames");

  // ── 4. Exactly one person (max across all measured frames). ─────────────────
  const maxFaces = frames.reduce((m, f) => Math.max(m, f.normalized.face_count), 0);
  add("single_person", maxFaces <= t.maxFaces, "MULTIPLE_PEOPLE", `max_faces=${maxFaces}`);

  // The remaining quality rules only make sense on a MEASURED (non-degraded)
  // reference. If we only have degraded frames, skip them (do NOT fail) and let
  // the degraded-provider branch push to REVIEW below.
  const canMeasure = !!ref && !frames.every((f) => f.degraded) && ref.sharpness >= 0;

  if (canMeasure) {
    // ── 5. Face size (close-up geometry). ─────────────────────────────────────
    const area = ref.box.width * ref.box.height;
    add("face_size", area >= t.minFaceArea, "FACE_TOO_SMALL", `area=${area.toFixed(4)}`);

    // ── 6. Brightness. ────────────────────────────────────────────────────────
    add("brightness", ref.brightness >= t.minBrightness, "LOW_BRIGHTNESS", `b=${ref.brightness}`);

    // ── 7. Blur / sharpness. ──────────────────────────────────────────────────
    add("sharpness", ref.sharpness >= t.minSharpness, "BLUR", `s=${ref.sharpness}`);

    // ── 8. Phone-screen / print (screen-replay tell). ─────────────────────────
    const screenSuspect = frames.some((f) => f.normalized.spoof_signals.flat_suspect);
    add("phone_screen", !screenSuspect, "PHONE_SCREEN");
  } else {
    // No measurable frame — record neutral (pass) rows so the map is complete;
    // the degraded branch forces REVIEW.
    map.push({ id: "face_size", pass: true, reason: "OK", detail: "degraded_skip" });
    map.push({ id: "brightness", pass: true, reason: "OK", detail: "degraded_skip" });
    map.push({ id: "sharpness", pass: true, reason: "OK", detail: "degraded_skip" });
    map.push({ id: "phone_screen", pass: true, reason: "OK", detail: "degraded_skip" });
  }

  // ── 9. Challenge sequence (null = not evaluated → pass). ────────────────────
  if (input.sequenceMatched === false) {
    add("challenge_sequence", false, "SEQUENCE_MISMATCH");
  } else {
    map.push({ id: "challenge_sequence", pass: true, reason: "OK" });
  }

  // ── 10. Face consistency (null = skipped → pass; false = fail). ─────────────
  if (input.sameFaceOk === false) {
    add("face_consistency", false, "MULTIPLE_PEOPLE", "compare_faces_mismatch");
  } else {
    map.push({ id: "face_consistency", pass: true, reason: "OK" });
  }

  // ── 11. Motion plausibility (null = skipped → pass; false = fail). ──────────
  if (input.motionMonotonicOk === false) {
    add("motion_consistency", false, "MOTION_IMPLAUSIBLE");
  } else {
    map.push({ id: "motion_consistency", pass: true, reason: "OK" });
  }

  // ── Verdict ────────────────────────────────────────────────────────────────
  const hardFail = codes.length > 0;
  // Provider degraded (breaker open) OR we couldn't measure quality → REVIEW,
  // never FAIL (Trust Engine §6). This only applies when nothing HARD failed.
  const mustReview = input.anyProviderDegraded || !canMeasure;

  let verdict: Verdict;
  if (hardFail) {
    verdict = "FAIL";
  } else if (mustReview) {
    verdict = "REVIEW";
    codes.push("PROVIDER_DEGRADED");
    map.push({ id: "provider_health", pass: false, reason: "PROVIDER_DEGRADED" });
  } else {
    verdict = "PASS";
    codes.push("OK");
    map.push({ id: "provider_health", pass: true, reason: "OK" });
  }

  return {
    verdict,
    reason_codes: uniq(codes),
    rule_pass_map: map,
    ruleset_version: LIVENESS_RULESET_V3_0,
  };
}

/**
 * Motion consistency (pure math): as the phone approaches the face during the
 * capture, the primary face bounding-box AREA must grow in a physically
 * plausible, roughly-monotonic way. We tolerate small dips (hand shake) but
 * reject a flat/paper-mask sequence (no growth) or an impossible shrink-then-jump.
 *
 * Returns null when there are too few measured frames to judge (caller passes
 * null → the rule is skipped, never a fail).
 */
export function motionMonotonic(frames: FrameEvidence[]): boolean | null {
  const areas = frames
    .filter((f) => !f.degraded && f.normalized.box.width > 0 && f.normalized.box.height > 0)
    .map((f) => f.normalized.box.width * f.normalized.box.height);
  if (areas.length < 3) return null;
  const first = areas[0];
  const last = areas[areas.length - 1];
  // Require net growth of at least 15% from first to last approach frame.
  if (last < first * 1.15) return false;
  // No single step may collapse to less than 70% of the running max (a hard
  // shrink mid-approach is implausible for a smooth walk-in / lean-in).
  let runMax = areas[0];
  for (const a of areas) {
    if (a < runMax * 0.7) return false;
    runMax = Math.max(runMax, a);
  }
  return true;
}
