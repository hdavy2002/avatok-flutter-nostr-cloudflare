import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart' show defaultTargetPlatform, TargetPlatform;
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/analytics.dart';
import '../../core/money_api.dart';
import '../../core/remote_config.dart';
import '../../core/ui/zine.dart';
import 'call_translation_controller.dart';
import 'call_translation_audio_bridge.dart';
import 'translation_langs.dart';

/// CallScreen overlay for Android 1:1 audio and video calls. It is hidden while
/// either master flag is false or the pinned decoded-playback bridge is absent.
class CallTranslateOverlay extends StatefulWidget {
  const CallTranslateOverlay({super.key, required this.callRef});
  final String callRef;
  @override State<CallTranslateOverlay> createState() => _CallTranslateOverlayState();
}

class _CallTranslateOverlayState extends State<CallTranslateOverlay> {
  CallTranslationController? _controller;
  bool _nativeSupported = false;
  bool _fundsDialogShown = false;
  bool _providerDialogShown = false;
  bool _hadActiveTranslation = false;

  /// [CALL-TRANSLATE-2C-2] Sheet debounce. Two taps landing in the same frame
  /// (or a double-tap on the chip) must open ONE sheet and queue ONE switch.
  bool _sheetOpen = false;
  DateTime _lastSheetAt = DateTime.fromMillisecondsSinceEpoch(0);
  static const Duration _kSheetDebounce = Duration(milliseconds: 600);

  /// The sheet has to sit open for this long before we spend anything warming
  /// up — a user who opens and instantly picks costs nothing extra.
  static const Duration _kWarmUpDelay = Duration(milliseconds: 500);
  Timer? _warmUpTimer;

  /// [CALL-TRANSLATE-OBS-1 / F2] The native support probe reflects into
  /// flutter_webrtc. If the WebRTC plugin is not attached at the instant we ask
  /// — which is exactly the shape of a cold call screen — `isSupported()` answers
  /// false and, before this, was never asked again: the pill stayed invisible for
  /// the WHOLE call with no log, no event and no dialog. So the probe is now
  /// retried on a bounded backoff and reports what it saw either way.
  static const List<Duration> _kProbeBackoff = <Duration>[
    Duration(milliseconds: 400),
    Duration(milliseconds: 900),
    Duration(milliseconds: 1800),
    Duration(milliseconds: 3500),
  ];
  int _probeAttempts = 0;

  /// [CALL-TRANSLATE-OBS-1 / F1] `build()` runs constantly during a call, so the
  /// visibility event is emitted only when the REASON changes, and never more
  /// than [_kMaxVisibilityEvents] times per mount. A handful of rows per call,
  /// not a flood.
  String? _lastVisibilityReason;
  int _visibilityEvents = 0;
  static const int _kMaxVisibilityEvents = 8;

  @override
  void initState() {
    super.initState();
    // [CALL-TRANSLATE-OBS-1 / F3] RemoteConfig starts with an empty `_cfg` (both
    // flags read false) and only polls every 15 minutes. Reading the flags in
    // `build()` WITHOUT listening meant the pill was hidden on a cold start until
    // some unrelated rebuild happened to re-read them — it self-corrected by luck,
    // because the call screen rebuilds often. Listening to the revision makes the
    // pill appear the moment config actually lands.
    RemoteConfig.revision.addListener(_changed);
    _initializeBridge();
  }

  Future<void> _initializeBridge() async {
    final bridge = CallTranslationAudioBridge.instance;
    _probeAttempts = 1;
    final supported = await bridge.isSupported();
    if (!mounted) return;
    final controller = CallTranslationController(callRef: widget.callRef, bridge: bridge);
    controller.state.addListener(_changed);
    controller.switchingTo.addListener(_changed);
    setState(() {
      _nativeSupported = supported;
      _controller = controller;
    });
    if (!supported) unawaited(_retryNativeProbe(bridge));
  }

