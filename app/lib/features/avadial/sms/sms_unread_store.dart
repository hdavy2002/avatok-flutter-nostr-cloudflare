import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';

import '../../../core/remote_config.dart';
import '../avadial_channel.dart';
import '../device_contacts.dart';

/// [AVA-SMS-BADGE-1] Live unread-SMS counters (owner request 2026-07-14):
///
///   - RED total on the AvaDialer icon in the shell [AppSwitcherBar] — "you
///     have a message" before the user even opens AvaDialer;
///   - ORANGE total on the Messages tab chip inside AvaDialer;
///   - ORANGE per-thread counts on the conversation rows;
///   - all three WALK DOWN as the user opens threads ([markThreadRead]).
///
/// LIVE reads of the OS SMS provider only (`read = 0`), keyed by
/// [DeviceContacts.normKey] so "+44…" and local formats collapse into one
/// thread. Nothing is persisted — the OS provider is the source of truth, so
/// counts survive restarts and stay honest if another SMS app marks things
/// read. Refreshes on: [start], every inbound SMS (smsIncoming), app resume,
/// and after [markThreadRead].
class SmsUnreadStore with WidgetsBindingObserver {
  SmsUnreadStore._();
  static final SmsUnreadStore I = SmsUnreadStore._();

  /// Total unread across all threads — the AvaDialer-icon / Messages-tab badge.
  final ValueNotifier<int> total = ValueNotifier<int>(0);

  /// Bumped whenever per-address counts change; thread rows listen to this.
  final ValueNotifier<int> _revision = ValueNotifier<int>(0);
  ValueListenable<int> get revision => _revision;

  Map<String, int> _perAddress = const {}; // normKey → unread count

  StreamSubscription<AvaSmsMessage>? _sub;
  bool _started = false;

  /// Idempotent. Wire the channel, watch inbound SMS + app resumes, and do the
  /// first read. Cheap when `avaSms` is off / role not held (resolves to 0).
  void start() {
    if (_started) return;
    _started = true;
    AvaDialChannel.I.ensureWired();
    WidgetsBinding.instance.addObserver(this);
    _sub = AvaDialChannel.I.smsIncoming.listen((_) => refresh());
    refresh();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // The user may read/receive texts elsewhere (notification shade, another
    // device surface) — re-read reality whenever we come back.
    if (state == AppLifecycleState.resumed) refresh();
  }

  /// Unread count for one conversation (0 when none / unknown).
  int countFor(String address) =>
      _perAddress[DeviceContacts.normKey(address)] ?? 0;

  Future<void> refresh() async {
    if (!RemoteConfig.avaSms) {
      _set(const {}, 0);
      return;
    }
    try {
      if (!await AvaDialChannel.I.isSmsRoleHeld()) {
        _set(const {}, 0);
        return;
      }
      final rows = await AvaDialChannel.I.smsUnreadCounts();
      final map = <String, int>{};
      var sum = 0;
      for (final r in rows) {
        final addr = (r['address'] as String?)?.trim() ?? '';
        final n = (r['count'] as num?)?.toInt() ?? 0;
        if (addr.isEmpty || n <= 0) continue;
        final k = DeviceContacts.normKey(addr);
        map[k] = (map[k] ?? 0) + n;
        sum += n;
      }
      _set(map, sum);
    } catch (_) {
      // Keep the last known counts — never crash a badge.
    }
  }

  /// The user opened [address]'s thread: mark its messages read in the OS
  /// provider, then re-read so every badge decrements together.
  Future<void> markThreadRead(String address) async {
    try {
      await AvaDialChannel.I.smsMarkRead(address);
    } catch (_) {}
    await refresh();
  }

  void _set(Map<String, int> m, int sum) {
    final changed = !mapEquals(m, _perAddress);
    _perAddress = m;
    if (total.value != sum) total.value = sum;
    if (changed) _revision.value++;
  }

  @visibleForTesting
  void stop() {
    if (!_started) return;
    _started = false;
    WidgetsBinding.instance.removeObserver(this);
    _sub?.cancel();
    _sub = null;
  }
}
