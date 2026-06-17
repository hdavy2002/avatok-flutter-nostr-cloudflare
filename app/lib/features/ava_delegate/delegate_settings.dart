import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/api_auth.dart';
import '../../core/config.dart';
import '../../core/disk_cache.dart';
import '../../core/paid_feature.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';

/// Per-chat Ava DELEGATE controls (Phase 7 — Delegate: Monitor + Auto-reply +
/// Push). Two opt-in toggles a user sets FOR ONE CONVERSATION:
///
///   • "Monitor & reply on my behalf"  — PREMIUM. When you are @mentioned in
///     this chat AND you are offline, Ava posts a clearly-DISCLOSED reply
///     ("Ava — for <you>: …") so the group isn't left hanging. Ava never
///     impersonates you; the disclosure is always shown.
///   • "Alert me on all mentions"      — FREE. Push you whenever you're
///     @mentioned here, even if monitoring is off.
///
/// Storage: the server is the source of truth (`/api/ava/delegate`, a documented
/// Phase-11 hook — `index.ts` is frozen and registered no delegate route yet).
/// Until that route is live, [DelegatePrefsClient] degrades GRACEFULLY to a
/// per-account local cache ([DiskCache], scoped under `cache/<AccountScope.id>/`)
/// so the toggles still work and persist on-device; they sync to the server the
/// moment the route lands. The premium ENABLE of monitoring is wrapped in
/// [PaidFeature]; turning anything OFF and the free alert toggle are ungated.
class DelegateSettingsSheet extends StatefulWidget {
  /// Server conversation id (`dm_…` or `g_…`). REQUIRED — prefs are per-conv.
  final String conv;

  /// A friendly chat label for the header (group name / peer name).
  final String? chatLabel;

  const DelegateSettingsSheet({super.key, required this.conv, this.chatLabel});

  /// Show as a modal bottom sheet. Returns when dismissed.
  static Future<void> show(BuildContext context, {required String conv, String? chatLabel}) {
    return showModalBottomSheet<void>(
      context: context,
      backgroundColor: Zine.paper,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (_) => DelegateSettingsSheet(conv: conv, chatLabel: chatLabel),
    );
  }

  @override
  State<DelegateSettingsSheet> createState() => _DelegateSettingsSheetState();
}

class _DelegateSettingsSheetState extends State<DelegateSettingsSheet> {
  DelegatePrefs _prefs = DelegatePrefs.off;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final p = await DelegatePrefsClient.I.get(widget.conv);
    if (!mounted) return;
    setState(() {
      _prefs = p;
      _loading = false;
    });
  }

  Future<void> _setMonitor(bool v) async {
    final next = await DelegatePrefsClient.I.set(widget.conv, monitor: v);
    if (mounted) setState(() => _prefs = next);
  }

  Future<void> _setAlert(bool v) async {
    final next = await DelegatePrefsClient.I.set(widget.conv, alertMentions: v);
    if (mounted) setState(() => _prefs = next);
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 18, 20, 20),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            ZineIconBadge(icon: PhosphorIcons.sparkle(PhosphorIconsStyle.fill), color: Zine.lilac, size: 38),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Ava delegate', style: ZineText.cardTitle(size: 18)),
                if (widget.chatLabel != null && widget.chatLabel!.isNotEmpty)
                  Text(widget.chatLabel!, style: ZineText.sub(size: 12)),
              ]),
            ),
          ]),
          const SizedBox(height: 16),
          if (_loading)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 28),
              child: Center(child: CircularProgressIndicator(strokeWidth: 2.4)),
            )
          else ...[
            // FREE — alert on all mentions.
            _ToggleRow(
              icon: PhosphorIcons.bellRinging(PhosphorIconsStyle.fill),
              title: 'Alert me on all mentions',
              subtitle: 'Get a push whenever someone @mentions you in this chat — '
                  'even when Ava isn’t replying for you.',
              value: _prefs.alertMentions,
              onChanged: _setAlert,
            ),
            const SizedBox(height: 12),
            // PREMIUM — monitor & reply on my behalf. Enable is gated; disable free.
            _MonitorRow(
              value: _prefs.monitor,
              onEnable: () => _setMonitor(true),
              onDisable: () => _setMonitor(false),
            ),
            const SizedBox(height: 14),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Zine.paper2,
                borderRadius: BorderRadius.circular(12),
                border: Zine.border,
              ),
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                PhosphorIcon(PhosphorIcons.info(PhosphorIconsStyle.bold), size: 16, color: Zine.inkSoft),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    'When Ava replies for you she always says so — "Ava — for <you>" — '
                    'and only while you’re offline. She never pretends to be you.',
                    style: ZineText.sub(size: 11.5),
                  ),
                ),
              ]),
            ),
            if (!DelegatePrefsClient.I.serverLive) ...[
              const SizedBox(height: 8),
              Text(
                'Saved on this device. Syncs to your account when delegate sync goes live.',
                style: ZineText.sub(size: 10.5, color: Zine.inkSoft),
              ),
            ],
          ],
        ]),
      ),
    );
  }
}

