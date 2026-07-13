import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/blocking_api.dart';
import '../../core/config.dart';
import '../../core/ui/avatok_dark.dart';
import 'unknown_caller.dart';

/// Message-bubble renderers for business-call records (Specs/PLAN-2026-07-11-
/// dialpad-business-calls-ava-voice-agent.md §6, §12.11). These render on the
/// CALLEE's side only — voicemails/agent transcripts are pushed server-side
/// into the callee's own thread sync stream, so no client-side `m.me` filter is
/// needed here (mirrors how `'recept'` messages already work; see
/// chat_thread.dart's `_specialContent`).
///
/// Two special kinds, wired into chat_thread.dart's `_specialContent` switch:
///   - `voicemail`        (gated on RemoteConfig.voicemailBot)
///   - `agent_transcript` (gated on RemoteConfig.voiceAgent)
///
/// Both widgets are intentionally public (not chat_thread.dart privates) so the
/// large host file only needs a one-line `case` + constructor call.

/// Callee-side voicemail card. `extra` shape (server envelope, `t:'voicemail'`,
/// see worker/src/do/voicemail_room.ts postVoicemail — field names MUST match
/// that writer exactly): { call_id, caller_uid, caller_name, caller_phone,
/// transcript, duration_s, has_recording, media_ref, session_id }. GAP-3:
/// `media_ref` is the R2 recording key (added to the envelope alongside the
/// existing top-level /inbox/append field so it also rides in the decoded
/// body, since `_Msg.extra` is built straight from that body and never merges
/// the separate DB column in) — `_recordingUrl` builds the authenticated
/// GET /api/voicemail/recording?key= URL from it, mirroring how
/// _ReceptionistCard fetches its `/api/receptionist/recording?sid=`.
class VoicemailCard extends StatefulWidget {
  final Map<String, dynamic> extra;
  const VoicemailCard({super.key, required this.extra});

  @override
  State<VoicemailCard> createState() => _VoicemailCardState();
}

class _VoicemailCardState extends State<VoicemailCard> {
  final AudioPlayer _player = AudioPlayer();
  bool _playing = false;
  bool _loading = false;
  bool _expanded = false;
  bool _handled = false; // local optimistic state for Accept/Block

  Map<String, dynamic> get _e => widget.extra;
  String get _callId => (_e['call_id'] ?? '').toString();
  String get _callerUid => (_e['caller_uid'] ?? '').toString();
  String get _callerName => (_e['caller_name'] ?? 'Unknown caller').toString();
  String get _callerNumber => (_e['caller_phone'] ?? '').toString();
  String get _transcript => (_e['transcript'] ?? '').toString();
  int get _durationSec => (_e['duration_s'] as num?)?.toInt() ?? 0;
  String get _mediaRef => (_e['media_ref'] ?? '').toString();
  bool get _hasRecording =>
      _e['has_recording'] == true ||
      _mediaRef.isNotEmpty ||
      (_e['recording_url'] ?? '').toString().isNotEmpty;
  String get _recordingUrl => _mediaRef.isNotEmpty
      ? 'https://$kSignalingHost/api/voicemail/recording?key=${Uri.encodeQueryComponent(_mediaRef)}'
      : (_e['recording_url'] ?? '').toString();

  @override
  void dispose() {
    _player.dispose();
    super.dispose();
  }

