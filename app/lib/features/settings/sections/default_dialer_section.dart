import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/analytics.dart';
import '../../../core/remote_config.dart';
import '../../../core/ui/avatok_dark.dart';
import '../../../core/ui/zine_widgets.dart';
import '../../avadial/avadial_channel.dart';
import '../../avadial/avadial_setup_sheet.dart';
import '../../avadial/sms_role_help.dart';
import '../settings_registry.dart';

/// Settings → "Default phone & messages" section (AVA-DIAL-6, owner decision
/// 2026-07-12). Gives users who declined the onboarding "make AvaTOK your phone"
/// step a later path to become the OS default phone / SMS app — and, just as
/// importantly, a place to see the LIVE truth and hand a role back if Truecaller
/// or the stock dialer took it. We can only launch the OS RoleManager picker /
/// the default-apps settings screen; a role can never be forced or released
/// programmatically.
///
/// Visible only on Android when both the `shellV2` and `avaDialer` flags are on.
/// The "Default messages app" toggle additionally requires `avaSms`.
///
/// Registered via [SettingsSectionRegistry] from [AvaBootstrap.init]
/// (`registerDefaultDialerSection()`) — never by editing settings_screen.dart.
void registerDefaultDialerSection() {
  SettingsSectionRegistry.register(
    SettingsSection(
      id: 'default_dialer',
      title: 'Default phone & messages',
      order: 26, // just below Ava Receptionist (24) / Ava voice (25)
      visible: () =>
          Platform.isAndroid && RemoteConfig.shellV2 && RemoteConfig.avaDialer,
      builder: (context) => const _DefaultDialerCard(),
    ),
  );
}

class _DefaultDialerCard extends StatefulWidget {
  const _DefaultDialerCard();
  @override
  State<_DefaultDialerCard> createState() => _DefaultDialerCardState();
}

