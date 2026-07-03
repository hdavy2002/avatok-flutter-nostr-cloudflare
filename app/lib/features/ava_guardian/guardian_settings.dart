import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/api_auth.dart';
import '../../core/config.dart';
import '../../core/disk_cache.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';

/// Per-chat Ava GUARDIAN controls (Phase 8 — Safety) + warning-display prefs.
///
/// Two opt-in protections a user sets FOR ONE CONVERSATION (typically a chat with
/// a stranger):
///
///   • "Secure-chat mode"        — FREE. Turns on Guardian monitoring for this
///     chat: the AI security classifier (Claude Opus 4.8) runs on every incoming
///     message and a PRIVATE warning (only you can see it) appears if the sender
///     looks predatory / scammy / unsafe.
///   • "Always-on deep monitoring" — FREE on all plans (no paywall). Same deep
///     check; kept as an explicit opt-in row.
///
/// Storage: the server is the source of truth (`POST /api/ava/guardian/scan` with
/// a `{prefs}` / `{get_prefs}` body — the route IS wired by Phase 0). If a call
/// fails, [GuardianPrefsClient] degrades GRACEFULLY to a per-account local cache
/// ([DiskCache], scoped under `cache/<AccountScope.id>/`) so the toggles still
/// work on-device and sync when the network is back. Mirrors P7's
/// DelegatePrefsClient pattern.
///
/// Warning-display preferences (how loud Guardian's private warnings are) are a
/// per-account on-device pref ([GuardianDisplayPrefs]); they only change client
/// presentation — the private `ava_private` warning bubble always renders.
class GuardianSettingsSheet extends StatefulWidget {
  /// Server conversation id (`dm_…` or `g_…`). REQUIRED — prefs are per-conv.
  final String conv;

  /// A friendly chat label for the header (group name / peer name).
  final String? chatLabel;

  const GuardianSettingsSheet({super.key, required this.conv, this.chatLabel});

  /// Show as a modal bottom sheet. Returns when dismissed.
  static Future<void> show(BuildContext context, {required String conv, String? chatLabel}) {
    return showModalBottomSheet<void>(
      context: context,
      backgroundColor: Zine.paper,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (_) => GuardianSettingsSheet(conv: conv, chatLabel: chatLabel),
    );
  }

  @override
  State<GuardianSettingsSheet> createState() => _GuardianSettingsSheetState();
}

class _GuardianSettingsSheetState extends State<GuardianSettingsSheet> {
  GuardianPrefs _prefs = GuardianPrefs.off;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final p = await GuardianPrefsClient.I.get(widget.conv);
    if (!mounted) return;
    setState(() {
      _prefs = p;
      _loading = false;
    });
  }

  Future<void> _setSecure(bool v) async {
    final next = await GuardianPrefsClient.I.set(widget.conv, secureChat: v);
    if (mounted) setState(() => _prefs = next);
  }

  Future<void> _setDeep(bool v) async {
    final next = await GuardianPrefsClient.I.set(widget.conv, deepMonitor: v);
    if (mounted) setState(() => _prefs = next);
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 18, 20, 20),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            ZineIconBadge(icon: PhosphorIcons.shieldCheck(PhosphorIconsStyle.fill), color: Zine.lilac, size: 38),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Ava guardian', style: ZineText.cardTitle(size: 18)),
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
            // FREE — secure-chat mode.
            _ToggleRow(
              icon: PhosphorIcons.shieldCheck(PhosphorIconsStyle.fill),
              title: 'Secure-chat mode',
              subtitle: 'Let Ava watch this chat for scams, spam, and unsafe behaviour. '
                  'If something looks off, only you get a private heads-up.',
              value: _prefs.secureChat,
              onChanged: _setSecure,
            ),
            const SizedBox(height: 12),
            // PREMIUM — always-on deep monitoring. Enable gated; disable free.
            _DeepRow(
              value: _prefs.deepMonitor,
              onEnable: () => _setDeep(true),
              onDisable: () => _setDeep(false),
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
                PhosphorIcon(PhosphorIcons.lockKey(PhosphorIconsStyle.bold), size: 16, color: Zine.inkSoft),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    'Guardian warnings are private — only you ever see them, never the '
                    'other person. Ava never reads end-to-end / on-device-only content.',
                    style: ZineText.sub(size: 11.5),
                  ),
                ),
              ]),
            ),
            if (!GuardianPrefsClient.I.serverLive) ...[
              const SizedBox(height: 8),
              Text(
                'Saved on this device. Syncs to your account when the connection is back.',
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

/// Deep-monitoring row — FREE on all plans (no paywall). A plain toggle.
class _DeepRow extends StatelessWidget {
  final bool value;
  final Future<void> Function() onEnable;
  final Future<void> Function() onDisable;

  const _DeepRow({required this.value, required this.onEnable, required this.onDisable});

  @override
  Widget build(BuildContext context) {
    return ZineCard(
      radius: Zine.rSm,
      padding: const EdgeInsets.all(14),
      boxShadow: Zine.shadowXs,
      child: Row(children: [
        ZineIconBadge(icon: PhosphorIcons.eye(PhosphorIconsStyle.fill), color: Zine.lilac, size: 34),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Flexible(child: Text('Always-on deep monitoring', style: ZineText.value(size: 14.5))),
            const SizedBox(height: 2),
            Text(
              value
                  ? 'Ava runs the deeper safety check on every message here, not just '
                      'when something obvious is spotted.'
                  : 'Run the deeper safety check on every message in this chat '
                      'for the strongest protection.',
              style: ZineText.sub(size: 12),
            ),
          ]),
        ),
        const SizedBox(width: 10),
        // Free on all plans — no paywall (owner decision 2026-06-24).
        ZineToggle(value: value, onChanged: (v) => v ? onEnable() : onDisable()),
      ]),
    );
  }
}

