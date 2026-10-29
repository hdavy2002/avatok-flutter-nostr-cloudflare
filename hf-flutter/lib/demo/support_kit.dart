import 'dart:io' show Platform;

import 'package:flutter/foundation.dart' show defaultTargetPlatform;
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../core/brand.dart';
import '../data/api_exception.dart';
import '../data/merch_art_picker.dart';
import '../data/models/support.dart';
import '../data/repos/settings_repo.dart' show AppVersionInfo;
import '../data/repos/support_repo.dart';
import 'desi.dart';
import 'theme.dart';

/// [HF-SUPPORT-APP] Shared pieces of the in-app policy pages and Contact Support, built to the owner-approved mock-ups
/// (Main, AppSupport, AppTicket, 2026-10-29): deep parchment page, white cards with a flower in the corner (never over text),
/// tinted tiles, solid buttons, Comfortaa titles and Nunito text.

/// Comfortaa title style (bundled in the app; weight 700).
TextStyle supTitle(double size, {Color color = C.maroon}) =>
    TextStyle(fontFamily: 'Comfortaa', fontSize: size, fontWeight: FontWeight.w700, color: color, height: 1.2);

/// Back circle, title (Comfortaa) and a marigold on the right. [eyebrow] is the small rose line above the title (the ticket number).
class SupHeader extends StatelessWidget {
  const SupHeader({super.key, required this.title, this.eyebrow, this.titleSize = 25, this.onBack, this.flower = true});

  final String title;
  final String? eyebrow;
  final double titleSize;
  final VoidCallback? onBack;
  final bool flower;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(20, 16, 20, 10),
        child: Row(children: [
          Semantics(
            button: true,
            label: 'Back',
            child: Material(
              color: C.cream,
              shape: const CircleBorder(),
              child: InkWell(
                customBorder: const CircleBorder(),
                onTap: onBack ??
                    () {
                      if (context.canPop()) {
                        context.pop();
                      } else {
                        context.go('/reels');
                      }
                    },
                child: const SizedBox(width: 48, height: 48, child: Icon(Icons.arrow_back_rounded, color: C.deep, size: 22)),
              ),
            ),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              if (eyebrow != null) Text(eyebrow!, style: t(14, color: C.tan, w: FontWeight.w800)),
              Semantics(header: true, child: Text(title, style: supTitle(titleSize))),
            ]),
          ),
          if (flower) ...[const SizedBox(width: 10), const Marigold(size: 40)],
        ]),
      );
}

/// White card with a thin parchment border and an optional flower in the top-right corner. The flower sits half outside the card
/// and is clipped; headings inside leave [flowerRoom] free on the right so it never covers text.
class SupCard extends StatelessWidget {
  const SupCard({super.key, required this.child, this.corner = DesiCorner.none, this.padding = const EdgeInsets.fromLTRB(18, 20, 18, 20), this.radius = 24});

  final Widget child;
  final DesiCorner corner;
  final EdgeInsets padding;
  final double radius;

  /// Width kept free at the right of a heading when the card has a flower.
  static const double flowerRoom = 44;

  Widget _flower() => switch (corner) {
        DesiCorner.marigold => const Marigold(size: 50),
        DesiCorner.yellow => const Marigold(size: 50, yellow: true),
        DesiCorner.hibiscus => const Hibiscus(size: 44),
        DesiCorner.jasmine => const Jasmine(size: 28),
        DesiCorner.none => const SizedBox.shrink(),
      };

  @override
  Widget build(BuildContext context) => Container(
        decoration: BoxDecoration(color: C.white, borderRadius: BorderRadius.circular(radius), border: Border.all(color: C.line)),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(radius - 1),
          child: Stack(children: [
            if (corner != DesiCorner.none) Positioned(right: -12, top: -12, child: _flower()),
            Padding(padding: padding, child: child),
          ]),
        ),
      );
}

/// Card heading with room for the corner flower.
class SupHeading extends StatelessWidget {
  const SupHeading(this.text, {super.key, this.sub, this.flower = true});

  final String text;
  final String? sub;
  final bool flower;

  @override
  Widget build(BuildContext context) => Padding(
        padding: EdgeInsets.only(right: flower ? SupCard.flowerRoom : 0, bottom: sub == null ? 12 : 16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Semantics(header: true, child: Text(text, style: t(19, color: C.maroon, w: FontWeight.w800))),
          if (sub != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text(sub!, style: t(14, color: C.muted, w: FontWeight.w600, h: 1.5))),
        ]),
      );
}

