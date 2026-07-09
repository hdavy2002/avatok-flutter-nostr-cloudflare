import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';

import '../../core/calls/call_session.dart';
import '../../core/db.dart';
import '../../core/receptionist_api.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../../sync/outbox.dart';
import 'media.dart';

/// [CALL-OUTCOME-MENU-1] The unified caller-facing menu shown when a call ends
/// without a human answer (Specs/CALL-OUTCOME-MENU-SPEC-2026-07-09.md). ONE
/// surface for every scenario — declined / no-answer / unreachable / busy — so
/// the caller always gets the same choices:
///
///   • Talk to Ava      (audio calls only; greys out at the daily caller cap)
///   • Leave a voice note (records in place, sends into the DM thread)
///   • Leave a text note  (inline box slides open underneath)
///   • See Listings       (hidden until callMenuListingsEnabled — marketplace
///                         is not public yet, owner 2026-07-09)
///
/// The honest status header ("{name} isn't answering" / red busy banner) comes
/// from [CallSession.statusText]; scenario in [CallSession.menuScenario].
/// Rendered by CallScreen when `session.showOutcomeMenu`; only constructed when
/// RemoteConfig.callMenuEnabled is on, so legacy UX is untouched while dark.
class CallOutcomeMenu extends StatefulWidget {
  final CallSession session;

  /// Callee display name (call config title).
  final String name;

  /// Callee uid (call config seed) — the notes' recipient.
  final String peerUid;

  /// Pop the call screen (used after a note is sent / menu closed).
  final VoidCallback onClosed;

  const CallOutcomeMenu({
    super.key,
    required this.session,
    required this.name,
    required this.peerUid,
    required this.onClosed,
  });

  @override
  State<CallOutcomeMenu> createState() => _CallOutcomeMenuState();
}

class _CallOutcomeMenuState extends State<CallOutcomeMenu> {
  // Ava availability + the caller's remaining daily sessions for THIS owner
  // (server-driven: GET /api/receptionist/config → caller_sessions_left; null
  // means the cap isn't active).
  bool _avaAvailable = true;
  int? _avaLeft;

  // Voice note state.
  final AudioRecorder _recorder = AudioRecorder();
  bool _recording = false;
  String? _recPath;
  Timer? _recTimer;
  int _recSecs = 0;

  // Text note state.
  bool _textOpen = false;
  final TextEditingController _textCtrl = TextEditingController();

  bool _sending = false;
  bool _sent = false;

  String get _first {
    final t = widget.name.trim();
    return t.isEmpty ? 'them' : t.split(RegExp(r'\s+')).first;
  }

  bool get _isBusy => widget.session.menuScenario == 'busy';
  bool get _avaCapped => _avaLeft != null && _avaLeft! <= 0;

  @override
  void initState() {
    super.initState();
    _probeAva();
  }

  Future<void> _probeAva() async {
    final cfg = await ReceptionistApi.configFor(widget.peerUid);
    if (!mounted) return;
    setState(() {
      _avaAvailable = cfg?['available'] == true;
      final left = cfg?['caller_sessions_left'];
      _avaLeft = left is num ? left.toInt() : null;
    });
  }

  @override
  void dispose() {
    _recTimer?.cancel();
    _recorder.dispose();
    _textCtrl.dispose();
    super.dispose();
  }

  // ── Notes: shared send path (same envelope + durable outbox the chat uses,
  //    so the note lands in the normal DM thread on both sides and the
  //    stranger accept/decline/block gate applies unchanged server-side). ──────
  String _newClientId() =>
      'cm${DateTime.now().microsecondsSinceEpoch}${Random().nextInt(0xFFFFF)}';

  Future<void> _sendPayload(String payload) async {
    final clientId = _newClientId();
    final convKey = '1:${widget.peerUid}';
    try {
      await Db.I.upsertMessage(MessagesCompanion.insert(
          rumorId: clientId,
          convKey: convKey,
          mine: true,
          payload: payload,
          createdAt: DateTime.now().millisecondsSinceEpoch ~/ 1000));
    } catch (_) {}
    await Outbox.I.enqueue(
        clientId: clientId,
        to: widget.peerUid,
        payload: payload,
        convKey: convKey,
        kind: 'text');
  }

  void _finishSent() {
    if (!mounted) return;
    setState(() { _sending = false; _sent = true; });
    // Brief confirmation, then close the session + screen.
    Timer(const Duration(milliseconds: 1400), () {
      widget.session.menuDismiss(reason: 'note-sent');
      widget.onClosed();
    });
  }

