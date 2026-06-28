import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/api_auth.dart';
import '../../core/team_api.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../avatok/call_screen.dart';

/// TeamIvrScreen — the caller-facing auto-attendant for a team's AvaTOK number.
/// Spec: Specs/TEAM-RECEPTIONIST-IVR-SPEC.md §1b.
///
/// Real IVR experience: on connect, **Ava speaks** the greeting + menu (one-way
/// TTS streamed from the server), the caller **punches a digit on the dialpad**,
/// then Ava says "Hold on, I'm transferring you to <dept>" and the call is
/// **bridged to that staffer without dropping** (pushReplacement → CallScreen, one
/// continuous flow). No answer → the staffer's Ava takes a message.
///
/// Reached two ways: the dialer pushes it when a dialed number is a team number,
/// and the manager opens it (preview=true) to hear the experience without calling.
class TeamIvrScreen extends StatefulWidget {
  final String teamNumber;
  final bool preview; // manager preview → speak + show, but don't place real calls
  const TeamIvrScreen({super.key, required this.teamNumber, this.preview = false});
  @override
  State<TeamIvrScreen> createState() => _TeamIvrScreenState();
}

class _TeamIvrScreenState extends State<TeamIvrScreen> {
  bool _loading = true;
  bool _speaking = false; // Ava is currently voicing a line (drives the icon only)
  bool _routing = false;  // resolving a digit → guards against double-press
  String _status = 'Connecting…';
  Map<String, dynamic>? _menu;
  final _player = AudioPlayer();

  @override
  void initState() {
    super.initState();
    _start();
  }

  @override
  void dispose() {
    _player.dispose();
    super.dispose();
  }

  Future<void> _start() async {
    final m = await TeamApi.ivrMenu(widget.teamNumber);
    if (!mounted) return;
    setState(() { _menu = m; _loading = false; });
    if (m == null) { setState(() => _status = 'Not a team number'); return; }
    setState(() => _status = '${m['team_name'] ?? 'Team'} — listen and choose');
    // Play greeting+menu but DON'T block the dialpad — the caller can punch a digit
    // during the prompt (dial-ahead), exactly like a real IVR.
    _playClip(TeamApi.ivrAudioUrl(widget.teamNumber));
  }

  /// Fetch a spoken clip (auth-signed) and play it from memory. Returns when the
  /// clip finishes — but guarded with a timeout because onPlayerComplete does NOT
  /// fire if a later press interrupts playback with stop() (audioplayers docs).
  Future<void> _playClip(String url) async {
    try {
      final r = await ApiAuth.getSigned(url);
      if (r.statusCode != 200 || r.bodyBytes.isEmpty) return;
      final done = _player.onPlayerComplete.first; // subscribe BEFORE play (no race)
      await _player.stop();
      await _player.play(BytesSource(r.bodyBytes, mimeType: 'audio/mpeg'));
      if (mounted) setState(() => _speaking = true);
      await done.timeout(const Duration(seconds: 20), onTimeout: () {});
    } catch (_) {/* silent — the on-screen menu legend still guides the caller */}
    if (mounted) setState(() => _speaking = false);
  }

