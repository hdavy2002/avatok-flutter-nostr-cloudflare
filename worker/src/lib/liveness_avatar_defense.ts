// Liveness V3 — AI-avatar / second-phone / injected-camera defense layer
// (LIVENESS-V3 plan §0-C, added 2026-07-06; owner-ratified security review).
//
// PHILOSOPHY (obey strictly — this file must NOT drift from it):
//   - Suspicion SIGNALS accumulate. No single display/forensic heuristic is a
//     standalone pass/fail rule. A high COMBINED score → REVIEW (or policy
//     escalation), NEVER an automatic FAIL. (Trust Engine breaker rule: never
//     FAIL a real user on a fragile forensic guess.)
//   - Feature EXTRACTORS produce NUMBERS; versioned WEIGHTS/THRESHOLDS combine
//     them. Recalibrating = editing DISPLAY_WEIGHTS_V1 / the thresholds here,
//     never rewriting the architecture. Ruleset stamp bumps to V3_1.
//   - Deterministic only. NO LLM anywhere (Trust Engine invariant).
//   - REJECTED (do NOT build): PRNU sensor fingerprinting, rolling-shutter
//     analysis, frequency-domain / FFT forensics — flagged fragile &
//     false-positive-prone in the review (plan §4-A Tier C).
//
// This module is PURE math over the normalized frames (liveness_provider.ts) and
// the client-reported `capture_meta` (sensor/luma/flash/vibrate timelines +
// device integrity). The caller (routes/liveness_v3.ts) owns all IO and folds the
// outputs into the deterministic verdict. Every extractor that cannot yet be
// computed returns `null` (documented in EXTRACTOR_TODOS) — the scoring framework
// still runs on whatever IS present.
import type { FrameEvidence } from "./liveness_rules_v3";

// ── Active-checks contract (server-randomized per session; SHARED with client) ──
export type FlashColor = "white" | "red" | "blue";
export interface FlashStep { color: FlashColor; t_offset_ms: number; duration_ms: number; }
export interface ActiveChecks {
  flash_sequence: FlashStep[];              // 2–4 flashes, random colors/timings
  vibrate: { t_offset_ms: number; duration_ms: number } | null;
  challenge_gaps_ms: number[];              // random 700–1900 per challenge
}

// ── capture_meta contract (optional verify-body payload; SHARED with client) ────
export interface SensorSample { t: number; ax: number; ay: number; az: number; gx?: number; gy?: number; gz?: number; }
export interface LumaSample { t: number; luma: number; }
export interface FlashEvent { color: FlashColor; t_actual_ms: number; }
export interface CaptureIntegrity {
  rooted: boolean | null;
  emulator: boolean | null;
  virtual_camera: boolean | null;
  instrumentation: boolean | null;
  play_integrity: string | null;
}
export interface CaptureCamera { model: string; resolution: string; fps: number; }
export interface CaptureMeta {
  sensor_timeline: SensorSample[];          // downsampled ≤50 samples
  luma_timeline: LumaSample[];              // mean frame luminance ≤60 samples
  flash_events: FlashEvent[];
  vibrate_event: { t_actual_ms: number } | null;
  integrity: CaptureIntegrity;
  camera: CaptureCamera;
}

// Size cap for the stored capture_meta (plan §0-C). ~32KB — the caller rejects
// larger bodies politely before this module ever sees them.
export const MAX_CAPTURE_META_BYTES = 32_768;

// Downsample caps (defensive — the caller also truncates on parse).
export const MAX_SENSOR_SAMPLES = 50;
export const MAX_LUMA_SAMPLES = 60;

// ═══════════════════════════════════════════════════════════════════════════
//  Versioned weights & thresholds (recalibrate HERE, never rewrite the code).
// ═══════════════════════════════════════════════════════════════════════════

/** Display-suspicion signal weights (plan §0-C). Combined ≥ DISPLAY_REVIEW_THRESHOLD
 *  → DISPLAY_SUSPECTED → REVIEW (never FAIL). Bump DISPLAY_WEIGHTS_VERSION on change. */
