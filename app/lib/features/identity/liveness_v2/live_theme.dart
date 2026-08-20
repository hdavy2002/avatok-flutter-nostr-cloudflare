import 'package:flutter/material.dart';

import '../../../core/ui/avatok_dark.dart';
import '../../../core/ui/messenger_theme.dart';

/// [LIVE-UI-3] Shared styling for the redesigned Liveness V2 flow, re-skinned to
/// the AvaTOK Dark v2 language (design port of `design/Liveliness Check
/// Screens/Liveness Check.dc.html`).
///
/// The flow is a DARK stage — near-black AD surfaces with dark-v2 accents layered
/// on top. Every token below maps to `AD`/`ADText` so the whole flow shifts with
/// the rest of the app. Hairline borders replace the old ink borders and the hard
/// offset shadows are dropped (soft/flat elevation).
class LiveTheme {
  LiveTheme._();

  // ── Surfaces (dark v2 — mapped to AD tokens) ──────────────────────────────
  /// Stage background — near-black (was deep teal).
  static const stage = AD.bg;
  /// Camera card inner fill — dark card surface.
  static const cameraCard = AD.card;
  /// Light text / corner brackets on the dark stage.
  static const paper = AD.textPrimary;

  // ── Accents (mapped to AD dark-v2 tokens) ─────────────────────────────────
  static const lime = AD.primaryBadge; // primary action (orange)
  static const coral = AD.danger;
  static const lilac = AD.iconVideo;
  static const mint = AD.online;
  static const blue = AD.iconSearch;
  /// Hairline border "ink" (was warm-black ink).
  static const ink = AD.borderControl;
  static const inkSoft = AD.textSecondary;
  static const card = AD.card;
  /// Tape highlight — primaryBadge @30%.
  ///
  /// [RAJ-PHASE2-1] Was a literal 0x4DE8833A: the OLD orange accent at 30%.
  /// That orange is not in the Rajasthani palette at all, so the comment
  /// ("primaryBadge @30%") had quietly stopped being true. Now it derives from
  /// the token, so it follows the accent instead of drifting from it.
  static final tape = AD.primaryBadge.withValues(alpha: 0.30);
  /// Danger marker-highlight @34%.
  static final coralMark = AD.danger.withValues(alpha: 0.34);

  /// Muted sub-text on the dark stage.
  static const subPaper = AD.textSecondary;
  /// Faint dashed borders / pending markers.
  static const dimPaper = AD.textTertiary;

  // ── Motion ────────────────────────────────────────────────────────────────
  /// Honour the OS "reduce motion" setting for every animation in this flow.
  static bool reducedMotion(BuildContext context) =>
      MediaQuery.maybeOf(context)?.disableAnimations ?? false;

  // ── Text styles ───────────────────────────────────────────────────────────
  // [UI-MSG-TYPE-1] Body copy is Regular. This is the sub-line under every stage
  // headline — it sat at w700, the same weight as the headline it explains, so
  // nothing on the stage could read as the heading.
  static const TextStyle subStyle = TextStyle(
    fontFamily: ADText.family,
    fontWeight: FontWeight.w400,
    fontSize: 14,
    height: 1.45,
    color: subPaper,
  );

  static const TextStyle kickerOnCardStyle = TextStyle(
    fontFamily: ADText.family,
    fontWeight: FontWeight.w600,
    fontSize: 11,
    letterSpacing: 0.66,
    color: AD.textTertiary,
  );

  // [UI-MSG-TYPE-1] w800 → w700. The read-aloud phrase is the loudest thing on
  // the stage, so it keeps the heaviest weight the scale allows — but 800/900
  // are gone from the app.
  static const TextStyle phraseStyle = TextStyle(
    fontFamily: ADText.family,
    fontWeight: FontWeight.w700,
    fontSize: 21,
    height: 1.35,
    color: AD.textPrimary,
  );

  static const TextStyle checkRowStyle = TextStyle(
    fontFamily: ADText.family,
    fontWeight: FontWeight.w600,
    fontSize: 14,
    color: paper,
  );

