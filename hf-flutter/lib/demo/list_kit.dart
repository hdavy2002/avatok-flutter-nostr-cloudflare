import 'package:flutter/material.dart';

import 'data.dart';
import 'theme.dart';
import 'widgets.dart';

/// [HF-APP-DESI-7] Call records and My bookings pieces, built to the owner-approved canvas previews "7 · Call records" and
/// "7b · My bookings" (2026-10-22). Shared by the demo and real screens.

const _edges = [Color(0xFFF8C4D9), Color(0xFFDDD2FB), Color(0xFFB9E2E5), Color(0xFFF3DFB3)];

/// Soft header card: eyebrow, title, one line and a ghost word. Lavender for calls, teal for bookings.
class ListHero extends StatelessWidget {
  const ListHero({super.key, required this.eyebrow, required this.title, required this.sub, required this.ghost, this.teal = false});
  final String eyebrow;
  final String title;
  final String sub;
  final String ghost;
  final bool teal;
  @override
  Widget build(BuildContext context) {
    final ink = teal ? C.peacock : C.lav;
    return Container(
      clipBehavior: Clip.antiAlias,
      constraints: const BoxConstraints(minHeight: 110),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(24),
        border: Border.all(color: C.line),
        gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: teal ? const [Color(0xFFD5EEF0), C.teatint, C.ivory] : const [Color(0xFFEAE3FE), C.lavtint, C.ivory]),
      ),
      child: Stack(children: [
        Positioned(
          right: 10,
          bottom: -14,
          child: ExcludeSemantics(child: Text(ghost.toUpperCase(), style: tOutline(70, color: ink.withValues(alpha: .18), stroke: 2))),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(18, 16, 18, 16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(eyebrow.toUpperCase(), style: t(14, color: ink, w: FontWeight.w800, ls: .06)),
            const SizedBox(height: 2),
            Text(title, style: t(24, w: FontWeight.w900)),
            const SizedBox(height: 2),
            Text(sub, style: t(15, color: C.muted, w: FontWeight.w700)),
          ]),
        ),
      ]),
    );
  }
}

/// One call: photo, name, when/minutes (or a grey "Didn't connect" chip), stars, amount chip and a plum Call again.
class CallRecordCard extends StatelessWidget {
  const CallRecordCard({
    super.key,
    required this.index,
    required this.who,
    required this.name,
    required this.detail,
    required this.amount,
    this.when,
    this.failed = false,
    this.stars = 0,
    this.onCallAgain,
    this.onMore,
  });
  final int index;
  final Influencer who;
  final String name;
  final String detail;

  /// Shown above a failed call's chip.
  final String? when;
  final bool failed;
  final int stars;
  final String amount;
  final VoidCallback? onCallAgain;

  /// [HF-APP-PARITY-SAFETY] The "..." menu (Report a person, Block) for this call; null hides it.
  final VoidCallback? onMore;

  @override
  Widget build(BuildContext context) {
    final edge = _edges[index % _edges.length];
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: C.white,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: edge, width: 2),
        boxShadow: const [BoxShadow(color: Color(0x404A1747), offset: Offset(0, 8), blurRadius: 18, spreadRadius: -12)],
      ),
      child: Row(children: [
        Container(padding: const EdgeInsets.all(2), decoration: BoxDecoration(color: edge, shape: BoxShape.circle), child: Avatar(who, size: 50, ring: false)),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: t(16, w: FontWeight.w900)),
            if (failed) ...[
              if (when != null) Text(when!, style: t(14, color: C.muted, w: FontWeight.w700)),
              const SizedBox(height: 2),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 1),
                decoration: BoxDecoration(color: const Color(0xFFF3EEF2), borderRadius: BorderRadius.circular(999)),
                child: Text(detail, style: t(14, color: C.muted, w: FontWeight.w800)),
              ),
            ] else
              Text(detail, style: t(14, color: C.muted, w: FontWeight.w700)),
            if (stars > 0) Text('★' * stars, style: t(14, color: C.marigold, ls: .1)),
          ]),
        ),
        const SizedBox(width: 8),
        Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
            decoration: BoxDecoration(color: failed ? const Color(0xFFF3EEF2) : C.blush, borderRadius: BorderRadius.circular(999)),
            child: Text(amount, style: t(16, color: failed ? C.muted : const Color(0xFFB0145B), w: FontWeight.w900)),
          ),
          if (onCallAgain != null) ...[
            const SizedBox(height: 6),
            Semantics(
              button: true,
              child: Material(
                color: C.maroon,
                shape: const StadiumBorder(),
                child: InkWell(
                  customBorder: const StadiumBorder(),
                  onTap: onCallAgain,
                  child: Container(
                    constraints: const BoxConstraints(minHeight: 44),
                    padding: const EdgeInsets.symmetric(horizontal: 12),
                    child: Row(mainAxisSize: MainAxisSize.min, children: [
                      const Icon(Icons.call_rounded, size: 16, color: C.white),
                      const SizedBox(width: 6),
                      Text('Call again', style: t(14, color: C.white, w: FontWeight.w800)),
                    ]),
                  ),
                ),
              ),
            ),
          ],
          if (onMore != null)
            Semantics(
              button: true,
              label: 'More: report or block',
              child: InkResponse(radius: 24, onTap: onMore, child: const SizedBox(width: 48, height: 48, child: Icon(Icons.more_horiz_rounded, color: C.maroon))),
            ),
        ]),
      ]),
    );
  }
}

