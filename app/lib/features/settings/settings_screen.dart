import 'dart:convert';

import 'package:flutter/material.dart';
import 'display_fonts_screen.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../auth/clerk_client.dart';
import '../avatok/number_settings_screen.dart';
import '../avatok/privacy_screen.dart';
import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/ava_ai_store.dart';
import '../../core/avaapps_cache.dart';
import '../../core/brain_consent.dart';
import '../../core/config.dart';
import '../../core/drive_service.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../../identity/identity.dart';
import '../ava_ai/ava_ai_setup.dart';
import '../avabrain/brain_settings_screen.dart';
import '../profile/phone_verify_card.dart';
import 'auto_responder_settings_page.dart';
import 'settings_registry.dart';

/// Account settings — Backup, Manage keys, Delete account.
class SettingsScreen extends StatefulWidget {
  final ClerkClient clerk;
  final VoidCallback onSignOut;
  final Identity? identity;
  const SettingsScreen({super.key, required this.clerk, required this.onSignOut, this.identity});
  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {

  // Owner request 2026-06-29: hide these registry sections from Settings. The
  // sections stay REGISTERED (features keep working); they are only filtered out
  // of the Settings list. Re-show by removing an id. Ava Receptionist is kept.
  static const Set<String> _hiddenSettingsSections = {
    'focus_mode',   // Focus mode
    'ava_local',    // Ava AI
    'ava_voice',    // Ava voice
    'ai_ringback',  // Ringback tone
    'ava_delegate', // Ava delegate
    // 'ava_guardian' un-hidden (F6): the Guardian section carries the adult-only
    // content-warning opt-out (adults) + the free scam/spam shield assurance.
    'ava_tools',    // Tools & connectors
    'backup_sync',  // Backup & sync
  };

  bool _backingUp = false;

  Map<String, bool> _brain = {};

  final _aiStore = AvaAiStore();
  bool _aiConnected = false;
  String? _aiEmail;

  @override
  void initState() {
    super.initState();
    BrainConsent.pull().then((_) => BrainConsent.all()).then((m) { if (mounted) setState(() => _brain = m); });
    _refreshAi();
  }

  Future<void> _refreshAi() async {
    final connected = await _aiStore.isConnected();
    final email = await _aiStore.googleEmail();
    if (mounted) setState(() { _aiConnected = connected; _aiEmail = email; });
  }

  Future<void> _setupAi() async {
    final saved = await Navigator.of(context).push<bool>(
        MaterialPageRoute(builder: (_) => const AvaAiSetupScreen()));
    if (saved == true) await _refreshAi();
  }

  void _removeAi() {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: Zine.card,
        shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(Zine.rSm),
            side: const BorderSide(color: Zine.ink, width: Zine.bw)),
        title: Text('Disconnect Ava AI?', style: ZineText.cardTitle()),
        content: Text(
            'This removes your Gemini API key and the linked Google account from '
            'this device. AvaTOK goes back to plain messaging. You can connect a '
            'different account anytime.',
            style: ZineText.sub(size: 13.5)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx),
              child: Text('Cancel', style: ZineText.value(size: 14))),
          TextButton(
            onPressed: () async {
              Navigator.pop(ctx);
              await _aiStore.clear();
              await _refreshAi();
              if (mounted) {
                ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('Ava AI disconnected')));
              }
            },
            child: Text('Disconnect', style: ZineText.value(size: 14, color: Zine.coral)),
          ),
        ],
      ),
    );
  }

  Future<void> _setBrain(String key, bool v) async {
    setState(() => _brain[key] = v);
    await BrainConsent.set(key, v);
    // F7 telemetry: which guardrail scope was flipped and to what.
    Analytics.capture('brain_toggle_set', {'scope': key, 'on': v});
  }

  /// F7 — the AvaBrain guardrail card: master switch + the four per-app toggles
  /// (Messaging, Library, Marketplace, Receptionist). ALL default ON. When the
  /// master is OFF the per-app toggles are disabled/greyed. Each toggle persists
  /// per-account (scoped) AND syncs to the server prefs the pipeline reads, via
  /// [BrainConsent].
  Widget _brainCard() {
    bool on(String k) => _brain[k] ?? true; // absent = default ON
    final masterOn = on('master');
    Widget row(String key, String title, String sub, {bool master = false}) {
      final enabled = master || masterOn;
      final value = on(key);
      return Padding(
        padding: EdgeInsets.only(bottom: master ? 12 : 10, left: master ? 0 : 8),
        child: Opacity(
          opacity: enabled ? 1 : 0.45,
          child: Row(children: [
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(title, style: ZineText.value(size: master ? 15 : 13.5)),
                const SizedBox(height: 2),
                Text(sub, style: ZineText.sub(size: master ? 12 : 11.5)),
              ]),
            ),
            const SizedBox(width: 10),
            ZineToggle(
              value: master ? value : (value && masterOn),
              onChanged: enabled ? (v) => _setBrain(key, v) : null,
            ),
          ]),
        ),
      );
    }

    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: ZineCard(
        radius: Zine.rSm,
        padding: const EdgeInsets.all(14),
        boxShadow: Zine.shadowXs,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            ZineIconBadge(icon: PhosphorIcons.brain(PhosphorIconsStyle.fill), color: Zine.lilac, size: 34),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                'AvaBrain learns from your activity to help you across apps. '
                'Turn it off entirely, or pick which apps it may learn from. '
                'Private, end-to-end content is only ever read on your device.',
                style: ZineText.sub(size: 12.5),
              ),
            ),
          ]),
          const SizedBox(height: 14),
          row('master', 'AvaBrain', 'Master switch for everything below', master: true),
          const Divider(height: 1, thickness: 1, color: Zine.inkMute),
          const SizedBox(height: 12),
          row('messaging', 'Messaging', 'Learn from your chats'),
          row('library', 'Library', 'Read your files (captions, text)'),
          row('marketplace', 'Marketplace', 'Remember your listings, buys and sells'),
          row('receptionist', 'Receptionist', 'Use call notes and voicemails to answer for you'),
        ]),
      ),
    );
  }

  void _backup() {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: Zine.card,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(Zine.r),
          side: const BorderSide(color: Zine.ink, width: Zine.bw),
        ),
        title: Text('Back up my account', style: ZineText.cardTitle()),
        content: Text(
          'We will export your AvaTOK account data (your posts and messages) and '
          'give you a download link. Media files (images, videos, voice) are not '
          'included in backups.',
          style: ZineText.sub(size: 14),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx),
              child: Text('Not now', style: ZineText.link(size: 14, color: Zine.inkSoft))),
          ZineButton(label: 'Back up', variant: ZineButtonVariant.blue, fontSize: 15,
              onPressed: () { Navigator.pop(ctx); _runBackup(); }),
        ],
      ),
    );
  }

  // Run the account export, then save it into the user's AvaTOK Drive folder
  // (Backups bucket). The export is small (media excluded), so this is cheap.
  Future<void> _backupToDrive() async {
    if (widget.identity == null || _backingUp) return;
    setState(() => _backingUp = true);
    ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Backing up to your Google Drive…')));
    try {
      final res = await ApiAuth.postJson(kBackupUrl, const {}, timeout: const Duration(seconds: 30));
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      final url = j['url']?.toString();
      if (url == null) throw Exception('no url');
      final dl = await ApiAuth.getBytes(url, timeout: const Duration(seconds: 30));
      final name = 'avatok-backup-${DateTime.now().toIso8601String().split('T').first}.json';
      final ok = await DriveService.I.upload('Backups', name, 'application/json', dl.bodyBytes);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(ok
          ? 'Backed up to your AvaTOK Drive (Backups) ✓'
          : 'Export done, but Drive isn\'t connected — connect it in AvaStorage.')));
    } catch (_) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Backup to Drive failed — check your connection.')));
    } finally {
      if (mounted) setState(() => _backingUp = false);
    }
  }

  Future<void> _runBackup() async {
    final id = widget.identity;
    if (id == null || _backingUp) return;
    setState(() => _backingUp = true);
    ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Exporting your account…')));
    try {
      // pubkey derived server-side from the NIP-98 signature.
      final res = await ApiAuth.postJson(kBackupUrl, const {},
          timeout: const Duration(seconds: 30));
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      final url = j['url']?.toString();
      if (!mounted) return;
      setState(() => _backingUp = false);
      if (url == null) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Backup failed — please try again')));
        return;
      }
      showDialog(
        context: context,
        builder: (ctx) => AlertDialog(
          backgroundColor: Zine.card,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(Zine.r),
            side: const BorderSide(color: Zine.ink, width: Zine.bw),
          ),
          title: Text('Backup ready', style: ZineText.cardTitle()),
          content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('${j['size'] ?? 0} bytes exported (media excluded).', style: ZineText.sub(size: 14)),
            const SizedBox(height: 10),
            SelectableText(url, style: ZineText.link(size: 12)),
          ]),
          actions: [
            TextButton(
              onPressed: () {
                Clipboard.setData(ClipboardData(text: url));
                Navigator.pop(ctx);
                ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('Download link copied')));
              },
              child: Text('Copy link', style: ZineText.link(size: 14)),
            ),
            ZineButton(label: 'Done', variant: ZineButtonVariant.blue, fontSize: 15,
                onPressed: () => Navigator.pop(ctx)),
          ],
        ),
      );
    } catch (_) {
      if (!mounted) return;
      setState(() => _backingUp = false);
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Backup failed — check your connection')));
    }
  }

  void _delete() {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: Zine.card,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(Zine.r),
          side: const BorderSide(color: Zine.ink, width: Zine.bw),
        ),
        title: Text('Delete account?', style: ZineText.cardTitle()),
        content: Text(
          'This permanently deletes your AvaTOK account. Your profile, settings, '
          'and data on our network are removed. This cannot be undone.',
          style: ZineText.sub(size: 14),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx),
              child: Text('Keep my account', style: ZineText.link(size: 14, color: Zine.inkSoft))),
          ZineButton(
            label: 'Delete',
            variant: ZineButtonVariant.coral,
            fontSize: 15,
            onPressed: () async {
              Navigator.pop(ctx);
              // Purge server-side data FIRST (needs the Clerk session that we
              // still have here), then delete the Clerk account, then sign out.
              try { await ApiAuth.postJson(kAccountDeleteUrl, const {}, timeout: const Duration(seconds: 30)); } catch (_) {}
              try { await widget.clerk.deleteAccount(); } catch (_) {}
              widget.onSignOut();
            },
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: const ZineAppBar(title: 'Settings', markWord: 'Settings'),
      body: ListView(padding: const EdgeInsets.all(20), children: [
        // Soft nudge to verify phone for users who skipped it at onboarding.
        // Self-hides when already verified or recently dismissed (account-scoped,
        // re-surfaces after 7 days), so it leaves no gap when not shown.
        // Owner request 2026-06-29: hide the phone-verify nudge card (we'll
        // re-enable phone verification later). The widget stays imported/available.
        // const PhoneNudgeCard(source: 'settings'),
        // Account type (preview) section hidden (owner decision 2026-06-17).
        // Google AI Studio BYOK removed (owner decision 2026-06-18): premium is
        // top-up only, everything runs on Cloudflare. The _aiCard() is no longer
        // shown (kept in source for now; does nothing server-side).
        // WhatsApp-style settings: each section is a single tappable row with a
        // short description that opens its own sub-page (with a back button).
        // AvaBrain routes to its full control room; Backup / Danger zone and every
        // pluggable registry section open as detail pages too (owner 2026-06-19).
        const SizedBox(height: 4),
        // Owner request 2026-06-29: hide 'Your number' and 'AvaBrain' tiles (the
        // screens stay registered; only these Settings rows are suppressed).
        // _tile(PhosphorIcons.hash(PhosphorIconsStyle.bold), Zine.blue, 'Your number',
        //     'Get a number that represents you, keep your real one private', () => _push(const NumberSettingsScreen())),
        _tile(PhosphorIcons.shieldCheck(PhosphorIconsStyle.bold), Zine.mint, 'Privacy & discoverability',
            'Choose how people can find and add you', () => _push(const PrivacyScreen())),
        // F7 — AvaBrain guardrails: master + per-app (Messaging, Library,
        // Marketplace, Receptionist). All default ON; per-app greyed when master
        // is OFF. Persisted per-account (scoped) + synced to server via BrainConsent.
        // AvaBrain — its own control-room page (Accounts & Settings › Settings ›
        // AvaBrain): master switch + per-source guardrail toggles (now incl. the
        // F7 Messaging / Library / Marketplace / Receptionist sources) + "delete my
        // AvaBrain data". Owner 2026-07-03: re-enabled as a page (replaces the inline
        // card). The page reads/writes the same BrainConsent store.
        _tile(PhosphorIcons.brain(PhosphorIconsStyle.bold), Zine.lilac, 'AvaBrain',
            'Control what your AI may remember', () => _push(const BrainSettingsScreen())),
        _tile(PhosphorIcons.textAa(PhosphorIconsStyle.bold), Zine.blue, 'Display & fonts',
            'Make text across the app bigger or smaller', () => _push(const DisplayFontsScreen())),
        // STREAM F — Auto-Responder ("Ava replies while you're away").
        _tile(PhosphorIcons.robot(PhosphorIconsStyle.bold), Zine.mint, 'Auto-Responder',
            'Let Ava reply while you\'re away', () => _push(const AutoResponderSettingsPage())),
        // Pluggable sections (Phase 0 contract): feature phases register a
        // SettingsSection from their own file under settings/sections/; each one
        // now renders as a row that opens the section in its own sub-page.
        // Owner request 2026-06-29: hide several of these sections (see
        // _hiddenSettingsSections); Ava Receptionist and any others stay visible.
        for (final s in SettingsSectionRegistry.sections)
          if (!_hiddenSettingsSections.contains(s.id)) _sectionRow(s),
        // Owner request 2026-06-29: 'Backup' tile hidden from Settings. Backup &
        // restore now live in the Storage area (AvaStorage → "Back up & restore",
        // a Google-Drive-backed encrypted backup + restore). The _backup /
        // _backupToDrive / _runBackup methods stay for reference. Re-show by
        // un-commenting the _tile below.
        /*
        _tile(PhosphorIcons.cloudArrowUp(PhosphorIconsStyle.bold), Zine.blue, 'Backup',
            'Export or back up your account', () => _push(_SettingsDetail(
                  title: 'Backup',
                  markWord: 'Backup',
                  children: [
                    _tile(PhosphorIcons.cloudArrowUp(PhosphorIconsStyle.bold), Zine.blue, 'Back up account',
                        'Email yourself a download of your account (media excluded)', _backup),
                    _tile(PhosphorIcons.googleDriveLogo(PhosphorIconsStyle.bold), Zine.mint, 'Back up to Google Drive',
                        'Save your account export to your AvaTOK Drive (Backups)', _backupToDrive),
                  ],
                ))),
        */
        _tile(PhosphorIcons.trash(PhosphorIconsStyle.bold), Zine.coral, 'Danger zone',
            'Permanently delete your account', () => _push(_SettingsDetail(
                  title: 'Danger zone',
                  markWord: 'Danger',
                  children: [
                    _tile(PhosphorIcons.trash(PhosphorIconsStyle.bold), Zine.coral, 'Delete account',
                        'Permanently remove your account', _delete, danger: true),
                  ],
                )), danger: true),
        const SizedBox(height: 14),
        ZineButton(
          label: 'Log out',
          variant: ZineButtonVariant.ghost,
          fullWidth: true,
          fontSize: 17,
          icon: PhosphorIcons.signOut(PhosphorIconsStyle.bold),
          trailingIcon: false,
          onPressed: () async {
            // Phase 2: wipe this account's AvaApps device snapshots before the
            // session ends so cached email/calendar data doesn't linger.
            await AvaAppsCache.clearCurrentAccount();
            await widget.clerk.signOut();
            widget.onSignOut();
          },
        ),
        const SizedBox(height: 18),
        Center(child: Text('AVATOK · YOU OWN IT ALL', style: ZineText.kicker(size: 10, color: Zine.inkMute))),
      ]),
    );
  }

  Widget _aiCard() {
    return ZineCard(
      radius: Zine.rSm,
      padding: const EdgeInsets.all(14),
      boxShadow: Zine.shadowXs,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          ZineIconBadge(
              icon: PhosphorIcons.sparkle(PhosphorIconsStyle.fill),
              color: Zine.lilac, size: 34),
          const SizedBox(width: 12),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(_aiConnected ? 'Connected to Gemini' : 'Connect Google AI Studio',
                style: ZineText.value(size: 15)),
            const SizedBox(height: 2),
            Text(_aiConnected
                    ? 'Ava runs on your own free Gemini key.'
                    : 'Power Ava with your own free Google Gemini key.',
                style: ZineText.sub(size: 12)),
          ])),
          if (_aiConnected)
            ZineSticker('ON', kind: ZineStickerKind.ok,
                icon: PhosphorIcons.check(PhosphorIconsStyle.bold)),
        ]),
        const SizedBox(height: 14),
        // ONE button: Connect when off, Disconnect when on. Disconnecting clears
        // the key + linked account and the label flips back to Connect.
        ZineButton(
          label: _aiConnected ? 'Disconnect' : 'Connect',
          onPressed: _aiConnected ? _removeAi : _setupAi,
          fullWidth: true,
          fontSize: 16,
          variant: _aiConnected ? ZineButtonVariant.coral : ZineButtonVariant.lime,
          icon: _aiConnected
              ? PhosphorIcons.plugs(PhosphorIconsStyle.bold)
              : PhosphorIcons.plug(PhosphorIconsStyle.bold),
          trailingIcon: false,
        ),
        // Below the button: the Google account this key is connected with.
        if (_aiConnected) ...[
          const SizedBox(height: 10),
          Row(children: [
            PhosphorIcon(PhosphorIcons.googleLogo(PhosphorIconsStyle.bold),
                size: 15, color: Zine.inkSoft),
            const SizedBox(width: 7),
            Expanded(child: Text(
                _aiEmail?.isNotEmpty == true
                    ? 'Connected as ${_aiEmail!}'
                    : 'Connected with your Gemini key',
                maxLines: 1, overflow: TextOverflow.ellipsis,
                style: ZineText.sub(size: 12.5))),
          ]),
        ],
      ]),
    );
  }

  Widget _section(String t) => Padding(
        padding: const EdgeInsets.only(bottom: 10, left: 4),
        child: Text(t.toUpperCase(), style: ZineText.kicker()),
      );

  Widget _tile(IconData icon, Color accent, String title, String sub, VoidCallback onTap, {bool danger = false}) =>
      Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: ZinePressable(
          onTap: onTap,
          radius: BorderRadius.circular(Zine.rSm),
          boxShadow: Zine.shadowXs,
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          child: Row(children: [
            ZineIconBadge(icon: icon, color: accent, size: 34),
            const SizedBox(width: 12),
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: ZineText.value(size: 15, color: danger ? Zine.coral : Zine.ink)),
              const SizedBox(height: 2),
              Text(sub, style: ZineText.sub(size: 12)),
            ])),
            PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold), size: 16, color: Zine.inkMute),
          ]),
        ),
      );

  void _push(Widget page) =>
      Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => page));

  /// A registry section rendered as a row that opens the section's body in its
  /// own sub-page (back button via the sub-page app bar).
  Widget _sectionRow(SettingsSection s) {
    final m = _secMeta(s.id);
    return _tile(m.icon, m.color, s.title, m.subtitle, () => _push(_SettingsDetail(
          title: s.title,
          markWord: s.title.split(' ').first,
          children: [s.builder(context)],
        )));
  }

  /// Icon + accent + one-liner for each known registry section. Unknown ids fall
  /// back to a neutral gear so a newly-registered section still renders cleanly.
  _SecMeta _secMeta(String id) {
    switch (id) {
      case 'focus_mode':
        return _SecMeta(PhosphorIcons.faders(PhosphorIconsStyle.bold), Zine.blue,
            'Show only AvaTOK + your essentials in the menu');
      case 'ai_ringback':
        return _SecMeta(PhosphorIcons.musicNotes(PhosphorIconsStyle.bold), Zine.lilac,
            'The sound callers hear while your phone rings');
      case 'ava_voice':
        return _SecMeta(PhosphorIcons.microphone(PhosphorIconsStyle.bold), Zine.lilac,
            'Voice settings for Ava');
      case 'ava_delegate':
        return _SecMeta(PhosphorIcons.userFocus(PhosphorIconsStyle.bold), Zine.blue,
            'Let Ava act on your behalf');
      case 'ava_receptionist':
        return _SecMeta(PhosphorIcons.phoneCall(PhosphorIconsStyle.bold), Zine.mint,
            'Your AI receptionist for incoming calls');
      case 'ava_guardian':
        return _SecMeta(PhosphorIcons.shieldCheck(PhosphorIconsStyle.bold), Zine.coral,
            'Safety controls and guardian oversight');
      case 'ava_tools':
        return _SecMeta(PhosphorIcons.wrench(PhosphorIconsStyle.bold), Zine.blue,
            'Connect tools and external services');
      case 'backup_sync':
        return _SecMeta(PhosphorIcons.cloudArrowUp(PhosphorIconsStyle.bold), Zine.mint,
            'Cross-device backup & sync');
      default:
        return _SecMeta(PhosphorIcons.gearSix(PhosphorIconsStyle.bold), Zine.blue, 'Open');
    }
  }

}

/// Row metadata (icon, accent colour, one-line description) for a settings row.
class _SecMeta {
  final IconData icon;
  final Color color;
  final String subtitle;
  const _SecMeta(this.icon, this.color, this.subtitle);
}

/// A generic Settings sub-page: app bar with a back button + the section body.
/// Used so each settings section opens as its own WhatsApp-style detail screen.
class _SettingsDetail extends StatelessWidget {
  final String title;
  final String markWord;
  final List<Widget> children;
  const _SettingsDetail({required this.title, required this.markWord, required this.children});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: ZineAppBar(title: title, markWord: markWord, showBack: true),
      body: ListView(padding: const EdgeInsets.all(20), children: children),
    );
  }
}
