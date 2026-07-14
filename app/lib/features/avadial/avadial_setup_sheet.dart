import 'dart:async';

import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';

import '../../core/analytics.dart';
import '../../core/remote_config.dart';
import '../../core/voice/native_voice_audio.dart';
import 'avadial_channel.dart';
import 'missed_call_service.dart';
import 'sms_role_help.dart';

/// [AVADIAL-SETUP-1] + [AVADIAL-SETUP-2] AvaDialer guided device-setup sheet.
///
/// AvaDialer can only behave like a real phone app — incoming calls ringing
/// FULL-SCREEN over the lock screen, texts & OTPs handled in-app, spam calls
/// screened — once the user grants a few OS roles/permissions that NO app can
/// grant itself. Android and OEM skins gate these behind Settings screens we
/// can only DEEP-LINK to; we can never flip them programmatically.
///
/// [AVADIAL-SETUP-2] (owner request 2026-07-14): the sheet is now a guided,
/// SEQUENTIAL task list for beta testers. It pitches AvaTOK as the default
/// dialer / SMS manager / spam call & message detector / phone book, explains
/// that during beta some switches must be flipped manually (once live they're
/// auto-set on install from the Play Store), highlights ONE next task at a
/// time, deep-links to the right Android settings screen when manual action is
/// needed, and — because it re-reads live OS state on every app resume — ticks
/// the task off the moment the user returns, then advances the highlight to
/// the next pending task with a confirmation snack.
bool _shownThisSession = false;

/// Show the setup sheet the first time AvaDialer opens in a session with any
/// core capability still missing (phone role, SMS role, spam screening,
/// contacts, or lock-screen calls). Safe no-op when everything is granted or
/// it has already shown this session.
Future<void> maybeShowAvaDialSetup(BuildContext context) async {
  if (_shownThisSession) return;
  try {
    final fsi = await NativeVoiceAudio.instance.canUseFullScreenIntent();
    final dialer = await AvaDialChannel.I.isDialerRoleHeld();
    final screening = await AvaDialChannel.I.isScreeningRoleHeld();
    final sms =
        RemoteConfig.avaSms ? await AvaDialChannel.I.isSmsRoleHeld() : true;
    final contacts = await Permission.contacts.isGranted;
    if (fsi && dialer && screening && sms && contacts) {
      return; // nothing missing — don't nag
    }
  } catch (_) {
    // If the checks fail, fall through and offer setup once.
  }
  _shownThisSession = true;
  if (!context.mounted) return;
  Analytics.capture('avadial_setup_sheet_shown');
  await showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: const Color(0xFF1B1B1D),
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
    ),
    builder: (_) => const _AvaDialSetupSheet(),
  );
}

class _AvaDialSetupSheet extends StatefulWidget {
  const _AvaDialSetupSheet();
  @override
  State<_AvaDialSetupSheet> createState() => _AvaDialSetupSheetState();
}

