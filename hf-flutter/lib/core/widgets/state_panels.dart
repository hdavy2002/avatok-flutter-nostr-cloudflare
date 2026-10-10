import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/api_error.dart';
import '../strings.dart';
import '../theme/hf_tokens.dart';
import 'hf_button.dart';

/// Every list screen has four states: loading, content, empty, error. These are the shared panels, so
/// every screen looks and reads the same. Loading is plain text and a spinner (no grey skeleton cards).
class _PanelFrame extends StatelessWidget {
  const _PanelFrame({required this.icon, required this.title, this.body, this.action});

  final IconData icon;
  final String title;
  final String? body;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(HfSpacing.page),
        child: Semantics(
          liveRegion: true,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 44, color: HfColors.orchid),
              const SizedBox(height: 12),
              Text(title, style: HfText.subtitle, textAlign: TextAlign.center),
              if (body != null) ...[
                const SizedBox(height: 8),
                Text(body!, style: HfText.bodyText, textAlign: TextAlign.center),
              ],
              if (action != null) ...[
                const SizedBox(height: 20),
                action!,
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// "Finding people…" and a spinner.
class LoadingPanel extends StatelessWidget {
  const LoadingPanel({super.key, this.message = Strings.loadingDefault});

  final String message;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Semantics(
        liveRegion: true,
        label: message,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const CircularProgressIndicator(),
            const SizedBox(height: 16),
            Text(message, style: HfText.bodyText, textAlign: TextAlign.center),
          ],
        ),
      ),
    );
  }
}

/// Friendly line plus an action ("No hosts are live yet. Check back soon.").
class EmptyPanel extends StatelessWidget {
  const EmptyPanel({super.key, required this.message, this.actionLabel, this.onAction, this.icon = Icons.search_off_rounded});

  final String message;
  final String? actionLabel;
  final VoidCallback? onAction;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    return _PanelFrame(
      icon: icon,
      title: message,
      action: actionLabel != null && onAction != null
          ? HfButton(label: actionLabel!, onPressed: onAction, expand: false)
          : null,
    );
  }
}

/// Message plus "Try again". Pass the [ApiError] and the worker's own message (or the per-code fallback)
/// is shown. No internet gets "No internet. Check your connection."
class ErrorPanel extends StatelessWidget {
  const ErrorPanel({super.key, this.error, this.message, this.onRetry});

  final Object? error;
  final String? message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final e = error;
    final text = message ??
        (e is ApiError ? e.userMessage : Strings.somethingWrong);
    final offline = e is ApiError && e.isOffline;
    return _PanelFrame(
      icon: offline ? Icons.wifi_off_rounded : Icons.error_outline_rounded,
      title: text,
      action: onRetry != null ? HfButton(label: Strings.tryAgain, onPressed: onRetry, expand: false) : null,
    );
  }
}

/// A flag is off, or the feature is not open yet: calm, never an error.
class ComingSoonPanel extends StatelessWidget {
  const ComingSoonPanel({super.key, this.title = Strings.comingSoonTitle, this.body = Strings.comingSoonBody});

  final String title;
  final String body;

  @override
  Widget build(BuildContext context) =>
      _PanelFrame(icon: Icons.hourglass_empty_rounded, title: title, body: body);
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
    this.isEmpty,
    this.empty,
    this.onRetry,
  });

  final AsyncValue<T> value;
  final Widget Function(T data) data;
  final String loadingMessage;
  final bool Function(T data)? isEmpty;
  final Widget? empty;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    return value.when(
      data: (d) {
        final emptyWidget = empty;
        if (emptyWidget != null && (isEmpty?.call(d) ?? false)) return emptyWidget;
        return data(d);
      },
      loading: () => LoadingPanel(message: loadingMessage),
      error: (e, _) {
        if (e is ApiError && e.isNotEnabled) return const ComingSoonPanel();
        return ErrorPanel(error: e, onRetry: onRetry);
      },
    );
  }
}