/// Per-chat guardian prefs (mirror of the worker `ava_guardian_prefs` row).
@immutable
class GuardianPrefs {
  final bool secureChat;
  final bool deepMonitor;
  const GuardianPrefs({required this.secureChat, required this.deepMonitor});

  static const off = GuardianPrefs(secureChat: false, deepMonitor: false);

  GuardianPrefs copyWith({bool? secureChat, bool? deepMonitor}) => GuardianPrefs(
        secureChat: secureChat ?? this.secureChat,
        deepMonitor: deepMonitor ?? this.deepMonitor,
      );

  Map<String, Object?> toJson() => {'secureChat': secureChat, 'deepMonitor': deepMonitor};

  factory GuardianPrefs.fromJson(Map<String, Object?> j) => GuardianPrefs(
        secureChat: j['secureChat'] == true,
        deepMonitor: j['deepMonitor'] == true,
      );
}

/// Reads/writes per-chat guardian prefs against `POST /api/ava/guardian/scan`
/// (the Phase-0-wired route) using its `{prefs}` / `{get_prefs}` body modes. On
/// any failure it transparently falls back to a per-account on-device cache so the
/// UI keeps working. A successful server round-trip flips [serverLive] true.
class GuardianPrefsClient {
  GuardianPrefsClient._();
  static final GuardianPrefsClient I = GuardianPrefsClient._();

  /// `/api/ava/guardian/scan` — built from the API origin (mirrors P7's client).
  static String get _url {
    final origin = kApiBase.endsWith('/api')
        ? kApiBase.substring(0, kApiBase.length - '/api'.length)
        : kApiBase;
    return '$origin/api/ava/guardian/scan';
  }

  /// True once a server round-trip has succeeded this session.
  bool serverLive = false;

  String _cacheKey(String conv) => 'ava_guardian_$conv';

  Future<GuardianPrefs> _readCache(String conv) async {
    try {
      final raw = await DiskCache.read(_cacheKey(conv));
      if (raw == null || raw.isEmpty) return GuardianPrefs.off;
      return GuardianPrefs.fromJson(jsonDecode(raw) as Map<String, Object?>);
    } catch (_) {
      return GuardianPrefs.off;
    }
  }

  Future<void> _writeCache(String conv, GuardianPrefs p) async {
    try {
      await DiskCache.write(_cacheKey(conv), jsonEncode(p.toJson()));
    } catch (_) {/* best-effort local cache */}
  }

  /// Read prefs for [conv]. Server first; on any failure, the local cache.
  Future<GuardianPrefs> get(String conv) async {
    try {
      final res = await ApiAuth.postJson(_url, {'get_prefs': {'conv': conv}},
          timeout: const Duration(seconds: 8));
      if (res.statusCode == 200) {
        serverLive = true;
        final j = jsonDecode(res.body) as Map<String, Object?>;
        final p = GuardianPrefs(secureChat: j['secureChat'] == true, deepMonitor: j['deepMonitor'] == true);
        await _writeCache(conv, p);
        return p;
      }
    } catch (_) {/* fall through to cache */}
    return _readCache(conv);
  }

