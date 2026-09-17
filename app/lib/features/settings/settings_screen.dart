
import '../../core/localization/ui_text.dart';

import '../../core/localization/ui_language_picker.dart';
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
import '../../core/ui/breakpoints.dart';
import '../../core/ui/rajasthani_motifs.dart';
import '../../core/ui/zine_widgets.dart';
import '../../identity/identity.dart';
import '../ava_ai/ava_ai_setup.dart';
// [LAUNCH-DARK-1] brain_settings_screen import removed with the AvaBrain row
// below; restore it alongside that row.
// [PA-UI-3] 2026-08-09: the "Auto-Responder" settings row is removed (owner
// request) and auto_responder_settings_page.dart is deleted with it — nothing
// else in app/lib referenced that page.
import 'settings_registry.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/motion/motion.dart';
import '../../shell/v2/shell_chrome.dart';
import '../../shell/ava_sidebar.dart' show AvaSidebarForShell; // [SIDEBAR-MENU-ALL-1]
import '../../shell/shell_v2.dart' show ShellScope; // [SIDEBAR-MENU-ALL-1]

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
    'ava_tools',    // Tools & connectors
    'backup_sync',  // Backup & sync
    // [LAUNCH-DARK-1 2026-09-05] avaTOK launches as a marketplace: paid live
    // streaming, paid 1:1 sessions, and a text-only Messenger. Every AI/agent
    // surface goes dark until there is money to support it, and a settings row
    // for a dark feature is worse than no row — it invites the user to
    // configure something that will not run.
    'ava_receptionist',  // Ava PA
    'marketplace_agent', // Marketplace Agent — NOTE: its own flag
                         // (marketplaceAgentSettingsEnabled) only collapses the
                         // page BODY, so the row rendered regardless. This id is
                         // what actually removes it.
    // 'ava_guardian' had been deliberately un-hidden by F6 (it carried the
    // adult-content opt-out and the scam/spam shield assurance). Re-hidden for
    // launch at the owner's request — note this REVERSES that decision, so if
    // the content-warning opt-out is needed for a store review, this is the
    // line to remove.
    'ava_guardian', // Guardian / safety
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
        title: UiText(UiMessage.m_disconnect_ava_ai_4a12230376, style: ADText.threadName()),
        content: UiText(
            UiMessage.m_this_removes_your_gemini_api_ed70656916,
            style: ADText.preview()),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx),
              child: UiText(UiMessage.m_cancel_19766ed6cc, style: ADText.rowName())),
          TextButton(
            onPressed: () async {
              Navigator.pop(ctx);
              await _aiStore.clear();
              await _refreshAi();
              if (mounted) {
                await showAdToast(context, message: uiCopy(UiMessage.m_ava_ai_disconnected_99839c721d));
              }
            },
            child: UiText(UiMessage.m_disconnect_acfc5be785, style: ADText.rowName(c: AD.danger)),
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
        title: UiText(UiMessage.m_back_up_my_account_4f47758434, style: ADText.threadName()),
        content: UiText(
          UiMessage.m_we_will_export_your_avatok_f437952f54,
          style: ADText.preview(),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx),
              child: UiText(UiMessage.m_not_now_a0e63d7c71, style: ADText.preview(c: AD.textSecondary))),
          AdButton(label: uiCopy(UiMessage.m_back_up_0054e707d5), variant: AdButtonVariant.teal, fontSize: 15,
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
    showAdToast(context, message: uiCopy(UiMessage.m_backing_up_to_your_google_4a5b6a9dcb));
    try {
      final res = await ApiAuth.postJson(kBackupUrl, const {}, timeout: const Duration(seconds: 30));
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      final url = j['url']?.toString();
      if (url == null) throw Exception('no url');
      final dl = await ApiAuth.getBytes(url, timeout: const Duration(seconds: 30));
      final name = 'avatok-backup-${DateTime.now().toIso8601String().split('T').first}.json';
      final ok = await DriveService.I.upload('Backups', name, 'application/json', dl.bodyBytes);
      if (!mounted) return;
      showAdToast(context, message: ok
          ? 'Backed up to your AvaTOK Drive (Backups) ✓'
          : 'Export done, but Drive isn\'t connected — connect it in AvaStorage.');
    } catch (_) {
      if (mounted) showAdToast(context, message: uiCopy(UiMessage.m_backup_to_drive_failed_check_cc4707c7ee));
    } finally {
      if (mounted) setState(() => _backingUp = false);
    }
  }

  Future<void> _runBackup() async {
    final id = widget.identity;
    if (id == null || _backingUp) return;
    setState(() => _backingUp = true);
    showAdToast(context, message: uiCopy(UiMessage.m_exporting_your_account_ad6189e83a));
    try {
      // pubkey derived server-side from the NIP-98 signature.
      final res = await ApiAuth.postJson(kBackupUrl, const {},
          timeout: const Duration(seconds: 30));
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      final url = j['url']?.toString();
      if (!mounted) return;
      setState(() => _backingUp = false);
      if (url == null) {
        showAdToast(context, message: uiCopy(UiMessage.m_backup_failed_please_try_again_b12ebca43d));
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
          title: UiText(UiMessage.m_backup_ready_8d810ccb6f, style: ADText.threadName()),
          content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            UiText(UiMessage.m_value1_bytes_exported_media_excluded_a8963cf3e9, params: {'value1': (j['size'] ?? 0).toString()}, style: ADText.preview()),
            const SizedBox(height: Msg.s2),
            SelectableText(url, style: ADText.preview(c: AD.iconSearch)),
          ]),
          actions: [
            TextButton(
              onPressed: () {
                Clipboard.setData(ClipboardData(text: url));
                Navigator.pop(ctx);
                showAdToast(context, message: uiCopy(UiMessage.m_download_link_copied_1d27c71a6b));
              },
              child: UiText(UiMessage.m_copy_link_dbf362d4f2, style: ADText.preview(c: AD.iconSearch)),
            ),
            AdButton(label: uiCopy(UiMessage.m_done_11a6767d56), variant: AdButtonVariant.teal, fontSize: 15,
                onPressed: () => Navigator.pop(ctx)),
          ],
        ),
      );
    } catch (_) {
      if (!mounted) return;
      setState(() => _backingUp = false);
      showAdToast(context, message: uiCopy(UiMessage.m_backup_failed_check_your_connection_08d2bc7186));
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
        title: UiText(UiMessage.m_delete_account_1617c15bde, style: ADText.threadName()),
        content: UiText(
          UiMessage.m_this_schedules_your_avatok_account_a12f111cb7,
          style: ADText.preview(),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx),
              child: UiText(UiMessage.m_keep_my_account_d62ce03448, style: ADText.preview(c: AD.textSecondary))),
          AdButton(
            label: uiCopy(UiMessage.m_delete_e2d0a54968),
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
                showAdToast(context, message: uiCopy(UiMessage.m_could_not_schedule_deletion_please_00b13f3421));
              }
            },
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    UiLocaleScope.watch(context);
    // RESPUI: SafeArea + resizeToAvoidBottomInset keep this consistent with the
    // rest of the app (this screen has no text fields of its own, but nested
    // sub-pages/dialogs can open the keyboard). Body was already a scrollable
    // ListView; page padding now keys off ZineBreakpoints instead of a fixed
    // 20px so a <360dp phone gets tighter gutters.
    final hPad = ZineBreakpoints.pagePadding(context);
    // [SIDEBAR-MENU-ALL-1] Settings rendered the hamburger (showBack: false ->
    // AvaTokHeader falls back to _MenuButton, whose default action is
    // `Scaffold.of(ctx).openDrawer()`) on a Scaffold that had NO `drawer:`.
    // `openDrawer` is null-safe, so the control was a silent no-op. Same
    // null-safe ShellScope resolution as wallet_screen.dart ([WALLET-MENU-1]):
    // the drawer needs the shell, and Settings can also be pushed from
    // standalone contexts, so outside the shell fall back to a back button
    // rather than leaving a dead hamburger.
    final shellScope = context.dependOnInheritedWidgetOfExactType<ShellScope>();
    return Scaffold(
      backgroundColor: AD.bg,
      resizeToAvoidBottomInset: true,
      drawer: shellScope == null ? null : const AvaSidebarForShell(),
      appBar: _adHeader(context, authoredUiCopy('Settings'), showBack: shellScope == null),
      body: SafeArea(
        child: ListView(padding: EdgeInsets.all(hPad), children: [
        const UiLanguageTile(),
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
        // _tile(PhosphorIcons.hash(PhosphorIconsStyle.bold), AD.newGroup, 'Your number',
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
        // [LAUNCH-DARK-1 2026-09-05] The AvaBrain row is HIDDEN for launch. The
        // page and the BrainConsent store both stay — consent values already
        // written keep being honoured by the ingestion paths — but there is no
        // reason to offer memory controls for an AI the product is not shipping
        // yet. Un-comment to restore.
        // _tile(PhosphorIcons.brain(PhosphorIconsStyle.bold), AD.iconVideo, 'AvaBrain',
        //     'Control what your AI may remember', () => _push(const BrainSettingsScreen())),
        _tile(PhosphorIcons.textAa(PhosphorIconsStyle.bold), AD.iconSearch, 'Display & fonts',
            'Make text across the app bigger or smaller', () => _push(const DisplayFontsScreen())),
        // [PA-UI-3] 2026-08-09: the STREAM F "Auto-Responder" row ("Ava replies
        // while you're away") is REMOVED at the owner's request, together with
        // its page (auto_responder_settings_page.dart). The worker route
        // /api/auto-responder is untouched.
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
        _tile(PhosphorIcons.cloudArrowUp(PhosphorIconsStyle.bold), AD.newGroup, 'Backup',
            'Export or back up your account', () => _push(_SettingsDetail(
                  title: 'Backup',
                  markWord: 'Backup',
                  children: [
                    _tile(PhosphorIcons.cloudArrowUp(PhosphorIconsStyle.bold), AD.newGroup, 'Back up account',
                        'Email yourself a download of your account (media excluded)', _backup),
                    _tile(PhosphorIcons.googleDriveLogo(PhosphorIconsStyle.bold), AD.online, 'Back up to Google Drive',
                        'Save your account export to your AvaTOK Drive (Backups)', _backupToDrive),
                  ],
                ))),
        */
        _tile(PhosphorIcons.trash(PhosphorIconsStyle.bold), AD.danger, 'Danger zone',
            'Permanently delete your account', () => _push(_SettingsDetail(
                  title: uiCopy(UiMessage.m_danger_zone_fd8b8dae44),
                  markWord: 'Danger',
                  children: [
                    _tile(PhosphorIcons.trash(PhosphorIconsStyle.bold), AD.danger, 'Delete account',
                        'Permanently remove your account', _delete, danger: true),
                  ],
                )), danger: true),
        const SizedBox(height: Msg.s3),
        AdButton(
          label: uiCopy(UiMessage.m_log_out_4961614551),
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
        const SizedBox(height: Msg.s4),
        Center(child: UiText(UiMessage.m_avatok_you_own_it_all_c87a3805ec, style: ADText.sectionLabel(c: AD.textTertiary))),
        ]),
      ),
    );
  }

  Widget _aiCard() {
    return AdCard(
      radius: AD.rListCard,
      padding: const EdgeInsets.all(Msg.s4),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          ZineIconBadge(
              icon: PhosphorIcons.sparkle(PhosphorIconsStyle.fill),
              color: AD.iconVideo, size: 34),
          const SizedBox(width: 12),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            AdSwitchText(_aiConnected ? uiCopy(UiMessage.m_connected_to_gemini_3bfb1238b1) : uiCopy(UiMessage.m_connect_google_ai_studio_dbd1a6a6f1),
                style: ADText.rowName()),
            const SizedBox(height: 2),
            Text(_aiConnected
                    ? uiCopy(UiMessage.m_ava_runs_on_your_own_ae679d6ee8)
                    : uiCopy(UiMessage.m_power_ava_with_your_own_671b5c1d13),
                style: ADText.preview()),
          ])),
          if (_aiConnected)
            AdSticker('ON', kind: AdStickerKind.ok,
                icon: PhosphorIcons.check(PhosphorIconsStyle.bold)),
        ]),
        const SizedBox(height: Msg.s3),
        // ONE button: Connect when off, Disconnect when on. Disconnecting clears
        // the key + linked account and the label flips back to Connect.
        AdButton(
          label: _aiConnected ? uiCopy(UiMessage.m_disconnect_acfc5be785) : uiCopy(UiMessage.m_connect_1a2303ede0),
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
          const SizedBox(height: Msg.s2),
          Row(children: [
            PhosphorIcon(PhosphorIcons.googleLogo(PhosphorIconsStyle.bold),
                size: 15, color: AD.textSecondary),
            const SizedBox(width: Msg.s2),
            Expanded(child: Text(
                _aiEmail?.isNotEmpty == true
                    ? uiCopy(UiMessage.m_connected_as_value1_8858228d66, {'value1': (_aiEmail!).toString()})
                    : uiCopy(UiMessage.m_connected_with_your_gemini_key_9c26482bb9),
                maxLines: 1, overflow: TextOverflow.ellipsis,
                style: ADText.preview())),
          ]),
        ],
      ]),
    );
  }

  Widget _section(String t) => Padding(
        padding: const EdgeInsets.only(bottom: Msg.s3, left: Msg.s1),
        child: Text(t, style: ADText.sectionLabel()),
      );

  Widget _tile(IconData icon, Color accent, String title, String sub, VoidCallback onTap, {bool danger = false}) =>
      Padding(
        padding: const EdgeInsets.only(bottom: Msg.s3),
        child: ZinePressable(
          onTap: onTap,
          color: AD.card,
          pressedColor: AD.cardHover,
          borderColor: AD.borderControl,
          radius: BorderRadius.circular(AD.rListCard),
          boxShadow: const [],
          padding: const EdgeInsets.symmetric(horizontal: Msg.s4, vertical: Msg.s3),
          child: Row(children: [
            ZineIconBadge(icon: icon, color: accent, size: 34),
            const SizedBox(width: 12),
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(authoredUiCopy(title), style: ADText.rowName(c: danger ? AD.danger : AD.textPrimary)),
              const SizedBox(height: 2),
              Text(authoredUiCopy(sub), style: ADText.preview()),
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
        // [PA-UI-1] the section is now the "Ava PA" hub (title comes from the
        // registry); the one-liner says what she actually does.
        return _SecMeta(PhosphorIcons.phoneCall(PhosphorIconsStyle.bold), AD.online,
            'Ava answers the calls you don’t take');
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
    UiLocaleScope.watch(context);
    // RESPUI: this generic sub-page hosts arbitrary section bodies (some of
    // which contain text fields, e.g. phone verify / auto-responder), so it
    // gets the same SafeArea + resizeToAvoidBottomInset + ZineBreakpoints
    // treatment as the main Settings screen.
    final hPad = ZineBreakpoints.pagePadding(context);
    return Scaffold(
      backgroundColor: AD.bg,
      resizeToAvoidBottomInset: true,
      appBar: _adHeader(context, title, showBack: true),
      body: SafeArea(
        child: ListView(padding: EdgeInsets.all(hPad), children: children),
      ),
    );
  }
}

/// Dark v2 inline header used across Settings (replaces ZineAppBar). Near-black
/// header bar, hairline bottom border, optional back button + Nunito title.
/// [RAJ-SEAMS-1] Takes a [context] so the band height can follow the user's
/// text scale. A `PreferredSize` reports a FIXED height, but the title inside
/// grows with FontScale — at textScale 2.0 on a 320dp screen the row needed
/// 69px against the 64 this reserved, and because the seam turned the child
/// into a Column (a Flex), that showed up as a RenderFlex overflow rather than
/// a silent squeeze. Scaling the reservation is the fix; hardcoding a bigger
/// number would only move the breaking point.
PreferredSizeWidget _adHeader(BuildContext context, String title,
    {bool showBack = true, VoidCallback? onBack, List<Widget> actions = const []}) {
  // Settings is a signed-in menu surface, so it uses the same wallet/avatar/
  // notification header as the main menu roots. Detail pages retain a back
  // affordance; onboarding never calls this helper.
  return AvaTokHeader(
    title: title,
    leading: showBack ? AdBackButton(onTap: onBack, color: AD.onBand(AD.headerFooter)) : null,
    actions: actions,
  );
}
