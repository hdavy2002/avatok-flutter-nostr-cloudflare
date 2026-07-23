import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';

import '../../core/analytics.dart';
import '../../core/ava_log.dart';
import '../../core/calls/call_session.dart';
import '../../core/db.dart';
import '../../core/receptionist_api.dart';
import '../../core/ui/avatok_dark.dart';
import '../../sync/outbox.dart';
import 'media.dart';
import 'voice_note_waveform.dart';

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

  /// [AVACALL-MENU-1] Redial the callee (audio). CallScreen pops this screen and
  /// re-launches the 1:1 call. null hides the option.
  final VoidCallback? onCallAgain;

  /// [AVACALL-MENU-1] Open the DM thread with the callee so the caller can send a
  /// message. CallScreen pops and pushes the chat thread. null hides the option.
  final VoidCallback? onMessage;

  /// [NOANSWER-LEAVE-NOTE-1] Save the callee as a contact. CallScreen wires this
  /// to ContactsStore and shows a confirmation. null hides the option.
  final VoidCallback? onSaveContact;

  const CallOutcomeMenu({
    super.key,
    required this.session,
    required this.name,
    required this.peerUid,
    required this.onClosed,
    this.onCallAgain,
    this.onMessage,
    this.onSaveContact,
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
  // [NOANSWER-LEAVE-NOTE-1] Live amplitude samples (0..1) feeding the animated
  // waveform — the SAME metering + mapping the Messenger recorder uses, so the
  // "leave a voice note" bar proves the mic is hearing the caller (a flat line
  // = a dead mic), rather than a static "Recording…" that could be lying.
  final List<double> _recLevels = [];
  StreamSubscription<Amplitude>? _recAmpSub;
  static const int _kRecMaxBars = 46;

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
    _recAmpSub?.cancel();
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
      _recAmpSub?.cancel();
      final path = await _recorder.stop();
      setState(() => _recording = false);
      if (path == null) return;
      widget.session.menuLogOption('voice_note');
      Analytics.uiInteraction('noanswer_note_voice_recorded',
          _recSecs * 1000, extra: {'peer_uid': widget.peerUid});
      setState(() => _sending = true);
      try {
        final bytes = await File(path).readAsBytes();
        final m = await MediaService.encryptAndUpload(bytes,
            kind: MediaKind.audio, contentType: 'audio/mp4', name: 'voice.m4a');
        await _sendPayload(jsonEncode(m.toEnvelope()));
        Analytics.uiInteraction('noanswer_note_voice_sent', 0,
            extra: {'peer_uid': widget.peerUid});
        _finishSent();
      } catch (e, st) {
        Analytics.captureException(e, st,
            screen: 'noanswer_voice_note_send');
        AvaLog.I.log('call', 'No-answer voice note send failed: $e');
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
    // Ask the platform for amplitude metering so the live waveform below has
    // real samples to draw (identical to the Messenger recorder).
    await _recorder.start(const RecordConfig(), path: _recPath!);
    _recSecs = 0;
    _recLevels.clear();
    _recAmpSub?.cancel();
    _recAmpSub = _recorder
        .onAmplitudeChanged(const Duration(milliseconds: 80))
        .listen((amp) {
      if (!mounted) return;
      // `current` is dBFS: roughly -60 (silence) → 0 (clipping). Map to 0..1 with
      // a floor so a quiet room shows a living baseline, not a flat dead line.
      final db = amp.current.isFinite ? amp.current : -60.0;
      final level = ((db + 60) / 60).clamp(0.05, 1.0);
      setState(() {
        _recLevels.add(level);
        if (_recLevels.length > _kRecMaxBars) _recLevels.removeAt(0);
      });
    });
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
      Analytics.uiInteraction('noanswer_note_text_sent', 0,
          extra: {'peer_uid': widget.peerUid});
      _finishSent();
    } catch (e, st) {
      Analytics.captureException(e, st, screen: 'noanswer_text_note_send');
      AvaLog.I.log('call', 'No-answer text note send failed: $e');
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
        child: AdCard(
          color: AD.popover,
          radius: AD.rDialog,
          boxShadow: const [],
          padding: const EdgeInsets.fromLTRB(20, 24, 20, 24),
          child: Text('Sent — $_first will see it',
              textAlign: TextAlign.center, style: ADText.appTitle()),
        ),
      );
    }
    final header = s.statusText;
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 380),
      child: AdCard(
        color: AD.popover,
        radius: AD.rDialog,
        boxShadow: const [],
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
                    ? ADText.appTitle(c: AD.missedCall)
                    : ADText.appTitle()),
            const SizedBox(height: 8),
            Text("Here's what you can do:",
                textAlign: TextAlign.center, style: ADText.preview()),
            const SizedBox(height: 18),

            // [AVACALL-MENU-1] Call again — redial the callee (audio). Top of the
            // menu because it's the most common follow-up to a declined/busy call.
            if (widget.onCallAgain != null) ...[
              AdButton(
                label: 'Call again',
                variant: AdButtonVariant.primary,
                fullWidth: true,
                fontSize: 16,
                onPressed: (_sending || _recording) ? null : widget.onCallAgain,
              ),
              const SizedBox(height: 10),
            ],

            // [AVACALL-MENU-1] Message — open the DM thread with the callee.
            if (widget.onMessage != null) ...[
              AdButton(
                label: 'Message',
                variant: AdButtonVariant.teal,
                fullWidth: true,
                fontSize: 16,
                onPressed: (_sending || _recording) ? null : widget.onMessage,
              ),
              const SizedBox(height: 10),
            ],

            // 1) Talk to Ava — audio calls only, and ONLY when the callee actually
            // has a receptionist available ([AVACALL-MENU-2] owner decision: hide,
            // don't show-and-break). A greyed "Talk to Ava" on a callee with no Ava
            // is a dead-end button, so the option is omitted entirely when
            // `_avaAvailable` is false. The daily-cap case (`_avaCapped`) is
            // different — Ava exists but the caller is out of free sessions today —
            // so that still renders as an honest, disabled "daily limit reached".
            if (!s.video && _avaAvailable) ...[
              AdButton(
                label: _avaCapped
                    ? 'Talk to Ava — daily limit reached'
                    : 'Talk to Ava',
                variant: AdButtonVariant.primary,
                fullWidth: true,
                fontSize: 16,
                onPressed: (_avaCapped || _sending || _recording)
                    ? null
                    : () {
                        // ignore: unawaited_futures
                        s.menuTalkToAva();
                      },
              ),
              const SizedBox(height: 10),
            ],

            // [RECEPT-SETTINGS-1] The classic recorded voicemail option was
            // removed with the voicemail feature. Callers leave a voice note or
            // text note below, or talk to Ava (the receptionist) above.

            // Voice note — records in place; tap again to stop & send. While
            // recording, a live animated waveform (the SAME one the Messenger
            // composer draws) appears BELOW the button so the caller can see the
            // mic is hearing them.
            AdButton(
              label: _recording
                  ? 'Recording ${_fmtRec(_recSecs)} — tap to send'
                  : 'Leave a voice note',
              variant: AdButtonVariant.teal,
              fullWidth: true,
              fontSize: 16,
              loading: _sending && !_textOpen,
              onPressed: _sending ? null : _toggleRecord,
            ),
            if (_recording) ...[
              const SizedBox(height: 10),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                decoration: BoxDecoration(
                  color: AD.card,
                  borderRadius: BorderRadius.circular(AD.rInput),
                  border: Border.all(color: AD.borderControl),
                ),
                child: Row(children: [
                  Container(
                    width: 9,
                    height: 9,
                    decoration: const BoxDecoration(
                        color: AD.danger, shape: BoxShape.circle),
                  ),
                  const SizedBox(width: 8),
                  SizedBox(
                    width: 40,
                    child: Text(_fmtRec(_recSecs),
                        style: ADText.bubbleMeta(c: AD.textSecondary)),
                  ),
                  Expanded(
                    child: SizedBox(
                      height: 28,
                      child: LiveWaveform(levels: _recLevels),
                    ),
                  ),
                ]),
              ),
            ],
            const SizedBox(height: 10),

            // 4) Text note — a box slides open underneath.
            AdButton(
              label: 'Leave a text note',
              variant: AdButtonVariant.teal,
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
                style: ADText.bubbleBody(),
                cursorColor: AD.iconSearch,
                decoration: InputDecoration(
                  hintText: 'Write a quick note for $_first…',
                  hintStyle: ADText.preview(c: AD.textTertiary),
                  filled: true,
                  fillColor: AD.card,
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(AD.rInput),
                    borderSide: BorderSide(color: AD.borderControl),
                  ),
                  enabledBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(AD.rInput),
                    borderSide: BorderSide(color: AD.borderControl),
                  ),
                  focusedBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(AD.rInput),
                    borderSide: BorderSide(color: AD.iconSearch),
                  ),
                  isDense: true,
                  contentPadding:
                      const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                ),
              ),
              const SizedBox(height: 8),
              AdButton(
                label: 'Send note',
                variant: AdButtonVariant.primary,
                fullWidth: true,
                fontSize: 15,
                loading: _sending && _textOpen,
                onPressed: _sending ? null : _sendText,
              ),
            ],
            const SizedBox(height: 10),

            // [NOANSWER-LEAVE-NOTE-1] Save contact — parity with the phone-style
            // no-answer card so the caller can save the callee without leaving.
            if (widget.onSaveContact != null) ...[
              AdButton(
                label: 'Save contact',
                variant: AdButtonVariant.ghost,
                fullWidth: true,
                fontSize: 16,
                onPressed: (_sending || _recording)
                    ? null
                    : () {
                        widget.session.menuLogOption('save_contact');
                        widget.onSaveContact!.call();
                      },
              ),
              const SizedBox(height: 10),
            ],

            // 4) See Listings — intentionally NOT rendered yet: gated behind
            // callMenuListingsEnabled (false until the marketplace goes public).

            AdButton(
              label: 'Close',
              variant: AdButtonVariant.ghost,
              fullWidth: true,
              fontSize: 16,
              onPressed: _sending
                  ? null
                  : () {
                      widget.session.menuLogOption('close');
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
