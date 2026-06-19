import 'dart:async';
import 'dart:io';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import 'package:file_picker/file_picker.dart';

import '../../core/ava_ai_client.dart';
import '../../core/ava_log.dart';
import '../../core/chat_history_service.dart';
import '../../core/drive_service.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../settings/sections/voice_section.dart';
import '../../core/paid_feature.dart';
import 'persona.dart';

/// CompanionThreadScreen (Phase 6 — Companion / Blank Ava Chat).
///
/// A FREE-FORM conversation with Ava herself (brainstorm / vent / language
/// practice / roleplay). This is a direct user↔Ava chat — NOT a multi-party
/// thread — so it does NOT post into an InboxDO. It drives turns through the
/// EXISTING moderated proxy [AvaAiClient.ask] (`POST /api/ava/gemini`, the P2
/// route), sending the chosen [AvaPersona.systemPrompt] as the `context` and the
/// running turn list as `history`. Every turn (every persona, incl. roleplay)
/// therefore passes through the server-side llama-guard gate.
///
/// (The OTHER posting path — `AvaTurnController.summon` / `postAvaMessage` →
/// `POST /api/ava/thread/turn` — exists for posting Ava INTO a real shared
/// conversation; it's the wrong tool for a private companion chat that has no
/// other participant. See the Phase 6 block in INTEGRATION-NOTES.md.)
///
/// The companion text chat is FREE. Only VOICE is premium (gated in
/// voice_section.dart); a "Listen" affordance appears on Ava's bubbles when the
/// voice toggle is on.
class CompanionThreadScreen extends StatefulWidget {
  final AvaPersona persona;
  const CompanionThreadScreen({super.key, required this.persona});

  @override
  State<CompanionThreadScreen> createState() => _CompanionThreadScreenState();
}

class _CompanionMsg {
  final String id;
  final String text;
  final bool me; // true = user, false = Ava
  final bool blocked; // Ava turn refused by the gate
  final String? reason; // gate reason, e.g. 'premium_required' | 'insufficient_coins'
  // Typewriter reveal: how many chars of [text] are currently shown. Ava replies
  // animate from 0 → text.length so the answer "types out" (feels instant /
  // streamed) even though it arrives whole — the output still passes the
  // server-side llama-guard gate first. Everything else shows fully right away.
  int reveal;
  _CompanionMsg(this.id, this.text, this.me, {this.blocked = false, this.reason, int? reveal})
      : reveal = reveal ?? text.length;
}

class _CompanionThreadScreenState extends State<CompanionThreadScreen> {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  final _audio = AudioPlayer();
  final List<_CompanionMsg> _msgs = [];
  bool _busy = false;
  String? _playingId;
  Timer? _revealTimer; // drives the typewriter reveal of Ava's latest reply
  // AvaChat history is saved locally + to D1 after each turn and on close.
  final String _sessionId = 'sess_${DateTime.now().millisecondsSinceEpoch}';

  @override
  void initState() {
    super.initState();
    AvaVoicePref.load();
    // Clear the "now playing" highlight when a clip finishes (subscribe once).
    _audio.onPlayerComplete.listen((_) {
      if (mounted && _playingId != null) setState(() => _playingId = null);
    });
    // Warm opener so the blank chat isn't empty.
    _msgs.add(_CompanionMsg('intro', _opener(widget.persona), false));
  }

  String _opener(AvaPersona p) {
    switch (p.id) {
      case 'brainstorm':
        return "Let's brainstorm. What are we cooking up — a name, a plan, a "
            'whole idea? Throw me the seed.';
      case 'language':
        return 'Ready to practise! Which language, and how confident are you? '
            "We'll just chat and I'll nudge corrections as we go.";
      case 'roleplay':
        return 'Scene-setting time. Tell me the setting and who you want me to '
            "be, and we'll build the story together.";
      default:
        return "Hey, it's Ava. What's on your mind? You can vent, ask, or just "
            'think out loud — I’m here.';
    }
  }

