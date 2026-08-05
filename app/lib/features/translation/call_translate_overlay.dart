import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart' show defaultTargetPlatform, TargetPlatform;
import 'package:flutter_webrtc/flutter_webrtc.dart' show WebRTC;
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/analytics.dart';
import '../../core/money_api.dart';
import '../../core/remote_config.dart';
import '../../core/ui/avatok_dark.dart';
// [CALL-TRANSLATE-UI-1] `zine.dart` (the legacy LIGHT palette) is deliberately
// no longer imported — this widget now renders entirely in the dark `AD` tokens
// the rest of the call screen uses. `zine_widgets.dart` stays for
// `ZinePressable`, which is the shared press primitive, not a palette.
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/zine_widgets.dart';
import 'call_translation_controller.dart';
import 'call_translation_audio_bridge.dart';
import 'translation_langs.dart';

/// The in-call Translate control, for Android 1:1 audio and video calls.
/// Renders nothing while either master flag is off or the pinned
/// decoded-playback bridge is absent.
///
/// ## [CALL-TRANSLATE-UI-1 2026-08-05] Was a floating pill, now a call control
///
/// This used to be a `Positioned` lozenge pinned to the top-right of the call
/// screen, styled in the LIGHT `Zine` palette — near-white fill, ink borders,
/// hard offset shadows — while the call screen around it is the DARK `AD`
/// palette. It read as a notification from a different app rather than a thing
/// you could press, and it was the only interactive control on the screen that
/// wasn't in the control row with mute/speaker/video.
///
/// It is now a 56x56 circle that is visually IDENTICAL to those controls
/// (`_btn` in call_screen.dart): same size, same `AD.card` / `AD.primaryBadge`
/// fill, same `AD.borderControl` hairline, same 25px Phosphor bold icon, same
/// `ZinePressable` press behaviour. Active (translating) lights up orange
/// exactly like an engaged speaker or camera toggle.
///
/// The session detail the pill used to carry — target language, running token
/// cost, stall and quality warnings — moves under the button as a compact
/// caption that appears ONLY during a session. Cost stays continuously visible
/// because this is a metered feature; hiding the meter behind a tap would be
/// the wrong trade for something that bills per minute.
class CallTranslateOverlay extends StatefulWidget {
  const CallTranslateOverlay({
    super.key,
    required this.callRef,
    this.tile = false,
    this.callConnected = true,
  });
  final String callRef;

  /// [CALL-TRANSLATE-SLOT-1 2026-08-05] Whether the call has actually connected.
  ///
  /// The overlay used to be MOUNTED on connect, which is why the Translate slot
  /// was empty while a call rang and then popped into existence — the owner's
  /// "there is a blank space, then it comes". Measured on avatok-7ed0f03c: the
  /// call screen opened at 16:22:59.905Z and `shown` landed at 16:23:02.267Z;
  /// only 20ms of that was the bridge probe, the other 2.34s was waiting to be
  /// mounted at all.
  ///
  /// So the widget now mounts with the screen and takes connectedness as input:
  /// false renders the dimmed placeholder tile (and starts the native probe early,
  /// so it is warm by the time the call connects), true unlocks it. Starting a
  /// billed session before there is a call to translate stays impossible.
  final bool callConnected;

  /// [CALL-UI-GRID-2026-08-05] Render as a cell of the call screen's 2x3
  /// control grid: a 64px circle with a "Translate" label under it, and NO
  /// leading gap (the grid owns its own spacing via equal Expanded thirds).
  ///
  /// False keeps the pre-grid geometry — a 56px circle carrying its own 28px
  /// leading gap — for any caller still appending this to a centred Row.
  final bool tile;
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