  /// [CALL-TRANSLATE-OBS-1 / F2] Bounded re-probe. Never spins: at most
  /// [_kProbeBackoff].length extra attempts (~6.6 s total), then it gives up and
  /// says so. A flip from false→true is the interesting signal — it means the
  /// device CAN translate and only the first probe was early.
  Future<void> _retryNativeProbe(CallTranslationAudioBridge bridge) async {
    for (final backoff in _kProbeBackoff) {
      await Future<void>.delayed(backoff);
      if (!mounted || _nativeSupported) return;
      _probeAttempts++;
      final ok = await bridge.isSupported();
      if (!mounted) return;
      if (ok) {
        setState(() => _nativeSupported = true);
        unawaited(Analytics.capture('call_translation_native_probe', {
          'result': 'recovered',
          'attempts': _probeAttempts,
          'call_ref': widget.callRef,
          'app_build': Analytics.appBuild,
        }));
        return;
      }
    }
    if (!mounted) return;
    // Terminal: this device will not show the pill for this call. The ONLY
    // genuine per-device failure mode, and it used to be completely invisible.
    // [CALL-TRANSLATE-PROBE-OBS-1] `result: unsupported` alone was still a dead
    // end — on 2026-08-04 it fired identically on a real motorola edge 70 fusion
    // (build 10507) and on the emulator, with no way to tell which of the five
    // null exits inside the native resolver had been taken. Carry the cause.
    final cause = await bridge.lastProbeFailure();
    if (!mounted) return;
    unawaited(Analytics.capture('call_translation_native_probe', {
      'result': 'unsupported',
      'cause': cause,
      'attempts': _probeAttempts,
      'call_ref': widget.callRef,
      'app_build': Analytics.appBuild,
    }));
  }

  /// [CALL-TRANSLATE-OBS-1 / F1] ONE event that says exactly why the pill is (or
  /// is not) on screen, plus the app build — because "which build is this person
  /// on" is the question that actually cost a session. Deduped by reason, capped
  /// per mount. Timings, flags and codes only; never anything audio-derived.
  void _reportVisibility(String reason, {required bool visible}) {
    if (reason == _lastVisibilityReason) return;
    _lastVisibilityReason = reason;
    if (_visibilityEvents >= _kMaxVisibilityEvents) return;
    _visibilityEvents++;
    unawaited(Analytics.capture('call_translation_pill_visibility', {
      'visible': visible,
      'reason': reason,
      'call_ref': widget.callRef,
      'app_build': Analytics.appBuild,
      'is_android': defaultTargetPlatform == TargetPlatform.android,
      'translation_enabled': RemoteConfig.translationEnabled,
      'call_translation_enabled': RemoteConfig.callTranslationEnabled,
      'native_supported': _nativeSupported,
      'native_probe_attempts': _probeAttempts,
      'controller_ready': _controller != null,
      'config_revision': RemoteConfig.revision.value,
    }));
  }

  @override
  void dispose() {
    _warmUpTimer?.cancel();
    RemoteConfig.revision.removeListener(_changed);
    final c = _controller;
    c?.state.removeListener(_changed);
    c?.switchingTo.removeListener(_changed);
    c?.dispose();
    super.dispose();
  }
  void _changed() {
    if (!mounted) return;
    setState(() {});
    final controller = _controller;
    if (controller == null) return;
    final s = controller.state.value;
    if (s == CallTranslationState.active) _hadActiveTranslation = true;
    if (s == CallTranslationState.failed && _hadActiveTranslation) {
      final why = controller.failure.value;
      if (why == CallTranslationFailure.insufficientTokens && !_fundsDialogShown) {
        _fundsDialogShown = true;
        WidgetsBinding.instance.addPostFrameCallback((_) { if (mounted) _showFundsDialog(); });
      } else if (why != CallTranslationFailure.insufficientTokens && !_providerDialogShown) {
        _providerDialogShown = true;
        final terminal = why == CallTranslationFailure.circuitOpen;
        WidgetsBinding.instance.addPostFrameCallback((_) { if (mounted) _showProviderStoppedDialog(terminal); });
      }
    }
    if (s == CallTranslationState.idle) _hadActiveTranslation = false;
  }

  /// [CALL-TRANSLATE-2D-4] Live translation is PAID-ONLY (owner, 2026-08-04):
  /// the 100-token welcome grant and the daily free grant are deliberately not
  /// spendable on it. So a user can be refused while their wallet visibly shows
  /// tokens, and "you have no Tokens" would be plainly wrong on their screen.
  /// The Worker's 402 reports the paid balance and the spendable balance
  /// separately so this copy can be honest about WHICH tokens are missing.
  String _outOfTokensCopy(String suffix) {
    final c = _controller;
    if (c != null && c.needsPaidTopUp) {
      return 'Live translation is paid only — your remaining ${c.nonPaidTokens} '
          'Tokens are free/bonus Tokens, which it cannot use. Top up to '
          'continue.$suffix';
    }
    return 'You do not have enough Tokens for live translation.$suffix';
  }

