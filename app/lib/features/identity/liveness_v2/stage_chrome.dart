// NOTE `dart:math` was dropped with `_Confetti` — nothing here needs it now.
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/ui/avatok_dark.dart';
import '../../../core/ui/messenger_theme.dart';
import 'live_theme.dart';

/// [LIVE-UI-3] Chrome + per-stage decorative widgets for the redesigned dark
/// Liveness V2 flow. Kept out of the orchestrator so the orchestrator stays
/// about flow logic. All animations honour reduced-motion.
///
/// [UI-LIVE-LOOPS-1 2026-08-05] This file used to own FOUR of the six infinite
/// animation loops the identity flow ran simultaneously: the pulsing REC inset
/// border, six staggered blink carets, two counter-rotating dashed analyse rings,
/// and floating confetti. All four are gone. The only loop left in the whole
/// flow is `_BlinkDot` in `live_theme.dart` (the "camera is live" pill dot).

/// Top header: "Liveness check" kicker + circular restart button.
class LivenessHeader extends StatelessWidget {
  const LivenessHeader({super.key, this.onRestart});
  final VoidCallback? onRestart;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        // [UI-CASE-1] Sentence case — the shouted kicker was part of the
        // "amateur UI" finding.
        Text(
          'Liveness check',
          style: ADText.sectionLabel(c: AD.textSecondary),
        ),
        if (onRestart != null)
          GestureDetector(
            onTap: onRestart,
            child: Container(
              width: 34,
              height: 34,
              decoration: BoxDecoration(
                color: LiveTheme.card,
                shape: BoxShape.circle,
                border: Border.all(color: LiveTheme.ink, width: 1),
              ),
              child: PhosphorIcon(
                  PhosphorIcons.arrowCounterClockwise(PhosphorIconsStyle.regular),
                  size: 18,
                  color: LiveTheme.paper),
            ),
          )
        else
          const SizedBox(width: 34, height: 34),
      ],
    );
  }
}

/// Step pips (1..total) inside a pill.
class StepPips extends StatelessWidget {
  const StepPips({super.key, required this.total, required this.active});
  final int total;
  final int active;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: Msg.s4, vertical: Msg.s2),
      decoration: BoxDecoration(
        color: LiveTheme.card,
        borderRadius: Msg.brPill,
        border: Border.all(color: LiveTheme.ink, width: 1),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (var i = 1; i <= total; i++) ...[
            if (i > 1) const SizedBox(width: Msg.s2),
            _pip(i == active, i < active),
          ],
        ],
      ),
    );
  }

  Widget _pip(bool isActive, bool isDone) => AnimatedContainer(
        duration: Msg.base,
        curve: Msg.curve,
        width: isActive ? 18 : 8,
        height: 8,
        decoration: BoxDecoration(
          color: (isActive || isDone)
              ? LiveTheme.lime
              : LiveTheme.paper.withValues(alpha: 0.18),
          borderRadius: Msg.brPill,
        ),
      );
}

/// Footer lock line, present on every stage.
class LivenessFooter extends StatelessWidget {
  const LivenessFooter({super.key});

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        // NOT const: `PhosphorIcons.lock(...)` is a function call.
        PhosphorIcon(PhosphorIcons.lock(PhosphorIconsStyle.regular),
            size: 13, color: AD.textTertiary),
        const SizedBox(width: Msg.s2),
        const Flexible(
          child: Text(
            'End-to-end encrypted — clips are deleted when you close your account.',
            textAlign: TextAlign.center,
            style: TextStyle(
              fontFamily: 'Nunito',
              fontWeight: FontWeight.w400,
              fontSize: 11,
              color: AD.textTertiary,
            ),
          ),
        ),
      ],
    );
  }
}

/// Static coral inset border for the recording stage.
///
/// [UI-LIVE-LOOPS-1 2026-08-05] LOOP REMOVED. This used to pulse 1.0 → 0.3 on a
/// 1400ms `repeat(reverse: true)` for the entire recording. It said the same
/// thing the "Rec" pill's blinking dot already says, so it was a second forever-
/// loop competing with the one that means something. The border stays — a solid
/// coral frame reads as "recording" perfectly well — it just no longer breathes.
///
/// [reducedMotion] is kept in the constructor so the ~1 call site compiles
/// unchanged; with no animation left there is nothing for it to gate.
class RecInsetBorder extends StatelessWidget {
  const RecInsetBorder({super.key, required this.reducedMotion});
  final bool reducedMotion;