  /// [CALL-TRANSLATE-SLOT-1] True once [_retryNativeProbe] has run out of
  /// attempts. Until then `!_nativeSupported` means "still asking", not "cannot"
  /// — and the difference decides whether the control slot shows a dimmed
  /// placeholder or collapses to nothing. Without this the two were conflated and
  /// a device that recovers on attempt 3 showed an empty hole for up to 6.6s.
  bool _probeExhausted = false;

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
    // [CALL-TRANSLATE-BIND-1 2026-08-05] Force flutter_webrtc to finish its
    // native init before probing.
    //
    // `playbackSamplesReadyCallbackAdapter` — the field this whole feature hangs
    // off — is created in exactly ONE place: `MethodCallHandlerImpl.initialize()`,
    // reached only via the `initialize` method channel call. The package's own
    // doc calls it optional ("If this is not manually called, will be initialized
    // with default settings") because `WebRTC.invokeMethod` lazily awaits it, so
    // in the normal flow it has already run by the time a call connects. Calling
    // it explicitly is idempotent (guarded by a static `initialized` bool on the
    // Dart side and by `if (mFactory != null) return;` natively) and removes any
    // dependence on that ordering holding.
    try {
      await WebRTC.initialize();
    } catch (_) {/* non-fatal: the probe below reports what it finds */}
    if (!mounted) return;
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
    // [CALL-TRANSLATE-SLOT-1] Probing is over and the answer is no. Flip the flag
    // BEFORE the (awaited) cause lookups below, so the dimmed placeholder does not
    // linger through two more method-channel round trips.
    setState(() => _probeExhausted = true);
    // Terminal: this device will not show the pill for this call. The ONLY
    // genuine per-device failure mode, and it used to be completely invisible.
    // [CALL-TRANSLATE-PROBE-OBS-1] `result: unsupported` alone was still a dead
    // end — on 2026-08-04 it fired identically on a real motorola edge 70 fusion
    // (build 10507) and on the emulator, with no way to tell which of the five
    // null exits inside the native resolver had been taken. Carry the cause.
    final cause = await bridge.lastProbeFailure();
    final source = await bridge.lastProbeSource();
    if (!mounted) return;
    unawaited(Analytics.capture('call_translation_native_probe', {
      'result': 'unsupported',
      'cause': cause,
      // [CALL-TRANSLATE-BIND-1] `engine_bound_singleton_mismatch` here is proof
      // the old sharedSingleton-only lookup was reading the wrong plugin.
      'source': source,
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

  /// [CALL-TRANSLATE-FREE-1 2026-08-05] Which of the two sentences below is true
  /// is now a SERVER decision, and this method must never guess it.
  ///
  /// The paid-only rule (owner, 2026-08-04) was reversed on 2026-08-05: free and
  /// bonus tokens now pay for live translation by default, behind the flag
  /// `callTranslationAllowFreeTokens`. So the "your tokens are the wrong kind"
  /// sentence is no longer the normal case — it is only correct while that flag
  /// is off. The Worker says which by sending `paid_only` on the 402, alongside
  /// the paid and spendable balances; the controller turns that into
  /// [CallTranslationController.needsPaidTopUp]. Do NOT reintroduce a client-side
  /// assumption here: telling someone with an empty wallet to top up because
  /// their tokens are "free/bonus" is visibly wrong next to a zero balance.
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
      // [CALL-TRANSLATE-UI-1] Dark sheet, matching the network sheet in
      // call_screen.dart, and BOUNDED so it cannot run off the screen.
      //
      // The old sheet was `Zine.paper` (light) with a hard
      // `height: screenHeight * .78` inside, and its search field autofocused.
      // With `isScrollControlled: true` the sheet does NOT shrink for the
      // keyboard, so 0.78·H of content had to fit in roughly 0.55·H of visible
      // space the moment it opened — the list and the bottom of the header ran
      // off the screen every single time. `constraints` replaces the magic
      // fraction with a real ceiling, and the picker now pads for the keyboard
      // itself instead of ignoring it.
      lang = await showModalBottomSheet<String>(
        context: context,
        backgroundColor: AD.overlaySheet,
        isScrollControlled: true,
        useSafeArea: true,
        showDragHandle: true,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(AD.rSheet)),
        ),
        constraints: BoxConstraints(
          maxHeight: MediaQuery.sizeOf(context).height * 0.85,
        ),
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

  /// [CALL-TRANSLATE-SLOT-1 2026-08-05] The Translate control while it is still
  /// waking up: same 64px circle, same label, same slot — dimmed and inert.
  ///
  /// It exists because the call controls are a fixed 2x3 grid (call_screen.dart
  /// `_controlRow`): the Translate third does not reflow when the widget returns
  /// nothing, it just goes blank, so the row reads as "More … End" with a hole in
  /// it for the first second or two of every call. Rendering the tile immediately
  /// and enabling it in place is the whole fix — nothing about the underlying
  /// probe got faster, but the control stops appearing out of nowhere.
  ///
  /// Deliberately NOT tappable: `_pick()` needs a controller, and a tap that
  /// silently does nothing is worse than one that is visibly not ready yet.
  Widget _pendingTile() {
    if (!widget.tile) return const SizedBox.shrink();
    return Semantics(
      button: true,
      enabled: false,
      label: 'Translate, preparing',
      child: Tooltip(
        message: 'Preparing translation…',
        child: Opacity(
          // Matches the disabled treatment of the other call tiles rather than
          // inventing a new one — see `_CallTile` in call_screen.dart.
          opacity: 0.45,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              ZinePressable(
                onTap: null,
                color: AD.cardHover,
                pressedColor: AD.cardHover,
                radius: Msg.brPill,
                boxShadow: Msg.none,
                borderWidth: 1,
                borderColor: AD.borderControl,
                child: SizedBox(
                  width: 64,
                  height: 64,
                  child: Center(
                    child: PhosphorIcon(
                      PhosphorIcons.translate(PhosphorIconsStyle.bold),
                      size: 27,
                      color: AD.textPrimary,
                    ),
                  ),
                ),
              ),
              const SizedBox(height: Msg.s1),
              Text('Translate',
                  maxLines: 1,
                  textAlign: TextAlign.center,
                  overflow: TextOverflow.ellipsis,
                  style: ADText.sectionLabel(c: AD.textSecondary)),
            ],
          ),
        ),
      ),
    );
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
    if (!widget.callConnected) {
      // Ringing / connecting. The tile is present but inert — see [callConnected].
      _reportVisibility('call_not_connected', visible: false);
      return _pendingTile();
    }
    final controller = _controller;
    if (controller == null) {
      // [CALL-TRANSLATE-SLOT-1 2026-08-05] Transient by nature: `_initializeBridge`
      // is still awaiting `WebRTC.initialize()` + `bridge.isSupported()`. Owner
      // report 2026-08-05: "the translate icon populates after a while when the
      // call comes, there is a blank space, then it comes." Telemetry agrees —
      // on call avatok-7ed0f03c the screen opened at 16:22:59.905Z and `shown`
      // only landed at 16:23:02.267Z, 2.4s of an empty hole between More and End.
      //
      // A transient state is NOT the same as "this device cannot translate", so
      // it no longer renders as nothing. It renders the real tile, dimmed and
      // inert, and swaps to the live one in place. Permanent hides (wrong
      // platform, flag off, probe exhausted) still collapse to nothing.
      _reportVisibility('controller_null', visible: false);
      return _pendingTile();
    }
    if (!_nativeSupported) {
      // Still probing (bounded by _kProbeBackoff) — same transient treatment.
      // Only once the retries are exhausted is this device genuinely incapable,
      // and only then does the slot go empty.
      if (!_probeExhausted) {
        _reportVisibility('native_probing', visible: false);
        return _pendingTile();
      }
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
    // [CALL-TRANSLATE-UI-1] A control-row button, byte-for-byte the same
    // geometry and palette as `_btn` in call_screen.dart. Do not restyle this
    // in isolation — if the call controls change, this changes with them.
    //
    // Tap semantics, unchanged from the pill:
    //   idle       -> open the language sheet, then start
    //   active     -> stop immediately (no confirm; it is billed by the minute)
    //   preparing  -> inert, so a double tap can't start two sessions
    // [CALL-UI-GRID-2026-08-05] In `tile` mode this mirrors `_CallTile` in
    // call_screen.dart exactly: 64px circle, 27px icon, AD.cardHover fill on
    // the raised control panel, and a label underneath. The two are deliberate
    // copies rather than a shared widget because this one also owns the
    // preparing/active state and the billed-minutes caption — but they must be
    // changed together or Translate will visibly not belong in the row.
    final double diameter = widget.tile ? 64 : 56;
    final double iconSize = widget.tile ? 27 : 25;
    final button = Semantics(
      button: true,
      label: label, // 'Translate' / 'Stop translation' / 'Switching to X…'
      child: Tooltip(
        message: label,
        child: ZinePressable(
          onTap: preparing ? null : (active ? controller.stop : _pick),
          color: active
              ? AD.primaryBadge
              : (widget.tile ? AD.cardHover : AD.card),
          pressedColor: AD.primaryBadge,
          // A round icon button is genuinely round. Same circle as `_CallTile`
          // in call_screen.dart — Msg.brPill is identical geometry, just named.
          radius: Msg.brPill,
          boxShadow: Msg.none,
          borderWidth: 1,
          borderColor: active ? AD.primaryBadge : AD.borderControl,
          child: SizedBox(
            width: diameter,
            height: diameter,
            child: Center(
              child: PhosphorIcon(
                PhosphorIcons.translate(PhosphorIconsStyle.bold),
                size: iconSize,
                color: active ? AD.textOnInput : AD.textPrimary,
              ),
            ),
          ),
        ),
      ),
    );

    // In the grid the label slot under the circle is not optional — an unlabelled
    // circle between "More" and "End" is the exact ambiguity the grid removed.
    if (widget.tile && !session) {
      return Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          button,
          const SizedBox(height: Msg.s1),
          Text('Translate',
              maxLines: 1,
              textAlign: TextAlign.center,
              overflow: TextOverflow.ellipsis,
              style: ADText.sectionLabel(c: AD.textSecondary)),
        ],
      );
    }