class _ToggleRow extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;
  final bool value;
  final ValueChanged<bool> onChanged;

  const _ToggleRow({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.value,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    return ZineCard(
      radius: Zine.rSm,
      padding: const EdgeInsets.all(14),
      boxShadow: Zine.shadowXs,
      child: Row(children: [
        ZineIconBadge(icon: icon, color: Zine.lilac, size: 34),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: ZineText.value(size: 14.5)),
            const SizedBox(height: 2),
            Text(subtitle, style: ZineText.sub(size: 12)),
          ]),
        ),
        const SizedBox(width: 10),
        ZineToggle(value: value, onChanged: onChanged),
      ]),
    );
  }
}

/// Premium monitor row — ON is the paid gate (wrapped in [PaidFeature]); OFF is
/// free (a plain toggle). Mirrors the voice_section premium-toggle pattern.
class _MonitorRow extends StatelessWidget {
  final bool value;
  final Future<void> Function() onEnable;
  final Future<void> Function() onDisable;

  const _MonitorRow({required this.value, required this.onEnable, required this.onDisable});

  @override
  Widget build(BuildContext context) {
    return ZineCard(
      radius: Zine.rSm,
      padding: const EdgeInsets.all(14),
      boxShadow: Zine.shadowXs,
      child: Row(children: [
        ZineIconBadge(icon: PhosphorIcons.userFocus(PhosphorIconsStyle.fill), color: Zine.lilac, size: 34),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Flexible(child: Text('Monitor & reply on my behalf', style: ZineText.value(size: 14.5))),
              const SizedBox(width: 8),
              const PaidBadge(),
            ]),
            const SizedBox(height: 2),
            Text(
              value
                  ? 'When you’re @mentioned here and offline, Ava posts a disclosed '
                      'holding reply so the group isn’t left waiting.'
                  : 'Premium. Let Ava cover @mentions of you here while you’re away '
                      '(always disclosed, never impersonation).',
              style: ZineText.sub(size: 12),
            ),
          ]),
        ),
        const SizedBox(width: 10),
        if (value)
          ZineToggle(value: true, onChanged: (_) => onDisable())
        else
          PaidFeature(
            actionLabel: 'Enable Ava delegate',
            onRun: onEnable,
            child: const IgnorePointer(child: ZineToggle(value: false, onChanged: null)),
          ),
      ]),
    );
  }
}

/// Per-chat delegate prefs (mirror of the worker `ava_delegate_prefs` row).
@immutable
class DelegatePrefs {
  final bool monitor;
  final bool alertMentions;
  const DelegatePrefs({required this.monitor, required this.alertMentions});

  static const off = DelegatePrefs(monitor: false, alertMentions: false);

  DelegatePrefs copyWith({bool? monitor, bool? alertMentions}) => DelegatePrefs(
        monitor: monitor ?? this.monitor,
        alertMentions: alertMentions ?? this.alertMentions,
      );

