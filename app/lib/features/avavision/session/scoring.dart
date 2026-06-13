// scoring.dart — geometry scoring adapters for AvaVision.
//
// Per master §6 there are four scoring modes:
//   geometry           → compute a 0..100 technique score locally from landmarks
//   gemini_qualitative → no local compute; the agent reports the score (badge
//                        shows the agent's number when it pushes one)
//   hybrid             → show the local geometry score AND let the agent comment
//   none               → no badge
//
// SAFETY (master §10 / rule 10): we score TECHNIQUE / ACTION geometry only —
// never beauty, attractiveness, body shape, identity, or anything medical. The
// adapters here only ever read joint *angles* and relative positions.
//
// The screen feeds `[SYSTEM: <label> <score>, <hint>]` text events into the Live
// session at a debounced cadence (≈ every 3 s) so coaching is grounded (master §5).
import 'dart:math' as math;

import 'pose_channel.dart';

/// Result of a local geometry evaluation.
class ScoreResult {
  /// 0..100, or null when this mode/capability produces no local number.
  final int? score;
  /// Short coaching hint for the SYSTEM cue, e.g. "left elbow dropping".
  final String? hint;
  const ScoreResult(this.score, [this.hint]);
  static const ScoreResult none = ScoreResult(null);
}

// ── Keypoint index maps ──────────────────────────────────────────────────────
// MoveNet (17, default pose engine on all platforms).
class MoveNet {
  static const nose = 0;
  static const leftEye = 1, rightEye = 2, leftEar = 3, rightEar = 4;
  static const leftShoulder = 5, rightShoulder = 6;
  static const leftElbow = 7, rightElbow = 8;
  static const leftWrist = 9, rightWrist = 10;
  static const leftHip = 11, rightHip = 12;
  static const leftKnee = 13, rightKnee = 14;
  static const leftAnkle = 15, rightAnkle = 16;
}

// MediaPipe Pose (33, the engine_upgrade_android_web=mediapipe_pose path). We
// only reference the indices that overlap conceptually with the geometry below.
class MpPose {
  static const leftShoulder = 11, rightShoulder = 12;
  static const leftElbow = 13, rightElbow = 14;
  static const leftWrist = 15, rightWrist = 16;
  static const leftHip = 23, rightHip = 24;
  static const leftKnee = 25, rightKnee = 26;
  static const leftAnkle = 27, rightAnkle = 28;
}

/// Pull the right index set for the active engine.
class _PoseIdx {
  final int ls, rs, le, re, lw, rw, lh, rh, lk, rk, la, ra;
  const _PoseIdx(this.ls, this.rs, this.le, this.re, this.lw, this.rw, this.lh,
      this.rh, this.lk, this.rk, this.la, this.ra);
  factory _PoseIdx.forEngine(String engine) => engine == 'mediapipe_pose'
      ? const _PoseIdx(MpPose.leftShoulder, MpPose.rightShoulder, MpPose.leftElbow,
          MpPose.rightElbow, MpPose.leftWrist, MpPose.rightWrist, MpPose.leftHip,
          MpPose.rightHip, MpPose.leftKnee, MpPose.rightKnee, MpPose.leftAnkle, MpPose.rightAnkle)
      : const _PoseIdx(MoveNet.leftShoulder, MoveNet.rightShoulder, MoveNet.leftElbow,
          MoveNet.rightElbow, MoveNet.leftWrist, MoveNet.rightWrist, MoveNet.leftHip,
          MoveNet.rightHip, MoveNet.leftKnee, MoveNet.rightKnee, MoveNet.leftAnkle, MoveNet.rightAnkle);
}

/// Scores a frame given the agent's capability + engine + scoring mode.
///
/// This is intentionally a small, transparent set of *generic* technique
/// adapters keyed off capability. A creator's specific drill nuance is coached
/// by the agent (the platform never ships per-creator scoring code at launch).
class VisionScorer {
  final String capability;   // pose | hand | ... | gemini_only
  final String engine;       // movenet | mediapipe_pose | mediapipe_tasks
  final String scoringMode;  // geometry | gemini_qualitative | hybrid | none
  late final _PoseIdx _idx = _PoseIdx.forEngine(engine);

  VisionScorer({required this.capability, required this.engine, required this.scoringMode});

  bool get producesLocalScore => scoringMode == 'geometry' || scoringMode == 'hybrid';

  /// Evaluate one frame. Returns [ScoreResult.none] when the mode is
  /// qualitative/none or there's no confident subject in view.
  ScoreResult evaluate(VisionFrame f) {
    if (!producesLocalScore) return ScoreResult.none;
    switch (capability) {
      case 'pose':
        return _pose(f);
      case 'hand':
      case 'gesture':
        return _hand(f);
      default:
        // face_landmark / object / segmentation / image_class / gemini_only:
        // no generic local geometry score — agent or none drives the badge.
        return ScoreResult.none;
    }
  }