  Future<void> _showFundsDialog() async {
    await showDialog<void>(context: context, builder: (d) => AlertDialog(
      title: const Text('Translation stopped'),
      content: Text(_outOfTokensCopy(' Your call is still connected.')),
      actions: [
        TextButton(onPressed: () => Navigator.pop(d), child: const Text('Not now')),
        TextButton(onPressed: () async {
          Navigator.pop(d);
          final topup = await MoneyApi.topup(500);
          final url = topup['checkout_url']?.toString();
          if (url != null && url.isNotEmpty) {
            try { await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication); } catch (_) {}
          }
        }, child: const Text('Top up Tokens')),
      ],
    ));
  }

  Future<void> _showProviderStoppedDialog(bool terminalForCall) async {
    await showDialog<void>(context: context, builder: (d) => AlertDialog(
      title: Text(terminalForCall ? 'Translation unavailable' : 'Translation stopped'),
      content: Text(terminalForCall
          // Circuit breaker tripped: 3 provider failures in one call. Saying
          // "try again" here would be a lie — start() refuses from now on.
          ? 'Translation is unavailable for this call. Original call audio has been restored and your call is still connected.'
          : 'Live translation became unavailable. Original call audio has been restored and your call is still connected.'),
      actions: [TextButton(onPressed: () => Navigator.pop(d), child: const Text('OK'))],
    ));
  }

  /// Opens the searchable language sheet, debounced, with the speculative
  /// warm-up armed. Returns the picked code, or null if dismissed/suppressed.
  Future<String?> _showLanguageSheet({String? currentCode}) async {
    final now = DateTime.now();
    if (_sheetOpen || now.difference(_lastSheetAt) < _kSheetDebounce) return null;
    _sheetOpen = true;
    _lastSheetAt = now;

    // [CALL-TRANSLATE-OBS-1 / F4] FIRST rung of the client funnel. Everything
    // downstream shares this call's `call_ref` (and `session_id` once one
    // exists), so a session that dies before `active` shows up as a step that
    // stops rather than as an absence of `call_translation_started`.
    _controller?.notePillTapped(currentCode == null ? 'start' : 'switch');

    // Pre-mint (and, from idle, pre-open the socket) for the LAST-USED language
    // once the sheet has been open ~500 ms. Everything it creates is unbilled
    // and discardable; see CallTranslationController.warmUp.
    _warmUpTimer?.cancel();
    _warmUpTimer = Timer(_kWarmUpDelay, () => unawaited(_controller?.warmUp() ?? Future.value()));

    String? lang;
    try {
      lang = await showModalBottomSheet<String>(
        context: context,
        backgroundColor: Zine.paper,
        isScrollControlled: true,
        builder: (_) => _CallTranslationLanguagePicker(currentCode: currentCode),
      );
    } finally {
      _warmUpTimer?.cancel();
      _warmUpTimer = null;
      _sheetOpen = false;
      _lastSheetAt = DateTime.now();
    }
    if (lang == null) {
      _controller?.noteFunnel('language_chosen', ok: false, reason: 'sheet_dismissed');
      unawaited(_controller?.discardWarmUp('sheet_dismissed'));
    } else {
      _controller?.noteFunnel('language_chosen', extra: {'chosen_language': lang});
    }
    return lang;
  }

  /// Mid-call language change from the ACTIVE pill's language chip. No stop, no
  /// confirmation — the same billing session simply changes language.
  Future<void> _switchLanguage() async {
    final controller = _controller;
    if (controller == null) return;
    final from = controller.targetLanguage.value;
    final lang = await _showLanguageSheet(currentCode: from);
    if (lang == null || !mounted || lang == from) return;
    final error = await controller.switchLanguage(lang);
    // 'stopped' = the session ended under the switch (user stop, teardown,
    // provider failure). Those paths own their own UI; a language toast on top
    // of them would be noise.
    if (error == null || error == 'stopped' || !mounted) return;
    final fromLabel = translationLangLabel(from ?? '');
    final message = error == 'switch_lost'
        // The cutover failed AND the previous language could not be restored.
        // The call itself is untouched — the plugin has already put the
        // original audio back — so say exactly that and nothing more.
        ? 'Translation stopped. Your call is still connected.'
        : error == 'unsupported_language'
            ? 'That language is not available for calls yet. Still translating to $fromLabel.'
            : error == 'call_ended'
                ? 'Translation stopped.'
                : 'Could not switch language. Still translating to $fromLabel.';
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
      SnackBar(content: Text(message), duration: const Duration(seconds: 4)),
    );
  }

  Future<void> _pick() async {
    final lang = await _showLanguageSheet();
    if (lang == null || !mounted) return;
    _fundsDialogShown = false;
    _providerDialogShown = false;
    _hadActiveTranslation = false;
    final error = await _controller?.start(lang);
    if (!mounted || error == null) return;
    final message = error == 'source_capture_unavailable'
        ? 'Live translation is not ready on this device yet.'
        : error == 'insufficient_tokens'
            ? _outOfTokensCopy(' Live translation costs 5 Tokens per started minute.')
            : error == 'unavailable_for_call'
                ? 'Translation is unavailable for this call. Your call is unchanged.'
                : 'Live translation could not start. Your call is unchanged.';
    await showDialog<void>(context: context, builder: (d) => AlertDialog(
      title: const Text('Translate unavailable'),
      content: Text(message),
      actions: [
        TextButton(onPressed: () => Navigator.pop(d), child: const Text('NOT NOW')),
        if (error == 'insufficient_tokens')
          TextButton(onPressed: () async {
            Navigator.pop(d);
            final topup = await MoneyApi.topup(500);
            final url = topup['checkout_url']?.toString();
            if (url != null && url.isNotEmpty) {
              try { await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication); } catch (_) {}
            }
          }, child: const Text('Top up Tokens')),
      ],
    ));
  }

  @override Widget build(BuildContext context) {
    // [CALL-TRANSLATE-OBS-1 / F1] Every hide path used to be a bare
    // `SizedBox.shrink()` — no log, no event, no dialog — so "I don't see the
    // Translate pill" was un-diagnosable without a device in hand. Each cause now
    // has its own reason code and one event carries it (deduped; see
    // [_reportVisibility]).
    if (defaultTargetPlatform != TargetPlatform.android) {
      _reportVisibility('not_android', visible: false);
      return const SizedBox.shrink();
    }
    if (!RemoteConfig.translationEnabled) {
      _reportVisibility('flag_translation_off', visible: false);
      return const SizedBox.shrink();
    }
    if (!RemoteConfig.callTranslationEnabled) {
      _reportVisibility('flag_call_translation_off', visible: false);
      return const SizedBox.shrink();
    }
    final controller = _controller;
    if (controller == null) {
      // Transient by nature: the async bridge probe has not returned yet.
      _reportVisibility('controller_null', visible: false);
      return const SizedBox.shrink();
    }
    if (!_nativeSupported) {
      _reportVisibility('native_unsupported', visible: false);
      return const SizedBox.shrink();
    }
    if (!controller.available) {
      // Same two flags read through the controller. Practically unreachable
      // given the checks above; kept so a future divergence is not silent.
      _reportVisibility('controller_unavailable', visible: false);
      return const SizedBox.shrink();
    }
    _reportVisibility('shown', visible: true);
    final active = controller.active;
    final preparing = controller.preparing;
    final stalled = controller.state.value == CallTranslationState.stalled;
    // [CALL-TRANSLATE-2C-2] A language switch also sits in `warming`, so it
    // would otherwise read as "Starting translation…" and blank the session
    // details. It is a distinct thing and says so.
    final switching = controller.switchingTo.value;
    final currentLang = translationLangLabel(controller.targetLanguage.value ?? '');
    final session = active || switching != null;
    final label = switching != null
        ? 'Switching to ${translationLangLabel(switching)}…'
        : preparing
            ? (controller.state.value == CallTranslationState.recovering
                ? 'Reconnecting translation…'
                : 'Starting translation…')
            : active
                ? 'Stop translation'
                : 'Translate';
    return SafeArea(child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.end, children: [
      Row(mainAxisSize: MainAxisSize.min, children: [
        // The language chip: reopens the SAME searchable sheet mid-session so
        // the payer can change target language without stopping anything.
        if (session) ...[
          GestureDetector(
            onTap: switching != null ? null : _switchLanguage,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
              decoration: BoxDecoration(color: Zine.card, borderRadius: BorderRadius.circular(100), border: Border.all(color: Zine.ink, width: Zine.bw), boxShadow: Zine.shadowXs),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Text(currentLang, style: ZineText.value(size: 13, weight: FontWeight.w700)),
                const SizedBox(width: 4),
                PhosphorIcon(PhosphorIcons.caretDown(PhosphorIconsStyle.bold), size: 13),
              ]),
            ),
          ),
          const SizedBox(width: 6),
        ],
        GestureDetector(
          onTap: preparing ? null : (active ? controller.stop : _pick),
          child: Container(padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9), decoration: BoxDecoration(color: active ? Zine.lilac : Zine.card, borderRadius: BorderRadius.circular(100), border: Border.all(color: Zine.ink, width: Zine.bw), boxShadow: Zine.shadowXs), child: Row(mainAxisSize: MainAxisSize.min, children: [PhosphorIcon(PhosphorIcons.translate(PhosphorIconsStyle.bold), size: 17), const SizedBox(width: 6), Text(label, style: ZineText.value(size: 13, weight: FontWeight.w700))])),
        ),
      ]),
      if (session) ...[
        const SizedBox(height: 5),
        ValueListenableBuilder<int>(valueListenable: controller.billedTokens, builder: (_, tokens, __) => ValueListenableBuilder<int>(valueListenable: controller.elapsedSeconds, builder: (_, elapsed, __) => Text('5/min · $tokens Tokens · ${elapsed ~/ 60}:${(elapsed % 60).toString().padLeft(2, '0')}', style: ZineText.tag(size: 10)))),
        // Dead-air guard: the plugin has already restored the original audio,
        // so this line explains what the user is hearing rather than warning
        // about a broken call.
        if (stalled)
          Text('Translator catching up… you are hearing the original voice', textAlign: TextAlign.right, style: ZineText.tag(size: 10)),
        ValueListenableBuilder<bool>(
          valueListenable: controller.qualityDegraded,
          // [CALL-TRANSLATE-OBS-1 / F1] This `SizedBox.shrink()` is NOT a pill
          // hide path: the pill is already on screen and this is only the
          // optional "quality is unstable" caption under it. Absence of a
          // warning is the healthy case, so it emits nothing — instrumenting it
          // would be an event on every rebuild of a working call.
          builder: (_, degraded, __) => degraded && !stalled
              ? Text('Translation quality is unstable on this connection', textAlign: TextAlign.right, style: ZineText.tag(size: 10))
              : const SizedBox.shrink(),
        ),
      ],
    ]));
  }
}

