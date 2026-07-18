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
import '../../core/config.dart';
import '../../core/drive_service.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../../identity/identity.dart';
import '../ava_ai/ava_ai_setup.dart';
import '../avabrain/brain_settings_screen.dart';
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

  final _aiStore = AvaAiStore();
  bool _aiConnected = false;
  String? _aiEmail;

  @override
  void initState() {
    super.initState();
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
        backgroundColor: AD.popover,
        shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AD.rDialog),
            side: const BorderSide(color: AD.borderControl, width: 1)),
        title: Text('Disconnect Ava AI?', style: ADText.threadName()),
        content: Text(
            'This removes your Gemini API key and the linked Google account from '
            'this device. AvaTOK goes back to plain messaging. You can connect a '
            'different account anytime.',
            style: ADText.preview()),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx),
              child: Text('Cancel', style: ADText.rowName())),
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
            child: Text('Disconnect', style: ADText.rowName(c: AD.danger)),
          ),
        ],
      ),
    );
  }

  void _backup() {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AD.popover,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AD.rDialog),
          side: const BorderSide(color: AD.borderControl, width: 1),
        ),
        title: Text('Back up my account', style: ADText.threadName()),
        content: Text(
          'We will export your AvaTOK account data (your posts and messages) and '
          'give you a download link. Media files (images, videos, voice) are not '
          'included in backups.',
          style: ADText.preview(),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx),
              child: Text('Not now', style: ADText.preview(c: AD.textSecondary))),
          AdButton(label: 'Back up', variant: AdButtonVariant.teal, fontSize: 15,
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
          backgroundColor: AD.popover,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AD.rDialog),
            side: const BorderSide(color: AD.borderControl, width: 1),
          ),
          title: Text('Backup ready', style: ADText.threadName()),
          content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('${j['size'] ?? 0} bytes exported (media excluded).', style: ADText.preview()),
            const SizedBox(height: 10),
            SelectableText(url, style: ADText.preview(c: AD.iconSearch)),
          ]),
          actions: [
            TextButton(
              onPressed: () {
                Clipboard.setData(ClipboardData(text: url));
                Navigator.pop(ctx);
                ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('Download link copied')));
              },
              child: Text('Copy link', style: ADText.preview(c: AD.iconSearch)),
            ),
            AdButton(label: 'Done', variant: AdButtonVariant.teal, fontSize: 15,
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
        backgroundColor: AD.popover,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AD.rDialog),
          side: const BorderSide(color: AD.borderControl, width: 1),
        ),
        title: Text('Delete account?', style: ADText.threadName()),
        content: Text(
          'This schedules your AvaTOK account for deletion. You have a 30-day grace '
          'period — sign back in any time before it ends to cancel the deletion and '
          'reactivate your account. After 30 days, your profile, settings, and data '
          'are permanently removed.',
          style: ADText.preview(),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx),
              child: Text('Keep my account', style: ADText.preview(c: AD.textSecondary))),
          AdButton(
            label: 'Delete',
            variant: AdButtonVariant.danger,
            fontSize: 15,
            onPressed: () async {
              Navigator.pop(ctx);
              // Schedule the 30-day-grace deletion server-side, then sign out. Do
              // NOT delete the Clerk user here — the account must survive the grace
              // so the user can reactivate by simply signing back in. The cascade
              // consumer removes the Clerk user only after the grace elapses.
              var ok = false;
              try {
                final r = await ApiAuth.postJson(kAccountDeleteUrl, const {}, timeout: const Duration(seconds: 30));
                ok = r.statusCode == 200;
              } catch (_) {/* fall through to error toast */}
              if (!mounted) return;
              if (ok) {
                widget.onSignOut();
              } else {
                ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
                    content: Text('Could not schedule deletion — please try again.')));
              }
            },
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    // RESPUI: SafeArea + resizeToAvoidBottomInset keep this consistent with the
    // rest of the app (this screen has no text fields of its own, but nested
    // sub-pages/dialogs can open the keyboard). Body was already a scrollable
    // ListView; page padding now keys off ZineBreakpoints instead of a fixed
    // 20px so a <360dp phone gets tighter gutters.
    final hPad = ZineBreakpoints.pagePadding(context);
    return Scaffold(
      backgroundColor: AD.bg,
      resizeToAvoidBottomInset: true,
      appBar: _adHeader('Settings'),
      body: SafeArea(
        child: ListView(padding: EdgeInsets.all(hPad), children: [
        // Soft nudge to verify phone for users who skipped it at onboarding.
        // [AVA-IDGATE-1] The PhoneNudgeCard is GONE, not merely hidden. All phone
        // verification was removed 2026-07-10; the widget and its Firebase SMS
        // dependency no longer exist.
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
        _tile(PhosphorIcons.shieldCheck(PhosphorIconsStyle.bold), AD.online, 'Privacy & discoverability',
            'Choose how people can find and add you', () => _push(const PrivacyScreen())),
        // F7 — AvaBrain guardrails: master + per-app (Messaging, Library,
        // Marketplace, Receptionist). All default ON; per-app greyed when master
        // is OFF. Persisted per-account (scoped) + synced to server via BrainConsent.
        // AvaBrain — its own control-room page (Accounts & Settings › Settings ›
        // AvaBrain): master switch + per-source guardrail toggles (now incl. the
        // F7 Messaging / Library / Marketplace / Receptionist sources) + "delete my
        // AvaBrain data". Owner 2026-07-03: re-enabled as a page (replaces the inline
        // card). The page reads/writes the same BrainConsent store.
        _tile(PhosphorIcons.brain(PhosphorIconsStyle.bold), AD.iconVideo, 'AvaBrain',
            'Control what your AI may remember', () => _push(const BrainSettingsScreen())),
        _tile(PhosphorIcons.textAa(PhosphorIconsStyle.bold), AD.iconSearch, 'Display & fonts',
            'Make text across the app bigger or smaller', () => _push(const DisplayFontsScreen())),
        // STREAM F — Auto-Responder ("Ava replies while you're away").
        _tile(PhosphorIcons.robot(PhosphorIconsStyle.bold), AD.online, 'Auto-Responder',
            'Let Ava reply while you\'re away', () => _push(const AutoResponderSettingsPage())),
        // Pluggable sections (Phase 0 contract): feature phases register a
        // SettingsSection from their own file under settings/sections/; each one
        // now renders as a row that opens the section in its own sub-page.
        // Owner request 2026-06-29: hide several of these sections (see
        // _hiddenSettingsSections); Ava Receptionist and any others stay visible.
        for (final s in SettingsSectionRegistry.sections)
          if (!_hiddenSettingsSections.contains(s.id) &&
              (s.visible?.call() ?? true))
            _sectionRow(s),
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
        _tile(PhosphorIcons.trash(PhosphorIconsStyle.bold), AD.danger, 'Danger zone',
            'Permanently delete your account', () => _push(_SettingsDetail(
                  title: 'Danger zone',
                  markWord: 'Danger',
                  children: [
                    _tile(PhosphorIcons.trash(PhosphorIconsStyle.bold), AD.danger, 'Delete account',
                        'Permanently remove your account', _delete, danger: true),
                  ],
                )), danger: true),
        const SizedBox(height: 14),
        AdButton(
          label: 'Log out',
          variant: AdButtonVariant.ghost,
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
        Center(child: Text('AVATOK · YOU OWN IT ALL', style: ADText.sectionLabel(c: AD.textTertiary))),
        ]),
      ),
    );
  }

  Widget _aiCard() {
    return AdCard(
      radius: AD.rListCard,
      padding: const EdgeInsets.all(14),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          ZineIconBadge(
              icon: PhosphorIcons.sparkle(PhosphorIconsStyle.fill),
              color: AD.iconVideo, size: 34),
          const SizedBox(width: 12),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(_aiConnected ? 'Connected to Gemini' : 'Connect Google AI Studio',
                style: ADText.rowName()),
            const SizedBox(height: 2),
            Text(_aiConnected
                    ? 'Ava runs on your own free Gemini key.'
                    : 'Power Ava with your own free Google Gemini key.',
                style: ADText.preview()),
          ])),
          if (_aiConnected)
            AdSticker('ON', kind: AdStickerKind.ok,
                icon: PhosphorIcons.check(PhosphorIconsStyle.bold)),
        ]),
        const SizedBox(height: 14),
        // ONE button: Connect when off, Disconnect when on. Disconnecting clears
        // the key + linked account and the label flips back to Connect.
        AdButton(
          label: _aiConnected ? 'Disconnect' : 'Connect',
          onPressed: _aiConnected ? _removeAi : _setupAi,
          fullWidth: true,
          fontSize: 16,
          variant: _aiConnected ? AdButtonVariant.danger : AdButtonVariant.primary,
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
                size: 15, color: AD.textSecondary),
            const SizedBox(width: 7),
            Expanded(child: Text(
                _aiEmail?.isNotEmpty == true
                    ? 'Connected as ${_aiEmail!}'
                    : 'Connected with your Gemini key',
                maxLines: 1, overflow: TextOverflow.ellipsis,
                style: ADText.preview())),
          ]),
        ],
      ]),
    );
  }

  Widget _section(String t) => Padding(
        padding: const EdgeInsets.only(bottom: 10, left: 4),
        child: Text(t.toUpperCase(), style: ADText.sectionLabel()),
      );

  Widget _tile(IconData icon, Color accent, String title, String sub, VoidCallback onTap, {bool danger = false}) =>
      Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: ZinePressable(
          onTap: onTap,
          color: AD.card,
          pressedColor: AD.cardHover,
          borderColor: AD.borderControl,
          radius: BorderRadius.circular(AD.rListCard),
          boxShadow: const [],
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          child: Row(children: [
            ZineIconBadge(icon: icon, color: accent, size: 34),
            const SizedBox(width: 12),
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: ADText.rowName(c: danger ? AD.danger : AD.textPrimary)),
              const SizedBox(height: 2),
              Text(sub, style: ADText.preview()),
            ])),
            PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold), size: 16, color: AD.textTertiary),
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
        return _SecMeta(PhosphorIcons.faders(PhosphorIconsStyle.bold), AD.iconSearch,
            'Show only AvaTOK + your essentials in the menu');
      case 'ai_ringback':
        return _SecMeta(PhosphorIcons.musicNotes(PhosphorIconsStyle.bold), AD.iconVideo,
            'The sound callers hear while your phone rings');
      case 'ava_voice':
        return _SecMeta(PhosphorIcons.microphone(PhosphorIconsStyle.bold), AD.iconVideo,
            'Voice settings for Ava');
      case 'ava_delegate':
        return _SecMeta(PhosphorIcons.userFocus(PhosphorIconsStyle.bold), AD.iconSearch,
            'Let Ava act on your behalf');
      case 'ava_receptionist':
        return _SecMeta(PhosphorIcons.phoneCall(PhosphorIconsStyle.bold), AD.online,
            'Your AI receptionist for incoming calls');
      case 'default_dialer':
        return _SecMeta(PhosphorIcons.phone(PhosphorIconsStyle.bold), AD.iconSearch,
            'Make AvaTOK your default phone & messages app');
      case 'ava_guardian':
        return _SecMeta(PhosphorIcons.shieldCheck(PhosphorIconsStyle.bold), AD.danger,
            'Safety controls and guardian oversight');
      case 'ava_tools':
        return _SecMeta(PhosphorIcons.wrench(PhosphorIconsStyle.bold), AD.iconSearch,
            'Connect tools and external services');
      case 'backup_sync':
        return _SecMeta(PhosphorIcons.cloudArrowUp(PhosphorIconsStyle.bold), AD.online,
            'Cross-device backup & sync');
      default:
        return _SecMeta(PhosphorIcons.gearSix(PhosphorIconsStyle.bold), AD.iconSearch, 'Open');
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
    // RESPUI: this generic sub-page hosts arbitrary section bodies (some of
    // which contain text fields, e.g. phone verify / auto-responder), so it
    // gets the same SafeArea + resizeToAvoidBottomInset + ZineBreakpoints
    // treatment as the main Settings screen.
    final hPad = ZineBreakpoints.pagePadding(context);
    return Scaffold(
      backgroundColor: AD.bg,
      resizeToAvoidBottomInset: true,
      appBar: _adHeader(title, showBack: true),
      body: SafeArea(
        child: ListView(padding: EdgeInsets.all(hPad), children: children),
      ),
    );
  }
}

/// Dark v2 inline header used across Settings (replaces ZineAppBar). Near-black
/// header bar, hairline bottom border, optional back button + Nunito title.
PreferredSizeWidget _adHeader(String title,
    {bool showBack = true, VoidCallback? onBack, List<Widget> actions = const []}) {
  return PreferredSize(
    preferredSize: const Size.fromHeight(64),
    child: Container(
      decoration: const BoxDecoration(
        color: AD.headerFooter,
        border: Border(bottom: BorderSide(color: AD.borderHairline, width: 1)),
      ),
      child: SafeArea(
        bottom: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(8, 6, 12, 10),
          child: Row(children: [
            if (showBack) AdBackButton(onTap: onBack) else const SizedBox(width: 8),
            const SizedBox(width: 4),
            Expanded(
              child: Text(title,
                  style: ADText.appTitle(),
                  maxLines: 1, overflow: TextOverflow.ellipsis),
            ),
            ...actions,
          ]),
        ),
      ),
    ),
  );
}