enum BookingKind { waiting, confirmed, completed, cancelled, failed, other }

/// Status chip: icon + words, coloured per state.
class BookingStatusChip extends StatelessWidget {
  const BookingStatusChip(this.kind, {super.key});
  final BookingKind kind;
  @override
  Widget build(BuildContext context) {
    final (IconData icon, String text, Color bg, Color fg) = switch (kind) {
      BookingKind.waiting => (Icons.hourglass_top_rounded, 'Waiting for approval', C.goldtint, C.amber),
      BookingKind.confirmed => (Icons.check_rounded, 'Confirmed', C.teatint, const Color(0xFF0B5F66)),
      BookingKind.completed => (Icons.task_alt_rounded, 'Completed', C.lavtint, const Color(0xFF5B3FC0)),
      BookingKind.cancelled => (Icons.close_rounded, 'Cancelled', const Color(0xFFF3EEF2), C.ruby),
      BookingKind.failed => (Icons.error_outline_rounded, 'Did not happen', const Color(0xFFF3EEF2), C.ruby),
      BookingKind.other => (Icons.info_outline_rounded, 'In progress', C.teatint, const Color(0xFF0B5F66)),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(999)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(icon, size: 16, color: fg),
        const SizedBox(width: 5),
        Flexible(child: Text(text, style: t(14, color: fg, w: FontWeight.w800))),
      ]),
    );
  }
}

/// A booking ticket: coloured date stub, photo + name, time, topic, held line, status chip + extra lines, Cancel behind a tear.
class BookingTicketCard extends StatelessWidget {
  const BookingTicketCard({
    super.key,
    required this.index,
    required this.stub,
    required this.who,
    required this.name,
    required this.time,
    required this.held,
    this.kind = BookingKind.confirmed,
    this.topic,
    this.topicKey,
    this.chip,
    this.extra = const [],
    this.onCancel,
    this.cancelKey,
    this.cancelEnabled = true,
    this.highlighted = false,
  });
  final int index;

  /// (weekday, day number, month) — or a single label in the first slot.
  final (String, String, String) stub;
  final Influencer who;
  final String name;
  final String time;
  final String held;
  final BookingKind kind;
  final String? topic;
  final Key? topicKey;
  final Widget? chip;
  final List<Widget> extra;
  final VoidCallback? onCancel;
  final Key? cancelKey;
  final bool cancelEnabled;
  final bool highlighted;