class _CallTranslationLanguagePicker extends StatefulWidget {
  const _CallTranslationLanguagePicker({this.currentCode});

  /// Non-null when reopened MID-SESSION from the pill's language chip: the live
  /// language is marked, and the copy drops the "5 Tokens per started minute"
  /// line because a switch does not start a new billed minute.
  final String? currentCode;

  @override
  State<_CallTranslationLanguagePicker> createState() => _CallTranslationLanguagePickerState();
}

class _CallTranslationLanguagePickerState extends State<_CallTranslationLanguagePicker> {
  final _search = TextEditingController();
  String _query = '';

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final q = _query.trim().toLowerCase();
    final languages = q.isEmpty
        ? kTranslationLangs
        : kTranslationLangs.where((item) =>
            item.label.toLowerCase().contains(q) || item.code.toLowerCase().contains(q)).toList();
    return SafeArea(
      child: SizedBox(
        height: MediaQuery.sizeOf(context).height * .78,
        child: Column(children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 18, 20, 10),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(widget.currentCode == null ? 'Translate incoming voice' : 'Change language',
                  style: ZineText.cardTitle()),
              const SizedBox(height: 6),
              Text(
                widget.currentCode == null
                    ? 'Choose your language · 5 Tokens per started minute'
                    : 'Switching is free — the same session keeps running',
                style: ZineText.sub(size: 13),
              ),
              const SizedBox(height: 14),
              TextField(
                controller: _search,
                autofocus: true,
                onChanged: (value) => setState(() => _query = value),
                decoration: const InputDecoration(
                  prefixIcon: Icon(Icons.search),
                  hintText: 'Search languages',
                  border: OutlineInputBorder(),
                ),
              ),
            ]),
          ),
          Expanded(
            child: languages.isEmpty
                ? const Center(child: Text('No matching language'))
                : ListView.builder(
                    itemCount: languages.length,
                    itemBuilder: (_, index) {
                      final item = languages[index];
                      final isCurrent = item.code == widget.currentCode;
                      return ListTile(
                        title: Text(item.label),
                        subtitle: Text(isCurrent ? '${item.code} · translating now' : item.code),
                        trailing: isCurrent ? const Icon(Icons.check) : null,
                        onTap: () => Navigator.pop(context, item.code),
                      );
                    },
                  ),
          ),
        ]),
      ),
    );
  }
}
