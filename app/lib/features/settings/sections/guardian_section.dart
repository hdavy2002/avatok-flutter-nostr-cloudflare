import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/admin_tools.dart';
import '../../../core/api_auth.dart';
import '../../../core/config.dart';
import '../../../core/disk_cache.dart';
import '../../../core/paid_feature.dart';
import '../../../core/ui/zine.dart';
import '../../../core/ui/zine_widgets.dart';
import '../../ava_guardian/guardian_settings.dart';
import '../settings_registry.dart';

/// Settings → "Guardian / safety" section (Phase 8 — Safety).
///
/// Holds the ACCOUNT-WIDE guardian controls (the per-chat secure-chat toggle lives
/// in [GuardianSettingsSheet], opened from a chat's Ava menu):
///
///   • Scam-shield                 — FREE, always-on. Ava flags likely scams/spam
///     and warns you privately. A read-only assurance row (it cannot be turned off
///     — basic safety is bundled), plus the warning-display preference.
///   • Always-on deep monitoring   — PREMIUM. The account-wide DEFAULT for new
///     stranger chats; the enable is wrapped in [PaidFeature].
///   • Weekly parent digest        — PARENT ACCOUNTS ONLY. Opt in to a weekly
///     safety digest covering your linked children. Shown only when the account
///     kind is `parent`.
///
/// Registered via [SettingsSectionRegistry] from [AvaBootstrap.init]
/// (`registerGuardianSection()`) — the one sanctioned bootstrap append.
void registerGuardianSection() {
  SettingsSectionRegistry.register(
    SettingsSection(
      id: 'ava_guardian',
      title: 'Guardian / safety',
      order: 28, // just below "Ava delegate" (27), above "Tools & connectors" (30)
      builder: (context) => const _GuardianCard(),
    ),
  );
}

/// Account-wide guardian DEFAULTS + parent-digest opt-in. Per-account on-device
/// via [DiskCache] (scoped under `cache/<AccountScope.id>/`); the parent-digest
/// opt-in also pings the server route so the weekly job knows to deliver.
class GuardianDefaults {
  GuardianDefaults._();

  static const _kDeepDefault = 'ava_guardian_default_deep';
  static const _kParentDigest = 'ava_guardian_parent_digest';

  /// Default for "always-on deep monitoring" in new stranger chats. Default OFF
  /// (premium + conservative).
  static final ValueNotifier<bool> deepDefault = ValueNotifier<bool>(false);

  /// Parent-account opt-in to the weekly safety digest. Default ON for parents
  /// (the whole point of a custodial account), but only shown/used for parents.
  static final ValueNotifier<bool> parentDigest = ValueNotifier<bool>(true);

  static bool _loaded = false;
  static bool get isLoaded => _loaded;

  static Future<void> load() async {
    try {
      final d = await DiskCache.read(_kDeepDefault);
      final pd = await DiskCache.read(_kParentDigest);
      deepDefault.value = d == '1';
      parentDigest.value = pd == null || pd.isEmpty ? true : pd == '1';
    } catch (_) {/* keep defaults */}
    _loaded = true;
  }

  static Future<void> setDeepDefault(bool v) async {
    deepDefault.value = v;
    await DiskCache.write(_kDeepDefault, v ? '1' : '0');
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

  @override
  void initState() {
    super.initState();
    GuardianDefaults.load();
    GuardianDisplayPrefs.load();
    _loadKind();
  }

  Future<void> _loadKind() async {
    final k = await AccountKindStore().load();
    if (mounted) setState(() => _kind = k);
  }

  @override
  Widget build(BuildContext context) {
    final isParent = _kind == AccountKind.parent;
    return ZineCard(
      radius: Zine.rSm,
      padding: const EdgeInsets.all(14),
      boxShadow: Zine.shadowXs,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          ZineIconBadge(icon: PhosphorIcons.shieldCheck(PhosphorIconsStyle.fill), color: Zine.lilac, size: 36),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              'Ava watches for scams, spam, and unsafe behaviour and warns you '
              'privately — only you ever see a warning, never the other person. '
              'Turn on secure-chat mode per chat from the chat’s Ava menu.',
              style: ZineText.sub(size: 12.5),
            ),
          ),
        ]),
        const SizedBox(height: 14),
        // FREE — scam-shield assurance (always on). Read-only row.
        Row(children: [
          PhosphorIcon(PhosphorIcons.checkCircle(PhosphorIconsStyle.fill), size: 18, color: Zine.mintInk),
          const SizedBox(width: 8),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Scam & spam shield', style: ZineText.value(size: 13.5)),
              Text('Always on and free. Ava flags likely scams and spam.', style: ZineText.sub(size: 11.5)),
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
                Text('Show prominent warning cards', style: ZineText.value(size: 13.5)),
                Text('In addition to the private in-chat note.', style: ZineText.sub(size: 11.5)),
              ]),
            ),
            const SizedBox(width: 10),
            ZineToggle(value: on, onChanged: (v) => GuardianDisplayPrefs.setShowBanner(v)),
          ]),
        ),
        const SizedBox(height: 12),
        const Divider(height: 1, thickness: 1, color: Zine.inkMute),
        const SizedBox(height: 12),
        // PREMIUM — always-on deep monitoring default. Enable is paid-gated.
        ValueListenableBuilder<bool>(
          valueListenable: GuardianDefaults.deepDefault,
          builder: (context, on, _) => Row(children: [
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  Flexible(child: Text('Always-on deep monitoring', style: ZineText.value(size: 13.5))),
                  const SizedBox(width: 8),
                  const PaidBadge(),
                ]),
                Text('Default new stranger chats to the deeper safety check.', style: ZineText.sub(size: 11.5)),
              ]),
            ),
            const SizedBox(width: 10),
            if (on)
              ZineToggle(value: true, onChanged: (_) => GuardianDefaults.setDeepDefault(false))
            else
              PaidFeature(
                actionLabel: 'Enable deep monitoring by default',
                onRun: () async => GuardianDefaults.setDeepDefault(true),
                child: const IgnorePointer(child: ZineToggle(value: false, onChanged: null)),
              ),
          ]),
        ),
        // PARENT ACCOUNTS — weekly safety digest opt-in.
        if (isParent) ...[
          const SizedBox(height: 12),
          const Divider(height: 1, thickness: 1, color: Zine.inkMute),
          const SizedBox(height: 12),
          ValueListenableBuilder<bool>(
            valueListenable: GuardianDefaults.parentDigest,
            builder: (context, on, _) => Row(children: [
              ZineIconBadge(icon: PhosphorIcons.envelopeSimple(PhosphorIconsStyle.fill), color: Zine.lilac, size: 30),
              const SizedBox(width: 10),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('Weekly safety digest', style: ZineText.value(size: 13.5)),
                  Text('A weekly summary of safety flags for your children.', style: ZineText.sub(size: 11.5)),
                ]),
              ),
              const SizedBox(width: 10),
              ZineToggle(value: on, onChanged: (v) => GuardianParentDigest.setOptIn(v)),
            ]),
          ),
        ],
      ]),
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