  @override
  Widget build(BuildContext context) {
    return Positioned.fill(
      child: Padding(
        padding: const EdgeInsets.all(Msg.s2),
        child: DecoratedBox(
          decoration: BoxDecoration(
            borderRadius: Msg.brLg,
            border: Border.all(color: LiveTheme.coral, width: 3),
          ),
        ),
      ),
    );
  }
}

/// A lime progress bar that fills over [durationMs].
class LiveProgressBar extends StatefulWidget {
  const LiveProgressBar({super.key, required this.fill, required this.durationMs});
  final Color fill;
  final int durationMs;
  @override
  State<LiveProgressBar> createState() => _LiveProgressBarState();
}

class _LiveProgressBarState extends State<LiveProgressBar>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c;
  @override
  void initState() {
    super.initState();
    _c = AnimationController(
        vsync: this, duration: Duration(milliseconds: widget.durationMs))
      ..forward();
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 18,
      decoration: BoxDecoration(
        color: const Color(0x24FFFFFF),
        borderRadius: Msg.brPill,
        border: Border.all(color: const Color(0x59FFFFFF), width: 1),
      ),
      child: ClipRRect(
        borderRadius: Msg.brPill,
        child: AnimatedBuilder(
          animation: _c,
          builder: (context, _) => Align(
            alignment: Alignment.centerLeft,
            child: FractionallySizedBox(
              widthFactor: _c.value.clamp(0.0, 1.0),
              child: Container(color: widget.fill),
            ),
          ),
        ),
      ),
    );
  }
}

/// The turn-head guide: caret arrows (3 sizes) each side, lime on the active
/// side + a face circle in the middle.
///
/// [UI-LIVE-LOOPS-1 2026-08-05] LOOP REMOVED. Each caret used to own its own
/// `AnimationController` on a 900ms `repeat(reverse: true)` with a staggered
/// start — SIX simultaneous forever-loops from this one widget, on top of the
/// four others the flow was already running. Which side to turn is already said
/// by colour (lime vs 22%-white) and by the caret sizes ramping outward, so the
/// blink added nothing except six tickers. The arrows are now static.
class TurnHeadGuide extends StatelessWidget {
  const TurnHeadGuide({super.key, required this.leftActive, required this.rightActive});
  final bool leftActive;
  final bool rightActive;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          _carets(PhosphorIcons.caretLeft(PhosphorIconsStyle.bold), leftActive,
              reverse: true),
          const SizedBox(width: Msg.s5),
          Container(
            width: 150,
            height: 150,
            decoration: BoxDecoration(
              color: const Color(0x0FFFFFFF),
              shape: BoxShape.circle,
              border: Border.all(color: LiveTheme.dimPaper, width: 2),
            ),
            child: PhosphorIcon(PhosphorIcons.user(PhosphorIconsStyle.regular),
                size: 92, color: const Color(0xD1FFFFFF)),
          ),
          const SizedBox(width: Msg.s5),
          _carets(PhosphorIcons.caretRight(PhosphorIconsStyle.bold), rightActive),
        ],
      ),
    );
  }

  Widget _carets(IconData icon, bool active, {bool reverse = false}) {
    final color = active ? LiveTheme.lime : const Color(0x38FFFFFF);
    const sizes = [22.0, 30.0, 38.0];
    final row = <Widget>[
      for (var i = 0; i < 3; i++)
        PhosphorIcon(icon, size: sizes[i], color: color),
    ];
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: reverse ? row.reversed.toList() : row,
    );
  }
}

// ── Analyzing stage ─────────────────────────────────────────────────────────

enum RowState { pending, active, done }

class AnalyzeRowData {
  const AnalyzeRowData(this.label, this.state);
  final String label;
  final RowState state;
}