class _DefaultDialerCardState extends State<_DefaultDialerCard>
    with WidgetsBindingObserver {
  // Live reality — never optimistic. Re-read on mount, on every app resume, and
  // after a role verdict, because the user can change these in OS Settings at any
  // time and another app (Truecaller / stock) can take the role back.
  bool _dialerHeld = false;
  bool _smsHeld = false;
  bool _loading = true;
  StreamSubscription<AvaRoleResult>? _roleSub;
  // [AVA-SMS-FIX-1] When the SMS toggle's role request was launched — used to
  // detect the OS auto-denying without showing the picker.
  DateTime? _smsAskedAt;

  bool get _smsVisible => RemoteConfig.avaSms;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    // The OS role picker returns its verdict on this stream (a prompt was shown).
    _roleSub = AvaDialChannel.I.roleResults.listen(_onRoleVerdict);
    _refresh();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _roleSub?.cancel();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // The user may flip the default in OS Settings (or another app grabs it)
    // while we're backgrounded — re-sync the toggles the moment we come back.
    if (state == AppLifecycleState.resumed) _refresh();
  }

  Future<void> _refresh() async {
    final dialer = await AvaDialChannel.I.isDialerRoleHeld();
    final sms = _smsVisible ? await AvaDialChannel.I.isSmsRoleHeld() : false;
    if (!mounted) return;
    setState(() {
      _dialerHeld = dialer;
      _smsHeld = sms;
      _loading = false;
    });
  }

  /// A verdict arrived after the OS RoleManager picker (dialer or SMS). Update the
  /// matching toggle to reality, log analytics, and — on a denial — nudge the user
  /// toward the OS default-apps screen (the only place the choice can be made).
  void _onRoleVerdict(AvaRoleResult r) {
    final role = r.role.toUpperCase();
    if (role.contains('DIALER')) {
      if (mounted) setState(() => _dialerHeld = r.granted);
      Analytics.capture('settings_default_dialer_toggle', {'granted': r.granted});
      if (!r.granted) _deniedSnack('phone');
    } else if (role.endsWith('SMS')) {
      if (mounted) setState(() => _smsHeld = r.granted);
      Analytics.capture('settings_default_sms_toggle', {'granted': r.granted});
      // [AVA-SMS-FIX-1] Instant denial = the OS never showed the picker
      // (Android 15+ restricted-settings gate on sideloaded installs, or
      // don't-ask-again). Explain the unlock instead of a generic snack.
      final askedAt = _smsAskedAt;
      _smsAskedAt = null;
      if (!r.granted) {
        if (mounted && isInstantDenial(askedAt)) {
          Analytics.capture('settings_default_sms_autodenied', const {});
          showSmsRoleRestrictedHelp(context);
        } else {
          _deniedSnack('messages');
        }
      }
    }
    // Re-read to catch any state the picker changed without a verdict for us.
    _refresh();
  }

  void _deniedSnack(String what) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text('AvaTOK wasn’t set as your default $what app.'),
      action: SnackBarAction(
        label: 'Open settings',
        onPressed: () => AvaDialChannel.I.openDefaultAppsSettings(),
      ),
    ));
  }

  // ── Dialer toggle ─────────────────────────────────────────────────────────
  Future<void> _onDialerChanged(bool want) async {
    if (want) {
      // Launch the OS RoleManager picker. `true` = already held (no prompt);
      // `null` = a prompt was shown, verdict arrives on [roleResults].
      final res = await AvaDialChannel.I.requestDialerRole();
      if (res == true) {
        if (mounted) setState(() => _dialerHeld = true);
        Analytics.capture('settings_default_dialer_toggle', {'granted': true});
      }
      // res == null → wait for _onRoleVerdict. Toggle stays bound to reality.
    } else {
      // A role can't be released programmatically — explain + deep-link the user
      // to the OS default-apps screen where they can hand it to another app.
      _explainCannotRelease('phone');
    }
  }

  // ── SMS toggle ────────────────────────────────────────────────────────────
  Future<void> _onSmsChanged(bool want) async {
    if (want) {
      _smsAskedAt = DateTime.now(); // [AVA-SMS-FIX-1] instant-denial detection
      final res = await AvaDialChannel.I.requestSmsRole();
      if (res != null) _smsAskedAt = null; // resolved synchronously
      if (res == true) {
        if (mounted) setState(() => _smsHeld = true);
        Analytics.capture('settings_default_sms_toggle', {'granted': true});
      }
    } else {
      _explainCannotRelease('messages');
    }
  }

  void _explainCannotRelease(String what) {
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AD.popover,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AD.rDialog),
          side: const BorderSide(color: AD.borderControl, width: 1),
        ),
        title: Text('Change your default $what app', style: ADText.threadName()),
        content: Text(
          'Android doesn’t let an app remove itself as the default $what app. '
          'To hand it back to another app, open the system “Default apps” '
          'screen and pick the one you want.',
          style: ADText.preview(),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: Text('Not now', style: ADText.rowName()),
          ),
          AdButton(
            label: 'Open system settings',
            variant: AdButtonVariant.teal,
            fontSize: 14,
            onPressed: () {
              Navigator.pop(ctx);
              AvaDialChannel.I.openDefaultAppsSettings();
            },
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return AdCard(
      padding: const EdgeInsets.all(14),
      child: _loading
          ? const Padding(
              padding: EdgeInsets.symmetric(vertical: 18),
              child: Center(
                child: SizedBox(
                    width: 22,
                    height: 22,
                    child: CircularProgressIndicator(strokeWidth: 2)),
              ),
            )
          : Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                ZineIconBadge(
                    icon: PhosphorIcons.phone(PhosphorIconsStyle.fill),
                    color: AD.iconSearch,
                    size: 36),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('Make AvaTOK your phone', style: ADText.rowName()),
                        const SizedBox(height: 2),
                        Text(
                          'Set AvaTOK as your default phone — and messages — '
                          'app so calls and texts run through it, with the free '
                          'scam/spam shield. You choose in the system picker.',
                          style: ADText.preview(),
                        ),
                      ]),
                ),
              ]),
              const SizedBox(height: 16),
              _toggleRow(
                title: 'Default phone app',
                held: _dialerHeld,
                onChanged: _onDialerChanged,
              ),
              if (_smsVisible) ...[
                const Divider(height: 22, thickness: 1, color: AD.borderHairline),
                _toggleRow(
                  title: 'Default messages app',
                  held: _smsHeld,
                  onChanged: _onSmsChanged,
                ),
              ],
              // [AVADIAL-SETUP-3] The guided setup checklist moved HERE from the
              // AvaDial auto-pop sheet (owner request 2026-07-14, pic 1). Walks
              // through every role/permission — dialer, SMS, screening, contacts,
              // lock-screen calls, battery, overlays — one highlighted task at a time.
              const Divider(height: 22, thickness: 1, color: AD.borderHairline),
              GestureDetector(
                onTap: () {
                  Analytics.capture('settings_dialer_checklist_opened');
                  showAvaDialSetupSheet(context);
                },
                behavior: HitTestBehavior.opaque,
                child: Row(children: [
                  Expanded(
                    child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('Phone setup checklist', style: ADText.rowName()),
                          const SizedBox(height: 3),
                          Text(
                            'Roles & permissions for calls, SMS, spam screening, '
                            'lock-screen ringing and pop-ups — step by step.',
                            style: ADText.preview(),
                          ),
                        ]),
                  ),
                  const SizedBox(width: 10),
                  const Icon(Icons.chevron_right, color: AD.textSecondary),
                ]),
              ),
            ]),
    );
  }

  Widget _toggleRow({
    required String title,
    required bool held,
    required ValueChanged<bool> onChanged,
  }) {
    return Row(children: [
      Expanded(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(title, style: ADText.rowName()),
          const SizedBox(height: 3),
          Text(
            held ? 'Currently: AvaTOK' : 'Currently: another app',
            style: ADText.preview(c: held ? AD.iconSearch : AD.textSecondary),
          ),
        ]),
      ),
      const SizedBox(width: 10),
      _AdToggle(value: held, onChanged: onChanged),
    ]);
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