  /// Update one or both toggles for [conv]. Optimistic local write, then a
  /// best-effort server sync. A 402 (premium required for deep monitoring) is
  /// surfaced by reverting the optimistic value for [deepMonitor].
  Future<GuardianPrefs> set(String conv, {bool? secureChat, bool? deepMonitor}) async {
    final cur = await _readCache(conv);
    final next = cur.copyWith(secureChat: secureChat, deepMonitor: deepMonitor);
    await _writeCache(conv, next); // local-first

    try {
      final body = <String, Object?>{
        'prefs': {
          'conv': conv,
          if (secureChat != null) 'secureChat': secureChat,
          if (deepMonitor != null) 'deepMonitor': deepMonitor,
        },
      };
      final res = await ApiAuth.postJson(_url, body, timeout: const Duration(seconds: 8));
      if (res.statusCode == 200) {
        serverLive = true;
        try {
          final j = jsonDecode(res.body) as Map<String, Object?>;
          final pj = j['prefs'];
          if (pj is Map<String, Object?>) {
            final p = GuardianPrefs(secureChat: pj['secureChat'] == true, deepMonitor: pj['deepMonitor'] == true);
            await _writeCache(conv, p);
            return p;
          }
        } catch (_) {/* keep optimistic value */}
      } else if (res.statusCode == 402 && deepMonitor == true) {
        // Premium required — revert the optimistic deep-monitor flip.
        final reverted = next.copyWith(deepMonitor: false);
        await _writeCache(conv, reverted);
        return reverted;
      }
    } catch (e) {
      if (kDebugMode) debugPrint('GuardianPrefsClient.set sync deferred: $e');
    }
    return next;
  }
}

/// Per-account display preferences for Guardian's private warnings. These only
/// affect client presentation (how prominently a warning surfaces); the private
/// `ava_private` warning bubble always renders regardless. Stored on-device via
/// [DiskCache] (account-scoped).
class GuardianDisplayPrefs {
  GuardianDisplayPrefs._();

  static const _kBanner = 'ava_guardian_show_banner';

  /// Whether to surface a prominent warning banner/card (the [GuardianWarning]
  /// affordance) in addition to the in-chat private bubble. Default ON.
  static final ValueNotifier<bool> showBanner = ValueNotifier<bool>(true);

  static bool _loaded = false;
  static bool get isLoaded => _loaded;

  static Future<void> load() async {
    try {
      final b = await DiskCache.read(_kBanner);
      showBanner.value = b == null || b.isEmpty ? true : b == '1';
    } catch (_) {/* keep default */}
    _loaded = true;
  }

  static Future<void> setShowBanner(bool v) async {
    showBanner.value = v;
    await DiskCache.write(_kBanner, v ? '1' : '0');
  }
}

/// F6 — account-wide "adult-only content warning" opt-out for ADULT accounts.
///
/// When ON (opted out), the user has chosen NOT to see the extra adult-content
/// caution cards. Persisted per-account on-device ([DiskCache], scoped under
/// `cache/<AccountScope.id>/`) AND mirrored to the server
/// (`POST /api/ava/guardian/scan` with `{adult_optout}`), which is the prefs row
/// the safety pipeline reads. The server REFUSES the write for child accounts
/// (403 `minor_cannot_opt_out`); the client additionally hides the toggle for
/// minors, so a child never reaches this at all. Default OFF (warnings shown).
class GuardianAdultPrefs {
  GuardianAdultPrefs._();

  static const _kOptOut = 'ava_guardian_adult_optout';

  /// true = the user has opted OUT of adult-content warnings. Default OFF.
  static final ValueNotifier<bool> optedOut = ValueNotifier<bool>(false);

  static bool _loaded = false;
  static bool get isLoaded => _loaded;

  static String get _url {
    final origin = kApiBase.endsWith('/api')
        ? kApiBase.substring(0, kApiBase.length - '/api'.length)
        : kApiBase;
    return '$origin/api/ava/guardian/scan';
  }

  /// Load the local value first (instant), then reconcile with the server.
  static Future<void> load() async {
    try {
      final v = await DiskCache.read(_kOptOut);
      optedOut.value = v == '1';
    } catch (_) {/* keep default */}
    _loaded = true;
    // Best-effort server reconcile — the server prefs row is the source of truth
    // for cross-device consistency.
    try {
      final res = await ApiAuth.postJson(_url, {'get_adult_optout': true},
          timeout: const Duration(seconds: 8));
      if (res.statusCode == 200) {
        final j = jsonDecode(res.body) as Map<String, Object?>;
        final serverVal = j['adultOptOut'] == true;
        optedOut.value = serverVal;
        await DiskCache.write(_kOptOut, serverVal ? '1' : '0');
      }
    } catch (_) {/* offline — keep local */}
  }

  /// Set the opt-out. Persists locally, then syncs to the server. Returns false
  /// if the server refused (minor) — the caller reverts the UI.
  static Future<bool> setOptedOut(bool v) async {
    optedOut.value = v;
    await DiskCache.write(_kOptOut, v ? '1' : '0');
    try {
      final res = await ApiAuth.postJson(_url, {'adult_optout': v},
          timeout: const Duration(seconds: 8));
      if (res.statusCode == 403) {
        // Minor — server refused. Revert.
        optedOut.value = false;
        await DiskCache.write(_kOptOut, '0');
        return false;
      }
    } catch (e) {
      if (kDebugMode) debugPrint('GuardianAdultPrefs.setOptedOut sync failed: $e');
    }
    return true;
  }
}