    // Legacy (non-tile) geometry: the 28px leading gap is OURS, not the row's —
    // the old call_screen deliberately appended this widget outside
    // `_controlRow` so that when translation is unavailable (every
    // `SizedBox.shrink()` return above) it collapsed to genuinely nothing, with
    // no phantom gap left hanging off the mic button.
    if (!session) return Padding(padding: const EdgeInsets.only(left: Msg.s6), child: button);

    // Session detail. Only while translating, so an idle call shows a bare
    // circle indistinguishable from mute/speaker — which is the point.
    // `IntrinsicWidth` + centre alignment keeps the caption from stretching the
    // control row: the Row that hosts this centres its children, so a taller
    // child grows the row symmetrically rather than shoving the others.
    return Padding(
      padding: EdgeInsets.only(left: widget.tile ? 0 : 28),
      child: Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        button,
        const SizedBox(height: Msg.s1),
        // Language chip: reopens the SAME searchable sheet mid-session so the
        // payer can change target language without stopping (and without being
        // re-billed for a new session).
        GestureDetector(
          onTap: switching != null ? null : _switchLanguage,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: Msg.s3, vertical: Msg.s1),
            decoration: BoxDecoration(
              color: AD.card,
              // A chip IS one of the shapes Msg.rPill is reserved for.
              borderRadius: Msg.brPill,
              border: Border.all(color: AD.borderControl, width: 1),
            ),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Text(currentLang,
                  style: ADText.timestamp().copyWith(color: AD.textPrimary)),
              const SizedBox(width: Msg.s1),
              PhosphorIcon(PhosphorIcons.caretDown(PhosphorIconsStyle.bold),
                  size: 10, color: AD.textSecondary),
            ]),
          ),
        ),
        const SizedBox(height: Msg.s1),
        // The meter. Continuously visible on purpose — see the class doc.
        ValueListenableBuilder<int>(
          valueListenable: controller.billedTokens,
          builder: (_, tokens, __) => ValueListenableBuilder<int>(
            valueListenable: controller.elapsedSeconds,
            builder: (_, elapsed, __) => Text(
              '5/min · $tokens · ${elapsed ~/ 60}:${(elapsed % 60).toString().padLeft(2, '0')}',
              style: ADText.timestamp(),
            ),
          ),
        ),
        // Dead-air guard: the plugin has ALREADY restored the original audio by
        // the time this shows, so it explains what the user is hearing rather
        // than warning about a broken call. Width-capped so a long string can't
        // widen the control row on a small handset.
        if (stalled)
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 190),
            child: Text('Catching up — you are hearing the original voice',
                textAlign: TextAlign.center, style: ADText.timestamp()),
          ),
        ValueListenableBuilder<bool>(
          valueListenable: controller.qualityDegraded,
          // [CALL-TRANSLATE-OBS-1 / F1] This `SizedBox.shrink()` is NOT a hide
          // path: the button is already on screen and this is only the optional
          // "quality is unstable" caption. Absence of a warning is the healthy
          // case, so it emits nothing — instrumenting it would fire an event on
          // every rebuild of a working call.
          builder: (_, degraded, __) => degraded && !stalled
              ? ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 190),
                  child: Text('Translation quality is unstable',
                      textAlign: TextAlign.center, style: ADText.timestamp()),
                )
              : const SizedBox.shrink(),
        ),
      ],
    ),
    );
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
    // [CALL-TRANSLATE-UI-1] Fully rebuilt. Three things were wrong:
    //
    //  1. OFF-SCREEN. A hard `height: screenHeight * .78` inside an
    //     `isScrollControlled` sheet, with the search field autofocused. The
    //     sheet does not resize for the keyboard, so 0.78·H of content had to
    //     fit in ~0.55·H — the list and part of the header were pushed off the
    //     bottom on open, every time. Now: no fixed height (the parent supplies
    //     a `maxHeight` ceiling), `mainAxisSize.min` so a short filtered list
    //     shrinks the sheet, and explicit `viewInsets.bottom` padding so the
    //     content sits ABOVE the keyboard when it does appear.
    //  2. NO AUTOFOCUS (owner decision 2026-08-05). The list is visible the
    //     instant the sheet opens; the keyboard only appears if you tap search.
    //     Picking a common language is now one tap, not type-then-tap.
    //  3. LIGHT THEME in a dark call screen. `ZineText`/`Zine` swapped for the
    //     `AD`/`ADText` tokens the rest of the call UI uses.
    //
    // Everything renders from bundled assets — Material icons and the local
    // Nunito face. No network image, no WebView, no remote font. It was already
    // true and is stated here so it stays true.
    final bottomInset = MediaQuery.viewInsetsOf(context).bottom;
    return Padding(
      padding: EdgeInsets.only(bottom: bottomInset),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(Msg.s5, Msg.s1, Msg.s5, Msg.s3),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(
              widget.currentCode == null ? 'Translate incoming voice' : 'Change language',
              style: ADText.appTitle().copyWith(fontSize: 18),
            ),
            const SizedBox(height: Msg.s1),
            Text(
              widget.currentCode == null
                  ? 'Choose your language · 5 Tokens per started minute'
                  : 'Switching is free — the same session keeps running',
              style: ADText.preview(),
            ),
            const SizedBox(height: Msg.s3),
            TextField(
              controller: _search,
              // Deliberately NOT autofocused — see (2) above.
              autofocus: false,
              textInputAction: TextInputAction.search,
              style: ADText.rowName().copyWith(color: AD.textPrimary),
              cursorColor: AD.primaryBadge,
              onChanged: (value) => setState(() => _query = value),
              decoration: InputDecoration(
                isDense: true,
                filled: true,
                fillColor: AD.card,
                prefixIcon: PhosphorIcon(
                    PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.regular),
                    size: 20, color: AD.textSecondary),
                suffixIcon: _query.isEmpty
                    ? null
                    : IconButton(
                        icon: PhosphorIcon(
                            PhosphorIcons.x(PhosphorIconsStyle.regular),
                            size: 18, color: AD.textSecondary),
                        onPressed: () {
                          _search.clear();
                          setState(() => _query = '');
                        },
                      ),
                hintText: 'Search languages',
                hintStyle: ADText.preview(),
                contentPadding: const EdgeInsets.symmetric(horizontal: Msg.s4, vertical: Msg.s4),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(14),
                  borderSide: BorderSide(color: AD.borderControl, width: 1),
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(14),
                  borderSide: BorderSide(color: AD.primaryBadge, width: 1.5),
                ),
              ),
            ),
          ]),
        ),
        // Flexible, not Expanded: with a filtered list of two results the sheet
        // shrinks to fit instead of holding a screen-height box of empty space.
        Flexible(
          child: languages.isEmpty
              ? Padding(
                  padding: const EdgeInsets.symmetric(vertical: 32),
                  child: Text('No matching language', style: ADText.preview()),
                )
              : ListView.builder(
                  shrinkWrap: true,
                  padding: const EdgeInsets.only(bottom: 12),
                  itemCount: languages.length,
                  itemBuilder: (_, index) {
                    final item = languages[index];
                    final isCurrent = item.code == widget.currentCode;
                    return ListTile(
                      dense: true,
                      title: Text(item.label,
                          style: ADText.rowName().copyWith(
                              color: isCurrent ? AD.primaryBadge : AD.textPrimary)),
                      subtitle: Text(
                        isCurrent ? '${item.code} · translating now' : item.code,
                        style: ADText.preview(),
                      ),
                      trailing: isCurrent
                          ? PhosphorIcon(
                              PhosphorIcons.check(PhosphorIconsStyle.regular),
                              size: 20, color: AD.primaryBadge)
                          : null,
                      onTap: () => Navigator.pop(context, item.code),
                    );
                  },
                ),
        ),
      ]),
    );
  }
}
