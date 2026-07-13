import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/admin_tools.dart';
import '../../../core/analytics.dart';
import '../../../core/api_auth.dart';
import '../../../core/config.dart';
import '../../../core/disk_cache.dart';
import '../../../core/profile_store.dart';
import '../../../core/remote_config.dart';
import '../../../core/ui/avatok_dark.dart';
import '../../../core/ui/zine_widgets.dart';
import '../../ava_guardian/guardian_settings.dart';
import '../settings_registry.dart';

/// Weekly parent digest UI — hidden 2026-07-04 (owner decision): the toggle
/// promised weekly delivery but no scheduled job exists yet. Flip to true once
/// runParentDigests() is wired to a cron + delivery channel.
const bool kParentDigestUiEnabled = false;

/// Settings → "Guardian / safety" section (Phase 8 — Safety).
///
/// Holds the ACCOUNT-WIDE guardian controls (the per-chat secure-chat toggle lives
/// in [GuardianSettingsSheet], opened from a chat's Ava menu):
///
///   • Scam-shield                 — FREE, always-on. Ava flags likely scams/spam
///     and warns you privately. A read-only assurance row (it cannot be turned off
///     — basic safety is bundled), plus the warning-display preference.
///   • Weekly parent digest        — PARENT ACCOUNTS ONLY. Opt in to a weekly
///     safety digest covering your linked children. Shown only when the account
///     kind is `parent`.
///
/// Registered via [SettingsSectionRegistry] from [AvaBootstrap.init]
/// (`registerGuardianSection()`) — the one sanctioned bootstrap append.
void registerGuardianSection() {
  // KV-driven hide (pro/live launch): register the section only while
  // RemoteConfig.guardianEnabled is true. Bootstrap runs before the config
  // fetch lands, so the default (kGuardianEnabledDefault=true) registers it
  // immediately; when prod KV returns `guardianEnabled:false` the revision
  // notifier fires and we unregister it. Re-runs on every config poll.
  void sync() {
    if (RemoteConfig.guardianEnabled) {
      SettingsSectionRegistry.register(
        SettingsSection(
          id: 'ava_guardian',
          title: 'Guardian / safety',
          order: 28, // just below "Ava delegate" (27), above "Tools & connectors" (30)
          builder: (context) => const _GuardianCard(),
        ),
      );
    } else {
      SettingsSectionRegistry.unregister('ava_guardian');
    }
  }

  sync();
  RemoteConfig.revision.addListener(sync);
}

/// Account-wide guardian DEFAULTS + parent-digest opt-in. Per-account on-device
/// via [DiskCache] (scoped under `cache/<AccountScope.id>/`); the parent-digest
/// opt-in also pings the server route so the weekly job knows to deliver.
class GuardianDefaults {
  GuardianDefaults._();

  static const _kParentDigest = 'ava_guardian_parent_digest';

  /// Parent-account opt-in to the weekly safety digest. Default ON for parents
  /// (the whole point of a custodial account), but only shown/used for parents.
  static final ValueNotifier<bool> parentDigest = ValueNotifier<bool>(true);

  static bool _loaded = false;
  static bool get isLoaded => _loaded;

  static Future<void> load() async {
    try {
      final pd = await DiskCache.read(_kParentDigest);
      parentDigest.value = pd == null || pd.isEmpty ? true : pd == '1';
    } catch (_) {/* keep defaults */}
    _loaded = true;
  }

  static Future<void> setParentDigest(bool v) async {
    parentDigest.value = v;
    await DiskCache.write(_kParentDigest, v ? '1' : '0');
  }
}

class _GuardianCard extends StatefulWidget {
  const _GuardianCard();
  @override
  State<_GuardianCard> createState() => _GuardianCardState();
}

class _GuardianCardState extends State<_GuardianCard> {
  AccountKind _kind = AccountKind.personal;
  // F6: whether this account is a minor (< 18 by birth year). Child accounts do
  // NOT see the adult-content opt-out toggle at all (the server also refuses the
  // write). Defaults to `true` until the profile loads so a minor never briefly
  // sees the toggle before we know their age.
  bool _isMinor = true;

  @override
  void initState() {
    super.initState();
    GuardianDefaults.load();
    GuardianDisplayPrefs.load();
    GuardianAdultPrefs.load();
    _loadKind();
    _loadMinor();
  }

  Future<void> _loadKind() async {
    final k = await AccountKindStore().load();
    if (mounted) setState(() => _kind = k);
  }

  Future<void> _loadMinor() async {
    final p = await ProfileStore().load();
    if (mounted) setState(() => _isMinor = p.isMinor);
  }