class _AvaDialSetupSheetState extends State<_AvaDialSetupSheet>
    with WidgetsBindingObserver {
  static const _teal = Color(0xFF11A37F);

  bool _fsi = false; // full-screen / lock-screen calls
  bool _battery = false; // ignore battery optimisation (reliable delivery)
  bool _dialer = false; // default phone app
  bool _screening = false; // Caller ID & spam role (replaces Truecaller)
  bool _sms = false; // default SMS app
  bool _contacts = false; // phone book (READ/WRITE_CONTACTS group)
  bool _overlay = false; // "appear on top" — the floating OTP card
  bool _loading = true;

  // Auto-detected rivals: who currently holds the phone/SMS slots, and which
  // known overlay apps (Truecaller etc.) are installed so we can deep-link to them.
  String? _dialerLabel; // current default phone app (null when it's us)
  String? _smsLabel; // current default SMS app (null when it's us)
  List<Map<String, dynamic>> _rivals = const [];

  // [AVA-SMS-FIX-1] Detect the OS auto-denying ROLE_SMS without showing the
  // picker (Android 15+ restricted-settings gate on sideloaded beta installs).
  DateTime? _smsAskedAt;
  StreamSubscription<AvaRoleResult>? _roleSub;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
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
    // The user leaves to a system settings screen and comes back — re-read
    // reality so the just-granted task ticks off without a manual refresh,
    // and the highlight advances to the next pending task.
    if (state == AppLifecycleState.resumed) _refresh();
  }

  void _onRoleVerdict(AvaRoleResult r) {
    if (!r.role.contains('SMS')) return;
    final askedAt = _smsAskedAt;
    _smsAskedAt = null;
    if (r.granted || askedAt == null || !mounted) return;
    if (isInstantDenial(askedAt)) {
      Analytics.capture('avadial_setup_sms_autodenied', const {});
      showSmsRoleRestrictedHelp(context);
    }
  }

  /// The beta task list, in the order we walk the user through it. Rebuilt on
  /// every refresh; the FIRST row with `done == false` is the "next task" and
  /// gets the highlight.
  List<_SetupStep> get _steps => [
        _SetupStep('dialer', 'Make AvaTOK your phone app', _dialer,
            _dialer
                ? 'AvaTOK handles your calls.'
                : _dialerLabel != null
                    ? 'Now: $_dialerLabel. Switching removes it from calls.'
                    : 'Handle every call through AvaTOK.',
            _openDialer),
        if (RemoteConfig.avaSms)
          _SetupStep('sms', 'Make AvaTOK your SMS manager', _sms,
              _sms
                  ? 'AvaTOK sends & receives your texts.'
                  : _smsLabel != null
                      ? 'Now: $_smsLabel. Texts, OTPs & spam filtering move to AvaTOK.'
                      : 'Texts, OTPs and AI spam filtering, in one place.',
              _openSms),
        _SetupStep('screening', 'Spam call & message detector', _screening,
            _screening
                ? 'AvaTOK screens your calls for spam.'
                : 'Let AvaTOK screen spam calls & messages for you.',
            _openScreening),
        _SetupStep('contacts', 'Make AvaTOK your phone book', _contacts,
            _contacts
                ? 'AvaTOK manages your contacts.'
                : 'Read & manage your contacts inside AvaTOK.',
            _openContacts),
        _SetupStep('fsi', 'Show calls on lock screen', _fsi,
            'Allow full-screen call notifications.', _openFsi),
        _SetupStep('battery', 'Keep AvaTOK running', _battery,
            'Ignore battery optimisation so calls arrive instantly.',
            _openBattery),
        _SetupStep('overlay', 'Show OTP pop-ups over apps', _overlay,
            'Appear on top, so one-time codes float over any app with a '
            'one-tap Copy — no need to open AvaTOK.',
            _openOverlay),
        // [AVA-MISSEDCALL-1] Truecaller-style missed-call pop-up. Uses the SAME
        // "appear on top" permission as the OTP card, so _overlay/_openOverlay are
        // reused; granting either lights this task too.
        if (RemoteConfig.missedCallOverlay)
          _SetupStep('missedcall', 'See who called (missed-call pop-up)', _overlay,
              _overlay
                  ? 'On — you\'ll see who called over any app, with one-tap call '
                      'back, message, and whether they\'re on AvaTOK.'
                  : 'Show a pop-up over any app when you miss a call: who it was, '
                      'call back or reply in a tap, and a bright AvaTOK icon if '
                      'they\'re on AvaTOK.',
              _openOverlay),
      ];

  Future<void> _refresh() async {
    // Snapshot before, so a task that JUST completed can be announced and the
    // highlight advanced ("show the task as done, then prompt the next task").
    // On the FIRST load everything starts false — announcing then would fire a
    // bogus "done ✓" snack for every already-granted step, so skip announcing.
    final firstLoad = _loading;
    final before = {for (final s in _steps) s.id: s.done};

    var fsi = _fsi,
        battery = _battery,
        dialer = _dialer,
        screening = _screening,
        sms = _sms,
        contacts = _contacts,
        overlay = _overlay;
    String? dialerLabel;
    String? smsLabel;
    var rivals = _rivals;
    try {
      fsi = await NativeVoiceAudio.instance.canUseFullScreenIntent();
    } catch (_) {}
    try {
      battery = await Permission.ignoreBatteryOptimizations.isGranted;
    } catch (_) {}
    try {
      dialer = await AvaDialChannel.I.isDialerRoleHeld();
    } catch (_) {}
    try {
      screening = await AvaDialChannel.I.isScreeningRoleHeld();
    } catch (_) {}
    try {
      sms = await AvaDialChannel.I.isSmsRoleHeld();
    } catch (_) {}
    try {
      contacts = await Permission.contacts.isGranted;
    } catch (_) {}
    try {
      overlay = await Permission.systemAlertWindow.isGranted;
    } catch (_) {}
    try {
      dialerLabel = await AvaDialChannel.I.defaultDialerLabel();
    } catch (_) {}
    try {
      smsLabel = await AvaDialChannel.I.defaultSmsLabel();
    } catch (_) {}
    try {
      rivals = await AvaDialChannel.I.detectRivalCallerApps();
    } catch (_) {}
    if (!mounted) return;
    setState(() {
      _fsi = fsi;
      _battery = battery;
      _dialer = dialer;
      _screening = screening;
      _sms = sms;
      _contacts = contacts;
      _overlay = overlay;
      _dialerLabel = dialerLabel;
      _smsLabel = smsLabel;
      _rivals = rivals;
      _loading = false;
    });

    // [AVA-MISSEDCALL-1] Arm/disarm the missed-call receiver in step with the "appear
    // on top" grant (the user may have just returned from granting it). No-op unless the
    // `missedCallOverlay` flag is on.
    if (RemoteConfig.missedCallOverlay) {
      unawaited(MissedCallService.I.ensureEnabled());
    }

    // Announce the freshly completed task and prompt the next one.
    if (firstLoad) return;
    final steps = _steps;
    _SetupStep? justDone;
    for (final s in steps) {
      if (s.done && before[s.id] == false) justDone = s;
    }
    if (justDone != null) {
      Analytics.capture(
          'avadial_setup_step_done', <String, Object>{'step': justDone.id});
      _SetupStep? next;
      for (final s in steps) {
        if (!s.done) {
          next = s;
          break;
        }
      }
      final msg = next == null
          ? '${justDone.title} — done ✓  All set!'
          : '${justDone.title} — done ✓  Next: ${next.title}';
      ScaffoldMessenger.maybeOf(context)
          ?.showSnackBar(SnackBar(content: Text(msg)));
    }
  }

  Future<void> _openFsi() async {
    Analytics.capture('avadial_setup_tap', <String, Object>{'step': 'fsi'});
    try {
      await NativeVoiceAudio.instance.openFullScreenIntentSettings();
    } catch (_) {}
  }

  Future<void> _openBattery() async {
    Analytics.capture('avadial_setup_tap', <String, Object>{'step': 'battery'});
    try {
      await Permission.ignoreBatteryOptimizations.request();
    } catch (_) {}
    _refresh();
  }

  Future<void> _openOverlay() async {
    Analytics.capture('avadial_setup_tap', <String, Object>{'step': 'overlay'});
    try {
      await Permission.systemAlertWindow.request();
    } catch (_) {}
    _refresh();
  }

  Future<void> _openDialer() async {
    Analytics.capture('avadial_setup_tap', <String, Object>{'step': 'dialer'});
    try {
      await AvaDialChannel.I.requestDialerRole();
    } catch (_) {}
    _refresh();
  }

  Future<void> _openScreening() async {
    Analytics.capture(
        'avadial_setup_tap', <String, Object>{'step': 'screening'});
    try {
      await AvaDialChannel.I.requestScreeningRole();
    } catch (_) {}
    _refresh();
  }

  Future<void> _openSms() async {
    Analytics.capture('avadial_setup_tap', <String, Object>{'step': 'sms'});
    _smsAskedAt = DateTime.now(); // [AVA-SMS-FIX-1]
    try {
      final res = await AvaDialChannel.I.requestSmsRole();
      if (res != null) _smsAskedAt = null; // resolved synchronously
      if (res == false && mounted) {
        // The prompt could not even be launched — go manual right away.
        await showSmsRoleRestrictedHelp(context);
      }
    } catch (_) {}
    _refresh();
  }

  Future<void> _openContacts() async {
    Analytics.capture(
        'avadial_setup_tap', <String, Object>{'step': 'contacts'});
    try {
      final st = await Permission.contacts.request();
      if (st.isPermanentlyDenied) {
        // Android stopped asking — the switch now lives in App info →
        // Permissions. Take the user there; resume-refresh ticks it off.
        await AvaDialChannel.I.openOwnAppDetails();
      }
    } catch (_) {}
    _refresh();
  }

  /// Deep-link straight to a detected rival's own "App info" page so the user can
  /// turn off its "appear on top" or disable it in one hop — no hunting.
  Future<void> _openRival(String package) async {
    Analytics.capture('avadial_setup_tap',
        <String, Object>{'step': 'rival', 'package': package});
    try {
      await AvaDialChannel.I.openAppDetails(package);
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    final steps = _steps;
    // The single task we're prompting for right now.
    String? activeId;
    for (final s in steps) {
      if (!s.done) {
        activeId = s.id;
        break;
      }
    }
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 12, 20, 20),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Center(
                child: Container(
                  width: 40,
                  height: 4,
                  decoration: BoxDecoration(
                    color: Colors.white24,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
              const SizedBox(height: 18),
              const Text(
                'Make AvaTOK your phone',
                style: TextStyle(
                    color: Colors.white,
                    fontSize: 20,
                    fontWeight: FontWeight.w700),
              ),
              const SizedBox(height: 6),
              const Text(
                'Would you like AvaTOK to be your default dialer, SMS manager, '
                'spam call & message detector, and phone book? Work through '
                'the tasks below — we highlight one at a time.',
                style:
                    TextStyle(color: Colors.white70, fontSize: 14, height: 1.35),
              ),
              const SizedBox(height: 10),
              // Beta notice (owner request 2026-07-14): manual switches are a
              // beta-period quirk; the Play Store release sets them automatically.
              Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: _teal.withValues(alpha: 0.10),
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: _teal.withValues(alpha: 0.35)),
                ),
                child: const Text(
                  'Beta testing period: Android may ask you to turn on some '
                  'settings manually — we\'ll take you to the right page and '
                  'tick the task off when you\'re back. Once we\'re live, '
                  'these are set automatically.',
                  style:
                      TextStyle(color: Colors.white70, fontSize: 13, height: 1.35),
                ),
              ),
              const SizedBox(height: 14),
              if (_loading)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 28),
                  child: Center(child: CircularProgressIndicator(color: _teal)),
                )
              else ...[
                for (final s in steps)
                  _StepRow(
                    done: s.done,
                    active: s.id == activeId,
                    title: s.title,
                    subtitle: s.subtitle,
                    onTap: s.onTap,
                  ),
                // Auto-detected rival overlay apps. Android won't let us disable
                // them, so each row deep-links STRAIGHT to that app's settings —
                // the user turns off its "appear on top" or disables it there.
                for (final r in _rivals)
                  _StepRow(
                    done: false,
                    active: false,
                    title: 'Stop ${r['label'] ?? 'another app'} overlaying calls',
                    subtitle:
                        'It draws its own call pop-up that no app can block. Open '
                        'it and turn off "appear on top", or disable it.',
                    actionLabel: 'Open',
                    onTap: () => _openRival('${r['package']}'),
                  ),
              ],
              const SizedBox(height: 4),
              Align(
                alignment: Alignment.centerRight,
                child: TextButton(
                  onPressed: () => Navigator.of(context).maybePop(),
                  child: const Text(
                    'Done',
                    style: TextStyle(
                        color: _teal, fontSize: 16, fontWeight: FontWeight.w600),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// One task in the guided checklist.
class _SetupStep {
  final String id;
  final String title;
  final bool done;
  final String subtitle;
  final Future<void> Function() onTap;
  const _SetupStep(this.id, this.title, this.done, this.subtitle, this.onTap);
}

class _StepRow extends StatelessWidget {
  final bool done;
  final bool active; // the ONE task currently being prompted
  final String title;
  final String subtitle;
  final String? actionLabel;
  final VoidCallback onTap;
  const _StepRow({
    required this.done,
    required this.active,
    required this.title,
    required this.subtitle,
    required this.onTap,
    this.actionLabel,
  });

  @override
  Widget build(BuildContext context) {
    const teal = Color(0xFF11A37F);
    final row = Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(
          done ? Icons.check_circle : Icons.radio_button_unchecked,
          color: done
              ? teal
              : active
                  ? teal.withValues(alpha: 0.7)
                  : Colors.white38,
          size: 22,
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(children: [
                Flexible(
                  child: Text(
                    title,
                    style: const TextStyle(
                        color: Colors.white,
                        fontSize: 15,
                        fontWeight: FontWeight.w600),
                  ),
                ),
                if (active) ...[
                  const SizedBox(width: 8),
                  Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                    decoration: BoxDecoration(
                      color: teal.withValues(alpha: 0.18),
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: const Text(
                      'NEXT',
                      style: TextStyle(
                          color: teal,
                          fontSize: 10,
                          fontWeight: FontWeight.w700,
                          letterSpacing: 0.5),
                    ),
                  ),
                ],
              ]),
              const SizedBox(height: 2),
              Text(
                subtitle,
                style: const TextStyle(
                    color: Colors.white60, fontSize: 13, height: 1.3),
              ),
            ],
          ),
        ),
        const SizedBox(width: 10),
        if (!done)
          TextButton(
            onPressed: onTap,
            style: TextButton.styleFrom(
              foregroundColor: teal,
              padding: const EdgeInsets.symmetric(horizontal: 10),
            ),
            child: Text(actionLabel ?? 'Enable'),
          )
        else
          const Padding(
            padding: EdgeInsets.only(right: 10),
            child: Text(
              'On',
              style: TextStyle(
                  color: teal, fontSize: 13, fontWeight: FontWeight.w600),
            ),
          ),
      ],
    );
    // The active task gets a soft highlight card so the eye lands on ONE thing.
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 4),
      padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 8),
      decoration: active
          ? BoxDecoration(
              color: teal.withValues(alpha: 0.07),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: teal.withValues(alpha: 0.35)),
            )
          : null,
      child: row,
    );
  }
}