  @override
  void dispose() {
    _revealTimer?.cancel();
    _persist(); // save the session on close (local + D1)
    _input.dispose();
    _scroll.dispose();
    _audio.dispose();
    super.dispose();
  }

  /// Save this AvaChat session locally + to D1 (fire-and-forget).
  void _persist() {
    final msgs = <Map<String, String>>[];
    for (final m in _msgs) {
      if (m.id == 'intro') continue;
      msgs.add({'role': m.me ? 'user' : 'ava', 'text': m.text});
    }
    if (msgs.isEmpty) return;
    // ignore: unawaited_futures
    ChatHistoryService.I.save(_sessionId, widget.persona.id, msgs);
  }

  /// Attach a file from the device → save it into the user's AvaTOK Drive
  /// folder (own files go to Drive). Shows a confirmation bubble.
  Future<void> _attachToDrive() async {
    final res = await FilePicker.platform.pickFiles(withData: true);
    final f = res?.files.single;
    if (f == null || f.bytes == null) return;
    setState(() => _msgs.add(_CompanionMsg('f${DateTime.now().microsecondsSinceEpoch}', '📎 ${f.name} — saving to your AvaTOK Drive…', true)));
    _jumpToEnd();
    final ok = await DriveService.I.upload('Files', f.name, 'application/octet-stream', f.bytes!);
    if (!mounted) return;
    setState(() => _msgs.add(_CompanionMsg('a${DateTime.now().microsecondsSinceEpoch}',
        ok ? 'Saved "${f.name}" to your AvaTOK Drive folder ✓' : "I couldn't save that — is Google Drive connected? (AvaStorage → Connect)", false)));
    _jumpToEnd();
  }

  /// History the proxy expects: [{role:'user'|'model', text:...}], excluding the
  /// local intro line (it's not a real model turn) and the message in flight.
  List<Map<String, String>> _history() {
    final out = <Map<String, String>>[];
    for (final m in _msgs) {
      if (m.id == 'intro' || m.blocked) continue;
      out.add({'role': m.me ? 'user' : 'model', 'text': m.text});
    }
    return out;
  }

  Future<void> _send() async {
    final t = _input.text.trim();
    if (t.isEmpty || _busy) return;
    _input.clear();
    _completeReveal(); // snap any in-progress typewriter to full before a new turn
    setState(() {
      _msgs.add(_CompanionMsg('u${DateTime.now().microsecondsSinceEpoch}', t, true));
      _busy = true;
    });
    _jumpToEnd();
    // Build the history BEFORE this user turn (ask() takes prior turns + message).
    final priorHistory = _history()..removeLast();
    final ans = await AvaAiClient.I.ask(
      message: t,
      context: widget.persona.systemPrompt,
      history: priorHistory.isEmpty ? null : priorHistory,
    );
    if (!mounted) return;
    final answer = ans.answer.isEmpty
        ? "I couldn't reach my thoughts just now — try again?"
        : ans.answer;
    final avaMsg = _CompanionMsg(
      'a${DateTime.now().microsecondsSinceEpoch}',
      answer,
      false,
      blocked: ans.blocked,
      reason: ans.reason,
      // Stream the normal answers in; show refusals/notices immediately.
      reveal: ans.blocked ? answer.length : 0,
    );
    setState(() {
      _msgs.add(avaMsg);
      _busy = false;
    });
    _jumpToEnd();
    if (!ans.blocked) _streamIn(avaMsg);
    _persist(); // save history (local + D1) after each completed turn
  }

  /// Snap any partially-revealed message to its full text (and stop the timer),
  /// so an earlier reply is never left truncated when a new turn begins.
  void _completeReveal() {
    _revealTimer?.cancel();
    for (final m in _msgs) {
      if (m.reveal < m.text.length) m.reveal = m.text.length;
    }
  }