  Future<void> _press(int slot) async {
    if (_routing) return;
    setState(() => _routing = true);
    await _player.stop(); // interrupt the greeting the moment a digit is pressed
    final r = await TeamApi.ivrRoute(widget.teamNumber, slot);
    if (!mounted) return;
    if (r == null) {
      setState(() => _routing = false);
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Could not connect')));
      return;
    }
    final fallback = r['fallback'] == true;
    final name = (r['target_name'] ?? '').toString();
    setState(() => _status = fallback ? 'Sorry, try another option' : 'Transferring you to $name…');
    // Ava speaks the transfer (or "invalid option") line, then we act.
    await _playClip(TeamApi.ivrAudioUrl(widget.teamNumber, slot: slot));
    if (!mounted) return;
    if (fallback) { // invalid slot → stay on the menu, let them pick again
      setState(() { _routing = false; _status = '${_menu?['team_name'] ?? 'Team'} — listen and choose'; });
      return;
    }
    if (widget.preview) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Would transfer to $name'), backgroundColor: Zine.ink));
      setState(() { _routing = false; _status = '${_menu?['team_name'] ?? 'Team'} — listen and choose'; });
      return;
    }
    // Warm transfer: bridge to the staffer in the SAME flow (no hangup → dialer).
    // Carry the team tag so a no-answer voicemail lands in the manager's team inbox.
    final number = (r['target_number'] ?? '').toString();
    final teamId = (r['team_id'] ?? '').toString();
    await _player.stop();
    Navigator.pushReplacement(context, MaterialPageRoute(
      builder: (_) => CallScreen(
        room: 'avatok-$number', title: name.isNotEmpty ? name : '+$number',
        seed: number, video: false, outgoing: true, avatarUrl: '',
        teamId: teamId.isEmpty ? null : teamId, teamSlot: slot),
    ));
  }

  @override
  Widget build(BuildContext context) {
    final entries = ((_menu?['entries'] ?? []) as List).cast<Map<String, dynamic>>();
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: ZineAppBar(
        title: widget.preview ? 'Menu preview' : 'Auto-attendant',
        markWord: widget.preview ? 'preview' : 'attendant',
        tag: widget.teamNumber.isEmpty ? '' : '+${widget.teamNumber}'),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: Zine.ink))
          : _menu == null
              ? Center(child: Padding(padding: const EdgeInsets.all(28), child: ZineEmptyState(icon: PhosphorIcons.phoneX(PhosphorIconsStyle.bold), text: 'This number is not a team auto-attendant.')))
              : SafeArea(
                  child: Column(children: [
                    // Speaking indicator + status
                    Padding(
                      padding: const EdgeInsets.fromLTRB(18, 14, 18, 6),
                      child: Row(children: [
                        ZineIconBadge(
                            icon: _speaking ? PhosphorIcons.speakerHigh(PhosphorIconsStyle.fill) : PhosphorIcons.buildings(PhosphorIconsStyle.bold),
                            color: _speaking ? Zine.mint : Zine.lilac),
                        const SizedBox(width: 12),
                        Expanded(child: Text(_status, style: ZineText.cardTitle(size: 16))),
                      ]),
                    ),
                    // Menu legend (what each digit does)
                    Expanded(
                      child: ListView(
                        padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
                        children: [
                          for (final e in entries)
                            Padding(
                              padding: const EdgeInsets.only(bottom: 8),
                              child: Row(children: [
                                _digitChip((e['slot'] as num?)?.toInt() ?? 0),
                                const SizedBox(width: 12),
                                Expanded(child: Text((e['role_label'] ?? '').toString(), style: ZineText.value(size: 15))),
                                if (e['available'] != true)
                                  Text('voicemail', style: ZineText.tag(size: 10.5, color: Zine.inkMute)),
                              ]),
                            ),
                        ],
                      ),
                    ),
                    // Dialpad — punch the menu number
                    _dialpad(),
                    const SizedBox(height: 10),
                  ]),
                ),
    );
  }

  Widget _digitChip(int n) => Container(
        width: 30, height: 30, alignment: Alignment.center,
        decoration: BoxDecoration(color: Zine.lime, shape: BoxShape.circle, border: Border.all(color: Zine.ink, width: 2)),
        child: Text('$n', style: ZineText.cardTitle(size: 14)),
      );

  Widget _dialpad() {
    Widget key(int n) => Padding(
          padding: const EdgeInsets.all(7),
          child: GestureDetector(
            onTap: _routing ? null : () => _press(n), // pressable during the greeting (dial-ahead)
            child: Container(
              width: 68, height: 68, alignment: Alignment.center,
              decoration: BoxDecoration(
                color: _routing ? Zine.card : Zine.paper2, shape: BoxShape.circle,
                border: Border.all(color: Zine.ink, width: Zine.bw),
                boxShadow: _routing ? const [] : Zine.shadowXs,
              ),
              child: Text('$n', style: ZineText.cardTitle(size: 26, color: _routing ? Zine.inkMute : Zine.ink)),
            ),
          ),
        );
    return Column(children: [
      for (final row in [[1, 2, 3], [4, 5, 6], [7, 8, 9]])
        Row(mainAxisAlignment: MainAxisAlignment.center, children: [for (final n in row) key(n)]),
    ]);
  }
}