  /// Headline with a tape-highlighted [markWord] (the design's rotated lime tape
  /// on the last word). Renders paper-coloured text on the dark stage.
  //
  // [RAJ-PHASE2-1] `markFill` is nullable-with-fallback rather than
  // `= tape`: `tape` is now DERIVED from AD.primaryBadge instead of being a
  // frozen hex, which makes it `static final`, and a default parameter value
  // has to be a compile-time constant. Callers that pass nothing still get
  // `tape`; callers that pass a colour are unaffected.
  static Widget stageHeadline(String lead,
      {required String markWord, Color? markFill, Color markText = paper}) {
    final fill = markFill ?? tape;
    return RichText(
      text: TextSpan(
        style: const TextStyle(
          fontFamily: ADText.family,
          fontWeight: FontWeight.w600,
          fontSize: 24,
          letterSpacing: -0.5,
          color: paper,
        ),
        children: [
          TextSpan(text: lead),
          WidgetSpan(
            alignment: PlaceholderAlignment.baseline,
            baseline: TextBaseline.alphabetic,
            child: Transform.rotate(
              angle: -0.021, // ~-1.2deg
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: Msg.s2),
                decoration: BoxDecoration(
                  color: fill,
                  borderRadius: Msg.brSm,
                ),
                child: Text(markWord,
                    style: TextStyle(
                      fontFamily: ADText.family,
                      fontWeight: FontWeight.w600,
                      fontSize: 24,
                      letterSpacing: -0.5,
                      color: markText,
                    )),
              ),
            ),
          ),
        ],
      ),
    );
  }

  // ── Reusable components ───────────────────────────────────────────────────

  /// Selectable pill chip (language picker). Active = lime fill.
  static Widget chip(
      {required String label, required bool active, VoidCallback? onTap}) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: Msg.s4, vertical: Msg.s2),
        decoration: BoxDecoration(
          color: active ? lime : card,
          borderRadius: Msg.brPill,
          border: Border.all(color: active ? lime : ink, width: 1),
        ),
        child: Text(label,
            style: const TextStyle(
              fontFamily: ADText.family,
              fontWeight: FontWeight.w600,
              fontSize: 13,
              color: paper,
            )),
      ),
    );
  }

  /// Status pill — filled (e.g. lime "done", coral "listening") or outlined
  /// (pending). Optional blinking leading dot.
  static Widget pill({
    required String label,
    Color? filled,
    Color textOnFill = paper,
    IconData? icon,
    bool leadingDotBlink = false,
    bool outlined = false,
  }) {
    final fg = filled != null ? textOnFill : paper;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: Msg.s4, vertical: Msg.s2),
      decoration: BoxDecoration(
        color: filled,
        borderRadius: Msg.brPill,
        border: Border.all(
            color: filled != null ? ink : dimPaper, width: 1),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (leadingDotBlink) ...[
            _BlinkDot(color: fg),
            const SizedBox(width: Msg.s2),
          ],
          if (icon != null) ...[
            Icon(icon, size: 12, color: fg),
            const SizedBox(width: Msg.s2),
          ],
          // [UI-CASE-1] The forced `.toUpperCase()` is gone — 'CAMERA ON' /
          // 'LISTENING' / 'FACE LOCKED' shouted at the user mid-capture. Callers
          // already pass sentence case and it now renders as written.
          Text(label,
              style: TextStyle(
                fontFamily: ADText.family,
                fontWeight: FontWeight.w600,
                fontSize: 11,
                letterSpacing: 0.2,
                color: fg,
              )),
        ],
      ),
    );
  }

  /// Full-width lime CTA with the design's hard offset shadow + optional icon.
  static Widget limeButton(
      {required String label, IconData? icon, VoidCallback? onPressed}) {
    final enabled = onPressed != null;
    return Opacity(
      opacity: enabled ? 1 : 0.5,
      child: GestureDetector(
        onTap: onPressed,
        child: Container(
          height: 56,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: lime,
            borderRadius: Msg.brLg,
            border: Border.all(color: ink, width: 1),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (icon != null) ...[
                Icon(icon, size: 20, color: paper),
                const SizedBox(width: Msg.s2),
              ],
              Text(label,
                  style: const TextStyle(
                    fontFamily: ADText.family,
                    fontWeight: FontWeight.w700,
                    fontSize: 18,
                    color: paper,
                  )),
            ],
          ),
        ),
      ),
    );
  }

  /// White card with ink border + hard shadow (phrase card, delete-mode card).
  static BoxDecoration get taperedCardDecoration => BoxDecoration(
        color: card,
        borderRadius: Msg.brLg,
        border: Border.all(color: ink, width: 1),
        boxShadow: Msg.none,
      );

  /// A little tape strip (rotated lime rectangle) that sits on card tops.
  static Widget tapeStrip() => Transform.rotate(
        angle: -0.035,
        child: Container(width: 92, height: 22, color: tape),
      );

  /// The rounded camera card container with corner brackets + dotted texture.
  static Widget cameraStage({required Widget child}) {
    return DecoratedBox(
      decoration: BoxDecoration(
        color: cameraCard,
        borderRadius: Msg.brLg,
        border: Border.all(color: ink, width: 1),
        boxShadow: Msg.none,
      ),
      child: ClipRRect(
        // One hairline inside the 16px outer radius so the border stays crisp.
        borderRadius: BorderRadius.circular(Msg.rLg - 1),
        child: Stack(
          fit: StackFit.expand,
          children: [
            const _DottedTexture(),
            child,
            const _CornerBrackets(),
          ],
        ),
      ),
    );
  }
}