export const DISPLAY_WEIGHTS_VERSION = "DISPLAY_WEIGHTS_V1";
export const DISPLAY_WEIGHTS = {
  horizontal_banding: 20,   // scan-line banding of a screen photographed off a screen
  moire: 15,                // moiré interference pattern (screen pixel grid)
  pwm_flicker: 20,          // PWM backlight flicker 50–240Hz aliasing in luma_timeline
  rgb_subpixel: 25,         // RGB sub-pixel structure visible (very close screen shot)
  flat_depth: 30,           // flat 2D depth (no parallax / uniform focus) — strongest tell
  display_reflection: 10,   // specular reflection band of a glossy panel
} as const;
export type DisplaySignal = keyof typeof DISPLAY_WEIGHTS;

/** Combined display-suspicion score at/above which we emit DISPLAY_SUSPECTED → REVIEW. */
export const DISPLAY_REVIEW_THRESHOLD = 60;

/** Sensor-motion correlation thresholds. During bbox growth (an approach/lean-in),
 *  a real handheld device shows non-trivial accel ENERGY; a static injected feed
 *  is flat. Below LOW → sensor_mismatch signal. */
export const SENSOR_THRESHOLDS = {
  minAccelEnergy: 0.015,    // m/s² variance floor over the growth window (flat rig ≈ 0)
  minSamples: 6,            // too few samples to judge → score null (skip, never fail)
} as const;

/** Flash-response latency window: a real face lit by the screen brightens within
 *  this latency and decays. Outside → weak/absent correlation. */
export const FLASH_THRESHOLDS = {
  maxLatencyMs: 300,        // plausible screen-lit brightening latency
  minRise: 2.0,             // min luma delta (0..100 scale) counted as a real rise
} as const;

/** Timing plausibility: a human reaction faster than this is implausibly instant
 *  (bot/replay driving the flow); dead-uniform gaps are also suspicious. */
export const TIMING_THRESHOLDS = {
  minReactionMs: 200,       // < this actual-vs-scheduled offset = implausibly instant
  uniformEpsilonMs: 5,      // gaps identical to within this = machine-uniform
} as const;

// ═══════════════════════════════════════════════════════════════════════════
//  Output shape folded back into the verdict by the caller.
// ═══════════════════════════════════════════════════════════════════════════
export interface AvatarDefenseSignals {
  // 0..100 or null when uncomputable (missing/degraded data → null, NOT a penalty).
  flash_correlation_score: number | null;
  sensor_correlation_score: number | null;
  display_suspicion_score: number | null;
  // Per-signal display breakdown (value 0..1 strength, weight, contribution). null
  // entries are documented extractor TODOs — present so the framework is auditable.
  display_signals: Array<{ signal: DisplaySignal; value: number | null; weight: number; contribution: number }>;
  // Camera-path integrity summary (client-reported; verbatim play_integrity).
  camera_path: {
    rooted: boolean | null; emulator: boolean | null; virtual_camera: boolean | null;
    instrumentation: boolean | null; play_integrity: string | null; compromised: boolean;
  };
  timing_anomaly: boolean;
  // Reason codes to merge into the verdict (all REVIEW-class or informational).
  review_codes: string[];        // DISPLAY_SUSPECTED | FLASH_MISMATCH | SENSOR_MISMATCH | CAMERA_PATH_COMPROMISED | TIMING_ANOMALY
  // Policy-escalation flag: a hard camera-path compromise should escalate policy
  // (the Trust Engine/Policy Engine decides what escalation means — we only flag).
  policy_escalation: boolean;
  weights_version: string;
}

// ── Small deterministic math helpers (no deps). ────────────────────────────────
function mean(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return mean(xs.map((x) => (x - m) * (x - m)));
}
function clamp(x: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, x)); }