  /// Typewriter-reveal [m]'s text so the reply appears to stream in. Reveal speed
  /// scales with length so any answer finishes in ~1.2s. Cancelled on a new turn
  /// or dispose; the underlying text is already complete (and gate-checked).
  void _streamIn(_CompanionMsg m) {
    _revealTimer?.cancel();
    final int step = (m.text.length / 75).ceil().clamp(1, 24).toInt(); // chars per tick
    _revealTimer = Timer.periodic(const Duration(milliseconds: 16), (t) {
      if (!mounted || m.reveal >= m.text.length) {
        t.cancel();
        return;
      }
      setState(() => m.reveal = (m.reveal + step).clamp(0, m.text.length).toInt());
      if (_scroll.hasClients) _scroll.jumpTo(_scroll.position.maxScrollExtent);
    });
  }

  void _jumpToEnd() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(_scroll.position.maxScrollExtent,
            duration: const Duration(milliseconds: 200), curve: Curves.easeOut);
      }
    });
  }

  Future<void> _listen(_CompanionMsg m) async {
    // Voice is premium + on-demand. If synthesis isn't wired yet, say so kindly.
    if (_playingId == m.id) {
      await _audio.stop();
      if (mounted) setState(() => _playingId = null);
      return;
    }
    if (!AvaVoice.available) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('Ava’s voice is coming soon — synthesis isn’t wired '
                'on this build yet.')));
      }
      return;
    }
    try {
      final path = await AvaVoice.speak(m.text);
      if (path == null || !mounted) return;
      await _audio.stop();
      await _audio.play(DeviceFileSource(path));
      if (mounted) setState(() => _playingId = m.id);
    } catch (e) {
      AvaLog.I.log('ava', 'companion voice failed: $e');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text("Couldn't play Ava’s voice")));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Zine.paper,
      body: SafeArea(
        child: Column(children: [
          _header(),
          Expanded(
            child: ListView.builder(
              controller: _scroll,
              padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
              itemCount: _msgs.length + (_busy ? 1 : 0),
              itemBuilder: (context, i) {
                if (i >= _msgs.length) return _workingChip();
                return _bubble(_msgs[i]);
              },
            ),
          ),
          _composer(),
        ]),
      ),
    );
  }

  Widget _header() {
    return Container(
      padding: const EdgeInsets.fromLTRB(8, 8, 14, 12),
      decoration: const BoxDecoration(
        color: Zine.paper2,
        border: Border(bottom: BorderSide(color: Zine.ink, width: Zine.bw)),
      ),
      child: Row(children: [
        const ZineBackButton(),
        const SizedBox(width: 4),
        ZineIconBadge(
            icon: PhosphorIcons.sparkle(PhosphorIconsStyle.fill),
            color: Zine.lilac,
            size: 40),
        const SizedBox(width: 10),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Ava', style: ZineText.cardTitle(size: 18)),
            Text('${widget.persona.glyph} ${widget.persona.name}',
                style: ZineText.sub(size: 12)),
          ]),
        ),
      ]),
    );
  }

  Widget _workingChip() => Padding(
        padding: const EdgeInsets.only(top: 4, bottom: 4, right: 80),
        child: Align(
          alignment: Alignment.centerLeft,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: BoxDecoration(
              color: Zine.lilac.withValues(alpha: 0.35),
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: Zine.ink.withValues(alpha: 0.3), width: 2),
            ),
            child: Text('Ava is thinking…',
                style: ZineText.sub(size: 12.5)
                    .copyWith(fontStyle: FontStyle.italic)),
          ),
        ),
      );

  Widget _bubble(_CompanionMsg m) {
    final isAva = !m.me;
    final showListen = isAva && m.id != 'intro' && !m.blocked && AvaVoice.enabled;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Column(
        crossAxisAlignment:
            m.me ? CrossAxisAlignment.end : CrossAxisAlignment.start,
        children: [
          if (isAva)
            Padding(
              padding: const EdgeInsets.only(left: 4, bottom: 3),
              child: Text('AVA', style: ZineText.tag(size: 9.5, color: Zine.inkSoft)),
            ),
          Container(
            constraints: BoxConstraints(
                maxWidth: MediaQuery.of(context).size.width * 0.78),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            decoration: BoxDecoration(
              color: m.me ? Zine.lime : Zine.lilac,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: Zine.ink, width: 2),
              boxShadow: Zine.shadowXs,
            ),
            child: Text(
              m.reveal >= m.text.length ? m.text : m.text.substring(0, m.reveal),
              style: ZineText.value(size: 14.5, weight: FontWeight.w600),
            ),
          ),
          if (showListen)
            Padding(
              padding: const EdgeInsets.only(top: 4, left: 2),
              child: GestureDetector(
                onTap: () => _listen(m),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  PhosphorIcon(
                      _playingId == m.id
                          ? PhosphorIcons.stop(PhosphorIconsStyle.fill)
                          : PhosphorIcons.speakerHigh(PhosphorIconsStyle.bold),
                      size: 14,
                      color: Zine.blueInk),
                  const SizedBox(width: 5),
                  Text(_playingId == m.id ? 'Stop' : 'Listen',
                      style: ZineText.link(size: 12)),
                ]),
              ),
            ),
          // Premium upsell CTA — shown when a turn needs premium AI (attachments,
          // tools) or coins. Opens the top-up sheet ($10 unlocks everything).
          if (isAva && (m.reason == 'premium_required' || m.reason == 'insufficient_coins'))
            Padding(
              padding: const EdgeInsets.only(top: 6, left: 2),
              child: ZinePressable(
                onTap: () => AvaWalletHook.instance
                    .openTopUp(context, suggestedUsd: kMinTopUpUsd),
                color: Zine.mint,
                radius: BorderRadius.circular(12),
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  PhosphorIcon(PhosphorIcons.coins(PhosphorIconsStyle.fill),
                      size: 14, color: Zine.ink),
                  const SizedBox(width: 6),
                  Text('Top up to unlock',
                      style: ZineText.value(size: 13, weight: FontWeight.w600)),
                ]),
              ),
            ),
        ],
      ),
    );
  }

  Widget _composer() {
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 10),
      decoration: const BoxDecoration(
        color: Zine.paper2,
        border: Border(top: BorderSide(color: Zine.ink, width: Zine.bw)),
      ),
      child: Row(children: [
        // Attach a file → saves it to the user's AvaTOK Google Drive folder.
        IconButton(
          icon: PhosphorIcon(PhosphorIcons.paperclip(PhosphorIconsStyle.bold), color: Zine.ink, size: 24),
          onPressed: _busy ? null : _attachToDrive,
          tooltip: 'Save a file to your AvaTOK Drive',
        ),
        Expanded(
          child: Container(
            decoration: BoxDecoration(
              color: Zine.card,
              borderRadius: BorderRadius.circular(Zine.rField),
              border: Border.all(color: Zine.ink, width: 2),
            ),
            padding: const EdgeInsets.symmetric(horizontal: 14),
            child: TextField(
              controller: _input,
              minLines: 1,
              maxLines: 4,
              textInputAction: TextInputAction.send,
              onSubmitted: (_) => _send(),
              style: ZineText.input(size: 15),
              decoration: InputDecoration(
                border: InputBorder.none,
                isDense: true,
                contentPadding: const EdgeInsets.symmetric(vertical: 12),
                hintText: 'Message Ava…',
                hintStyle: ZineText.sub(size: 14, color: Zine.placeholder),
              ),
            ),
          ),
        ),
        const SizedBox(width: 8),
        ZinePressable(
          onTap: _busy ? null : _send,
          color: Zine.lime,
          radius: BorderRadius.circular(100),
          child: SizedBox(
            width: 48,
            height: 48,
            child: Center(
              child: PhosphorIcon(PhosphorIcons.paperPlaneRight(PhosphorIconsStyle.fill),
                  size: 20, color: Zine.ink),
            ),
          ),
        ),
      ]),
    );
  }
}