  Future<void> _togglePlay() async {
    if (!_hasRecording) return;
    if (_playing) {
      await _player.pause();
      if (mounted) setState(() => _playing = false);
      return;
    }
    setState(() => _loading = true);
    try {
      final url = _recordingUrl.startsWith('http')
          ? _recordingUrl
          : 'https://$kSignalingHost$_recordingUrl';
      // Owner-authed fetch → play from bytes (audioplayers UrlSource has no
      // headers param in this project's version; same pattern as team_inbox).
      final headers = await ApiAuth.signedHeaders('GET', url);
      final r = await http.get(Uri.parse(url), headers: headers);
      if (r.statusCode != 200) throw Exception('recording ${r.statusCode}');
      await _player.play(BytesSource(r.bodyBytes, mimeType: 'audio/wav'));
      if (!mounted) return;
      setState(() { _playing = true; _loading = false; });
      Analytics.capture('voicemail_played', {'call_id': _callId});
      _player.onPlayerComplete.first.then((_) { if (mounted) setState(() => _playing = false); });
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _accept() async {
    setState(() => _handled = true);
    Analytics.capture('voicemail_accepted', {'call_id': _callId});
  }

  Future<void> _block() async {
    setState(() => _handled = true);
    // [DIALPAD-BIZ-CALLS] §15.2 — block is account-level: blocking this caller
    // silently blocks calls to ALL my numbers + voicemail + agent + messaging.
    // Reuses BlockingApi (core/blocking_api.dart), the SAME POST /api/block →
    // convBlock() account-level blocklist every other block affordance uses.
    // Optimistic: the card dismisses immediately regardless of the network
    // result — the server-side block record is authoritative either way, and a
    // failed request here just means the caller isn't blocked yet (best-effort,
    // matches this card's Accept/Save-contact error handling).
    final ok = _callerUid.isNotEmpty && await BlockingApi.blockAccount(_callerUid);
    Analytics.capture('voicemail_blocked', {'call_id': _callId, 'ok': ok});
  }

  Future<void> _saveContact() async {
    Analytics.capture('voicemail_save_contact_tapped', {'call_id': _callId});
    await showSavePhoneContactSheet(context, phone: _callerNumber, source: 'voicemail_card');
  }

  @override
  Widget build(BuildContext context) {
    return ConstrainedBox(
      constraints: const BoxConstraints(minWidth: 220),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
        Row(children: [
          Icon(PhosphorIcons.voicemail(PhosphorIconsStyle.fill), size: 18, color: AD.danger),
          const SizedBox(width: 6),
          Expanded(child: Text('$_callerName left a voicemail', style: ADText.rowName())),
        ]),
        if (_callerNumber.isNotEmpty)
          Padding(padding: const EdgeInsets.only(top: 2), child: Text(_callerNumber, style: ADText.preview())),
        const SizedBox(height: 8),
        GestureDetector(
          onTap: _togglePlay,
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            _loading
                ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : Icon(_playing
                    ? PhosphorIcons.pauseCircle(PhosphorIconsStyle.fill)
                    : PhosphorIcons.playCircle(PhosphorIconsStyle.fill), size: 26, color: AD.iconSearch),
            const SizedBox(width: 8),
            Text(_durationSec > 0 ? '${_durationSec}s voicemail' : 'Play voicemail',
                style: ADText.rowName(c: AD.iconSearch)),
          ]),
        ),
        if (_transcript.isNotEmpty) ...[
          const SizedBox(height: 6),
          GestureDetector(
            onTap: () => setState(() => _expanded = !_expanded),
            child: Text(_expanded ? 'Hide transcript ▲' : 'Show transcript ▼',
                style: ADText.statCaption(c: AD.textTertiary)),
          ),
          if (_expanded)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(_transcript, style: ADText.preview()),
            ),
        ],
        if (!_handled) ...[
          const SizedBox(height: 10),
          Wrap(spacing: 8, runSpacing: 6, children: [
            AdChip(label: 'Accept', onTap: _accept),
            AdChip(label: 'Block', onTap: _block),
            AdChip(label: 'Save contact', onTap: _saveContact),
          ]),
        ],
      ]),
    );
  }
}

/// Callee-side full AI-agent conversation transcript (§6). `extra` shape
/// (server envelope, `t:'agent_transcript'`, see worker/src/do/agent_voice_room.ts
/// finalize() — field names MUST match that writer exactly): { call_id,
/// caller_uid, caller_name, caller_phone, transcript (flat string built by
/// buildTranscript(), NOT a structured turns[] array), booking_created,
/// tools_used, session_id }. `text` already carries a one-line summary
/// ("🤖 Ava AI Agent call with X: <summaryText>") — there is no separate
/// `summary` field on the wire, so fall back to `text`.
class AgentTranscriptCard extends StatefulWidget {
  final Map<String, dynamic> extra;
  final void Function(String callerNumber, String callerName)? onReply;
  const AgentTranscriptCard({super.key, required this.extra, this.onReply});