  // ── Voice note ──────────────────────────────────────────────────────────────
  Future<void> _toggleRecord() async {
    if (_recording) {
      _recTimer?.cancel();
      final path = await _recorder.stop();
      setState(() => _recording = false);
      if (path == null) return;
      widget.session.menuLogOption('voice_note');
      setState(() => _sending = true);
      try {
        final bytes = await File(path).readAsBytes();
        final m = await MediaService.encryptAndUpload(bytes,
            kind: MediaKind.audio, contentType: 'audio/mp4', name: 'voice.m4a');
        await _sendPayload(jsonEncode(m.toEnvelope()));
        _finishSent();
      } catch (_) {
        if (mounted) {
          setState(() => _sending = false);
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
              content: Text("Couldn't send the voice note — try again")));
        }
      }
      return;
    }
    if (!await _recorder.hasPermission()) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('Microphone permission needed for voice notes')));
      }
      return;
    }
    final dir = await getTemporaryDirectory();
    _recPath = '${dir.path}/cm_vn_${DateTime.now().millisecondsSinceEpoch}.m4a';
    await _recorder.start(const RecordConfig(), path: _recPath!);
    _recSecs = 0;
    _recTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() => _recSecs++);
    });
    setState(() { _recording = true; _textOpen = false; });
  }

  // ── Text note ───────────────────────────────────────────────────────────────
  Future<void> _sendText() async {
    final text = _textCtrl.text.trim();
    if (text.isEmpty || _sending) return;
    widget.session.menuLogOption('text_note');
    setState(() => _sending = true);
    try {
      await _sendPayload(jsonEncode({'t': 'text', 'body': text}));
      _finishSent();
    } catch (_) {
      if (mounted) setState(() => _sending = false);
    }
  }

  String _fmtRec(int s) =>
      '${(s ~/ 60).toString().padLeft(1, '0')}:${(s % 60).toString().padLeft(2, '0')}';

  @override
  Widget build(BuildContext context) {
    final s = widget.session;
    if (_sent) {
      return ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 380),
        child: ZineCard(
          padding: const EdgeInsets.fromLTRB(20, 24, 20, 24),
          child: Text('Sent — $_first will see it',
              textAlign: TextAlign.center, style: ZineText.hero(size: 20)),
        ),
      );
    }
    final header = s.statusText;
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 380),
      child: ZineCard(
        padding: const EdgeInsets.fromLTRB(20, 22, 20, 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Honest status header — RED for busy (owner 2026-07-09), so the
            // caller knows exactly why they landed here before choosing.
            Text(header,
                textAlign: TextAlign.center,
                style: _isBusy
                    ? ZineText.hero(size: 21).copyWith(color: const Color(0xFFD32F2F))
                    : ZineText.hero(size: 21)),
            const SizedBox(height: 8),
            Text("Here's what you can do:",
                textAlign: TextAlign.center, style: ZineText.sub(size: 14.5)),
            const SizedBox(height: 18),

            // 1) Talk to Ava — audio calls only; greyed at the daily cap.
            if (!s.video) ...[
              ZineButton(
                label: _avaCapped
                    ? 'Talk to Ava — daily limit reached'
                    : 'Talk to Ava',
                variant: ZineButtonVariant.lime,
                fullWidth: true,
                fontSize: 16,
                onPressed: (!_avaAvailable || _avaCapped || _sending || _recording)
                    ? null
                    : () {
                        // ignore: unawaited_futures
                        s.menuTalkToAva();
                      },
              ),
              const SizedBox(height: 10),
            ],

            // 2) Voice note — records in place; tap again to stop & send.
            ZineButton(
              label: _recording
                  ? 'Recording ${_fmtRec(_recSecs)} — tap to send'
                  : 'Leave a voice note',
              variant: ZineButtonVariant.blue,
              fullWidth: true,
              fontSize: 16,
              loading: _sending && !_textOpen,
              onPressed: _sending ? null : _toggleRecord,
            ),
            const SizedBox(height: 10),

            // 3) Text note — a box slides open underneath.
            ZineButton(
              label: 'Leave a text note',
              variant: ZineButtonVariant.blue,
              fullWidth: true,
              fontSize: 16,
              onPressed: (_sending || _recording)
                  ? null
                  : () => setState(() => _textOpen = !_textOpen),
            ),
            if (_textOpen) ...[
              const SizedBox(height: 10),
              TextField(
                controller: _textCtrl,
                autofocus: true,
                minLines: 1,
                maxLines: 4,
                textInputAction: TextInputAction.send,
                onSubmitted: (_) => _sendText(),
                decoration: InputDecoration(
                  hintText: 'Write a quick note for $_first…',
                  border: const OutlineInputBorder(),
                  isDense: true,
                  contentPadding:
                      const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                ),
              ),
              const SizedBox(height: 8),
              ZineButton(
                label: 'Send note',
                variant: ZineButtonVariant.lime,
                fullWidth: true,
                fontSize: 15,
                loading: _sending && _textOpen,
                onPressed: _sending ? null : _sendText,
              ),
            ],
            const SizedBox(height: 10),

            // 4) See Listings — intentionally NOT rendered yet: gated behind
            // callMenuListingsEnabled (false until the marketplace goes public).

            ZineButton(
              label: 'Close',
              variant: ZineButtonVariant.ghost,
              fullWidth: true,
              fontSize: 16,
              onPressed: _sending
                  ? null
                  : () {
                      widget.session.menuDismiss();
                      widget.onClosed();
                    },
            ),
          ],
        ),
      ),
    );
  }
}
