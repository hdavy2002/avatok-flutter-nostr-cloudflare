import 'dart:async';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import 'avadial_channel.dart';
import 'device_contacts.dart';

/// The active-call UI shared by incoming (after answer) and outgoing (after connect)
/// PSTN calls (plan §4.3). Phone-style, Zine design language, consistent with
/// [PstnCallScreen]:
///   - a running call timer once the call is ACTIVE;
///   - mute + speaker toggles (state mirrored from the native audio-route events);
///   - a DTMF keypad overlay (Call.playDtmfTone via the channel);
///   - a prominent End button.
///
/// All actions route through [AvaDialChannel]. DARK behind `avaDialer` (the caller
/// only pushes this when the dialer role is held). Pops itself when the OS removes
/// the call.
class InCallScreen extends StatefulWidget {
  /// Native call id (from [AvaCallEvent.id]) targeting the live [Call].
  final String callId;
  final String number;

  /// Initial call state ('active'|'dialing'|…) — usually 'active' when navigated
  /// here from the answer/connect transition.
  final String initialState;

  const InCallScreen({
    super.key,
    required this.callId,
    required this.number,
    this.initialState = 'active',
  });

  @override
  State<InCallScreen> createState() => _InCallScreenState();
}

class _InCallScreenState extends State<InCallScreen> {
  DeviceContact? _contact;
  late String _state;
  bool _muted = false;
  bool _speaker = false;
  bool _keypad = false;
  Duration _elapsed = Duration.zero;
  Timer? _timer;

  StreamSubscription<AvaCallEvent>? _stateSub;
  StreamSubscription<String>? _removedSub;
  StreamSubscription<AvaAudioRoute>? _audioSub;

