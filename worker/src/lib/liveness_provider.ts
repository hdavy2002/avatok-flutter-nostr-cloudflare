// Liveness V3 — provider normalization layer (Trust Engine §6 uniform-provider
// contract + LIVENESS-V3 plan §4-A.2). Rekognition's raw DetectFaces response is
// normalized to a SINGLE provider-independent shape here; the deterministic rules
// engine (worker/src/lib/liveness_rules_v3.ts) consumes ONLY `NormalizedFace`
// fields and never sees a vendor type. Swapping FaceProvider (Azure/Google/…) is
// an adapter change in THIS file, not a rules change.
//
// No LLM is involved anywhere in this file — it is pure structural mapping over
// the provider's numeric outputs (Trust Engine invariant: LLM-free decisions).
import type { RekFaceDetail, DetectFacesResult } from "../aws/rekognition";

/** The provider-independent per-frame face signal the V3 rules engine reads. */
export interface NormalizedFace {
  face_found: boolean;        // at least one face detected with usable confidence
  face_count: number;         // number of distinct faces in the frame
  confidence: number;         // 0..100 that the primary region IS a face
  sharpness: number;          // 0..100 (higher = crisper; low = blur)
  brightness: number;         // 0..100 (low = under-exposed / dark)
  pose: { roll: number; yaw: number; pitch: number }; // degrees, primary face
  eyes_open: boolean | null;  // null = provider gave no reliable read
  // face bounding box of the primary (largest) face, fractions 0..1 of frame.
  box: { width: number; height: number; left: number; top: number };
  // Cheap spoof heuristics derived from provider signals (screen/print tells).
  spoof_signals: {
    // sunglasses or heavy eyewear can mask a printed-photo / mask attack.
    eyewear: boolean;
    // extreme flatness proxy: a screen replay often reads as very high sharpness
    // AND unusually uniform brightness; we surface the raw numbers and let the
    // rules engine decide (never a verdict here).
    flat_suspect: boolean;
  };
  provider: string;           // e.g. "aws_rekognition" | "workers_ai"
  provider_version: string;   // pinned model/API version string for the manifest
}

// Provider identity constants — stamped onto every verdict (Trust Engine §10
// provenance: "why did this pass in March?" must be answerable).
export const PROVIDER_REKOGNITION = "aws_rekognition";
export const PROVIDER_WORKERS_AI = "workers_ai";
// Rekognition Image API has no versioned model string the way a model endpoint
// does; pin the API contract name so a future API change is auditable.
export const REKOGNITION_PROVIDER_VERSION = "detectfaces-2016-06-27";
export const WORKERS_AI_PROVIDER_VERSION = "@cf/llava-hf/llava-1.5-7b-hf";

/** Pick the largest-area face detail as the "primary" subject. */
function primaryFace(details: RekFaceDetail[]): RekFaceDetail | null {
  let best: RekFaceDetail | null = null;
  let bestArea = -1;
  for (const d of details) {
    const b = d.BoundingBox ?? {};
    const area = (b.Width ?? 0) * (b.Height ?? 0);
    if (area > bestArea) { bestArea = area; best = d; }
  }
  return best;
}

/**
 * Normalize a Rekognition DetectFaces response into `NormalizedFace`. Deterministic
 * mapping only — no thresholds/verdicts (those live in the rules engine). A
 * confidence floor of 90 is used ONLY to decide `face_found` (below that the
 * region isn't reliably a face); the raw confidence is still surfaced for rules.
 */
export function normalizeRekognition(resp: DetectFacesResult): NormalizedFace {
  const details = resp.FaceDetails ?? [];
  const primary = primaryFace(details);
  const q = primary?.Quality ?? {};
  const box = primary?.BoundingBox ?? {};
  const confidence = primary?.Confidence ?? 0;
  const sharpness = q.Sharpness ?? primary?.Sharpness ?? 0;
  const brightness = q.Brightness ?? primary?.Brightness ?? 0;
  const eyewear =
    (primary?.Sunglasses?.Value === true) ||
    (primary?.Eyeglasses?.Value === true && (primary?.Eyeglasses?.Confidence ?? 0) >= 90);
  // Flat-suspect heuristic (screen replay tell): very high sharpness with very
  // high brightness is unusual for a real front-camera capture in normal light.
  const flatSuspect = sharpness >= 95 && brightness >= 92;
  let eyesOpen: boolean | null = null;
  if (primary?.EyesOpen && typeof primary.EyesOpen.Value === "boolean" &&
      (primary.EyesOpen.Confidence ?? 0) >= 80) {
    eyesOpen = primary.EyesOpen.Value;
  }
  return {
    face_found: !!primary && confidence >= 90,
    face_count: details.length,
    confidence,
    sharpness,
    brightness,
    pose: {
      roll: primary?.Pose?.Roll ?? 0,
      yaw: primary?.Pose?.Yaw ?? 0,
      pitch: primary?.Pose?.Pitch ?? 0,
    },
    eyes_open: eyesOpen,
    box: {
      width: box.Width ?? 0,
      height: box.Height ?? 0,
      left: box.Left ?? 0,
      top: box.Top ?? 0,
    },
    spoof_signals: { eyewear, flat_suspect: flatSuspect },
    provider: PROVIDER_REKOGNITION,
    provider_version: REKOGNITION_PROVIDER_VERSION,
  };
}

/**
 * Normalize a Workers AI fallback face read. The breaker degrades to Workers AI
 * when Rekognition is throttled/down (Trust Engine §6): we can only cheaply
 * confirm "a face is present" via LLaVA, so the normalized shape carries a
 * face-present boolean and marks everything else as unknown. Rules that require a
 * real Rekognition signal treat a Workers-AI-only normalization as insufficient
 * → REVIEW (never FAIL on our infra problem).
 */
export function normalizeWorkersAiFace(faceFound: boolean): NormalizedFace {
  return {
    face_found: faceFound,
    face_count: faceFound ? 1 : 0,
    confidence: faceFound ? 90 : 0,
    // Unknowns (Workers AI fallback can't measure these). Rules must NOT fail a
    // user on a value the degraded provider couldn't measure.
    sharpness: -1,
    brightness: -1,
    pose: { roll: 0, yaw: 0, pitch: 0 },
    eyes_open: null,
    box: { width: 0, height: 0, left: 0, top: 0 },
    spoof_signals: { eyewear: false, flat_suspect: false },
    provider: PROVIDER_WORKERS_AI,
    provider_version: WORKERS_AI_PROVIDER_VERSION,
  };
}
