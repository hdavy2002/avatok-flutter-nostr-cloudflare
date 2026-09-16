
import '../../core/localization/ui_text.dart';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/api_auth.dart';
import '../../core/calls/call_room_id.dart'; // [CALL-ROOM-ID-1]
import '../../core/config.dart';
import '../../core/remote_config.dart';
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
    if (!m.hasRecording) { _toast(uiCopy(UiMessage.m_no_recording_for_this_message_7df7b43b51)); return; }
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
        _toast(uiCopy(UiMessage.m_recording_unavailable_2ef4c842e6));
      }
    } catch (_) {
      _toast(uiCopy(UiMessage.m_could_not_play_recording_8cede48276));
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
    if (number.isEmpty) { _toast(uiCopy(UiMessage.m_no_callback_number_c299b492d7)); return; }
    Clipboard.setData(ClipboardData(text: number));
    _toast(uiCopy(UiMessage.m_number_copied_number_646b29b7b1, {'number': (number).toString()}));
  }

  void _toast(String s) => ScaffoldMessenger.of(context)
      .showSnackBar(SnackBar(
        content: Text(s, style: ADText.preview(c: AD.textPrimary)),
        backgroundColor: AD.card,
      ));

  @override
  Widget build(BuildContext context) {
    UiLocaleScope.watch(context);
    return Scaffold(
      backgroundColor: AD.bg,
      appBar:  ZineAppBar(title: uiCopy(UiMessage.m_messages_04d7b48339), markWord: 'Messages', tag: 'Team voicemail'),
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
                UiText(UiMessage.m_called_from_value2_88a2062784, params: {'from': (from).toString(), 'value2': (_ago(m.createdAt)).toString()}, maxLines: 1, overflow: TextOverflow.ellipsis, style: ADText.sectionLabel(c: AD.textSecondary)),
              ]),
            ),
          ]),
          if (m.message != null && m.message!.isNotEmpty) ...[
            const SizedBox(height: Msg.s3),
            Text('“${m.message}”', style: ADText.preview(c: AD.textPrimary).copyWith(fontWeight: FontWeight.w500)),
          ],
          const SizedBox(height: Msg.s4),
          Row(children: [
            // [PIVOT-MSGR-CALL-OFF-1] Messenger 1:1 calling is being killed — the
            // dial engine already refuses at place_1to1_call.dart, so hide "Call
            // back" too instead of leaving it visible-and-failing with a snackbar.
            if (RemoteConfig.messengerCallingEnabled) ...[
              Expanded(
                child: ZineButton(
                  label: uiCopy(UiMessage.m_call_back_fbb0a343f6), icon: PhosphorIcons.phone(PhosphorIconsStyle.bold), trailingIcon: false,
                  fontSize: 14, variant: ZineButtonVariant.lime, onPressed: () => _callBack(m),
                ),
              ),
              const SizedBox(width: Msg.s3),
            ],
            Expanded(
              child: ZineButton(
                label: playing ? uiCopy(UiMessage.m_stop_cae7d57bc0) : uiCopy(UiMessage.m_play_436e61016e),
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
