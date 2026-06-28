import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/api_auth.dart';
import '../../core/config.dart';
import '../../core/team_api.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../avatok/call_screen.dart';

/// TeamInboxScreen — the message cards from Ava-taken voicemails across the team.
/// Spec: Specs/TEAM-RECEPTIONIST-IVR-SPEC.md. Each card: "Julie called from +1 302…
/// and left this message" + Call back + Play (streams the recording).
class TeamInboxScreen extends StatefulWidget {
  const TeamInboxScreen({super.key});
  @override
  State<TeamInboxScreen> createState() => _TeamInboxScreenState();
}

class _TeamInboxScreenState extends State<TeamInboxScreen> {
  bool _loading = true;
  List<TeamMessage> _messages = const [];
  final _player = AudioPlayer();
  String? _playingId;

  @override
  void initState() {
    super.initState();
    _load();
    _player.onPlayerComplete.listen((_) { if (mounted) setState(() => _playingId = null); });
  }

  @override
  void dispose() {
    _player.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    final m = await TeamApi.messages();
    if (!mounted) return;
    setState(() { _messages = m; _loading = false; });
  }

  Future<void> _play(TeamMessage m) async {
    if (!m.hasRecording) { _toast('No recording for this message'); return; }
    if (_playingId == m.id) { await _player.stop(); setState(() => _playingId = null); return; }
    // The recording endpoint requires signed auth, so fetch the bytes with the
    // signed GET (manager or staffer authorized server-side) and play from memory.
    final url = 'https://$kSignalingHost/api/receptionist/recording?sid=${Uri.encodeQueryComponent(m.id)}';
    try {
      final r = await ApiAuth.getSigned(url);
      if (r.statusCode == 200 && r.bodyBytes.isNotEmpty) {
        await _player.play(BytesSource(r.bodyBytes, mimeType: 'audio/wav'));
        setState(() => _playingId = m.id);
      } else {
        _toast('Recording unavailable');
      }
    } catch (_) {
      _toast('Could not play recording');
    }
  }

  void _callBack(TeamMessage m) {
    final title = m.callerName ?? (m.callerPhone != null ? '+${m.callerPhone}' : 'Caller');
    // In-network caller → place a real 1:1 call (calls are keyed by uid). Stop any
    // voicemail playback first so it doesn't bleed into the call screen.
    if (m.callerUid != null && m.callerUid!.isNotEmpty) {
      _player.stop();
      Navigator.push(context, MaterialPageRoute(
        builder: (_) => CallScreen(
          room: 'avatok-${m.callerUid}', title: title, seed: m.callerUid!,
          video: false, outgoing: true, avatarUrl: ''),
      ));
      return;
    }
    // External / unknown caller (no in-network account) → copy the number to dial.
    final number = (m.callback?.isNotEmpty == true) ? m.callback! : (m.callerPhone ?? '');
    if (number.isEmpty) { _toast('No callback number'); return; }
    Clipboard.setData(ClipboardData(text: number));
    _toast('Number copied — $number');
  }

  void _toast(String s) => ScaffoldMessenger.of(context)
      .showSnackBar(SnackBar(content: Text(s), backgroundColor: Zine.ink));

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: const ZineAppBar(title: 'Messages', markWord: 'Messages', tag: 'TEAM VOICEMAIL'),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: Zine.ink))
          : _messages.isEmpty
              ? Center(
                  child: Padding(
                  padding: const EdgeInsets.all(28),
                  child: ZineEmptyState(icon: PhosphorIcons.voicemail(PhosphorIconsStyle.bold), text: 'No messages yet. When a staffer misses a call, Ava takes a message and it appears here.'),
                ))
              : RefreshIndicator(
                  onRefresh: _load, color: Zine.ink,
                  child: ListView.builder(
                    padding: const EdgeInsets.fromLTRB(16, 14, 16, 28),
                    itemCount: _messages.length,
                    itemBuilder: (_, i) => _card(_messages[i]),
                  ),
                ),
    );
  }

  Widget _card(TeamMessage m) {
    final who = m.callerName ?? 'Unknown caller';
    final from = m.callerPhone == null ? '' : ' · +${m.callerPhone}';
    final playing = _playingId == m.id;
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: ZineCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            ZineIconBadge(icon: PhosphorIcons.phoneIncoming(PhosphorIconsStyle.bold), color: m.urgency == 'high' ? Zine.coral : Zine.blue),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('$who${m.slot != null ? '  ·  #${m.slot}' : ''}', style: ZineText.cardTitle(size: 15.5)),
                Text('Called$from · ${_ago(m.createdAt)}', maxLines: 1, overflow: TextOverflow.ellipsis, style: ZineText.tag(size: 11, color: Zine.inkSoft)),
              ]),
            ),
          ]),
          if (m.message != null && m.message!.isNotEmpty) ...[
            const SizedBox(height: 10),
            Text('“${m.message}”', style: ZineText.value(size: 14, weight: FontWeight.w500)),
          ],
          const SizedBox(height: 14),
          Row(children: [
            Expanded(
              child: ZineButton(
                label: 'Call back', icon: PhosphorIcons.phone(PhosphorIconsStyle.bold), trailingIcon: false,
                fontSize: 14, variant: ZineButtonVariant.lime, onPressed: () => _callBack(m),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: ZineButton(
                label: playing ? 'Stop' : 'Play',
                icon: playing ? PhosphorIcons.stop(PhosphorIconsStyle.bold) : PhosphorIcons.play(PhosphorIconsStyle.bold),
                trailingIcon: false, fontSize: 14,
                variant: ZineButtonVariant.blue, onPressed: () => _play(m),
              ),
            ),
          ]),
        ]),
      ),
    );
  }

  String _ago(int ms) {
    if (ms == 0) return '';
    final d = DateTime.now().difference(DateTime.fromMillisecondsSinceEpoch(ms));
    if (d.inMinutes < 1) return 'just now';
    if (d.inMinutes < 60) return '${d.inMinutes}m ago';
    if (d.inHours < 24) return '${d.inHours}h ago';
    return '${d.inDays}d ago';
  }
}