  @override
  void initState() {
    super.initState();
    _state = widget.initialState;
    _contact = DeviceContacts.I.lookup(widget.number);
    if (_state == 'active') _startTimer();
    Analytics.capture('avadial_in_call_shown', const {});

    _stateSub = AvaDialChannel.I.calls.listen((e) {
      if (e.id != widget.callId) return;
      _onState(e.state);
    });
    _removedSub = AvaDialChannel.I.removedCalls.listen((id) {
      if (id == widget.callId) _close();
    });
    _audioSub = AvaDialChannel.I.audioRoute.listen((r) {
      if (!mounted) return;
      setState(() {
        _speaker = r.isSpeaker;
        _muted = r.muted;
      });
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    _stateSub?.cancel();
    _removedSub?.cancel();
    _audioSub?.cancel();
    super.dispose();
  }

  void _onState(String state) {
    if (!mounted) return;
    setState(() => _state = state);
    if (state == 'active' && _timer == null) _startTimer();
    if (state == 'disconnected') _close();
  }

  void _startTimer() {
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() => _elapsed += const Duration(seconds: 1));
    });
  }

  Future<void> _toggleMute() async {
    final next = !_muted;
    setState(() => _muted = next);
    await AvaDialChannel.I.setMuted(next);
  }

  Future<void> _toggleSpeaker() async {
    final next = !_speaker;
    setState(() => _speaker = next);
    await AvaDialChannel.I.setSpeaker(next);
  }

  Future<void> _dtmf(String d) async {
    await AvaDialChannel.I.sendDtmf(widget.callId, d);
  }

  Future<void> _end() async {
    await AvaDialChannel.I.disconnect(widget.callId);
    _close();
  }

  void _close() {
    _timer?.cancel();
    if (mounted && Navigator.of(context).canPop()) Navigator.of(context).pop();
  }

  String get _statusLine {
    switch (_state) {
      case 'dialing':
      case 'connecting':
        return 'Dialing…';
      case 'ringing':
        return 'Ringing…';
      case 'holding':
        return 'On hold';
      case 'active':
        return _fmt(_elapsed);
      default:
        return _state;
    }
  }

  static String _fmt(Duration d) {
    final m = d.inMinutes.remainder(60).toString().padLeft(2, '0');
    final s = d.inSeconds.remainder(60).toString().padLeft(2, '0');
    final h = d.inHours;
    return h > 0 ? '$h:$m:$s' : '$m:$s';
  }

  @override
  Widget build(BuildContext context) {
    final name = _contact?.name;
    return Scaffold(
      backgroundColor: Zine.paper,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 32, 24, 28),
          child: Column(children: [
            const Spacer(),
            _avatar(name),
            const SizedBox(height: 20),
            Text(name ?? widget.number, textAlign: TextAlign.center, style: ZineText.hero(size: 30)),
            const SizedBox(height: 6),
            Text(_statusLine, style: ZineText.sub(size: 16)),
            const Spacer(),
            if (_keypad) _keypadGrid() else _controls(),
            const SizedBox(height: 18),
            _endButton(),
          ]),
        ),
      ),
    );
  }

  Widget _avatar(String? name) {
    final initial = (name != null && name.isNotEmpty)
        ? name.characters.first.toUpperCase()
        : null;
    return Container(
      width: 108,
      height: 108,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: Zine.mint,
        shape: BoxShape.circle,
        border: Border.all(color: Zine.ink, width: Zine.bwLg),
        boxShadow: Zine.shadow,
      ),
      child: initial != null
          ? Text(initial, style: ZineText.hero(size: 44))
          : Icon(PhosphorIcons.phoneCall(PhosphorIconsStyle.fill), size: 50, color: Zine.ink),
    );
  }

  Widget _controls() {
    return Row(mainAxisAlignment: MainAxisAlignment.spaceEvenly, children: [
      _circleToggle(
        icon: _muted ? PhosphorIcons.microphoneSlash(PhosphorIconsStyle.fill) : PhosphorIcons.microphone(PhosphorIconsStyle.bold),
        label: 'Mute',
        active: _muted,
        onTap: _toggleMute,
      ),
      _circleToggle(
        icon: PhosphorIcons.gridFour(PhosphorIconsStyle.bold),
        label: 'Keypad',
        active: false,
        onTap: () => setState(() => _keypad = true),
      ),
      _circleToggle(
        icon: PhosphorIcons.speakerHigh(_speaker ? PhosphorIconsStyle.fill : PhosphorIconsStyle.bold),
        label: 'Speaker',
        active: _speaker,
        onTap: _toggleSpeaker,
      ),
    ]);
  }

  Widget _circleToggle({
    required IconData icon,
    required String label,
    required bool active,
    required VoidCallback onTap,
  }) {
    return Column(mainAxisSize: MainAxisSize.min, children: [
      ZinePressable(
        onTap: onTap,
        color: active ? Zine.lime : Zine.card,
        radius: BorderRadius.circular(100),
        padding: const EdgeInsets.all(18),
        child: Icon(icon, size: 26, color: Zine.ink),
      ),
      const SizedBox(height: 6),
      Text(label, style: ZineText.tag(size: 11)),
    ]);
  }

  Widget _keypadGrid() {
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];
    return Column(children: [
      GridView.count(
        crossAxisCount: 3,
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        mainAxisSpacing: 10,
        crossAxisSpacing: 10,
        childAspectRatio: 1.6,
        children: [
          for (final k in keys)
            ZinePressable(
              onTap: () => _dtmf(k),
              color: Zine.card,
              radius: BorderRadius.circular(16),
              child: Center(child: Text(k, style: ZineText.hero(size: 26))),
            ),
        ],
      ),
      const SizedBox(height: 10),
      ZineButton(
        label: 'Hide keypad',
        variant: ZineButtonVariant.ghost,
        trailingIcon: false,
        onPressed: () => setState(() => _keypad = false),
      ),
    ]);
  }

  Widget _endButton() => ZineButton(
        label: 'End',
        variant: ZineButtonVariant.coral,
        fullWidth: true,
        icon: Icons.call_end,
        trailingIcon: false,
        onPressed: _end,
      );
}