/// Blinking indicator dot (coral REC / camera-on / listening pills).
///
/// [UI-LIVE-LOOPS-1 2026-08-05] **This is the ONE infinite animation loop the
/// identity flow is allowed to run.** It is the only one that carries meaning:
/// it says "the camera/mic is live right now". The other six repeating loops in
/// this flow (the pulsing REC inset border, the six staggered blink carets, the
/// two counter-rotating analyse rings, the confetti, the face-search scan line
/// and the fake voice waveform) were removed on 2026-08-05 — they animated
/// forever while saying nothing, and six of them ran at once. Do not add another
/// `.repeat()` to this feature; if a new state needs signalling, express it with
/// colour or a one-shot transition.
class _BlinkDot extends StatefulWidget {
  const _BlinkDot({required this.color});
  final Color color;
  @override
  State<_BlinkDot> createState() => _BlinkDotState();
}

class _BlinkDotState extends State<_BlinkDot>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c;
  @override
  void initState() {
    super.initState();
    _c = AnimationController(
        vsync: this, duration: const Duration(milliseconds: 900));
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!LiveTheme.reducedMotion(context) && !_c.isAnimating) {
      _c.repeat(reverse: true);
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return FadeTransition(
      opacity: Tween<double>(begin: 1, end: 0.12).animate(_c),
      child: Container(
        width: 7,
        height: 7,
        decoration: BoxDecoration(color: widget.color, shape: BoxShape.circle),
      ),
    );
  }
}

/// Faint radial-dot texture on the dark camera card (design uses 18px steps).
class _DottedTexture extends StatelessWidget {
  const _DottedTexture();
  @override
  Widget build(BuildContext context) =>
      CustomPaint(painter: _DotPainter(), size: Size.infinite);
}

class _DotPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    // [RAJ-PHASE2-1] Was 0x0DF9F7ED — the OLD paper white at 5%. Derived from
    // the palette token now so it can't drift from AD.bg again.
    final p = Paint()..color = AD.bg.withValues(alpha: 0.05); // paper @5%
    const step = 18.0;
    for (var y = 0.0; y < size.height; y += step) {
      for (var x = 0.0; x < size.width; x += step) {
        canvas.drawCircle(Offset(x, y), 1, p);
      }
    }
  }

  @override
  bool shouldRepaint(_DotPainter old) => false;
}

/// The four L-shaped corner brackets on the camera card.
class _CornerBrackets extends StatelessWidget {
  const _CornerBrackets();
  @override
  Widget build(BuildContext context) =>
      CustomPaint(painter: _BracketPainter(), size: Size.infinite);
}

class _BracketPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      // [RAJ-PHASE2-1] Was 0xD9F9F7ED — the OLD paper white at 85%.
      ..color = AD.bg.withValues(alpha: 0.85) // paper @85%
      ..strokeWidth = 3
      ..strokeCap = StrokeCap.round
      ..style = PaintingStyle.stroke;
    const m = 12.0; // margin from edge
    const len = 26.0;
    // top-left
    canvas.drawLine(Offset(m, m + len), Offset(m, m + 8), paint);
    canvas.drawLine(Offset(m + 8, m), Offset(m + len, m), paint);
    // top-right
    canvas.drawLine(
        Offset(size.width - m, m + len), Offset(size.width - m, m + 8), paint);
    canvas.drawLine(
        Offset(size.width - m - 8, m), Offset(size.width - m - len, m), paint);
    // bottom-left
    canvas.drawLine(
        Offset(m, size.height - m - len), Offset(m, size.height - m - 8), paint);
    canvas.drawLine(
        Offset(m + 8, size.height - m), Offset(m + len, size.height - m), paint);
    // bottom-right
    canvas.drawLine(Offset(size.width - m, size.height - m - len),
        Offset(size.width - m, size.height - m - 8), paint);
    canvas.drawLine(Offset(size.width - m - 8, size.height - m),
        Offset(size.width - m - len, size.height - m), paint);
  }

  @override
  bool shouldRepaint(_BracketPainter old) => false;
}