  Future<void> _setAdultOptOut(bool v) async {
    final ok = await GuardianAdultPrefs.setOptedOut(v);
    Analytics.capture('brain_toggle_set', {'scope': 'guardian_adult_optout', 'on': v});
    if (!ok && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('This setting isn\'t available on this account.')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final isParent = _kind == AccountKind.parent;
    return AdCard(
      padding: const EdgeInsets.all(14),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          ZineIconBadge(icon: PhosphorIcons.shieldCheck(PhosphorIconsStyle.fill), color: AD.iconVideo, size: 36),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              'Ava watches for scams, spam, and unsafe behaviour and warns you '
              'privately — only you ever see a warning, never the other person. '
              'Turn on secure-chat mode per chat from the chat’s Ava menu.',
              style: ADText.preview(),
            ),
          ),
        ]),
        const SizedBox(height: 14),
        // FREE — scam-shield assurance (always on). Read-only row.
        Row(children: [
          PhosphorIcon(PhosphorIcons.checkCircle(PhosphorIconsStyle.fill), size: 18, color: AD.online),
          const SizedBox(width: 8),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Scam & spam shield', style: ADText.rowName()),
              Text('Always on and free. Ava flags likely scams and spam.', style: ADText.preview()),
            ]),
          ),
        ]),
        const SizedBox(height: 12),
        // Warning-display preference (free).
        ValueListenableBuilder<bool>(
          valueListenable: GuardianDisplayPrefs.showBanner,
          builder: (context, on, _) => Row(children: [
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Show prominent warning cards', style: ADText.rowName()),
                Text('In addition to the private in-chat note.', style: ADText.preview()),
              ]),
            ),
            const SizedBox(width: 10),
            _AdToggle(value: on, onChanged: (v) => GuardianDisplayPrefs.setShowBanner(v)),
          ]),
        ),
        // F6 — adult-content warning opt-out (ADULT accounts only). Hidden for
        // minors; the server also refuses the write for child accounts.
        if (!_isMinor) ...[
          const SizedBox(height: 12),
          ValueListenableBuilder<bool>(
            valueListenable: GuardianAdultPrefs.optedOut,
            builder: (context, optedOut, _) => Row(children: [
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('Show adult-only content warnings', style: ADText.rowName()),
                  Text('Turn off to view adult content without the extra caution card.',
                      style: ADText.preview()),
                ]),
              ),
              const SizedBox(width: 10),
              // The toggle shows "warnings ON" = NOT opted out, so invert.
              _AdToggle(value: !optedOut, onChanged: (show) => _setAdultOptOut(!show)),
            ]),
          ),
        ],
        // G0: the account-wide "always-on deep monitoring" default (premium/
        // PaidFeature) has been removed — guardian is free and secure-chat already
        // runs the deep classifier per message.
        // PARENT ACCOUNTS — weekly safety digest opt-in.
        // DISABLED 2026-07-04 (owner decision): no scheduled delivery job exists
        // yet, so the toggle over-promises. Backend (runParentDigests + scan
        // {digest:true}) stays; flip kParentDigestUiEnabled when delivery ships.
        if (kParentDigestUiEnabled && isParent) ...[
          const SizedBox(height: 12),
          const Divider(height: 1, thickness: 1, color: AD.borderHairline),
          const SizedBox(height: 12),
          ValueListenableBuilder<bool>(
            valueListenable: GuardianDefaults.parentDigest,
            builder: (context, on, _) => Row(children: [
              ZineIconBadge(icon: PhosphorIcons.envelopeSimple(PhosphorIconsStyle.fill), color: AD.iconVideo, size: 30),
              const SizedBox(width: 10),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('Weekly safety digest', style: ADText.rowName()),
                  Text('A weekly summary of safety flags for your children.', style: ADText.preview()),
                ]),
              ),
              const SizedBox(width: 10),
              _AdToggle(value: on, onChanged: (v) => GuardianParentDigest.setOptIn(v)),
            ]),
          ),
        ],
      ]),
    );
  }
}

/// Dark v2 inline toggle — track [AD.card] off / [AD.online] on, white thumb.
class _AdToggle extends StatelessWidget {
  final bool value;
  final ValueChanged<bool>? onChanged;
  const _AdToggle({required this.value, this.onChanged});
  @override
  Widget build(BuildContext context) {
    final reduce = MediaQuery.of(context).disableAnimations;
    return GestureDetector(
      onTap: onChanged == null ? null : () => onChanged!(!value),
      child: AnimatedContainer(
        duration: reduce ? Duration.zero : const Duration(milliseconds: 120),
        width: 52, height: 30,
        padding: const EdgeInsets.all(3),
        decoration: BoxDecoration(
          color: value ? AD.online : AD.card,
          borderRadius: BorderRadius.circular(100),
          border: Border.all(color: AD.borderControl, width: 1),
        ),
        child: AnimatedAlign(
          duration: reduce ? Duration.zero : const Duration(milliseconds: 120),
          alignment: value ? Alignment.centerRight : Alignment.centerLeft,
          child: Container(
            width: 22, height: 22,
            decoration: const BoxDecoration(shape: BoxShape.circle, color: Colors.white),
          ),
        ),
      ),
    );
  }
}

/// The parent-digest opt-in + on-demand fetch. The opt-in is a local pref (the
/// weekly delivery is a server hook); [fetchNow] pulls the caller's current
/// digest via `POST /api/ava/guardian/scan` with a `{digest:true}` body for an
/// in-app view (e.g. a "see this week's digest" action on a parent dashboard).
class GuardianParentDigest {
  GuardianParentDigest._();

  static String get _url {
    final origin = kApiBase.endsWith('/api')
        ? kApiBase.substring(0, kApiBase.length - '/api'.length)
        : kApiBase;
    return '$origin/api/ava/guardian/scan';
  }

  static Future<void> setOptIn(bool v) => GuardianDefaults.setParentDigest(v);

  /// Fetch the caller's parent digest now (parent accounts only — the server
  /// scopes to the caller's linked children). Returns the decoded `digest` map,
  /// or null on any failure.
  static Future<Map<String, Object?>?> fetchNow({int windowDays = 7}) async {
    try {
      final res = await ApiAuth.postJson(_url, {'digest': true, 'windowDays': windowDays},
          timeout: const Duration(seconds: 12));
      if (res.statusCode == 200) {
        final j = jsonDecode(res.body) as Map<String, Object?>;
        final d = j['digest'];
        if (d is Map<String, Object?>) return d;
      }
    } catch (e) {
      if (kDebugMode) debugPrint('GuardianParentDigest.fetchNow failed: $e');
    }
    return null;
  }
}