class AnalyzingStage extends StatelessWidget {
  const AnalyzingStage({super.key, required this.rows, required this.reducedMotion});
  final List<AnalyzeRowData> rows;
  final bool reducedMotion;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        _SpinningBadge(reducedMotion: reducedMotion),
        const SizedBox(height: Msg.s5),
        LiveTheme.stageHeadline('Ava is ', markWord: 'checking'),
        const SizedBox(height: Msg.s2),
        Text('Face, motion and voice — all on your device.',
            textAlign: TextAlign.center, style: LiveTheme.subStyle),
        const SizedBox(height: Msg.s5),
        ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 300),
          child: Column(
            children: [
              for (final r in rows)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: Msg.s1),
                  child: _row(r),
                ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _row(AnalyzeRowData r) {
    Widget marker;
    switch (r.state) {
      case RowState.done:
        marker = Container(
          width: 22,
          height: 22,
          decoration: BoxDecoration(
            color: LiveTheme.mint,
            shape: BoxShape.circle,
            border: Border.all(color: LiveTheme.ink, width: 1),
          ),
          child: PhosphorIcon(PhosphorIcons.check(PhosphorIconsStyle.bold),
              size: 12, color: LiveTheme.paper),
        );
        break;
      case RowState.active:
        marker = SizedBox(
          width: 22,
          height: 22,
          child: reducedMotion
              ? PhosphorIcon(
                  PhosphorIcons.arrowsClockwise(PhosphorIconsStyle.regular),
                  size: 20,
                  color: LiveTheme.lilac)
              : const CircularProgressIndicator(strokeWidth: 2.5, color: LiveTheme.lilac),
        );
        break;
      case RowState.pending:
        marker = Container(
          width: 22,
          height: 22,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            border: Border.all(color: LiveTheme.dimPaper, width: 1),
          ),
        );
        break;
    }
    return Opacity(
      opacity: r.state == RowState.pending ? 0.45 : 1,
      child: Row(
        children: [
          marker,
          const SizedBox(width: Msg.s3),
          Expanded(child: Text(r.label, style: LiveTheme.checkRowStyle)),
        ],
      ),
    );
  }
}

/// The analyse-stage badge: two concentric dashed rings around a lilac disc.
///
/// [UI-LIVE-LOOPS-1 2026-08-05] LOOP REMOVED. The two rings used to
/// counter-rotate forever off a single 5s `repeat()` — a decorative "thinking"
/// spinner sitting directly above a column of rows that ALREADY each show a real
/// `CircularProgressIndicator` for the check actually in progress. Two spinners
/// saying the same thing is one spinner too many, and only one of them was
/// telling the truth about progress. The rings are now static; the per-row
/// indicators are the live signal.
///
/// The name and [reducedMotion] parameter are kept so the call site is unchanged.
class _SpinningBadge extends StatelessWidget {
  const _SpinningBadge({required this.reducedMotion});
  final bool reducedMotion;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 170,
      height: 170,
      child: Stack(
        alignment: Alignment.center,
        children: [
          CustomPaint(size: const Size(170, 170), painter: _DashedRing(1)),
          CustomPaint(size: const Size(138, 138), painter: _DashedRing(0.45)),
          Container(
            width: 96,
            height: 96,
            decoration: BoxDecoration(
              color: LiveTheme.lilac,
              shape: BoxShape.circle,
              border: Border.all(color: LiveTheme.ink, width: 1),
            ),
            child: PhosphorIcon(PhosphorIcons.sparkle(PhosphorIconsStyle.regular),
                size: 44, color: LiveTheme.paper),
          ),
        ],
      ),
    );
  }
}

class _DashedRing extends CustomPainter {
  _DashedRing(this.opacity);
  final double opacity;
  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = opacity < 1 ? 2 : 3
      ..color = LiveTheme.lilac.withValues(alpha: opacity);
    final rect = Offset.zero & size;
    final path = Path()..addOval(rect.deflate(2));
    const dash = 8.0, gap = 8.0;
    for (final m in path.computeMetrics()) {
      var d = 0.0;
      while (d < m.length) {
        canvas.drawPath(m.extractPath(d, d + dash), paint);
        d += dash + gap;
      }
    }
  }

  @override
  bool shouldRepaint(_DashedRing old) => false;
}

// ── Accepted stage ──────────────────────────────────────────────────────────

class AcceptedStage extends StatefulWidget {
  const AcceptedStage({
    super.key,
    required this.reducedMotion,
    required this.listingContext,
    required this.onCta,
  });
  final bool reducedMotion;
  final bool listingContext;
  final VoidCallback onCta;
  @override
  State<AcceptedStage> createState() => _AcceptedStageState();
}

