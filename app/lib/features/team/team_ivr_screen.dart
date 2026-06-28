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
  bool _busy = false; // playing the greeting or a transfer line
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
    await _speak(TeamApi.ivrAudioUrl(widget.teamNumber)); // greeting + menu
  }

  // Fetch a spoken clip (auth-signed) and play it; waits until it finishes.
  Future<void> _speak(String url) async {
    setState(() => _busy = true);
    try {
      final r = await ApiAuth.getSigned(url);
      if (r.statusCode == 200 && r.bodyBytes.isNotEmpty) {
        await _player.stop();
        await _player.play(BytesSource(r.bodyBytes, mimeType: 'audio/mpeg'));
        await _player.onPlayerComplete.first;
      }
    } catch (_) {/* silent — the menu legend is still on screen */}
    if (mounted) setState(() => _busy = false);
  }

  Future<void> _press(int slot) async {
    if (_busy) return;
    final r = await TeamApi.ivrRoute(widget.teamNumber, slot);
    if (!mounted || r == null) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Could not connect')));
      return;
    }
    final fallback = r['fallback'] == true;
    final name = (r['target_name'] ?? '').toString();
    // Ava speaks the transfer (or "invalid option") line.
    setState(() => _status = fallback ? 'Sorry, try another option' : 'Transferring you to $name…');
    await _speak(TeamApi.ivrAudioUrl(widget.teamNumber, slot: slot));
    if (!mounted) return;
    if (fallback) return; // invalid slot → stay on the menu, let them pick again
    if (widget.preview) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Would transfer to $name'), backgroundColor: Zine.ink));
      setState(() => _status = '${_menu?['team_name'] ?? 'Team'} — listen and choose');
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
                            icon: _busy ? PhosphorIcons.speakerHigh(PhosphorIconsStyle.fill) : PhosphorIcons.buildings(PhosphorIconsStyle.bold),
                            color: _busy ? Zine.mint : Zine.lilac),
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
            onTap: _busy ? null : () => _press(n),
            child: Container(
              width: 68, height: 68, alignment: Alignment.center,
              decoration: BoxDecoration(
                color: _busy ? Zine.card : Zine.paper2, shape: BoxShape.circle,
                border: Border.all(color: Zine.ink, width: Zine.bw),
                boxShadow: _busy ? const [] : Zine.shadowXs,
              ),
              child: Text('$n', style: ZineText.cardTitle(size: 26, color: _busy ? Zine.inkMute : Zine.ink)),
            ),
          ),
        );
    return Column(children: [
      for (final row in [[1, 2, 3], [4, 5, 6], [7, 8, 9]])
        Row(mainAxisAlignment: MainAxisAlignment.center, children: [for (final n in row) key(n)]),
    ]);
  }
}
