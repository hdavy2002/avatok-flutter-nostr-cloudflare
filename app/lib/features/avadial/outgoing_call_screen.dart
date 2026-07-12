import 'dart:async';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import 'avadial_channel.dart';
import 'avadial_theme.dart';
import 'device_contacts.dart';
import 'in_call_screen.dart';

/// Outgoing PSTN "dialing" screen (plan §4.3). Shown right after the dialpad places
/// a call via [AvaDialChannel.placeCall]. It listens for the native call events to
/// resolve the [AvaCallEvent.id] (the call id is only known once the OS reports
/// onCallAdded) and shows a Dialing… / Ringing… status. When the call goes ACTIVE it
/// transitions (pushReplacement) to the shared [InCallScreen]. Phone-style, Zine
/// design language, consistent with [PstnCallScreen]. DARK behind `avaDialer`.
class OutgoingCallScreen extends StatefulWidget {
  final String number;
  const OutgoingCallScreen({super.key, required this.number});

  @override
  State<OutgoingCallScreen> createState() => _OutgoingCallScreenState();
}

class _OutgoingCallScreenState extends State<OutgoingCallScreen> {
  DeviceContact? _contact;
  String? _callId;
  String _state = 'dialing';
  bool _transitioned = false;

  StreamSubscription<AvaCallEvent>? _sub;
  StreamSubscription<String>? _removedSub;

  @override
  void initState() {
    super.initState();
    _contact = DeviceContacts.I.lookup(widget.number);
    Analytics.capture('avadial_outgoing_call_shown', const {});
    _sub = AvaDialChannel.I.calls.listen(_onCall);
    _removedSub = AvaDialChannel.I.removedCalls.listen((id) {
      if (id == _callId) _close();
    });
  }

  @override
  void dispose() {
    _sub?.cancel();
    _removedSub?.cancel();
    super.dispose();
  }

  bool _matches(AvaCallEvent e) {
    if (_callId != null) return e.id == _callId;
    // Before we know the id: adopt the first outgoing event (or one whose number
    // matches ours) as this screen's call.
    if (e.direction == 'outgoing') return true;
    final n = e.number;
    return n != null && DeviceContacts.normKey(n) == DeviceContacts.normKey(widget.number);
  }

  void _onCall(AvaCallEvent e) {
    if (!mounted || !_matches(e)) return;
    _callId ??= e.id;
    setState(() => _state = e.state);
    if (e.state == 'active' && !_transitioned) _goActive();
    if (e.state == 'disconnected') _close();
  }

  void _goActive() {
    final id = _callId;
    if (id == null) return;
    _transitioned = true;
    Navigator.of(context).pushReplacement(MaterialPageRoute<void>(
      fullscreenDialog: true,
      builder: (_) => InCallScreen(callId: id, number: widget.number, initialState: 'active'),
    ));
  }

  Future<void> _end() async {
    final id = _callId;
    if (id != null) await AvaDialChannel.I.disconnect(id);
    _close();
  }

  void _close() {
    if (mounted && Navigator.of(context).canPop()) Navigator.of(context).pop();
  }

  String get _statusLine => switch (_state) {
        'ringing' => 'Ringing…',
        'connecting' => 'Connecting…',
        _ => 'Dialing…',
      };

  @override
  Widget build(BuildContext context) {
    final name = _contact?.name;
    final initial = (name != null && name.isNotEmpty) ? name.characters.first.toUpperCase() : null;
    // Known contact = mint, unknown = blue — same convention as PstnCallScreen.
    final accent = _contact != null ? Zine.mint : Zine.blue;
    return Scaffold(
      // Dark PSTN outgoing/"dialing" screen (owner request 2026-07-12) — never
      // the AvaTalk/messenger UI, and always shown for a placed PSTN call so a
      // dial never silently just rings with no screen.
      backgroundColor: AvaDialTheme.bg,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 32, 24, 28),
          child: Column(children: [
            const Spacer(),
            Container(
              width: 108,
              height: 108,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: accent,
                shape: BoxShape.circle,
                border: Border.all(color: AvaDialTheme.border, width: Zine.bwLg),
                boxShadow: Zine.shadow,
              ),
              child: initial != null
                  ? Text(initial, style: ZineText.hero(size: 44, color: Zine.ink))
                  : Icon(PhosphorIcons.phoneOutgoing(PhosphorIconsStyle.fill), size: 50, color: Zine.ink),
            ),
            const SizedBox(height: 20),
            Text('CALLING', style: ZineText.kicker(color: AvaDialTheme.textSoft)),
            const SizedBox(height: 6),
            Text(name ?? widget.number,
                textAlign: TextAlign.center, style: ZineText.hero(size: 30, color: AvaDialTheme.text)),
            if (name != null) ...[
              const SizedBox(height: 4),
              Text(widget.number, style: ZineText.sub(size: 15, color: AvaDialTheme.textSoft)),
            ],
            const SizedBox(height: 8),
            Text(_statusLine, style: ZineText.sub(size: 16, color: AvaDialTheme.textSoft)),
            const Spacer(),
            ZineButton(
              label: 'End',
              variant: ZineButtonVariant.coral,
              fullWidth: true,
              icon: Icons.call_end,
              trailingIcon: false,
              onPressed: _end,
            ),
          ]),
        ),
      ),
    );
  }
}
