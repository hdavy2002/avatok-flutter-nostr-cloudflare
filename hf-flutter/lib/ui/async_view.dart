import 'dart:async';

import 'package:flutter/material.dart';

import '../data/api_exception.dart';
import '../demo/theme.dart';

/// Where a screen's data is right now. Every list or detail screen shows one of the four
/// states: loading, content, empty or error with "Try again".
sealed class AsyncState<T> {
  const AsyncState();
}

class AsyncLoading<T> extends AsyncState<T> {
  const AsyncLoading();
}

class AsyncData<T> extends AsyncState<T> {
  const AsyncData(this.value);
  final T value;
}

class AsyncFailure<T> extends AsyncState<T> {
  const AsyncFailure(this.error);
  final Object error;
}

bool _defaultIsEmpty(Object? v) {
  if (v == null) return true;
  if (v is Iterable) return v.isEmpty;
  if (v is Map) return v.isEmpty;
  if (v is String) return v.isEmpty;
  return false;
}

/// Renders an [AsyncState] in the app's look. Pass [onRetry] to get the "Try again" button.
///
/// - loading: a spinner with a label
/// - data: [builder], unless the value is empty (an empty list, map or string by default; override
///   with [isEmpty]) in which case the empty panel shows
/// - error: "No internet. Check your connection." when offline, otherwise the server's plain-English
///   message, with a "Try again" button
class AsyncView<T> extends StatelessWidget {
  const AsyncView({
    super.key,
    required this.state,
    required this.builder,
    this.onRetry,
    this.isEmpty,
    this.emptyTitle = 'Nothing here yet',
    this.emptyMessage,
    this.emptyAction,
    this.loadingLabel = 'Loading…',
  });

  final AsyncState<T> state;
  final Widget Function(BuildContext context, T value) builder;
  final VoidCallback? onRetry;
  final bool Function(T value)? isEmpty;
  final String emptyTitle;
  final String? emptyMessage;

  /// Optional button under the empty message (for example "WATCH REELS").
  final Widget? emptyAction;
  final String loadingLabel;

  @override
  Widget build(BuildContext context) {
    final s = state;
    if (s is AsyncData<T>) {
      final empty = isEmpty != null ? isEmpty!(s.value) : _defaultIsEmpty(s.value);
      return empty ? _Panel(title: emptyTitle, message: emptyMessage, action: emptyAction) : builder(context, s.value);
    }
    if (s is AsyncFailure<T>) {
      final e = s.error;
      final msg = e is ApiException ? e.userMessage : ApiException.genericText;
      return _Panel(
        title: e is ApiException && e.isOffline ? 'You are offline' : 'That did not work',
        message: msg,
        icon: e is ApiException && e.isOffline ? Icons.wifi_off_rounded : Icons.error_outline_rounded,
        action: onRetry == null ? null : _TryAgain(onTap: onRetry!),
      );
    }
    return Center(
      child: Semantics(
        label: loadingLabel,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const SizedBox(width: 44, height: 44, child: CircularProgressIndicator(color: C.maroon, strokeWidth: 5)),
            const SizedBox(height: 14),
            Text(loadingLabel, style: t(16, color: C.muted, w: FontWeight.w700)),
          ],
        ),
      ),
    );
  }
}

class _Panel extends StatelessWidget {
  const _Panel({required this.title, this.message, this.icon = Icons.inbox_rounded, this.action});

  final String title;
  final String? message;
  final IconData icon;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 56, color: C.violet),
            const SizedBox(height: 14),
            Text(title, textAlign: TextAlign.center, style: t(22, color: C.maroon)),
            if (message != null) ...[
              const SizedBox(height: 8),
              Text(message!, textAlign: TextAlign.center, style: t(16, color: C.deep, w: FontWeight.w700, h: 1.35)),
            ],
            if (action != null) ...[const SizedBox(height: 20), action!],
          ],
        ),
      ),
    );
  }
}

class _TryAgain extends StatelessWidget {
  const _TryAgain({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: 'Try again',
      child: SizedBox(
        height: 56,
        child: Material(
          color: C.marigold,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14), side: const BorderSide(color: C.marigold, width: 3)),
          child: InkWell(
            borderRadius: BorderRadius.circular(14),
            onTap: onTap,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 28),
              child: Center(widthFactor: 1, child: Text('Try again', style: t(18, ls: 0.04))),
            ),
          ),
        ),
      ),
    );
  }
}

/// Runs [load] on first build and again on "Try again", and renders it through [AsyncView].
/// Use [reloadKey] (a changing value) to reload from outside.
class AsyncLoader<T> extends StatefulWidget {
  const AsyncLoader({
    super.key,
    required this.load,
    required this.builder,
    this.isEmpty,
    this.emptyTitle = 'Nothing here yet',
    this.emptyMessage,
    this.emptyAction,
    this.loadingLabel = 'Loading…',
    this.reloadKey,
  });

  final Future<T> Function() load;
  final Widget Function(BuildContext context, T value) builder;
  final bool Function(T value)? isEmpty;
  final String emptyTitle;
  final String? emptyMessage;
  final Widget? emptyAction;
  final String loadingLabel;
  final Object? reloadKey;

  @override
  State<AsyncLoader<T>> createState() => _AsyncLoaderState<T>();
}

class _AsyncLoaderState<T> extends State<AsyncLoader<T>> {
  AsyncState<T> _state = AsyncLoading<T>();
  int _run = 0;

  @override
  void initState() {
    super.initState();
    unawaited(_go());
  }

  @override
  void didUpdateWidget(covariant AsyncLoader<T> old) {
    super.didUpdateWidget(old);
    if (old.reloadKey != widget.reloadKey) unawaited(_go());
  }

  Future<void> _go() async {
    final run = ++_run;
    if (run > 1) setState(() => _state = AsyncLoading<T>());
    AsyncState<T> next;
    try {
      next = AsyncData<T>(await widget.load());
    } catch (e) {
      next = AsyncFailure<T>(e);
    }
    if (!mounted || run != _run) return;
    setState(() => _state = next);
  }

  @override
  Widget build(BuildContext context) {
    return AsyncView<T>(
      state: _state,
      builder: widget.builder,
      onRetry: () => unawaited(_go()),
      isEmpty: widget.isEmpty,
      emptyTitle: widget.emptyTitle,
      emptyMessage: widget.emptyMessage,
      emptyAction: widget.emptyAction,
      loadingLabel: widget.loadingLabel,
    );
  }
}