  @override
  Widget build(BuildContext context) {
    final (Color stubBg, Color stubInk) = switch (kind) {
      BookingKind.waiting => (C.goldtint, C.amber),
      BookingKind.confirmed || BookingKind.other => (C.teatint, C.peacock),
      BookingKind.completed => (C.lavtint, C.lav),
      BookingKind.cancelled || BookingKind.failed => (const Color(0xFFF3EEF2), C.muted),
    };
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: C.white,
        borderRadius: BorderRadius.circular(22),
        border: Border.all(color: highlighted ? C.maroon : _edges[index % _edges.length], width: highlighted ? 3 : 2),
        boxShadow: const [BoxShadow(color: Color(0x404A1747), offset: Offset(0, 8), blurRadius: 18, spreadRadius: -12)],
      ),
      child: IntrinsicHeight(
        child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Container(
            width: 58,
            padding: const EdgeInsets.symmetric(vertical: 6),
            decoration: BoxDecoration(color: stubBg, borderRadius: BorderRadius.circular(16)),
            child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
              if (stub.$1.isNotEmpty) Text(stub.$1, textAlign: TextAlign.center, style: t(14, color: stubInk, w: FontWeight.w800)),
              if (stub.$2.isNotEmpty) Text(stub.$2, style: t(24, color: C.deep, w: FontWeight.w900, h: 1)),
              if (stub.$3.isNotEmpty) Text(stub.$3, style: t(14, color: stubInk, w: FontWeight.w800)),
            ]),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisAlignment: MainAxisAlignment.center, children: [
              Row(children: [
                Avatar(who, size: 30, ring: false),
                const SizedBox(width: 8),
                Expanded(child: Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: t(16, w: FontWeight.w900))),
              ]),
              const SizedBox(height: 4),
              Text(time, style: t(15, color: C.maroon, w: FontWeight.w800)),
              if (topic != null) Text('About: $topic', key: topicKey, style: t(14, color: C.amber, w: FontWeight.w700)),
              Text(held, style: t(14, color: C.muted, w: FontWeight.w700)),
              if (chip != null) ...[const SizedBox(height: 6), chip!],
              ...extra,
            ]),
          ),
          if (onCancel != null) ...[
            const SizedBox(width: 8),
            const SizedBox(width: 3, child: DashedLine(color: C.line)),
            const SizedBox(width: 8),
            Column(mainAxisAlignment: MainAxisAlignment.center, children: [
              Semantics(
                button: true,
                child: Material(
                  color: C.white,
                  shape: StadiumBorder(side: BorderSide(color: cancelEnabled ? const Color(0xFFF6C2D8) : C.line, width: 1.5)),
                  child: InkWell(
                    key: cancelKey,
                    customBorder: const StadiumBorder(),
                    onTap: onCancel,
                    child: Container(
                      constraints: const BoxConstraints(minHeight: 44),
                      padding: const EdgeInsets.symmetric(horizontal: 12),
                      alignment: Alignment.center,
                      child: Text('Cancel', style: t(14, color: cancelEnabled ? C.rani : C.muted, w: FontWeight.w800)),
                    ),
                  ),
                ),
              ),
            ]),
          ],
        ]),
      ),
    );
  }
}

/// "Earlier" with a dashed gold rule.
class EarlierDivider extends StatelessWidget {
  const EarlierDivider({super.key});
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 4, bottom: 12),
        child: Row(children: [
          Text('Earlier', style: t(18, color: C.maroon, w: FontWeight.w900)),
          const SizedBox(width: 10),
          const Expanded(child: SizedBox(height: 2, child: DashedLine(vertical: false, color: Color(0xFFF3DFB3), width: 2))),
        ]),
      );
}

/// Ghost "LOAD MORE" pill.
class LoadMorePill extends StatelessWidget {
  const LoadMorePill({super.key, required this.label, required this.onTap});
  final String label;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) => Semantics(
        button: true,
        child: Material(
          color: C.white,
          shape: const StadiumBorder(side: BorderSide(color: Color(0xFFDDD2FB), width: 1.5)),
          child: InkWell(
            customBorder: const StadiumBorder(),
            onTap: onTap,
            child: SizedBox(height: 52, child: Center(child: Text(label, style: t(16, color: C.maroon, w: FontWeight.w800)))),
          ),
        ),
      );
}

const _wd = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const _mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/// Stub parts for a date.
(String, String, String) stubOf(DateTime d) => (_wd[d.weekday - 1], '${d.day}', _mo[d.month - 1]);

/// Stub parts from a demo day label like "Sat 24 Oct"; anything else goes in one line.
(String, String, String) stubOfLabel(String label) {
  final p = label.split(' ');
  if (p.length == 3) return (p[0], p[1], p[2]);
  if (p.length == 2) return (p[0], p[1], '');
  return (label, '', '');
}