  // ── pose: posture/symmetry technique score ─────────────────────────────────
  // Generic, safe proxy for "good form": torso uprightness + left/right symmetry
  // of the knee and elbow angles. Squat depth etc. are surfaced as hints when a
  // clear bend is detected. NO body-shape or attractiveness signal is read.
  ScoreResult _pose(VisionFrame f) {
    if (f.points.isEmpty) return ScoreResult.none;
    final p = f.points.first;
    if (p.length < 17 && engine != 'mediapipe_pose') return ScoreResult.none;

    double? ang(int a, int b, int c) => _angle(p, a, b, c);

    final lKnee = ang(_idx.lh, _idx.lk, _idx.la);
    final rKnee = ang(_idx.rh, _idx.rk, _idx.ra);
    final lElbow = ang(_idx.ls, _idx.le, _idx.lw);
    final rElbow = ang(_idx.rs, _idx.re, _idx.rw);

    // Torso uprightness: shoulder-midpoint vs hip-midpoint verticality.
    final upright = _torsoUpright(p);

    final parts = <double>[];
    if (upright != null) parts.add(upright); // 0..1
    final kneeSym = _symmetry(lKnee, rKnee);
    if (kneeSym != null) parts.add(kneeSym);
    final elbowSym = _symmetry(lElbow, rElbow);
    if (elbowSym != null) parts.add(elbowSym);

    if (parts.isEmpty) return ScoreResult.none;
    final score = (parts.reduce((a, b) => a + b) / parts.length * 100).round().clamp(0, 100);

    // Hint: pick the weakest contributor.
    String? hint;
    if (upright != null && upright < 0.7) {
      hint = 'keep your torso upright';
    } else if (kneeSym != null && kneeSym < 0.7) {
      hint = 'balance your weight evenly';
    } else if (lElbow != null && rElbow != null && (lElbow < 150 || rElbow < 150) && (elbowSym ?? 1) < 0.8) {
      hint = (lElbow < rElbow) ? 'left elbow dropping' : 'right elbow dropping';
    }
    return ScoreResult(score, hint);
  }

  // ── hand/gesture: openness/spread proxy ────────────────────────────────────
  // For a 21-pt MediaPipe hand, a generic "clarity" proxy = how extended the
  // fingers are (tip-to-wrist distances vs the palm size). Coaching the gesture
  // itself is the agent's job; this just keeps the badge alive in geometry mode.
  ScoreResult _hand(VisionFrame f) {
    if (f.points.isEmpty) return ScoreResult.none;
    final p = f.points.first;
    if (p.length < 21) return ScoreResult.none;
    const wrist = 0;
    const tips = [4, 8, 12, 16, 20];
    final palm = _dist(p[wrist], p[9]); // wrist→middle-MCP as a scale unit
    if (palm <= 0) return ScoreResult.none;
    double spread = 0;
    for (final t in tips) {
      spread += _dist(p[wrist], p[t]) / palm;
    }
    spread /= tips.length; // ~1.2 (fist) .. ~2.6 (open)
    final norm = ((spread - 1.2) / (2.6 - 1.2)).clamp(0.0, 1.0);
    return ScoreResult((norm * 100).round(), norm < 0.4 ? 'open your hand a little more' : null);
  }

  // ── geometry helpers ───────────────────────────────────────────────────────
  static double _dist(VisionPoint a, VisionPoint b) =>
      math.sqrt(math.pow(a.x - b.x, 2) + math.pow(a.y - b.y, 2)).toDouble();

  /// Interior angle (degrees) at vertex [b] for points a-b-c, or null if any
  /// point is low-confidence / missing.
  static double? _angle(List<VisionPoint> p, int a, int b, int c) {
    if (a >= p.length || b >= p.length || c >= p.length) return null;
    final pa = p[a], pb = p[b], pc = p[c];
    if (pa.score < .3 || pb.score < .3 || pc.score < .3) return null;
    final v1x = pa.x - pb.x, v1y = pa.y - pb.y;
    final v2x = pc.x - pb.x, v2y = pc.y - pb.y;
    final dot = v1x * v2x + v1y * v2y;
    final m1 = math.sqrt(v1x * v1x + v1y * v1y);
    final m2 = math.sqrt(v2x * v2x + v2y * v2y);
    if (m1 == 0 || m2 == 0) return null;
    final cos = (dot / (m1 * m2)).clamp(-1.0, 1.0);
    return math.acos(cos) * 180 / math.pi;
  }

  /// 1.0 when two angles match, decaying to 0 at ≥45° apart. null if either null.
  static double? _symmetry(double? a, double? b) {
    if (a == null || b == null) return null;
    return (1 - (a - b).abs() / 45).clamp(0.0, 1.0);
  }

  /// Torso uprightness 0..1 (1 = vertical spine) from shoulder/hip midpoints.
  double? _torsoUpright(List<VisionPoint> p) {
    if (_idx.rh >= p.length) return null;
    final sx = (p[_idx.ls].x + p[_idx.rs].x) / 2, sy = (p[_idx.ls].y + p[_idx.rs].y) / 2;
    final hx = (p[_idx.lh].x + p[_idx.rh].x) / 2, hy = (p[_idx.lh].y + p[_idx.rh].y) / 2;
    if ([p[_idx.ls], p[_idx.rs], p[_idx.lh], p[_idx.rh]].any((k) => k.score < .3)) return null;
    final dx = (sx - hx).abs(), dy = (sy - hy).abs();
    if (dy == 0) return 0;
    // tilt = horizontal offset relative to vertical length; 0 tilt → upright.
    final tilt = (dx / dy).clamp(0.0, 1.0);
    return 1 - tilt;
  }
}
