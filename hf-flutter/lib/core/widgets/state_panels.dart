import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/api_error.dart';
import '../strings.dart';
import '../motion/beaver_guide.dart';
import '../motion/loops.dart';
import '../motion/speech_bubble.dart';
import '../theme/hf_theme.dart';
import 'hf_button.dart';
import 'hf_cluster.dart';
import 'hf_card.dart';

/// Every list screen has four states: loading, content, empty, error. These are the shared panels, so
/// Shared bento states keep the same clear hierarchy as the finished screens.
///
/// HF-MOTION-B: loading shows the bouncing [HfLoader] dots, empty shows the sleepy beaver with the message in
/// a [SpeechBubble], error shows the "oops" beaver above the message and "Try again". With reduced motion the
/// beaver is a still picture and the bubble shows the whole message at once.
class _PanelFrame extends StatelessWidget {
  const _PanelFrame({required this.art, this.title, this.body, this.action});

  final Widget art;
  final String? title;
  final String? body;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final t = title;
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(HfSpacing.pageWide),
        child: Semantics(
          liveRegion: true,
          child: HfCard(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                art,
                if (t != null) ...[
                  const SizedBox(height: 12),
                  Text(
                    t,
                    style: HfText.of(context, HfText.subsection),
                    textAlign: TextAlign.center,
                  ),
                ],
                if (body != null) ...[
                  const SizedBox(height: 8),
                  Text(
                    body!,
                    style: HfText.of(context, HfText.body),
                    textAlign: TextAlign.center,
                  ),
                ],
                if (action != null) ...[const SizedBox(height: 20), action!],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The panel beaver: decorative (the message carries the meaning), so it is hidden from screen readers.
class _PanelBeaver extends StatelessWidget {
  const _PanelBeaver({required this.pose});

  final BeaverPose pose;

  @override
  Widget build(BuildContext context) => ExcludeSemantics(
    child: BeaverGuide(key: kStatePanelBeaverKey, pose: pose, size: kStatePanelBeaverSize),
  );
}

/// Key of the beaver in the empty and error panels (for tests).
const Key kStatePanelBeaverKey = ValueKey<String>('state-panel-beaver');

/// Size of the beaver in the empty and error panels: small enough for a 320 dp phone with 2x text.
const double kStatePanelBeaverSize = 104;

/// "Finding people..." and the bouncing dots, or the [skeleton] you pass (for example
/// `HfSkeleton.hostCard()`), which replaces the dots so the layout does not jump when the content arrives. The
/// message stays as the screen-reader label either way.
class LoadingPanel extends StatelessWidget {
  const LoadingPanel({
    super.key,
    this.message = Strings.loadingDefault,
    this.skeleton,
  });

  final String message;
  final Widget? skeleton;

  @override
  Widget build(BuildContext context) {
    final sk = skeleton;
    if (sk != null) {
      return Semantics(
        liveRegion: true,
        label: message,
        child: SingleChildScrollView(
          physics: const NeverScrollableScrollPhysics(),
          padding: const EdgeInsets.all(HfSpacing.page),
          child: sk,
        ),
      );
    }
    return Center(
      child: Semantics(
        liveRegion: true,
        label: message,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const ExcludeSemantics(child: HfLoader(dotSize: 12)),
            const SizedBox(height: 16),
            Text(
              message,
              style: HfText.of(context, HfText.body),
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }
}

/// Friendly line plus an action ("No hosts are live yet. Check back soon."). The sleepy beaver says the
/// [message] in a speech bubble. [icon] is kept for callers; the beaver replaces it on screen.
class EmptyPanel extends StatelessWidget {
  const EmptyPanel({
    super.key,
    required this.message,
    this.actionLabel,
    this.onAction,
    this.icon = Icons.search_off_rounded,
  });

  final String message;
  final String? actionLabel;
  final VoidCallback? onAction;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    return _PanelFrame(
      art: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          SpeechBubble(text: message),
          const SizedBox(height: 6),
          const _PanelBeaver(pose: BeaverPose.sleepy),
        ],
      ),
      action: actionLabel != null && onAction != null
          ? HfButton(label: actionLabel!, onPressed: onAction, expand: false)
          : null,
    );
  }
}

/// Message plus "Try again". Pass the [ApiError] and the worker's own message (or the per-code fallback)
/// is shown. No internet gets "No internet. Check your connection." The "oops" beaver sits above it.
class ErrorPanel extends StatelessWidget {
  const ErrorPanel({super.key, this.error, this.message, this.onRetry});

  final Object? error;
  final String? message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final e = error;
    final text =
        message ?? (e is ApiError ? e.userMessage : Strings.somethingWrong);
    final offline = e is ApiError && e.isOffline;
    return _PanelFrame(
      art: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const _PanelBeaver(pose: BeaverPose.oops),
          if (offline) ...[
            const SizedBox(height: 4),
            Icon(
              Icons.wifi_off_rounded,
              size: 24,
              color: HfText.of(context, HfText.body).color,
            ),
          ],
        ],
      ),
      title: text,
      action: onRetry != null
          ? HfButton(label: Strings.tryAgain, onPressed: onRetry, expand: false)
          : null,
    );
  }
}

/// A flag is off, or the feature is not open yet: calm, never an error.
class ComingSoonPanel extends StatelessWidget {
  const ComingSoonPanel({
    super.key,
    this.title = Strings.comingSoonTitle,
    this.body = Strings.comingSoonBody,
  });

  final String title;
  final String body;

  @override
  Widget build(BuildContext context) => _PanelFrame(
    art: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        const HfCluster(kind: HfClusterKind.discover, height: 110),
        Icon(
          Icons.hourglass_empty_rounded,
          size: 32,
          color: HfText.of(context, HfText.body).color,
        ),
      ],
    ),
    title: title,
    body: body,
  );
}

/// The four states of a screen driven by a Riverpod `AsyncValue`:
///
/// ```dart
/// AsyncValueView<List<Host>>(
///   value: ref.watch(hostsProvider),
///   loadingMessage: Strings.loadingPeople,
///   isEmpty: (hosts) => hosts.isEmpty,
///   empty: const EmptyPanel(message: 'No hosts are live yet. Check back soon.'),
///   onRetry: () => ref.invalidate(hostsProvider),
///   data: (hosts) => HostList(hosts),
/// )
/// ```
/// A `404 not_enabled` error shows the Coming soon panel instead of an error.
class AsyncValueView<T> extends StatelessWidget {
  const AsyncValueView({
    super.key,
    required this.value,
    required this.data,
    this.loadingMessage = Strings.loadingDefault,
    this.loadingSkeleton,
    this.isEmpty,
    this.empty,
    this.onRetry,
  });

  final AsyncValue<T> value;
  final Widget Function(T data) data;
  final String loadingMessage;

  /// Shown instead of the loading dots while loading (for example `HfSkeleton.hostCard()`).
  final Widget? loadingSkeleton;
  final bool Function(T data)? isEmpty;
  final Widget? empty;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    return value.when(
      data: (d) {
        final emptyWidget = empty;
        if (emptyWidget != null && (isEmpty?.call(d) ?? false)) {
          return emptyWidget;
        }
        return data(d);
      },
      loading: () =>
          LoadingPanel(message: loadingMessage, skeleton: loadingSkeleton),
      error: (e, _) {
        if (e is ApiError && e.isNotEnabled) return const ComingSoonPanel();
        return ErrorPanel(error: e, onRetry: onRetry);
      },
    );
  }
}
