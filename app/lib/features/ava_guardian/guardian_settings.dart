import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/api_auth.dart';
import '../../core/config.dart';
import '../../core/disk_cache.dart';
import '../../core/remote_config.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/zine_widgets.dart';

/// Ava's badge accent on this surface.
///
/// [UI-ZINE-DARK-1] Replaces the pale `Zine.lilac` — a near-WHITE poster fill
/// that read as a bright blob on the near-black sheet. The dark system's lilac
/// family `solid` is dark enough that `ZineIconBadge` resolves its glyph to
/// white. Not `const` — `familyByName` is a lookup.
final Color _avaAccent = AD.familyByName('lilac').solid;

/// Per-chat Ava GUARDIAN controls (Phase 8 — Safety) + warning-display prefs.
///
/// A single opt-in protection a user sets FOR ONE CONVERSATION (typically a chat
/// with a stranger):
///
///   • "Guardian is watching this chat" — FREE. Turns on Guardian monitoring for
///     this chat: the AI security classifier (Claude Opus 4.8) runs on every
///     incoming message and a PRIVATE warning (only you can see it) appears if the
///     sender looks predatory / scammy / unsafe.
///
/// G0: the redundant "always-on deep monitoring" toggle has been removed — with
/// secure-chat ON the deep classifier already runs on every message.
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

  /// U1-lite: the PEER's uid for a 1:1 chat (null for groups). When non-null AND
  /// [RemoteConfig.guardianGateEnabled] is on, the "Require verification" row shows.
  final String? peerUid;

  const GuardianSettingsSheet({super.key, required this.conv, this.chatLabel, this.peerUid});

  /// Show as a modal bottom sheet. Returns when dismissed.
  static Future<void> show(BuildContext context, {required String conv, String? chatLabel, String? peerUid}) {
    return showModalBottomSheet<void>(
      context: context,
      backgroundColor: AD.overlaySheet,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(borderRadius: Msg.brSheetTop),
      builder: (_) => GuardianSettingsSheet(conv: conv, chatLabel: chatLabel, peerUid: peerUid),
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

  bool _verifyRequested = false;
  bool _verifyBusy = false;

  /// U1-lite: whether to surface the (dark) "Require verification" row. 1:1 only
  /// (peerUid present) AND behind the guardianGateEnabled kill switch.
  bool get _showRequireVerify =>
      RemoteConfig.guardianGateEnabled &&
      widget.peerUid != null &&
      widget.peerUid!.isNotEmpty;

  Future<void> _requireVerification() async {
    if (_verifyBusy || widget.peerUid == null) return;
    setState(() => _verifyBusy = true);
    final ok = await GuardianPrefsClient.I.requireVerify(widget.conv, widget.peerUid!);
    if (!mounted) return;
    setState(() {
      _verifyBusy = false;
      if (ok) _verifyRequested = true;
    });
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(ok ? 'Verification requested' : "Couldn't request verification — try again.")));
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(Msg.s5, Msg.s5, Msg.s5, Msg.s5),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            ZineIconBadge(
                icon: PhosphorIcons.shieldCheck(PhosphorIconsStyle.fill),
                color: _avaAccent, size: 38),
            const SizedBox(width: Msg.s3),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Ava guardian',
                    style: ADText.threadName().copyWith(fontSize: 18)),
                if (widget.chatLabel != null && widget.chatLabel!.isNotEmpty)
                  Text(widget.chatLabel!,
                      style: ADText.preview(c: AD.textSecondary)
                          .copyWith(fontSize: 12)),
              ]),
            ),
          ]),
          const SizedBox(height: Msg.s4),
          if (_loading)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: Msg.s6),
              child: Center(child: CircularProgressIndicator(strokeWidth: 2.4)),
            )
          else ...[
            // FREE — the single "Guardian is watching this chat" switch.
            _ToggleRow(
              icon: PhosphorIcons.shieldCheck(PhosphorIconsStyle.fill),
              title: 'Guardian is watching this chat',
              subtitle: 'Let Ava watch this chat for scams, spam, and unsafe behaviour. '
                  'If something looks off, only you get a private heads-up.',
              value: _prefs.secureChat,
              onChanged: _setSecure,
            ),
            const SizedBox(height: Msg.s4),
            Container(
              padding: const EdgeInsets.all(Msg.s3),
              decoration: BoxDecoration(
                color: AD.card,
                borderRadius: Msg.brMd,
                border: Border.all(color: AD.borderHairline, width: 1),
              ),
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                PhosphorIcon(PhosphorIcons.lockKey(PhosphorIconsStyle.regular),
                    size: 16, color: AD.textSecondary),
                const SizedBox(width: Msg.s2),
                Expanded(
                  child: Text(
                    'Guardian warnings are private — only you ever see them, never the '
                    'other person. Ava never reads end-to-end / on-device-only content.',
                    style: ADText.preview(c: AD.textSecondary)
                        .copyWith(fontSize: 12),
                  ),
                ),
              ]),
            ),
            // U1-lite: MANUAL "Require verification" for 1:1 chats (dark behind
            // guardianGateEnabled). Asks the peer to complete a live face check.
            if (_showRequireVerify) ...[
              const SizedBox(height: Msg.s4),
              ZineCard(
                padding: const EdgeInsets.all(Msg.s4),
                child: Row(children: [
                  // Was `Zine.blue` (pale aqua). AD.newGroup is the same token
                  // ZineButtonVariant.blue resolves to, so the badge and the
                  // "Ask" button below it now read as one control.
                  ZineIconBadge(
                      icon: PhosphorIcons.userFocus(PhosphorIconsStyle.fill),
                      color: AD.newGroup, size: 34),
                  const SizedBox(width: Msg.s3),
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text('Require verification', style: ADText.rowName()),
                      const SizedBox(height: 2),
                      Text(
                        _verifyRequested
                            ? 'Verification requested — Ava asked them to prove a live human face.'
                            : "Ask this person to prove they're a real, live human with a quick face check.",
                        style: ADText.preview(c: AD.textSecondary)
                            .copyWith(fontSize: 12),
                      ),
                    ]),
                  ),
                  const SizedBox(width: Msg.s3),
                  if (_verifyBusy)
                    const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2.2))
                  else
                    ZineButton(
                      label: _verifyRequested ? 'Requested' : 'Ask',
                      variant: _verifyRequested ? ZineButtonVariant.ghost : ZineButtonVariant.blue,
                      onPressed: _verifyRequested ? null : _requireVerification,
                    ),
                ]),
              ),
            ],
            if (!GuardianPrefsClient.I.serverLive) ...[
              const SizedBox(height: Msg.s2),
              Text(
                'Saved on this device. Syncs to your account when the connection is back.',
                style: ADText.statCaption(c: AD.textTertiary),
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
      padding: const EdgeInsets.all(Msg.s4),
      child: Row(children: [
        ZineIconBadge(icon: icon, color: _avaAccent, size: 34),
        const SizedBox(width: Msg.s3),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: ADText.rowName()),
            const SizedBox(height: 2),
            Text(subtitle,
                style: ADText.preview(c: AD.textSecondary)
                    .copyWith(fontSize: 12)),
          ]),
        ),
        const SizedBox(width: Msg.s3),
        ZineToggle(value: value, onChanged: onChanged),
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

  /// Update the guardian watch state for [conv]. Optimistic local write, then a
  /// best-effort server sync. [source] tags whether the flip came from an explicit
  /// shield 'tap' or a 'stranger_accept' auto-enable (passed through to telemetry).
  ///
  /// G0: the guardian is FREE on all plans — there is no premium/402 path. The
  /// [deepMonitor] param is retained for wire compat but is IGNORED by the server.
  Future<GuardianPrefs> set(String conv, {bool? secureChat, bool? deepMonitor, String source = 'tap'}) async {
    final cur = await _readCache(conv);
    final next = cur.copyWith(secureChat: secureChat);
    await _writeCache(conv, next); // local-first

    try {
      final body = <String, Object?>{
        'prefs': {
          'conv': conv,
          if (secureChat != null) 'secureChat': secureChat,
          'source': source,
        },
      };
      final res = await ApiAuth.postJson(_url, body, timeout: const Duration(seconds: 8));
      if (res.statusCode == 200) {
        serverLive = true;
        try {
          final j = jsonDecode(res.body) as Map<String, Object?>;
          final pj = j['prefs'];
          if (pj is Map<String, Object?>) {
            final p = GuardianPrefs(secureChat: pj['secureChat'] == true, deepMonitor: false);
            await _writeCache(conv, p);
            return p;
          }
        } catch (_) {/* keep optimistic value */}
      }
    } catch (e) {
      if (kDebugMode) debugPrint('GuardianPrefsClient.set sync deferred: $e');
    }
    return next;
  }

  /// [G2] Push a "This is fine" dismissal to the server so it reaches the caller's
  /// OTHER devices and survives a reinstall. The server marks the flag dismissed in
  /// the caller's own InboxDO (store-and-forward) and tracks the false-positive.
  /// Best-effort, fire-and-forget: the local dismiss is already applied by the
  /// caller, so a network failure here is non-fatal (the next /sync reconciles).
  Future<void> dismissFlag(String msgId, {String conv = ''}) async {
    if (msgId.isEmpty) return;
    try {
      await ApiAuth.postJson(_url, {
        'dismiss_flag': {'msg_id': msgId, 'conv': conv},
      }, timeout: const Duration(seconds: 8));
    } catch (e) {
      if (kDebugMode) debugPrint('GuardianPrefsClient.dismissFlag deferred: $e');
    }
  }

  /// U1-lite: ask [peerUid] to complete a live face check for [conv]. Server-side
  /// this is DARK behind guardianGateEnabled (403 `feature_off` when off) — the
  /// client only calls it when [RemoteConfig.guardianGateEnabled] is already on, so
  /// a 200 means the request was recorded + a private prompt posted to the peer.
  /// Returns true on success. Best-effort; never throws.
  Future<bool> requireVerify(String conv, String peerUid) async {
    if (conv.isEmpty || peerUid.isEmpty) return false;
    try {
      final res = await ApiAuth.postJson(_url, {
        'require_verify': {'conv': conv, 'peer_uid': peerUid},
      }, timeout: const Duration(seconds: 8));
      return res.statusCode == 200;
    } catch (e) {
      if (kDebugMode) debugPrint('GuardianPrefsClient.requireVerify failed: $e');
      return false;
    }
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
