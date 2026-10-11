import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_error.dart';
import '../../../core/strings.dart';
import '../../../core/theme/hf_theme.dart';
import '../../../core/widgets/widgets.dart';
import 'dash_surface.dart';

/// One dashboard section driven by an `AsyncValue`. While it loads it shows a skeleton block of
/// [skeletonHeight]. A section that fails shows its own small "Try again" card (or "No internet. Check your
/// connection."), so one broken call never blanks the whole dashboard.
class SectionAsync<T> extends StatelessWidget {
  const SectionAsync({
    super.key,
    required this.title,
    required this.value,
    required this.builder,
    required this.onRetry,
    this.notEnabledMessage = Strings.comingSoonBody,
    this.skeletonHeight = 96,
    this.skeletonRadius = 26,
  });

  final String title;
  final AsyncValue<T> value;
  final Widget Function(T data) builder;
  final VoidCallback onRetry;

  /// Shown when the worker answers `404 not_enabled` (a flag is off): calm, never an error.
  final String notEnabledMessage;
  final double skeletonHeight;
  final double skeletonRadius;

  @override
  Widget build(BuildContext context) {
    return value.when(
      skipLoadingOnReload: true,
      skipLoadingOnRefresh: true,
      data: builder,
      loading: () =>
          HfSkeleton.box(height: skeletonHeight, radius: skeletonRadius),
      error: (e, _) {
        if (e is ApiError && e.isNotEnabled) {
          return DashSurface(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                DashHeading(title),
                const SizedBox(height: HfSpacing.sm),
                Text(notEnabledMessage, style: HfText.of(context, HfText.body)),
              ],
            ),
          );
        }
        final offline = e is ApiError && e.isOffline;
        return DashSurface(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              DashHeading(title),
              const SizedBox(height: HfSpacing.sm),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Padding(
                    padding: const EdgeInsets.only(right: HfSpacing.md, top: 2),
                    child: Icon(
                      offline
                          ? Icons.wifi_off_rounded
                          : Icons.error_outline_rounded,
                      size: 22,
                      color: HfText.of(context, HfText.body).color,
                    ),
                  ),
                  Expanded(
                    child: Text(
                      e is ApiError ? e.userMessage : Strings.somethingWrong,
                      style: HfText.of(context, HfText.body),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: HfSpacing.sm),
              HfButton(
                label: Strings.tryAgain,
                onPressed: onRetry,
                kind: HfButtonKind.text,
                expand: false,
              ),
            ],
          ),
        );
      },
    );
  }
}