// ═══════════════════════════════════════════════════════════════════════════
//  1. FLASH RESPONSE CHECK
//  During each scheduled flash window (active_checks.flash_sequence vs the actual
//  flash_events), the luma_timeline should show a correlated brightness RISE with
//  plausible latency (<300ms) then a decay — a real face lit by the phone screen
//  brightens. Score 0..100 = fraction of flashes that produced a plausible rise,
//  scaled. Missing/degraded data → null (contributes to REVIEW only under strict
//  policy; never a FAIL).
// ═══════════════════════════════════════════════════════════════════════════
export function flashCorrelationScore(
  active: ActiveChecks | null, meta: CaptureMeta | null,
): number | null {
  const luma = meta?.luma_timeline;
  const flashes = meta?.flash_events;
  if (!active?.flash_sequence?.length || !luma || luma.length < 3 || !flashes?.length) return null;
  const sorted = [...luma].sort((a, b) => a.t - b.t);
  const lumaAt = (t: number): number | null => {
    // nearest sample within a small window; null if the timeline doesn't cover t.
    let best: LumaSample | null = null; let bestD = Infinity;
    for (const s of sorted) { const d = Math.abs(s.t - t); if (d < bestD) { bestD = d; best = s; } }
    return best && bestD <= 500 ? best.luma : null;
  };
  let plausible = 0; let judged = 0;
  for (const fe of flashes) {
    const t0 = fe.t_actual_ms;
    const base = lumaAt(t0 - 60);                 // luma just before the flash
    // peak within the plausible screen-lit latency window
    const window = sorted.filter((s) => s.t >= t0 && s.t <= t0 + FLASH_THRESHOLDS.maxLatencyMs);
    if (base == null || window.length === 0) continue;
    judged++;
    const peak = Math.max(...window.map((s) => s.luma));
    const rise = peak - base;
    // require a real rise AND a subsequent decay toward baseline (light removed).
    const afterWindow = sorted.filter((s) => s.t > t0 + FLASH_THRESHOLDS.maxLatencyMs && s.t <= t0 + 800);
    const decays = afterWindow.length === 0 || Math.min(...afterWindow.map((s) => s.luma)) < peak - FLASH_THRESHOLDS.minRise / 2;
    if (rise >= FLASH_THRESHOLDS.minRise && decays) plausible++;
  }
  if (judged === 0) return null;
  return Math.round((plausible / judged) * 100);
}

// ═══════════════════════════════════════════════════════════════════════════
//  2. SENSOR-MOTION CORRELATION
//  During the approach (face bbox GROWTH across sampled frames), sensor_timeline
//  should show non-trivial device motion. bbox grows while the accelerometer is
//  flat → sensor_mismatch. Score 0..100 from accel ENERGY (variance) over the
//  growth window vs SENSOR_THRESHOLDS. null when too few samples to judge.
// ═══════════════════════════════════════════════════════════════════════════
export function sensorCorrelationScore(
  frames: FrameEvidence[], meta: CaptureMeta | null,
): { score: number | null; mismatch: boolean } {
  const sensor = meta?.sensor_timeline;
  if (!sensor || sensor.length < SENSOR_THRESHOLDS.minSamples) return { score: null, mismatch: false };
  // Detect whether the face bbox actually grew (an approach happened). If it never
  // grew, there is nothing to correlate against — return null (skip, never fail).
  const areas = frames
    .filter((f) => !f.degraded && f.normalized.box.width > 0 && f.normalized.box.height > 0)
    .map((f) => f.normalized.box.width * f.normalized.box.height);
  const grew = areas.length >= 3 && areas[areas.length - 1] >= areas[0] * 1.15;
  if (!grew) return { score: null, mismatch: false };
  // Accel energy = combined variance of ax/ay/az over the whole (downsampled) window.
  const energy = variance(sensor.map((s) => s.ax)) + variance(sensor.map((s) => s.ay)) + variance(sensor.map((s) => s.az));
  // Map energy → 0..100 (linear up to ~4× the floor, then saturate).
  const score = Math.round(clamp(energy / (SENSOR_THRESHOLDS.minAccelEnergy * 4), 0, 1) * 100);
  const mismatch = energy < SENSOR_THRESHOLDS.minAccelEnergy;
  return { score, mismatch };
}

