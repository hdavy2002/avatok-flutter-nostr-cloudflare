import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/analytics/analytics.dart';
import '../../../core/api/api_error.dart';
import '../../../core/theme/hf_tokens.dart';
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

class _PresenceCardState extends ConsumerState<PresenceCard> with WidgetsBindingObserver {
  late final PresenceHeartbeat _heartbeat;

  /// Set by a successful toggle; cleared when the server value is read again.
  String? _override;
  bool _switching = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _heartbeat = PresenceHeartbeat(beat: _sendBeat, interval: ref.read(presenceBeatIntervalProvider));
    // No lifecycle state yet (tests) counts as foreground.
    final life = WidgetsBinding.instance.lifecycleState;
    if (life != null && life != AppLifecycleState.resumed) _heartbeat.setForeground(false);
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

  static bool _isOnline(String presence) => presence == 'online' || presence == 'busy';

  Future<void> _toggle(bool wantOnline) async {
    setState(() {
      _switching = true;
      _error = null;
    });
    try {
      final presence = await ref.read(hostDashboardApiProvider).setPresence(wantOnline);
      if (!mounted) return;
      setState(() {
        _override = presence;
        _switching = false;
      });
      _heartbeat.setOnline(_isOnline(presence));
      unawaited(Analytics.capture('hf_app_host_presence', {'online': wantOnline, 'outcome': 'ok'}));
    } on ApiError catch (e) {
      if (!mounted) return;
      setState(() {
        _switching = false;
        _error = e.code == 'not_live' && (e.message == null) ? HostCopy.notLive : e.userMessage;
      });
      unawaited(Analytics.capture('hf_app_host_presence', {
        'online': wantOnline,
        'outcome': 'error',
        'reason': e.code,
        'status': e.status,
      }));
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
      _heartbeat.setOnline(_isOnline(value), beatNow: first && _isOnline(value));
    });
    final presence = ref.watch(hostPresenceProvider);
    return SectionAsync<String>(
      title: HostCopy.presenceTitle,
      value: presence,
      onRetry: () => ref.invalidate(hostPresenceProvider),
      notEnabledMessage: 'Calls open soon.',
      builder: (server) => _card(_override ?? server),
    );
  }

  Widget _card(String current) {
    final online = _isOnline(current);
    final pill = HostPresence.parse(current);
    return HfCard(
      key: const ValueKey<String>('presence-card'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(child: Text(HostCopy.presenceTitle, style: HfText.subtitle)),
              StatusPill(presence: pill),
            ],
          ),
          const SizedBox(height: 14),
          SizedBox(
            height: 64,
            child: HfButton(
              key: const ValueKey<String>('presence-toggle'),
              label: online ? HostCopy.goOffline : HostCopy.goOnline,
              kind: online ? HfButtonKind.secondary : HfButtonKind.primary,
              icon: online ? Icons.power_settings_new_rounded : Icons.call_rounded,
              loading: _switching,
              onPressed: () => _toggle(!online),
            ),
          ),
          if (_error != null) ...[
            const SizedBox(height: 10),
            Text(_error!, key: const ValueKey<String>('presence-error'), style: HfText.bodyText.copyWith(color: HfColors.accent)),
          ],
          const SizedBox(height: 10),
          Text(online ? HostCopy.onlineNote : HostCopy.offlineNote, style: HfText.note, key: const ValueKey<String>('presence-note')),
        ],
      ),
    );
  }
}
