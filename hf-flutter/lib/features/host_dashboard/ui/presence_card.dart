import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/analytics/analytics.dart';
import '../../../core/api/api_error.dart';
import '../../../core/theme/hf_theme.dart';
import '../../../core/widgets/widgets.dart';
import '../data/presence_heartbeat.dart';
import '../host_dashboard_providers.dart';
import 'host_dashboard_copy.dart';
import 'section_async.dart';

/// The big online / offline switch, and the heartbeat that keeps an online host online.
///
/// The heartbeat runs ONLY while the host is online AND the app is in the foreground ([PresenceHeartbeat]).
/// The server drops a host offline after 8 hours without a beat, which is what the note under the button says.
class PresenceCard extends ConsumerStatefulWidget {
  const PresenceCard({super.key});

  @override
  ConsumerState<PresenceCard> createState() => _PresenceCardState();
}

class _PresenceCardState extends ConsumerState<PresenceCard>
    with WidgetsBindingObserver {
  late final PresenceHeartbeat _heartbeat;

  /// What the card shows instead of the server value: set at once when the switch is flipped (optimistic),
  /// confirmed by the answer, put back if the server refuses. Cleared when the server value is read again.
  String? _override;
  bool _switching = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _heartbeat = PresenceHeartbeat(
      beat: _sendBeat,
      interval: ref.read(presenceBeatIntervalProvider),
    );
    // No lifecycle state yet (tests) counts as foreground.
    final life = WidgetsBinding.instance.lifecycleState;
    if (life != null && life != AppLifecycleState.resumed) {
      _heartbeat.setForeground(false);
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _heartbeat.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    switch (state) {
      case AppLifecycleState.resumed:
        _heartbeat.setForeground(true);
      case AppLifecycleState.hidden:
      case AppLifecycleState.paused:
        _heartbeat.setForeground(false);
      case AppLifecycleState.inactive:
      case AppLifecycleState.detached:
        break;
    }
  }

  void _sendBeat() {
    unawaited(() async {
      try {
        await ref.read(hostDashboardApiProvider).beat();
      } catch (_) {
        // A missed beat is harmless: the next one (or the next resume) covers it.
      }
    }());
  }

  static bool _isOnline(String presence) =>
      presence == 'online' || presence == 'busy';

  void _say(String message) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  /// Flips the switch at once, asks the server, and puts it back (with a snackbar) if the server says no.
  /// Taps are ignored while a request is in flight.
  Future<void> _toggle(bool wantOnline, String shown) async {
    if (_switching) return;
    unawaited(HapticFeedback.selectionClick());
    final previous = _override;
    setState(() {
      _switching = true;
      _override = wantOnline ? 'online' : 'offline';
    });
    try {
      final presence = await ref
          .read(hostDashboardApiProvider)
          .setPresence(wantOnline);
      if (!mounted) return;
      setState(() {
        _override = presence;
        _switching = false;
      });
      _heartbeat.setOnline(_isOnline(presence));
      _say(wantOnline ? HostCopy.nowOnline : HostCopy.nowOffline);
      unawaited(
        Analytics.capture('hf_app_host_presence', {
          'online': wantOnline,
          'outcome': 'ok',
        }),
      );
    } on ApiError catch (e) {
      if (!mounted) return;
      setState(() {
        _switching = false;
        _override = previous ?? shown;
      });
      _say(
        e.code == 'not_live' && (e.message == null)
            ? HostCopy.notLive
            : e.userMessage,
      );
      unawaited(
        Analytics.capture('hf_app_host_presence', {
          'online': wantOnline,
          'outcome': 'error',
          'reason': e.code,
          'status': e.status,
        }),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.listen<AsyncValue<String>>(hostPresenceProvider, (prev, next) {
      final value = dashValueOf(next);
      if (value == null) return;
      final first = prev == null || !prev.hasValue;
      _override = null; // the screen rebuilds from the provider change itself
      // First read finds the host online (the app was reopened): beat at once so the 8 h clock restarts.
      _heartbeat.setOnline(
        _isOnline(value),
        beatNow: first && _isOnline(value),
      );
    });
    final presence = ref.watch(hostPresenceProvider);
    return SectionAsync<String>(
      title: HostCopy.presenceTitle,
      value: presence,
      onRetry: () => ref.invalidate(hostPresenceProvider),
      notEnabledMessage: 'Calls open soon.',
      skeletonHeight: 128,
      skeletonRadius: HfRadius.cardInner,
      builder: (server) => _card(context, _override ?? server),
    );
  }

  Widget _card(BuildContext context, String current) {
    final online = _isOnline(current);
    final busy = current == 'busy';
    final title = HfText.of(
      context,
      HfText.stat.copyWith(color: HfTint.blush.valueInk(context)),
    );
    final sub = HfText.of(
      context,
      HfText.label.copyWith(
        color: HfTint.blush.valueInk(context),
        fontWeight: FontWeight.w400,
      ),
    );
    return Container(
      key: const ValueKey<String>('presence-card'),
      padding: const EdgeInsets.all(HfSpacing.xxl),
      decoration: HfSurfaces.card(context, radius: HfRadius.cardInner),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      online ? HostCopy.onlineTitle : HostCopy.offlineTitle,
                      style: title,
                    ),
                    const SizedBox(height: 2),
                    Text(
                      busy
                          ? HostCopy.busySub
                          : (online ? HostCopy.onlineSub : HostCopy.offlineSub),
                      style: sub,
                    ),
                  ],
                ),
              ),
              const SizedBox(width: HfSpacing.lg),
              if (busy)
                const HfStatusPill(
                  status: HfPresence.busy,
                  large: true,
                  animate: false,
                )
              else
                _HfSwitch(
                  key: const ValueKey<String>('presence-toggle'),
                  on: online,
                  busy: _switching,
                  label: online ? HostCopy.goOffline : HostCopy.goOnline,
                  onTap: () => _toggle(!online, current),
                ),
            ],
          ),
          const SizedBox(height: HfSpacing.md),
          Text(
            HostCopy.presenceNote,
            style: sub,
            key: const ValueKey<String>('presence-note'),
          ),
        ],
      ),
    );
  }
}