/// Status pill: We replied (green tint), Open (gold), Solved (lavender), Closed (grey).
class SupStatusChip extends StatelessWidget {
  const SupStatusChip({super.key, required this.tone, required this.label, this.big = false});

  final SupportTone tone;
  final String label;
  final bool big;

  static (Color, Color) colors(SupportTone tone) => switch (tone) {
        SupportTone.replied => (C.onlineBg, C.onlineInk),
        SupportTone.open => (C.goldtint, C.amber),
        SupportTone.solved => (C.lavtint, C.lav),
        SupportTone.closed => (const Color(0xFFECE6EC), C.muted),
      };

  @override
  Widget build(BuildContext context) {
    final (bg, ink) = colors(tone);
    return Container(
      padding: EdgeInsets.symmetric(horizontal: big ? 12 : 10, vertical: big ? 6 : 6),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(999)),
      child: Text(label, style: t(14, color: ink, w: FontWeight.w800)),
    );
  }
}

/// Solid pill button (no gradient). [color] is the fill; text is white.
class SupSolidButton extends StatelessWidget {
  const SupSolidButton({super.key, required this.label, required this.onTap, this.color = C.maroon, this.height = 56, this.busy = false});

  final String label;
  final VoidCallback? onTap;
  final Color color;
  final double height;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final enabled = onTap != null && !busy;
    return Semantics(
      button: true,
      enabled: enabled,
      label: label,
      child: Opacity(
        opacity: onTap == null ? 0.45 : 1,
        child: SizedBox(
          height: height,
          width: double.infinity,
          child: Material(
            color: color,
            shape: const StadiumBorder(),
            child: InkWell(
              customBorder: const StadiumBorder(),
              onTap: enabled ? onTap : null,
              child: Center(
                child: busy
                    ? const SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 3, color: C.white))
                    : Text(label, style: t(17, color: C.white, w: FontWeight.w800, ls: .04)),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Input style of the mock-ups: cream fill, 1.5 px parchment border, 16 px corners.
InputDecoration supField({String? hint}) {
  OutlineInputBorder b(Color c, double w) => OutlineInputBorder(borderRadius: BorderRadius.circular(16), borderSide: BorderSide(color: c, width: w));
  return InputDecoration(
    hintText: hint,
    counterText: '',
    filled: true,
    fillColor: C.cream,
    contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
    border: b(C.line, 1.5),
    enabledBorder: b(C.line, 1.5),
    focusedBorder: b(C.maroon, 2),
  );
}

// ---------------------------------------------------------------------------------------------- times (always India time)

const List<String> _mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const List<String> _wd = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

DateTime _ist(int ms) => DateTime.fromMillisecondsSinceEpoch(ms, isUtc: true).add(const Duration(hours: 5, minutes: 30));

/// "6:42 pm"
String supClock(int ms) {
  final d = _ist(ms);
  final h = d.hour % 12 == 0 ? 12 : d.hour % 12;
  return '$h:${d.minute.toString().padLeft(2, '0')} ${d.hour >= 12 ? 'pm' : 'am'}';
}

/// "Mon 27 Oct, 6:42 pm"
String supStamp(int ms) {
  final d = _ist(ms);
  return '${_wd[d.weekday - 1]} ${d.day} ${_mon[d.month - 1]}, ${supClock(ms)}';
}

/// "Tue 28 Oct · 11:05 am"
String supStampDot(int ms) {
  final d = _ist(ms);
  return '${_wd[d.weekday - 1]} ${d.day} ${_mon[d.month - 1]} · ${supClock(ms)}';
}

/// My tickets row time: "Just now", "5 min ago", "2 h ago", "Yesterday", "12 Oct" (with the year when it is not this year).
String supWhen(int ms, {DateTime? now}) {
  final nowUtc = (now ?? DateTime.now()).toUtc();
  final diff = nowUtc.millisecondsSinceEpoch - ms;
  if (diff < 60 * 1000) return 'Just now';
  if (diff < 3600 * 1000) return '${diff ~/ 60000} min ago';
  if (diff < 24 * 3600 * 1000) return '${diff ~/ 3600000} h ago';
  final a = _ist(ms);
  final b = _ist(nowUtc.millisecondsSinceEpoch);
  final days = DateTime.utc(b.year, b.month, b.day).difference(DateTime.utc(a.year, a.month, a.day)).inDays;
  if (days == 1) return 'Yesterday';
  return a.year == b.year ? '${a.day} ${_mon[a.month - 1]}' : '${a.day} ${_mon[a.month - 1]} ${a.year}';
}

/// True when the team is away (they work 10 am to 7 pm India time, Monday to Saturday).
bool supOutsideHours({DateTime? now}) {
  final d = _ist((now ?? DateTime.now()).toUtc().millisecondsSinceEpoch);
  return d.weekday == DateTime.sunday || d.hour < 10 || d.hour >= 19;
}

/// The note shown after a ticket is sent (contract rule: the acknowledgement line, plus the hours line when the team is away).
String supAckText(String number, {DateTime? now}) {
  final base = 'Your ticket $number is open. Someone from ${Brand.name} will respond back soon.';
  return supOutsideHours(now: now) ? '$base Our team works 10 am–7 pm IST, Monday to Saturday. We\'ll reply within 24 hours.' : base;
}

// ---------------------------------------------------------------------------------------------- files and meta

/// Most pictures on one message.
const int kSupportMaxFiles = 4;

/// A picture the person chose, and its id once it is uploaded (so a retry after a failed send does not upload it twice).
class SupportDraft {
  SupportDraft(this.art);

  final PickedArt art;
  String? uploadedId;
}

/// Opens the phone's picture chooser (the same one the merch screens use: no extra package, no permission) and returns the
/// pick, or null when she backs out or the picture is refused ([onProblem] gets the plain-words reason).
Future<SupportDraft?> pickSupportPicture(Future<PickedArt?> Function()? custom, void Function(String problem) onProblem) async {
  try {
    final art = await (custom ?? () => MerchArtPicker.pick(allowWebp: true))();
    if (art == null) return null;
    if (art.problem != null) {
      onProblem(art.problem!);
      return null;
    }
    if (art.bytes.length > SupportRepo.maxFileBytes) {
      onProblem('That picture is bigger than 10 MB. Please choose a smaller one.');
      return null;
    }
    return SupportDraft(art);
  } catch (_) {
    onProblem('We could not open your photos. Please try again.');
    return null;
  }
}

/// Uploads every picture that is not up yet and returns all their ids, in order.
Future<List<String>> uploadSupportDrafts(SupportRepo repo, List<SupportDraft> drafts) async {
  final ids = <String>[];
  for (final d in drafts) {
    d.uploadedId ??= (await repo.upload(d.art.bytes, contentType: d.art.mime, fileName: d.art.name)).id;
    ids.add(d.uploadedId!);
  }
  return ids;
}

/// What the app tells support about itself with every ticket: app version and build, and the phone's platform and system version.
/// (There is no device-model helper in the app, so the model is not sent.)
Future<Map<String, Object?>> supportMeta() async {
  final v = await AppVersionInfo.load();
  var os = '';
  try {
    os = Platform.operatingSystemVersion.trim();
  } catch (_) {
    os = '';
  }
  if (os.length > 120) os = os.substring(0, 120);
  return <String, Object?>{
    if (v.version.isNotEmpty) 'appVersion': v.version,
    if (v.build.isNotEmpty) 'build': v.build,
    'platform': defaultTargetPlatform.name,
    if (os.isNotEmpty) 'os': os,
  };
}

/// Plain words for a failed support call.
String supportErrorText(Object e) {
  if (e is ApiException) {
    if (e.status == 429 && (e.message ?? '').isEmpty) return 'You have reached today\'s limit of 5 tickets. Please reply on one of your open tickets, or try again tomorrow.';
    return e.userMessage;
  }
  return ApiException.genericText;
}

/// The chosen pictures as removable chips.
class SupportDraftChips extends StatelessWidget {
  const SupportDraftChips({super.key, required this.drafts, required this.onRemove});

  final List<SupportDraft> drafts;
  final void Function(SupportDraft d) onRemove;

  @override
  Widget build(BuildContext context) => Wrap(spacing: 8, runSpacing: 8, children: [
        for (final d in drafts)
          Container(
            constraints: const BoxConstraints(minHeight: 40, maxWidth: 240),
            padding: const EdgeInsets.only(left: 12),
            decoration: BoxDecoration(color: C.lavtint, borderRadius: BorderRadius.circular(14)),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              const Icon(Icons.image_rounded, size: 18, color: C.lav),
              const SizedBox(width: 6),
              Flexible(child: Text(d.art.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: t(14, color: C.lav, w: FontWeight.w800))),
              IconButton(
                tooltip: 'Remove',
                constraints: const BoxConstraints(minWidth: 48, minHeight: 40),
                padding: EdgeInsets.zero,
                icon: const Icon(Icons.close_rounded, size: 18, color: C.lav),
                onPressed: () => onRemove(d),
              ),
            ]),
          ),
      ]);
}