class _AcceptedStageState extends State<AcceptedStage>
    with SingleTickerProviderStateMixin {
  late final AnimationController _pop;
  @override
  void initState() {
    super.initState();
    // [UI-MSG-MOTION-1] 450ms → Msg.slow (320). One-shot entrance, not a loop.
    _pop = AnimationController(vsync: this, duration: Msg.slow);
    if (widget.reducedMotion) {
      _pop.value = 1;
    } else {
      _pop.forward();
    }
  }

  @override
  void dispose() {
    _pop.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(
          child: Stack(
            alignment: Alignment.center,
            children: [
              // [UI-LIVE-LOOPS-1 2026-08-05] The floating `_Confetti` layer used
              // to live here — six pieces bobbing on a 1600ms `repeat(reverse:
              // true)` for as long as this screen stayed up. It was pure
              // decoration on the LAST screen of a compliance flow, and it was
              // the sixth simultaneous loop. The one-shot `_pop` scale on the
              // tick below is the celebration now.
              Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  ScaleTransition(
                    scale: CurvedAnimation(parent: _pop, curve: Msg.curve),
                    child: Container(
                      width: 128,
                      height: 128,
                      decoration: BoxDecoration(
                        color: LiveTheme.lime,
                        shape: BoxShape.circle,
                        border: Border.all(color: LiveTheme.ink, width: 1),
                      ),
                      child: PhosphorIcon(PhosphorIcons.check(PhosphorIconsStyle.bold),
                          size: 60, color: LiveTheme.paper),
                    ),
                  ),
                  const SizedBox(height: Msg.s4),
                  Container(
                    padding: const EdgeInsets.symmetric(
                        horizontal: Msg.s4, vertical: Msg.s2),
                    decoration: BoxDecoration(
                      color: LiveTheme.mint,
                      borderRadius: Msg.brPill,
                      border: Border.all(color: LiveTheme.ink, width: 1),
                    ),
                    child: Row(mainAxisSize: MainAxisSize.min, children: [
                      PhosphorIcon(PhosphorIcons.sealCheck(PhosphorIconsStyle.regular),
                          size: 14, color: LiveTheme.paper),
                      const SizedBox(width: Msg.s2),
                      const Text('Verified',
                          style: TextStyle(
                            fontFamily: 'Nunito',
                            fontWeight: FontWeight.w600,
                            fontSize: 12,
                            color: LiveTheme.paper,
                          )),
                    ]),
                  ),
                  const SizedBox(height: Msg.s4),
                  LiveTheme.stageHeadline('Accepted — you are ', markWord: 'in'),
                  const SizedBox(height: Msg.s2),
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: Msg.s2),
                    child: Text(
                      widget.listingContext
                          ? "Liveness passed. You're free to make a listing now."
                          : "Liveness passed. Verified features are now unlocked.",
                      textAlign: TextAlign.center,
                      style: LiveTheme.subStyle,
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
        const SizedBox(height: Msg.s4),
        // Delete-mode storage card.
        Container(
          padding: const EdgeInsets.all(Msg.s4),
          decoration: LiveTheme.taperedCardDecoration,
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 34,
                height: 34,
                decoration: BoxDecoration(
                  color: LiveTheme.mint,
                  borderRadius: Msg.brMd,
                  border: Border.all(color: LiveTheme.ink, width: 1),
                ),
                child: PhosphorIcon(PhosphorIcons.shield(PhosphorIconsStyle.regular),
                    size: 18, color: LiveTheme.paper),
              ),
              const SizedBox(width: Msg.s3),
              const Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Delete-mode storage',
                        style: TextStyle(
                          fontFamily: 'Nunito',
                          fontWeight: FontWeight.w600,
                          fontSize: 14,
                          color: AD.textPrimary,
                        )),
                    SizedBox(height: Msg.s1),
                    Text(
                      'Your video is erased automatically the moment you close your account with us.',
                      style: TextStyle(
                        fontFamily: 'Nunito',
                        fontWeight: FontWeight.w400,
                        fontSize: 12,
                        height: 1.45,
                        color: AD.textSecondary,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: Msg.s4),
        LiveTheme.limeButton(
          label: widget.listingContext ? 'Create a listing' : 'Done',
          icon: widget.listingContext
              ? PhosphorIcons.storefront(PhosphorIconsStyle.bold)
              : PhosphorIcons.check(PhosphorIconsStyle.bold),
          onPressed: widget.onCta,
        ),
      ],
    );
  }
}

// [UI-LIVE-LOOPS-1 2026-08-05] `_Confetti` was deleted here. It bobbed six
// coloured squares/dots forever on a 1600ms `repeat(reverse: true)` behind the
// accepted screen. Nothing referenced it except `AcceptedStage`, and nothing
// depended on its controller. If a celebration is ever wanted again, make it a
// ONE-SHOT that settles — not another infinite loop.