/// The mockup's switch: a 64 x 38 track (rose when on, soft grey when off) with a 30 px thumb that slides in
/// 220 ms. A 48 dp tall hit area wraps it. [busy] shows a spinner in the thumb and ignores taps.
class _HfSwitch extends StatelessWidget {
  const _HfSwitch({
    super.key,
    required this.on,
    required this.busy,
    required this.label,
    required this.onTap,
  });

  final bool on;
  final bool busy;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final dark = HfBrightness.isDark(context);
    final d = HfMotion.of(context, HfMotion.base);
    final track = on
        ? HfColors.rose
        : (dark ? HfColors.darkSelected : HfColors.surfaceSoft);
    final thumb = on
        ? HfColors.white
        : (dark ? HfColors.mutedSoft : HfColors.handle);
    return Semantics(
      toggled: on,
      enabled: !busy,
      label: label,
      onTap: busy ? null : onTap,
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: busy ? null : onTap,
        child: SizedBox(
          width: 64,
          height: HfSpacing.tap,
          child: Center(
            child: AnimatedContainer(
              duration: d,
              curve: HfMotion.curve,
              width: 64,
              height: 38,
              padding: const EdgeInsets.all(4),
              decoration: BoxDecoration(
                color: track,
                borderRadius: BorderRadius.circular(19),
              ),
              child: AnimatedAlign(
                duration: d,
                curve: HfMotion.curve,
                alignment: on ? Alignment.centerRight : Alignment.centerLeft,
                child: AnimatedContainer(
                  duration: d,
                  curve: HfMotion.curve,
                  width: 30,
                  height: 30,
                  decoration: BoxDecoration(
                    color: thumb,
                    shape: BoxShape.circle,
                  ),
                  child: busy
                      ? Padding(
                          padding: const EdgeInsets.all(7),
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: on ? HfColors.rose : HfColors.muted,
                          ),
                        )
                      : null,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
