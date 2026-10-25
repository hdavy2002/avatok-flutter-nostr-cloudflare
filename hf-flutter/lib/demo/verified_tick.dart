import 'package:flutter/material.dart';

import '../data/models/spaces.dart';
import '../data/telemetry.dart';
import 'theme.dart';

/// [HF-VERIFIED-BLIP-1 2026-10-25] The verified tick beside a creator's name, on every screen that shows one (same rule as the web).
/// Green = Video KYC verified (Aadhaar + approved selfie video; the one allowed green). Lavender indigo = a social channel verified
/// but no Video KYC yet. Nothing when only the WhatsApp number is checked. Tapping opens a sheet that lists every check.
/// Telemetry: hf_verified_tick_shown {surface, level} once per mount; hf_verified_tick_tap {surface, level}.
class VerifiedTick extends StatefulWidget {
  const VerifiedTick({
    super.key,
    required this.name,
    required this.videoKyc,
    required this.channel,
    required this.surface,
    this.space,
    this.phone = false,
    this.size = 22,
    this.interactive = true,
  });

  final String name;
  final bool videoKyc;
  final bool channel;
  final String surface;

  /// `women` / `lgbtq` / null.
  final String? space;

  /// The WhatsApp number was checked by a one-time code (listed in the sheet only).
  final bool phone;
  final double size;

  /// False where the tick sits inside something already tappable (a row that opens the profile).
  final bool interactive;

  /// True when this creator earns a tick at all.
  static bool earns({required bool videoKyc, required bool channel}) => videoKyc || channel;

  @override
  State<VerifiedTick> createState() => _VerifiedTickState();
}

class _VerifiedTickState extends State<VerifiedTick> {
  String get _level => widget.videoKyc ? 'kyc' : 'channel';
  String get _label => widget.videoKyc ? 'Video KYC verified' : 'Channel verified';

  @override
  void initState() {
    super.initState();
    if (VerifiedTick.earns(videoKyc: widget.videoKyc, channel: widget.channel)) {
      Telemetry.event('hf_verified_tick_shown', {'surface': widget.surface, 'level': _level});
    }
  }

  Widget _dot(double size) => Container(
        width: size,
        height: size,
        decoration: BoxDecoration(color: widget.videoKyc ? C.kycGreen : C.lav, shape: BoxShape.circle),
        child: Icon(Icons.check_rounded, size: size * .72, color: C.white),
      );

  Future<void> _open() async {
    Telemetry.event('hf_verified_tick_tap', {'surface': widget.surface, 'level': _level});
    final first = widget.name.trim().split(RegExp(r'\s+')).first;
    final lane = SpaceLane.parse(widget.space);
    final rows = <(bool, bool, String, String)>[
      (widget.videoKyc, true, 'Video KYC', widget.videoKyc ? 'Aadhaar checked and a selfie video approved by our team.' : 'Not done yet.'),
      if (widget.phone) (true, false, 'WhatsApp number', 'Confirmed with a one-time code. Never shown to callers.'),
      (
        widget.channel,
        false,
        'Social channel',
        widget.channel ? 'Ownership checked with a code in the bio.' : (widget.videoKyc ? 'Not connected. Video KYC already proves who they are.' : 'Not connected.'),
      ),
      if (lane != null) (true, false, lane.tagText, lane == SpaceLane.women ? 'Only verified women can call.' : 'Only verified LGBTQ+ members can call.'),
    ];
    await showModalBottomSheet<void>(
      context: context,
      useRootNavigator: true,
      showDragHandle: true,
      isScrollControlled: true,
      backgroundColor: C.paper,
      builder: (sheet) => SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(22, 0, 22, 20),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Flexible(child: Text('$first is verified', style: t(22, w: FontWeight.w900))),
              const SizedBox(width: 6),
              _dot(20),
            ]),
            const SizedBox(height: 6),
            Text('What we checked before $first could take calls.', style: t(15, color: C.muted, w: FontWeight.w700, h: 1.4)),
            const SizedBox(height: 10),
            for (final r in rows)
              Container(
                padding: const EdgeInsets.symmetric(vertical: 12),
                decoration: const BoxDecoration(border: Border(top: BorderSide(color: C.line))),
                child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Container(
                    width: 30,
                    height: 30,
                    decoration: BoxDecoration(color: r.$1 ? (r.$2 ? C.kycGreen : C.lav) : C.brass, shape: BoxShape.circle),
                    child: Icon(r.$1 ? Icons.check_rounded : Icons.remove_rounded, size: 18, color: C.white),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(r.$3, style: t(16, w: FontWeight.w900)),
                      const SizedBox(height: 2),
                      Text(r.$4, style: t(14, color: C.muted, w: FontWeight.w700, h: 1.4)),
                    ]),
                  ),
                ]),
              ),
          ]),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (!VerifiedTick.earns(videoKyc: widget.videoKyc, channel: widget.channel)) return const SizedBox.shrink();
    if (!widget.interactive) return Semantics(label: _label, child: _dot(widget.size));
    return Semantics(
      button: true,
      label: '$_label. See what we checked',
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: _open,
        child: Padding(padding: const EdgeInsets.all(6), child: _dot(widget.size)),
      ),
    );
  }
}

/// A name followed by the tick, wrapping like normal text (keeps centring and maxLines).
Widget nameWithTick(
  String name, {
  required TextStyle style,
  required bool videoKyc,
  required bool channel,
  required String surface,
  String? space,
  bool phone = false,
  double size = 22,
  bool interactive = true,
  TextAlign textAlign = TextAlign.start,
  int? maxLines,
}) {
  final tick = VerifiedTick.earns(videoKyc: videoKyc, channel: channel);
  return Text.rich(
    TextSpan(children: [
      TextSpan(text: name),
      if (tick)
        WidgetSpan(
          alignment: PlaceholderAlignment.middle,
          child: Padding(
            padding: const EdgeInsets.only(left: 4),
            child: VerifiedTick(name: name, videoKyc: videoKyc, channel: channel, surface: surface, space: space, phone: phone, size: size, interactive: interactive),
          ),
        ),
    ]),
    style: style,
    textAlign: textAlign,
    maxLines: maxLines,
    overflow: maxLines == null ? null : TextOverflow.ellipsis,
  );
}