// ═══════════════════════════════════════════════════════════════════════════
//  3. DISPLAY SUSPICION SCORE (weighted, versioned)
//  Combine whatever display-attack signals are computable from: normalized
//  Rekognition frame data (sharpness/brightness dynamics) + luma_timeline
//  periodicity (PWM flicker) + inter-frame brightness dynamics. Uncomputable
//  signals return null and are documented extractor TODOs — the framework still
//  runs on the present ones. Score ≥60 → DISPLAY_SUSPECTED → REVIEW (never FAIL).
// ═══════════════════════════════════════════════════════════════════════════
export function displaySuspicionScore(
  frames: FrameEvidence[], meta: CaptureMeta | null,
): { score: number | null; signals: AvatarDefenseSignals["display_signals"] } {
  const measured = frames.filter((f) => !f.degraded && f.normalized.sharpness >= 0).map((f) => f.normalized);

  // ── flat_depth: the strongest computable tell. A screen replay reads as very
  //    uniform sharpness+brightness across frames with the existing flat_suspect
  //    heuristic, and near-zero brightness dynamics (no real 3D shading change).
  let flatDepth: number | null = null;
  if (measured.length >= 2) {
    const flatSuspectFrac = measured.filter((f) => f.spoof_signals.flat_suspect).length / measured.length;
    const brightSpread = Math.sqrt(variance(measured.map((f) => f.brightness)));
    // low brightness spread across frames = suspiciously flat lighting (2D panel).
    const lowDynamics = brightSpread < 2 ? 0.5 : 0;
    flatDepth = clamp(flatSuspectFrac + lowDynamics, 0, 1);
  }

  // ── pwm_flicker: periodic luma oscillation (50–240Hz aliasing) detectable as a
  //    high-frequency oscillation in the luma_timeline (sign changes of the
  //    first difference well above what a real scene produces). Value = normalized
  //    oscillation ratio.
  let pwm: number | null = null;
  const luma = meta?.luma_timeline;
  if (luma && luma.length >= 8) {
    const seq = [...luma].sort((a, b) => a.t - b.t).map((s) => s.luma);
    let signChanges = 0;
    for (let i = 2; i < seq.length; i++) {
      const d1 = seq[i - 1] - seq[i - 2];
      const d2 = seq[i] - seq[i - 1];
      if (d1 !== 0 && d2 !== 0 && Math.sign(d1) !== Math.sign(d2)) signChanges++;
    }
    const ratio = signChanges / (seq.length - 2);
    // A real scene oscillates rarely; heavy alternation (>0.6 of steps) is flicker.
    pwm = ratio > 0.6 ? clamp((ratio - 0.6) / 0.4, 0, 1) : 0;
  }

  // ── display_reflection: proxy from extreme high-brightness outlier frames
  //    (specular band of a glossy panel). Weak signal; computed from measured
  //    brightness extremes only.
  let reflection: number | null = null;
  if (measured.length >= 2) {
    const maxB = Math.max(...measured.map((f) => f.brightness));
    reflection = maxB >= 96 ? clamp((maxB - 96) / 4, 0, 1) : 0;
  }

  // ── Extractor TODOs (need per-pixel frame analysis we don't run yet). Present in
  //    the map as null so the weighted framework is complete + auditable.
  const banding: number | null = null;      // horizontal_banding — TODO frame-pixel extractor
  const moire: number | null = null;        // moire — TODO frame-pixel FFT-free grid extractor
  const rgbSubpixel: number | null = null;  // rgb_subpixel — TODO high-res crop extractor

  const raw: Record<DisplaySignal, number | null> = {
    horizontal_banding: banding,
    moire,
    pwm_flicker: pwm,
    rgb_subpixel: rgbSubpixel,
    flat_depth: flatDepth,
    display_reflection: reflection,
  };

  const signals = (Object.keys(DISPLAY_WEIGHTS) as DisplaySignal[]).map((sig) => {
    const value = raw[sig];
    const weight = DISPLAY_WEIGHTS[sig];
    const contribution = value == null ? 0 : Number((value * weight).toFixed(2));
    return { signal: sig, value, weight, contribution };
  });

  // If EVERY signal is null we can't compute a score at all → null (skip).
  const anyComputable = signals.some((s) => s.value != null);
  const score = anyComputable ? Math.round(signals.reduce((a, s) => a + s.contribution, 0)) : null;
  return { score, signals };
}

// ═══════════════════════════════════════════════════════════════════════════
//  4. CAMERA-PATH INTEGRITY
//  From capture_meta.integrity. rooted/emulator/virtual_camera/instrumentation
//  true → CAMERA_PATH_COMPROMISED → REVIEW + policy escalation. play_integrity
//  string recorded verbatim for future enforcement.
// ═══════════════════════════════════════════════════════════════════════════
export function cameraPathIntegrity(meta: CaptureMeta | null): AvatarDefenseSignals["camera_path"] {
  const i = meta?.integrity;
  const rooted = i?.rooted ?? null;
  const emulator = i?.emulator ?? null;
  const virtual_camera = i?.virtual_camera ?? null;
  const instrumentation = i?.instrumentation ?? null;
  const play_integrity = i?.play_integrity ?? null;
  const compromised = rooted === true || emulator === true || virtual_camera === true || instrumentation === true;
  return { rooted, emulator, virtual_camera, instrumentation, play_integrity, compromised };
}

