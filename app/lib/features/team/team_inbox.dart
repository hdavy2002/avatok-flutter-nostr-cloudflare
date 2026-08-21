import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/api_auth.dart';
import '../../core/calls/call_room_id.dart'; // [CALL-ROOM-ID-1]
import '../../core/config.dart';
import '../../core/team_api.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/zine_widgets.dart';
import '../avatok/call_screen.dart';
import '../avatok/place_1to1_call.dart' show routeToStreamCallIfEnabled; // [STREAM-ROUTE-1]

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

  Future<void> _callBack(TeamMessage m) async {
    final title = m.callerName ?? (m.callerPhone != null ? '+${m.callerPhone}' : 'Caller');
    // In-network caller → place a real 1:1 call. Stop any voicemail playback
    // first so it doesn't bleed into the call screen.
    //
    // [CALL-ROOM-ID-1 2026-07-14] Was `room: 'avatok-${m.callerUid}'`, under the
    // comment "calls are keyed by uid" — that assumption was the bug. A call id
    // keys a CALL, not a person: a per-callee id reuses one CallRoom DO forever
    // and gets permanently swallowed by the callee's untimed `_isCallIdProcessed`
    // dedup cache from the second call onward. `seed:` carries the peer id.
    if (m.callerUid != null && m.callerUid!.isNotEmpty) {
      _player.stop();
      // [STREAM-ROUTE-1 2026-08-21] Stream is the only 1:1 call path. This
      // mount site never read `streamCallsEnabled` and would have dialled the
      // legacy Cloudflare engine straight into the build-10612 getUserMedia
      // failure. The legacy push below stays compiled as the emergency backup
      // and is reachable again only if the kill switch is turned off.
      if (await routeToStreamCallIfEnabled(context,
          peerId: m.callerUid!, video: false, entrypoint: 'team_inbox')) {
        return;
      }
      if (!mounted) return;
      Navigator.push(context, MaterialPageRoute(
        builder: (_) => CallScreen(
          room: CallRoomId.newRoomId(), title: title, seed: m.callerUid!,
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
      .showSnackBar(SnackBar(
        content: Text(s, style: ADText.preview(c: AD.textPrimary)),
        backgroundColor: AD.card,
      ));

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: const ZineAppBar(title: 'Messages', markWord: 'Messages', tag: 'Team voicemail'),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: AD.primaryBadge))
          : _messages.isEmpty
              ? Center(
                  child: Padding(
                  padding: const EdgeInsets.all(Msg.s5),
                  child: ZineEmptyState(icon: PhosphorIcons.voicemail(PhosphorIconsStyle.regular), text: 'No messages yet. When a staffer misses a call, Ava takes a message and it appears here.'),
                ))
              : RefreshIndicator(
                  onRefresh: _load,
                  color: AD.primaryBadge,
                  backgroundColor: AD.card,
                  child: ListView.builder(
                    padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s4, Msg.s4, Msg.s6),
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
      padding: const EdgeInsets.only(bottom: Msg.s3),
      child: ZineCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            ZineIconBadge(icon: PhosphorIcons.phoneIncoming(PhosphorIconsStyle.regular), color: m.urgency == 'high' ? AD.destructiveBg : AD.newGroup),
            const SizedBox(width: Msg.s3),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('$who${m.slot != null ? '  ·  #${m.slot}' : ''}', style: ADText.rowName()),
                Text('Called$from · ${_ago(m.createdAt)}', maxLines: 1, overflow: TextOverflow.ellipsis, style: ADText.sectionLabel(c: AD.textSecondary)),
              ]),
            ),
          ]),
          if (m.message != null && m.message!.isNotEmpty) ...[
            const SizedBox(height: Msg.s3),
            Text('“${m.message}”', style: ADText.preview(c: AD.textPrimary).copyWith(fontWeight: FontWeight.w500)),
          ],
          const SizedBox(height: Msg.s4),
          Row(children: [
            Expanded(
              child: ZineButton(
                label: 'Call back', icon: PhosphorIcons.phone(PhosphorIconsStyle.bold), trailingIcon: false,
                fontSize: 14, variant: ZineButtonVariant.lime, onPressed: () => _callBack(m),
              ),
            ),
            const SizedBox(width: Msg.s3),
            Expanded(
              child: ZineButton(
                label: playing ? 'Stop' : 'Play',
                icon: playing ? PhosphorIcons.stop(PhosphorIconsStyle.regular) : PhosphorIcons.play(PhosphorIconsStyle.regular),
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
