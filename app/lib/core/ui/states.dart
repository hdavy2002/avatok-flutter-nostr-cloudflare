import 'dart:async';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import 'zine.dart';
import 'zine_widgets.dart';

/// Shared empty/error/offline conventions (creator-marketplace Phase 1, audit
/// A3). RULE for every later phase: each new screen MUST define its empty-state
/// copy and use these widgets — no blank bodies, no spinner-forever states.
/// Visuals follow the zine design system (§7.12 empty states).

class EmptyState extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;
  final String? ctaLabel;
  final VoidCallback? onCta;
  const EmptyState({
    super.key,
    required this.icon,
    required this.title,
    required this.subtitle,
    this.ctaLabel,
    this.onCta,
  });

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 36, vertical: 24),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          // Dashed-feel glyph tile (§7.12): muted ink border, no shadow.
          Container(
            width: 72, height: 72,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(Zine.rSm),
              border: Border.all(color: Zine.ink.withValues(alpha: 0.3), width: 2),
            ),
            child: Icon(icon, color: Zine.inkMute, size: 32),
          ),
          const SizedBox(height: 16),
          Text(title, textAlign: TextAlign.center, style: ZineText.cardTitle(size: 19)),
          const SizedBox(height: 6),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 280),
            child: Text(subtitle, textAlign: TextAlign.center, style: ZineText.sub(size: 13.5)),
          ),
          if (ctaLabel != null && onCta != null) ...[
            const SizedBox(height: 18),
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
        padding: const EdgeInsets.symmetric(horizontal: 36, vertical: 24),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Container(
            width: 72, height: 72,
            decoration: BoxDecoration(
              color: Zine.coral,
              borderRadius: BorderRadius.circular(Zine.rSm),
              border: Zine.border,
              boxShadow: Zine.shadowSm,
            ),
            child: PhosphorIcon(PhosphorIcons.warning(PhosphorIconsStyle.bold),
                color: Colors.white, size: 32),
          ),
          const SizedBox(height: 16),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 280),
            child: Text(message, textAlign: TextAlign.center,
                style: ZineText.value(size: 15)),
          ),
          if (onRetry != null) ...[
            const SizedBox(height: 16),
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
        color: Zine.paper2,
        border: Border(bottom: BorderSide(color: Zine.ink, width: Zine.bw)),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
      child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
        PhosphorIcon(PhosphorIcons.cloudSlash(PhosphorIconsStyle.bold),
            color: Zine.inkSoft, size: 14),
        const SizedBox(width: 8),
        Flexible(
          child: Text("you're offline — showing saved data",
              style: ZineText.kicker(size: 11.5)),
        ),
      ]),
    );
  }
}
