import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../analytics/analytics.dart';
import '../links.dart';
import '../theme/hf_tokens.dart';
import '../widgets/widgets.dart';
import 'update_check.dart';

/// Copy of the update prompts (kept here, next to the widgets).
abstract final class UpdateCopy {
  static const String bannerText = 'A new version is ready';
  static const String bannerButton = 'Update';
  static const String bannerClose = 'Not now';
  static const String forcedTitle = 'Please update the app';
  static const String forcedBody =
      'This version is too old to keep working. Update it from Google Play, then open the app again.';
  static const String forcedButton = 'Update';
  static const String couldNotOpen = "We couldn't open Google Play. Please open it yourself and update the app.";
}

/// Telemetry for the update prompt (`hf_app_update_prompt`). Best effort; tests replace [sink].
abstract final class UpdateTelemetry {
  static Future<void> Function(String event, Map<String, Object> props) sink = _toAnalytics;

  static Future<void> _toAnalytics(String event, Map<String, Object> props) => Analytics.capture(event, props);

  static void resetSink() => sink = _toAnalytics;

  /// `kind`: `soft | forced`. `action`: `shown | update_tapped | dismissed`.
  static void prompt(String kind, String action, {int? installed}) {
    try {
      sink('hf_app_update_prompt', {
        'kind': kind,
        'action': action,
        if (installed != null) 'installed': installed,
      }).catchError((Object _) {});
    } catch (_) {
      // telemetry never breaks a screen
    }
  }
}

/// Sits above the whole router (`MaterialApp.router builder`).
///  - Installed build below `hfAppMinBuild`: the blocking "Please update" screen replaces the app.
///  - Installed build below `hfAppLatestBuild`: a soft banner on top, which can be closed until the next start.
///  - Anything else (or the numbers unknown, or 0): the app as is.
class UpdateGate extends ConsumerStatefulWidget {
  const UpdateGate({super.key, required this.child});

  final Widget? child;

  @override
  ConsumerState<UpdateGate> createState() => _UpdateGateState();
}

class _UpdateGateState extends ConsumerState<UpdateGate> {
  bool _dismissed = false;
  bool _openFailed = false;
  String? _shownKind;
  final GlobalKey _appKey = GlobalKey();

  void _reportShown(String kind) {
    if (_shownKind == kind) return;
    _shownKind = kind;
    final installed = ref.read(installedBuildProvider);
    WidgetsBinding.instance.addPostFrameCallback((_) => UpdateTelemetry.prompt(kind, 'shown', installed: installed));
  }

  Future<void> _openStore(String kind) async {
    UpdateTelemetry.prompt(kind, 'update_tapped', installed: ref.read(installedBuildProvider));
    final ok = await LinkOpener.instance.playStore();
    if (!mounted) return;
    setState(() => _openFailed = !ok);
  }

  @override
  Widget build(BuildContext context) {
    final status = ref.watch(updateStatusProvider);
    final child = widget.child ?? const SizedBox.shrink();

    if (status == UpdateStatus.forced) {
      _reportShown('forced');
      return UpdateRequiredScreen(onUpdate: () => _openStore('forced'), openFailed: _openFailed);
    }
    final showBanner = status == UpdateStatus.soft && !_dismissed;
    if (showBanner) _reportShown('soft');
    // The tree keeps the same shape whether or not the banner shows (the app below is held by a GlobalKey),
    // so the router and the screen on it are never rebuilt from scratch when the banner comes or goes.
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (showBanner)
          UpdateBanner(
            onUpdate: () => _openStore('soft'),
            onClose: () {
              UpdateTelemetry.prompt('soft', 'dismissed', installed: ref.read(installedBuildProvider));
              setState(() => _dismissed = true);
            },
            openFailed: _openFailed,
          ),
        Expanded(
          key: _appKey,
          // The banner already covers the status bar, so the screen below must not add that space again.
          child: MediaQuery.removePadding(context: context, removeTop: showBanner, child: child),
        ),
      ],
    );
  }
}

/// The soft banner: "A new version is ready" with Update and Not now. Rose on blush (never green).
class UpdateBanner extends StatelessWidget {
  const UpdateBanner({super.key, required this.onUpdate, required this.onClose, this.openFailed = false});

  final VoidCallback onUpdate;
  final VoidCallback onClose;
  final bool openFailed;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: HfColors.white,
      child: SafeArea(
        bottom: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(HfSpacing.page, 4, 8, 4),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const Icon(Icons.system_update_rounded, color: HfColors.ink),
                  const SizedBox(width: 12),
                  const Expanded(child: Text(UpdateCopy.bannerText, style: HfText.bodyStrong)),
                  TextButton(
                    key: const ValueKey<String>('update-banner-button'),
                    style: TextButton.styleFrom(minimumSize: const Size(64, HfSpacing.tap)),
                    onPressed: onUpdate,
                    child: const Text(UpdateCopy.bannerButton),
                  ),
                  // No tooltip here: this banner sits above the Navigator, so there is no Overlay for one.
                  IconButton(
                    key: const ValueKey<String>('update-banner-close'),
                    constraints: const BoxConstraints(minWidth: HfSpacing.tap, minHeight: HfSpacing.tap),
                    onPressed: onClose,
                    icon: const Icon(Icons.close_rounded, color: HfColors.plum, semanticLabel: UpdateCopy.bannerClose),
                  ),
                ],
              ),
              if (openFailed)
                const Padding(
                  padding: EdgeInsets.only(bottom: 8),
                  child: Text(UpdateCopy.couldNotOpen, style: HfText.note),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The blocking screen for a build below `hfAppMinBuild`. The only action is Update (Play Store, with the
/// web page as the fallback inside [LinkOpener.playStore]).
class UpdateRequiredScreen extends StatelessWidget {
  const UpdateRequiredScreen({super.key, required this.onUpdate, this.openFailed = false});

  final VoidCallback onUpdate;
  final bool openFailed;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      key: const ValueKey<String>('update-required'),
      backgroundColor: HfColors.cream,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(HfSpacing.page),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const HfScene(kind: HfSceneKind.success, height: 160),
                const SizedBox(height: 16),
                const Text(UpdateCopy.forcedTitle, style: HfText.title, textAlign: TextAlign.center),
                const SizedBox(height: 12),
                const HfCard(child: Text(UpdateCopy.forcedBody, style: HfText.bodyText, textAlign: TextAlign.center)),
                const SizedBox(height: HfSpacing.gapLarge),
                HfButton(
                  key: const ValueKey<String>('update-required-button'),
                  label: UpdateCopy.forcedButton,
                  icon: Icons.open_in_new_rounded,
                  onPressed: onUpdate,
                ),
                if (openFailed) ...[
                  const SizedBox(height: 12),
                  const Text(UpdateCopy.couldNotOpen, style: HfText.note, textAlign: TextAlign.center),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}