// ═══════════════════════════════════════════════════════════════════════════
//  5. TIMING CONSISTENCY
//  Challenge completion timing (flash/vibrate actual-vs-scheduled offsets) that is
//  implausibly instant (<200ms reaction) or exactly uniform → timing_anomaly, fed
//  into the suspicion pool. Prefers explicit challenge results if the client ever
//  captures them; falls back to flash/vibrate offsets.
// ═══════════════════════════════════════════════════════════════════════════
export function timingAnomaly(active: ActiveChecks | null, meta: CaptureMeta | null): boolean {
  const reactions: number[] = [];
  // flash actual-vs-scheduled offsets
  if (active?.flash_sequence && meta?.flash_events) {
    const n = Math.min(active.flash_sequence.length, meta.flash_events.length);
    for (let k = 0; k < n; k++) {
      reactions.push(Math.abs(meta.flash_events[k].t_actual_ms - active.flash_sequence[k].t_offset_ms));
    }
  }
  // vibrate actual-vs-scheduled offset
  if (active?.vibrate && meta?.vibrate_event) {
    reactions.push(Math.abs(meta.vibrate_event.t_actual_ms - active.vibrate.t_offset_ms));
  }
  if (reactions.length === 0) return false;
  // implausibly instant: ALL reactions faster than a human floor.
  const allInstant = reactions.every((r) => r < TIMING_THRESHOLDS.minReactionMs);
  // machine-uniform: ≥3 reactions identical to within epsilon.
  let uniform = false;
  if (reactions.length >= 3) {
    const spread = Math.max(...reactions) - Math.min(...reactions);
    uniform = spread <= TIMING_THRESHOLDS.uniformEpsilonMs;
  }
  return allInstant || uniform;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Orchestrator — run every extractor, apply the versioned weights, and emit the
//  review codes + policy-escalation flag. Pure; never throws.
// ═══════════════════════════════════════════════════════════════════════════
export function evaluateAvatarDefense(
  frames: FrameEvidence[], active: ActiveChecks | null, meta: CaptureMeta | null,
): AvatarDefenseSignals {
  const flash_correlation_score = flashCorrelationScore(active, meta);
  const sensor = sensorCorrelationScore(frames, meta);
  const display = displaySuspicionScore(frames, meta);
  const camera_path = cameraPathIntegrity(meta);
  const timing_anomaly = timingAnomaly(active, meta);

  const review_codes: string[] = [];
  let policy_escalation = false;

  // DISPLAY_SUSPECTED: combined weighted display score at/above threshold → REVIEW.
  if (display.score != null && display.score >= DISPLAY_REVIEW_THRESHOLD) review_codes.push("DISPLAY_SUSPECTED");

  // FLASH_MISMATCH: a computed flash score that is present and clearly failing (the
  // face did NOT brighten to the screen flashes). Informational REVIEW signal only
  // when computable — a null score never penalizes (strict-policy escalation only).
  if (flash_correlation_score != null && flash_correlation_score < 40) review_codes.push("FLASH_MISMATCH");

  // SENSOR_MISMATCH: bbox grew but the device never moved.
  if (sensor.mismatch) review_codes.push("SENSOR_MISMATCH");

  // CAMERA_PATH_COMPROMISED: hard integrity flag → REVIEW + escalate policy.
  if (camera_path.compromised) { review_codes.push("CAMERA_PATH_COMPROMISED"); policy_escalation = true; }

  // TIMING_ANOMALY: implausibly instant / machine-uniform reactions.
  if (timing_anomaly) review_codes.push("TIMING_ANOMALY");

  return {
    flash_correlation_score,
    sensor_correlation_score: sensor.score,
    display_suspicion_score: display.score,
    display_signals: display.signals,
    camera_path,
    timing_anomaly,
    review_codes,
    policy_escalation,
    weights_version: DISPLAY_WEIGHTS_VERSION,
  };
}

// ── capture_meta parse + size/shape guard. Returns null on absent/oversize/bad. ──
export function parseCaptureMeta(raw: unknown): { meta: CaptureMeta | null; tooLarge: boolean } {
  if (raw == null || typeof raw !== "object") return { meta: null, tooLarge: false };
  let approxBytes = 0;
  try { approxBytes = JSON.stringify(raw).length; } catch { return { meta: null, tooLarge: false }; }
  if (approxBytes > MAX_CAPTURE_META_BYTES) return { meta: null, tooLarge: true };
  const b = raw as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && isFinite(v) ? v : 0);
  const numOpt = (v: unknown): number | undefined => (typeof v === "number" && isFinite(v) ? v : undefined);
  const boolOrNull = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
  const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v.slice(0, 256) : null);

  const sensor_timeline: SensorSample[] = Array.isArray(b.sensor_timeline)
    ? (b.sensor_timeline as unknown[]).slice(0, MAX_SENSOR_SAMPLES).map((s) => {
        const o = (s ?? {}) as Record<string, unknown>;
        return { t: num(o.t), ax: num(o.ax), ay: num(o.ay), az: num(o.az), gx: numOpt(o.gx), gy: numOpt(o.gy), gz: numOpt(o.gz) };
      })
    : [];
  const luma_timeline: LumaSample[] = Array.isArray(b.luma_timeline)
    ? (b.luma_timeline as unknown[]).slice(0, MAX_LUMA_SAMPLES).map((s) => {
        const o = (s ?? {}) as Record<string, unknown>;
        return { t: num(o.t), luma: num(o.luma) };
      })
    : [];
  const flash_events: FlashEvent[] = Array.isArray(b.flash_events)
    ? (b.flash_events as unknown[]).slice(0, 8).map((s) => {
        const o = (s ?? {}) as Record<string, unknown>;
        const color = o.color === "red" ? "red" : o.color === "blue" ? "blue" : "white";
        return { color: color as FlashColor, t_actual_ms: num(o.t_actual_ms) };
      })
    : [];
  const ve = b.vibrate_event as Record<string, unknown> | null | undefined;
  const vibrate_event = ve && typeof ve === "object" ? { t_actual_ms: num(ve.t_actual_ms) } : null;
  const ig = (b.integrity ?? {}) as Record<string, unknown>;
  const integrity: CaptureIntegrity = {
    rooted: boolOrNull(ig.rooted),
    emulator: boolOrNull(ig.emulator),
    virtual_camera: boolOrNull(ig.virtual_camera),
    instrumentation: boolOrNull(ig.instrumentation),
    play_integrity: strOrNull(ig.play_integrity),
  };
  const cam = (b.camera ?? {}) as Record<string, unknown>;
  const camera: CaptureCamera = {
    model: typeof cam.model === "string" ? cam.model.slice(0, 120) : "",
    resolution: typeof cam.resolution === "string" ? cam.resolution.slice(0, 40) : "",
    fps: num(cam.fps),
  };
  return { meta: { sensor_timeline, luma_timeline, flash_events, vibrate_event, integrity, camera }, tooLarge: false };
}

