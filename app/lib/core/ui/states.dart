import 'dart:async';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import 'avatok_dark.dart';
import 'messenger_theme.dart';
import 'zine_widgets.dart';

/// Shared empty/error/offline conventions (creator-marketplace Phase 1, audit
/// A3). RULE for every later phase: each new screen MUST define its empty-state
/// copy and use these widgets — no blank bodies, no spinner-forever states.
/// Visuals follow the AvaTOK Dark v2 tokens (`AD` / `ADText` / `Msg`).

class EmptyState extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;
  final String? ctaLabel;
  final VoidCallback? onCta;
  /// Optional Rajasthani illustration asset path (e.g. from `Illustrations`
  /// in `core/ui/illustrations.dart`). When set, this DECORATIVE svg replaces
  /// the 72px icon-in-a-square tile below. When null (the ~40 existing call
  /// sites), the icon tile renders exactly as before — strictly additive.
  final String? illustration;
  const EmptyState({
    super.key,
    required this.icon,
    required this.title,
    required this.subtitle,
    this.ctaLabel,
    this.onCta,
    this.illustration,
  });

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 36, vertical: Msg.s5),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          if (illustration != null)
            // Decorative — always sits beside the title/subtitle below, so a
            // screen reader should announce only the text, never the art.
            SvgPicture.asset(illustration!, height: 140, fit: BoxFit.contain, excludeFromSemantics: true)
          else
            // Outlined glyph tile: hairline border, no fill, no shadow.
            Container(
              width: 72, height: 72,
              decoration: BoxDecoration(
                borderRadius: Msg.brLg,
                border: Border.all(color: AD.borderControl, width: 1),
              ),
              child: Icon(icon, color: AD.textTertiary, size: 32),
            ),
          const SizedBox(height: Msg.s4),
          Text(title, textAlign: TextAlign.center,
              style: ADText.threadName().copyWith(fontSize: 19)),
          const SizedBox(height: Msg.s1),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 280),
            child: Text(subtitle, textAlign: TextAlign.center, style: ADText.preview()),
          ),
          if (ctaLabel != null && onCta != null) ...[
            const SizedBox(height: Msg.s4),
            ZineButton(
              label: ctaLabel!,
              onPressed: onCta,
              fontSize: 17,
              icon: PhosphorIcons.arrowRight(PhosphorIconsStyle.bold),
            ),
          ],
        ]),
      ),
    );
  }
}

class ErrorState extends StatelessWidget {
  final String message;
  final VoidCallback? onRetry;
  const ErrorState({super.key, this.message = 'Something went wrong', this.onRetry});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 36, vertical: Msg.s5),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Container(
            width: 72, height: 72,
            decoration: BoxDecoration(
              color: AD.destructiveBg,
              borderRadius: Msg.brLg,
              border: Border.all(color: AD.borderControl, width: 1),
            ),
            child: PhosphorIcon(PhosphorIcons.warning(PhosphorIconsStyle.bold),
                color: AD.destructiveInk, size: 32),
          ),
          const SizedBox(height: Msg.s4),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 280),
            child: Text(message, textAlign: TextAlign.center, style: ADText.rowName()),
          ),
          if (onRetry != null) ...[
            const SizedBox(height: Msg.s4),
            ZineButton(
              label: 'Try again',
              onPressed: onRetry,
              variant: ZineButtonVariant.ghost,
              fontSize: 17,
              icon: PhosphorIcons.arrowsClockwise(PhosphorIconsStyle.bold),
              trailingIcon: false,
            ),
          ],
        ]),
      ),
    );
  }
}

/// Thin banner shown while the device is offline. Screens keep rendering their
/// cached drift data underneath — this only signals that data may be stale.
class OfflineBanner extends StatefulWidget {
  const OfflineBanner({super.key});
  @override
  State<OfflineBanner> createState() => _OfflineBannerState();
}

class _OfflineBannerState extends State<OfflineBanner> {
  StreamSubscription? _sub;
  bool _offline = false;

  @override
  void initState() {
    super.initState();
    Connectivity().checkConnectivity().then(_apply);
    _sub = Connectivity().onConnectivityChanged.listen(_apply);
  }

  void _apply(List<ConnectivityResult> results) {
    final off = results.isEmpty || results.every((r) => r == ConnectivityResult.none);
    if (mounted && off != _offline) setState(() => _offline = off);
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!_offline) return const SizedBox.shrink();
    return Container(
      width: double.infinity,
      decoration: const BoxDecoration(
        color: AD.headerFooter,
        border: Border(bottom: Msg.hairline),
      ),
      padding: const EdgeInsets.symmetric(horizontal: Msg.s4, vertical: Msg.s2),
      child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
        PhosphorIcon(PhosphorIcons.cloudSlash(PhosphorIconsStyle.regular),
            color: AD.textSecondary, size: 14),
        const SizedBox(width: Msg.s2),
        Flexible(
          child: Text("You're offline — showing saved data",
              style: ADText.sectionLabel(c: AD.textSecondary)),
        ),
      ]),
    );
  }
}
