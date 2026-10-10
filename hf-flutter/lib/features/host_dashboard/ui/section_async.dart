import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_error.dart';
import '../../../core/strings.dart';
import '../../../core/theme/hf_tokens.dart';
import '../../../core/widgets/widgets.dart';

/// One dashboard section driven by an `AsyncValue`. A section that fails shows its own small
/// "Try again" card, so one broken call never blanks the whole dashboard.
class SectionAsync<T> extends StatelessWidget {
  const SectionAsync({
    super.key,
    required this.title,
    required this.value,
    required this.builder,
    required this.onRetry,
    this.notEnabledMessage = Strings.comingSoonBody,
  });

  final String title;
  final AsyncValue<T> value;
  final Widget Function(T data) builder;
  final VoidCallback onRetry;

  /// Shown when the worker answers `404 not_enabled` (a flag is off): calm, never an error.
  final String notEnabledMessage;

  @override
  Widget build(BuildContext context) {
    return value.when(
      skipLoadingOnReload: true,
      skipLoadingOnRefresh: true,
      data: builder,
      loading: () => HfCard(
        child: Row(
          children: [
            const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5)),
            const SizedBox(width: 14),
            Expanded(child: Text(Strings.loadingDefault, style: HfText.bodyText)),
          ],
        ),
      ),
      error: (e, _) {
        if (e is ApiError && e.isNotEnabled) {
          return HfCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: HfText.subtitle),
                const SizedBox(height: 8),
                Text(notEnabledMessage, style: HfText.bodyText),
              ],
            ),
          );
        }
        return HfCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: HfText.subtitle),
              const SizedBox(height: 8),
              Text(e is ApiError ? e.userMessage : Strings.somethingWrong, style: HfText.bodyText),
              const SizedBox(height: 8),
              HfButton(label: Strings.tryAgain, onPressed: onRetry, kind: HfButtonKind.text, expand: false),
            ],
          ),
        );
      },
    );
  }
}