  @override
  State<AgentTranscriptCard> createState() => _AgentTranscriptCardState();
}

class _AgentTranscriptCardState extends State<AgentTranscriptCard> {
  bool _expanded = false;

  Map<String, dynamic> get _e => widget.extra;
  String get _callId => (_e['call_id'] ?? '').toString();
  String get _callerName => (_e['caller_name'] ?? 'Unknown caller').toString();
  String get _callerNumber => (_e['caller_phone'] ?? '').toString();
  String get _summary => (_e['summary'] ?? _e['text'] ?? 'The Ava AI agent handled this call.').toString();
  bool get _bookingCreated => _e['booking_created'] == true;
  // Prefer a structured turns[] if a future server version ever sends one;
  // fall back to rendering the flat `transcript` string agent_voice_room.ts
  // actually writes today (buildTranscript() produces "caller: ...\nagent: ..."
  // lines, so a naive '\n' split already reads as a reasonable turn-by-turn view).
  List<Map<String, dynamic>> get _turns {
    final raw = (_e['turns'] as List?) ?? const [];
    if (raw.isNotEmpty) return raw.whereType<Map>().map((m) => m.cast<String, dynamic>()).toList();
    final flat = (_e['transcript'] ?? '').toString().trim();
    if (flat.isEmpty) return const [];
    return flat.split('\n').where((l) => l.trim().isNotEmpty).map((line) {
      final lower = line.toLowerCase();
      final speaker = lower.startsWith('caller') ? 'caller' : 'agent';
      return <String, dynamic>{'speaker': speaker, 'text': line};
    }).toList();
  }

  @override
  Widget build(BuildContext context) {
    return ConstrainedBox(
      constraints: const BoxConstraints(minWidth: 220),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
        Row(children: [
          Icon(PhosphorIcons.robot(PhosphorIconsStyle.fill), size: 18, color: AD.iconVideo),
          const SizedBox(width: 6),
          Expanded(child: Text('Ava AI Agent talked to $_callerName', style: ADText.rowName())),
        ]),
        if (_callerNumber.isNotEmpty)
          Padding(padding: const EdgeInsets.only(top: 2), child: Text(_callerNumber, style: ADText.preview())),
        const SizedBox(height: 6),
        // "What the agent did" summary line — the owner reads this without
        // opening the whole transcript.
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          if (_bookingCreated)
            Padding(
              padding: const EdgeInsets.only(right: 6, top: 1),
              child: Icon(PhosphorIcons.checkCircle(PhosphorIconsStyle.fill), size: 14, color: AD.online),
            ),
          Expanded(child: Text(_summary, style: ADText.preview())),
        ]),
        if (_turns.isNotEmpty) ...[
          const SizedBox(height: 8),
          GestureDetector(
            onTap: () {
              setState(() => _expanded = !_expanded);
              if (_expanded) Analytics.capture('agent_transcript_expanded', {'call_id': _callId});
            },
            child: Text(_expanded ? 'Hide transcript ▲' : 'Show full transcript ▼',
                style: ADText.statCaption(c: AD.textTertiary)),
          ),
          if (_expanded)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                for (final t in _turns)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 4),
                    child: Text(
                      '${(t['speaker'] ?? 'agent') == 'caller' ? _callerName : 'Ava'}: ${t['text'] ?? ''}',
                      style: ADText.preview(),
                    ),
                  ),
              ]),
            ),
        ],
        if (widget.onReply != null) ...[
          const SizedBox(height: 10),
          AdChip(
            label: 'Reply',
            onTap: () {
              Analytics.capture('agent_transcript_reply_tapped', {'call_id': _callId});
              widget.onReply!(_callerNumber, _callerName);
            },
          ),
        ],
      ]),
    );
  }
}
