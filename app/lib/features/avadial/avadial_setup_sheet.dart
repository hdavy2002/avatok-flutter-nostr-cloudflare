import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';

import '../../core/analytics.dart';
import '../../core/voice/native_voice_audio.dart';
import 'avadial_channel.dart';

/// [AVADIAL-SETUP-1] AvaDialer device-setup sheet.
///
/// AvaDialer can only behave like a real phone app — incoming calls ringing
/// FULL-SCREEN over the lock screen, answerable without opening the app, with no
/// rival caller-ID overlay — once the user grants a few OS permissions that NO app
/// can grant itself. Android and OEM skins gate these behind Settings screens we
/// can only DEEP-LINK to; we can never flip them programmatically.
///
/// This sheet gathers them in one place with one-tap links and re-reads the live
/// OS state every time it (re)opens, so a step flips to "On" the moment the user
/// returns from the relevant settings screen. Truecaller note: a rival "Caller ID
/// & spam" app keeps drawing its own overlay on SIM calls until the user turns its
/// role + "appear on top" off — we can only guide them to the settings screen.
bool _shownThisSession = false;

/// Show the setup sheet the first time AvaDialer opens in a session with anything
/// essential (lock-screen calls or the phone role) still missing. Safe no-op when
/// everything is already granted, or if it has already shown this session.
Future<void> maybeShowAvaDialSetup(BuildContext context) async {
  if (_shownThisSession) return;
  try {
    final fsi = await NativeVoiceAudio.instance.canUseFullScreenIntent();
    final dialer = await AvaDialChannel.I.isDialerRoleHeld();
    if (fsi && dialer) return; // nothing essential missing — don't nag
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
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _refresh();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // The user leaves to a system settings screen and comes back — re-read reality
    // so the just-granted step flips to "On" without a manual refresh.
    if (state == AppLifecycleState.resumed) _refresh();
  }

  Future<void> _refresh() async {
    var fsi = _fsi, battery = _battery, dialer = _dialer, screening = _screening;
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
    if (!mounted) return;
    setState(() {
      _fsi = fsi;
      _battery = battery;
      _dialer = dialer;
      _screening = screening;
      _loading = false;
    });
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

  Future<void> _openDialer() async {
    Analytics.capture('avadial_setup_tap', <String, Object>{'step': 'dialer'});
    try {
      await AvaDialChannel.I.requestDialerRole();
    } catch (_) {}
    _refresh();
  }

  Future<void> _openScreening() async {
    Analytics.capture('avadial_setup_tap', <String, Object>{'step': 'screening'});
    try {
      await AvaDialChannel.I.requestScreeningRole();
    } catch (_) {}
    _refresh();
  }

  Future<void> _openDefaultApps() async {
    Analytics.capture('avadial_setup_tap', <String, Object>{'step': 'truecaller'});
    try {
      await AvaDialChannel.I.openDefaultAppsSettings();
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 12, 20, 20),
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
              'Set up AvaDialer calls',
              style: TextStyle(
                  color: Colors.white,
                  fontSize: 20,
                  fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 6),
            const Text(
              'Turn these on so calls ring full-screen on your lock screen — and '
              'you can answer without opening the app, just like any phone app.',
              style: TextStyle(color: Colors.white70, fontSize: 14, height: 1.35),
            ),
            const SizedBox(height: 18),
            if (_loading)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 28),
                child: Center(child: CircularProgressIndicator(color: _teal)),
              )
            else ...[
              _StepRow(
                done: _fsi,
                title: 'Show calls on lock screen',
                subtitle: 'Allow full-screen call notifications.',
                onTap: _openFsi,
              ),
              _StepRow(
                done: _battery,
                title: 'Keep AvaDialer running',
                subtitle: 'Ignore battery optimisation so calls arrive instantly.',
                onTap: _openBattery,
              ),
              _StepRow(
                done: _dialer,
                title: 'Make AvaDialer your phone app',
                subtitle: 'Handle your calls through AvaDialer.',
                onTap: _openDialer,
              ),
              _StepRow(
                done: _screening,
                title: 'Set AvaDialer as Caller ID & spam',
                subtitle: 'Takes the caller-ID slot from Truecaller.',
                onTap: _openScreening,
              ),
              _StepRow(
                done: false,
                title: 'Turn off Truecaller',
                subtitle: 'In system settings, remove Truecaller as Caller ID and '
                    'turn off its "appear on top" — or disable the app — so it '
                    'stops overlaying your calls.',
                actionLabel: 'Open settings',
                onTap: _openDefaultApps,
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
    );
  }
}

class _StepRow extends StatelessWidget {
  final bool done;
  final String title;
  final String subtitle;
  final String? actionLabel;
  final VoidCallback onTap;
  const _StepRow({
    required this.done,
    required this.title,
    required this.subtitle,
    required this.onTap,
    this.actionLabel,
  });

  @override
  Widget build(BuildContext context) {
    const teal = Color(0xFF11A37F);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 9),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            done ? Icons.check_circle : Icons.radio_button_unchecked,
            color: done ? teal : Colors.white38,
            size: 22,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                      color: Colors.white,
                      fontSize: 15,
                      fontWeight: FontWeight.w600),
                ),
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
      ),
    );
  }
}
