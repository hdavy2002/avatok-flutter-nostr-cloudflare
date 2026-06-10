import 'dart:async';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/material.dart';

import '../theme.dart';

/// Shared empty/error/offline conventions (creator-marketplace Phase 1, audit
/// A3). RULE for every later phase: each new screen MUST define its empty-state
/// copy and use these widgets — no blank bodies, no spinner-forever states.

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
          Container(
            width: 72, height: 72,
            decoration: BoxDecoration(color: AvaColors.brand50, borderRadius: BorderRadius.circular(20)),
            child: Icon(icon, color: AvaColors.brand, size: 34),
          ),
          const SizedBox(height: 16),
          Text(title, textAlign: TextAlign.center,
              style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 17)),
          const SizedBox(height: 6),
          Text(subtitle, textAlign: TextAlign.center,
              style: const TextStyle(color: AvaColors.sub, fontSize: 13.5, height: 1.5)),
          if (ctaLabel != null && onCta != null) ...[
            const SizedBox(height: 18),
            FilledButton(onPressed: onCta, child: Text(ctaLabel!)),
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
                color: AvaColors.danger.withValues(alpha: 0.10),
                borderRadius: BorderRadius.circular(20)),
            child: const Icon(Icons.error_outline, color: AvaColors.danger, size: 34),
          ),
          const SizedBox(height: 16),
          Text(message, textAlign: TextAlign.center,
              style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
          if (onRetry != null) ...[
            const SizedBox(height: 16),
            OutlinedButton.icon(
                onPressed: onRetry,
                icon: const Icon(Icons.refresh, size: 18),
                label: const Text('Try again')),
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
      color: const Color(0xFF3A3A42),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
      child: const Row(mainAxisAlignment: MainAxisAlignment.center, children: [
        Icon(Icons.cloud_off, color: Colors.white70, size: 14),
        SizedBox(width: 8),
        Text("You're offline — showing saved data",
            style: TextStyle(color: Colors.white70, fontSize: 12, fontWeight: FontWeight.w600)),
      ]),
    );
  }
}