// ── Build the server-randomized active_checks for a session (SHARED with client). ─
// Uses the same crypto-random style as routes/liveness_v3.ts. 2–4 flashes with
// random colors/timings inside the face stage, an optional vibrate, and one random
// challenge_gaps_ms (700–1900) per issued challenge.
export function buildActiveChecks(
  challengeCount: number,
  rnd: { int: (maxExclusive: number) => number; float: (min: number, max: number) => number },
): ActiveChecks {
  const colors: FlashColor[] = ["white", "red", "blue"];
  const flashCount = 2 + rnd.int(3); // 2, 3, or 4
  const flash_sequence: FlashStep[] = [];
  let cursor = 800 + rnd.int(600); // first flash 0.8–1.4s into the face stage
  for (let i = 0; i < flashCount; i++) {
    flash_sequence.push({
      color: colors[rnd.int(colors.length)],
      t_offset_ms: cursor,
      duration_ms: 180 + rnd.int(220), // 180–400ms
    });
    cursor += 700 + rnd.int(900); // 0.7–1.6s gap before the next flash
  }
  const vibrate = rnd.int(2) === 0
    ? null
    : { t_offset_ms: 600 + rnd.int(cursor > 700 ? cursor - 600 : 400), duration_ms: 120 + rnd.int(180) };
  const challenge_gaps_ms = Array.from({ length: Math.max(1, challengeCount) }, () => 700 + rnd.int(1200)); // 700–1899
  return { flash_sequence, vibrate, challenge_gaps_ms };
}

// ── Extractor TODOs left null (documented; the scoring framework already combines
//    whatever IS present). Kept as a const so the spec + tests can assert on it. ──
export const EXTRACTOR_TODOS = [
  "horizontal_banding — per-pixel scan-line banding extractor over decoded frames (frame pipeline required)",
  "moire — screen pixel-grid interference detector (grid-domain, FFT-FREE per the rejected-forensics rule)",
  "rgb_subpixel — RGB sub-pixel structure detector on a high-res face crop (frame pipeline required)",
] as const;