  Map<String, Object?> toJson() => {'monitor': monitor, 'alertMentions': alertMentions};

  factory DelegatePrefs.fromJson(Map<String, Object?> j) => DelegatePrefs(
        monitor: j['monitor'] == true,
        alertMentions: j['alertMentions'] == true,
      );
}

/// Reads/writes per-chat delegate prefs. Talks to the (Phase-11-wired)
/// `/api/ava/delegate` route; if that route is not yet live (HTTP 404/501/etc.)
/// it transparently falls back to a per-account on-device cache so the UI keeps
/// working. Every successful server read flips [serverLive] true so the UI can
/// note when prefs are device-only.
class DelegatePrefsClient {
  DelegatePrefsClient._();
  static final DelegatePrefsClient I = DelegatePrefsClient._();

  /// `/api/ava/delegate` — built from the API origin + path (mirrors
  /// AvaTurnController/AvaAiClient URL building).
  static String get _url {
    final origin = kApiBase.endsWith('/api')
        ? kApiBase.substring(0, kApiBase.length - '/api'.length)
        : kApiBase;
    return '$origin/api/ava/delegate';
  }

  /// True once a server round-trip has succeeded this session (so the UI can
  /// stop showing the "device-only" hint). Stays false while the route is 404.
  bool serverLive = false;

  String _cacheKey(String conv) => 'ava_delegate_$conv';

  Future<DelegatePrefs> _readCache(String conv) async {
    try {
      final raw = await DiskCache.read(_cacheKey(conv));
      if (raw == null || raw.isEmpty) return DelegatePrefs.off;
      return DelegatePrefs.fromJson(jsonDecode(raw) as Map<String, Object?>);
    } catch (_) {
      return DelegatePrefs.off;
    }
  }

  Future<void> _writeCache(String conv, DelegatePrefs p) async {
    try {
      await DiskCache.write(_cacheKey(conv), jsonEncode(p.toJson()));
    } catch (_) {/* best-effort local cache */}
  }

  /// Read prefs for [conv]. Server first; on any failure, the local cache.
  Future<DelegatePrefs> get(String conv) async {
    try {
      final res = await ApiAuth.getSigned('$_url?conv=${Uri.encodeQueryComponent(conv)}',
          timeout: const Duration(seconds: 8));
      if (res.statusCode == 200) {
        serverLive = true;
        final j = jsonDecode(res.body) as Map<String, Object?>;
        final p = DelegatePrefs(monitor: j['monitor'] == true, alertMentions: j['alertMentions'] == true);
        await _writeCache(conv, p); // keep the local mirror fresh
        return p;
      }
    } catch (_) {/* fall through to cache */}
    return _readCache(conv);
  }

  /// Update one or both toggles for [conv]. Optimistically writes the local
  /// cache, then best-effort syncs to the server (when the route is live).
  Future<DelegatePrefs> set(String conv, {bool? monitor, bool? alertMentions}) async {
    final cur = await _readCache(conv);
    final next = cur.copyWith(monitor: monitor, alertMentions: alertMentions);
    await _writeCache(conv, next); // local-first so the toggle persists regardless

    try {
      final body = <String, Object?>{
        'conv': conv,
        if (monitor != null) 'monitor': monitor,
        if (alertMentions != null) 'alertMentions': alertMentions,
      };
      final res = await ApiAuth.postJson(_url, body, timeout: const Duration(seconds: 8));
      if (res.statusCode == 200) {
        serverLive = true;
        try {
          final j = jsonDecode(res.body) as Map<String, Object?>;
          final pj = j['prefs'];
          if (pj is Map<String, Object?>) {
            final p = DelegatePrefs(monitor: pj['monitor'] == true, alertMentions: pj['alertMentions'] == true);
            await _writeCache(conv, p);
            return p;
          }
        } catch (_) {/* keep optimistic value */}
      }
    } catch (e) {
      if (kDebugMode) debugPrint('DelegatePrefsClient.set sync deferred: $e');
    }
    return next;
  }
}
