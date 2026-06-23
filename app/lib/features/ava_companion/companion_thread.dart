import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import 'package:file_picker/file_picker.dart';

import '../../core/analytics.dart';
import '../../core/ava_ai_client.dart';
import '../../core/ava_local_mode.dart';
import '../../core/ava_log.dart';
import '../../core/ava_memory/ava_profile_memory.dart';
import '../../core/ava_memory/local_index.dart';
import '../../core/ava_ondevice_rag.dart';
import '../../core/ava_prompt_budget.dart';
import '../../core/ava_quality.dart';
import '../../core/library_api.dart';
import '../../core/rag_service.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../../core/ava_ondevice_stt.dart';
import '../settings/sections/voice_section.dart';
import '../../core/paid_feature.dart';
import 'companion_session_store.dart';
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

  /// Resume an existing session when provided; otherwise a fresh one is created.
  final String? sessionId;
  /// Transcript to seed when resuming — `[{role:'user'|'ava', text}]`.
  final List<Map<String, String>>? initialMessages;
  /// Existing (possibly user-renamed) title to preserve when resuming.
  final String? initialTitle;

  /// "Discuss this chat with Ava" grounding block — the on-device-assembled
  /// transcript of a Messenger conversation. When set, it is injected into the
  /// per-turn `context` so Ava can give an opinion on that chat and help draft
  /// replies. Never persisted server-side (DM/group content stays on-device).
  final String? discussContext;

  /// Discuss mode: when set, each Ava bubble offers "Use in chat" — tapping it
  /// hands Ava's drafted text back to the originating Messenger thread (which
  /// pre-fills its composer for the user to review) and closes this screen.
  final void Function(String text)? onUseDraft;

  const CompanionThreadScreen({
    super.key,
    required this.persona,
    this.sessionId,
    this.initialMessages,
    this.initialTitle,
    this.discussContext,
    this.onUseDraft,
  });

  @override
  State<CompanionThreadScreen> createState() => _CompanionThreadScreenState();
}

class _CompanionMsg {
  final String id;
  String text; // mutable so streamed deltas can append live
  final bool me; // true = user, false = Ava
  final bool blocked; // Ava turn refused by the gate
  final String? reason; // gate reason, e.g. 'premium_required' | 'insufficient_coins'
  // Typewriter reveal: how many chars of [text] are currently shown. Ava replies
  // animate from 0 → text.length so the answer "types out" (feels instant /
  // streamed) even though it arrives whole — the output still passes the
  // server-side llama-guard gate first. Everything else shows fully right away.
  int reveal;
  _CompanionMsg(this.id, this.text, this.me,
      {this.blocked = false, this.reason, int? reveal})
      : reveal = reveal ?? text.length;
}

class _CompanionThreadScreenState extends State<CompanionThreadScreen> {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  final _audio = AudioPlayer();
  final List<_CompanionMsg> _msgs = [];
  bool _busy = false;
  String? _playingId;
  // On-device dictation (Convert voice to text → message box).
  SttSession? _stt;
  bool _sttActive = false;
  String _lastAnswerSource = ''; // for attributing a follow-up correction
  Timer? _revealTimer; // drives the typewriter reveal of Ava's latest reply
  // AvaChat history is saved locally (per-account SQLite) + to D1 after each turn
  // and on close. A resumed session keeps its id; a new one gets a fresh id.
  late final String _sessionId =
      widget.sessionId ?? 'sess_${DateTime.now().millisecondsSinceEpoch}';
  // Auto-named title. Seeds from a resumed (possibly renamed) title; otherwise
  // derived from the first user message the first time the user sends one.
  String _title = '';

  @override
  void initState() {
    super.initState();
    AvaVoicePref.load();
    Analytics.screenViewed('avatok', 'avachat_thread');
    _title = (widget.initialTitle ?? '').trim();
    // Clear the "now playing" highlight when a clip finishes (subscribe once).
    _audio.onPlayerComplete.listen((_) {
      if (mounted && _playingId != null) setState(() => _playingId = null);
    });
    final seed = widget.initialMessages ?? const [];
    if (seed.isEmpty) {
      // Warm opener so the blank chat isn't empty.
      _msgs.add(_CompanionMsg('intro', _opener(widget.persona), false));
    } else {
      // Resume: rebuild the bubbles from the saved transcript (no intro line).
      for (var i = 0; i < seed.length; i++) {
        final role = (seed[i]['role'] ?? '').toString();
        _msgs.add(_CompanionMsg('h$i', (seed[i]['text'] ?? '').toString(), role == 'user'));
      }
      Analytics.capture('avachat_session_resumed',
          {'persona': widget.persona.id, 'turns': seed.length});
    }
  }

  String _opener(AvaPersona p) {
    switch (p.id) {
      case 'discuss':
        return "I've read through this chat. Ask me what I think, what they "
            'might mean, or have me help you draft a reply.';
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
    _stt?.cancel();
    _persist(); // save the session on close (local + D1)
    _input.dispose();
    _scroll.dispose();
    _audio.dispose();
    super.dispose();
  }

  /// Save this AvaChat session to the local SQLite store + D1 (fire-and-forget).
  /// The session is auto-named from the first user message the first time we have
  /// one (a user rename, carried in [initialTitle], is never overwritten).
  void _persist() {
    final msgs = <Map<String, String>>[];
    for (final m in _msgs) {
      if (m.id == 'intro') continue;
      msgs.add({'role': m.me ? 'user' : 'ava', 'text': m.text});
    }
    if (msgs.isEmpty) return;
    if (_title.isEmpty) {
      final firstUser = msgs.firstWhere((m) => m['role'] == 'user', orElse: () => const {});
      _title = _autoName(firstUser['text'] ?? '');
    }
    // ignore: unawaited_futures
    CompanionSessionStore.I.upsert(
      sessionId: _sessionId,
      persona: widget.persona.id,
      title: _title,
      messages: msgs,
    );
  }

  /// Build a short, friendly session name from the first user message.
  static String _autoName(String text) {
    var t = text.replaceAll(RegExp(r'\s+'), ' ').trim();
    if (t.isEmpty) return 'New chat';
    if (t.length <= 42) return t;
    // Cut on a word boundary near 42 chars so the name doesn't end mid-word.
    final cut = t.substring(0, 42);
    final sp = cut.lastIndexOf(' ');
    return '${(sp > 20 ? cut.substring(0, sp) : cut).trim()}…';
  }

  /// Attach a file from the device and INGEST it three ways so Ava can use it and
  /// the user can find it later:
  ///   1. AvaLibrary — the universal content-addressed pool (it shows up in
  ///      AvaLibrary; the server runs moderation + AvaBrain ingestion on upload).
  ///   2. RAG vector store — the user's own File Search store, so `@ava` can cite
  ///      it (no-op when AI isn't connected).
  ///   3. On-device FTS5 + vector index — so local search surfaces it offline.
  Future<void> _attachFile() async {
    final res = await FilePicker.platform.pickFiles(withData: true);
    final f = res?.files.single;
    if (f == null || f.bytes == null) return;
    final name = f.name;
    final bytes = f.bytes!;
    final mime = _mimeOf(name);
    setState(() => _msgs.add(_CompanionMsg(
        'f${DateTime.now().microsecondsSinceEpoch}', '📎 $name — saving & indexing for Ava…', true)));
    _jumpToEnd();
    Analytics.capture('avachat_file_attach_started', {'mime': mime, 'size': bytes.length});

    // 1) AvaLibrary (content-addressed pool → visible in AvaLibrary; server-side
    //    moderation + brain ingestion run on the upload).
    String? mediaId;
    try {
      mediaId = await LibraryApi.uploadFile(bytes: bytes, mime: mime, name: name, app: 'avachat');
    } catch (e) {
      Analytics.error(
          domain: 'media', code: 'avachat_library_upload_failed',
          message: e.toString(), screen: 'avachat_thread', action: 'attach_file');
    }
    // 2) RAG vector store (user's File Search store). 3) On-device index.
    // ignore: unawaited_futures
    RagService.I.ingestFileBytes(bytes, mime, name);
    // ignore: unawaited_futures
    AvaLocalIndex.I.indexMessage(
      messageId: 'avachat_file_${DateTime.now().microsecondsSinceEpoch}',
      convKey: 'avachat:$_sessionId',
      payload: jsonEncode({'t': 'text', 'body': 'File shared with Ava: $name'}),
      createdAt: DateTime.now().millisecondsSinceEpoch ~/ 1000,
    );

    if (!mounted) return;
    final ok = mediaId != null;
    setState(() => _msgs.add(_CompanionMsg(
        'a${DateTime.now().microsecondsSinceEpoch}',
        ok
            ? 'Saved “$name” to AvaLibrary and indexed it for Ava ✓ — ask me about it anytime.'
            : 'I indexed “$name” for our chat, but couldn’t save it to AvaLibrary (check your connection).',
        false)));
    _jumpToEnd();
    Analytics.capture('avachat_file_ingested', {'mime': mime, 'size': bytes.length, 'to_library': ok});
    _persist();
  }

  /// Best-effort MIME from a file name (the picker hands us a generic type).
  static String _mimeOf(String name) {
    final n = name.toLowerCase();
    if (n.endsWith('.pdf')) return 'application/pdf';
    if (n.endsWith('.png')) return 'image/png';
    if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
    if (n.endsWith('.gif')) return 'image/gif';
    if (n.endsWith('.webp')) return 'image/webp';
    if (n.endsWith('.txt') || n.endsWith('.md')) return 'text/plain';
    if (n.endsWith('.csv')) return 'text/csv';
    if (n.endsWith('.json')) return 'application/json';
    if (n.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (n.endsWith('.pptx')) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    if (n.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    if (n.endsWith('.mp4')) return 'video/mp4';
    if (n.endsWith('.mp3')) return 'audio/mpeg';
    return 'application/octet-stream';
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
    // Correction signal: prior turn was Ava (me == false) and this is pushback.
    final prevWasAva = _msgs.isNotEmpty && !_msgs.last.me;
    AvaQuality.maybeCorrection(
        surface: 'companion',
        prevWasAva: prevWasAva,
        text: t,
        answerSource: _lastAnswerSource.isEmpty ? null : _lastAnswerSource);
    setState(() {
      _msgs.add(_CompanionMsg('u${DateTime.now().microsecondsSinceEpoch}', t, true));
      _busy = true;
    });
    _jumpToEnd();
    final startedAt = DateTime.now();
    Analytics.capture('avachat_turn_sent', {'persona': widget.persona.id, 'len': t.length});
    // ignore: unawaited_futures
    AvaProfileMemory.I.observeUserMessage(t);

    // Build the history BEFORE this user turn (ask() takes prior turns + message).
    final priorHistory = _history()..removeLast();
    // Tell Ava who she's talking to so the companion feels personal.
    final about = await AvaProfileMemory.I.contextBlock();
    // Ground the companion in the user's OWN notes/messages (saved from ANY Ava
    // surface) so "what was my note for April" actually finds it. Searches the
    // on-device memory when Local Ava AI is on.
    var hitCount = 0;
    String notes = '';
    if (AvaLocalMode.I.isActive) {
      try {
        final hits = await AvaOnDeviceRag.I.search(t, limit: 4);
        hitCount = hits.length;
        if (hits.isNotEmpty) {
          notes = AvaPromptBudget.rag(
              "The user's own saved notes/messages that may be relevant (use them to answer; if they don't cover it, say you don't have it):\n${hits.map((h) => '• ${h.content}').join('\n')}");
        }
      } catch (_) {}
    }
    final ctxParts = <String>[widget.persona.systemPrompt];
    // "Discuss this chat" grounding rides right after the system prompt so the
    // conversation under review is the primary context for every turn.
    final discuss = widget.discussContext;
    if (discuss != null && discuss.isNotEmpty) ctxParts.add(discuss);
    if (about.isNotEmpty) ctxParts.add(about);
    if (notes.isNotEmpty) ctxParts.add(notes);
    final ctxStr = ctxParts.join('\n\n');
    _lastAnswerSource = notes.isNotEmpty ? 'hybrid' : (about.isEmpty ? 'llm' : 'hybrid');

    // STREAM FIRST — type the answer out token-by-token as it arrives (feels
    // instant). Fall back to a single ask() on any stream failure.
    final live = _CompanionMsg(
        'a${DateTime.now().microsecondsSinceEpoch}', '', false, reveal: 0);
    var streamed = false;
    try {
      await for (final delta in AvaAiClient.I.askStream(
        message: t,
        context: ctxStr,
        history: priorHistory.isEmpty ? null : priorHistory,
      )) {
        if (!mounted) return;
        if (!streamed) {
          streamed = true;
          setState(() { _msgs.add(live); _busy = false; });
        }
        setState(() { live.text += delta; live.reveal = live.text.length; });
        if (_scroll.hasClients) _scroll.jumpTo(_scroll.position.maxScrollExtent);
      }
    } catch (_) {
      streamed = false;
    }

    if (streamed && live.text.trim().isNotEmpty) {
      if (notes.isNotEmpty) {
        AvaQuality.roi(surface: 'companion', retrieved: hitCount, injected: notes, answer: live.text);
      }
      Analytics.capture('avachat_turn_replied', {
        'persona': widget.persona.id, 'streamed': true,
        'latency_ms': DateTime.now().difference(startedAt).inMilliseconds,
      });
      _ingestTurn('You', t);
      _ingestTurn('Ava', live.text);
      _persist();
      return;
    }
    // Fallback path: drop any empty streamed bubble, then one-shot ask().
    if (streamed) setState(() => _msgs.remove(live));
    final ans = await AvaAiClient.I.ask(
      message: t,
      context: ctxStr,
      history: priorHistory.isEmpty ? null : priorHistory,
    );
    if (notes.isNotEmpty) {
      AvaQuality.roi(surface: 'companion', retrieved: hitCount, injected: notes, answer: ans.answer);
    }
    if (!mounted) return;
    Analytics.capture('avachat_turn_replied', {
      'persona': widget.persona.id, 'blocked': ans.blocked, 'streamed': false,
      if (ans.reason != null) 'reason': ans.reason!,
      'latency_ms': DateTime.now().difference(startedAt).inMilliseconds,
    });
    final answer = ans.answer.isEmpty
        ? "I couldn't reach my thoughts just now — try again?"
        : ans.answer;
    final avaMsg = _CompanionMsg(
      'a${DateTime.now().microsecondsSinceEpoch}', answer, false,
      blocked: ans.blocked, reason: ans.reason,
      reveal: ans.blocked ? answer.length : 0,
    );
    setState(() { _msgs.add(avaMsg); _busy = false; });
    _jumpToEnd();
    if (!ans.blocked) _streamIn(avaMsg);
    _ingestTurn('You', t);
    if (!ans.blocked) _ingestTurn('Ava', answer);
    _persist();
  }

  /// Index one chat line into on-device memory (when Local Ava AI is loaded) and
  /// the user's cloud File Search store. Fire-and-forget; never blocks the chat.
  void _ingestTurn(String who, String text) {
    final line = text.trim();
    if (line.isEmpty) return;
    // On-device: keep only the user's substantive lines (store facts, not Ava's
    // chatter) — gated by worthEmbedding + the episodic cap in rememberMessage.
    if (AvaLocalMode.I.isActive && who == 'You') {
      // ignore: unawaited_futures
      AvaOnDeviceRag.I.rememberMessage(who, line, name: 'avachat');
    }
    // cloud File Search store (separate budget) keeps the full exchange.
    // ignore: unawaited_futures
    RagService.I.ingestText('$who: $line', name: 'avachat');
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
          // Discuss mode: copy Ava's drafted reply, or hand it back to the
          // Messenger thread (only when opened from a thread, i.e. onUseDraft set).
          if (isAva && m.id != 'intro' && !m.blocked && widget.discussContext != null)
            Padding(
              padding: const EdgeInsets.only(top: 5, left: 2),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                if (widget.onUseDraft != null) ...[
                  GestureDetector(
                    onTap: () => _useInChat(m),
                    child: Row(mainAxisSize: MainAxisSize.min, children: [
                      PhosphorIcon(PhosphorIcons.paperPlaneTilt(PhosphorIconsStyle.bold),
                          size: 14, color: Zine.blueInk),
                      const SizedBox(width: 5),
                      Text('Use in chat', style: ZineText.link(size: 12)),
                    ]),
                  ),
                  const SizedBox(width: 16),
                ],
                GestureDetector(
                  onTap: () => _copyDraft(m),
                  child: Row(mainAxisSize: MainAxisSize.min, children: [
                    PhosphorIcon(PhosphorIcons.copy(PhosphorIconsStyle.bold),
                        size: 14, color: Zine.blueInk),
                    const SizedBox(width: 5),
                    Text('Copy', style: ZineText.link(size: 12)),
                  ]),
                ),
              ]),
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

  /// Hand a drafted reply back to the Messenger thread (pre-fills its composer)
  /// and close this discussion screen. We never auto-send — the user reviews it.
  void _useInChat(_CompanionMsg m) {
    final text = m.text.trim();
    if (text.isEmpty) return;
    Analytics.capture('discuss_with_ava_draft_used', {'len': text.length});
    widget.onUseDraft?.call(text);
    Navigator.of(context).pop();
  }

  /// Copy a drafted reply to the clipboard.
  void _copyDraft(_CompanionMsg m) {
    final text = m.text.trim();
    if (text.isEmpty) return;
    Clipboard.setData(ClipboardData(text: text));
    Analytics.capture('discuss_with_ava_draft_copied', {'len': text.length});
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Copied — paste it into your chat.')));
  }

  // On-device dictation into the message box (private; the Whisper model
  // downloads on first use).
  Future<void> _startVoiceToText() async {
    if (_sttActive) return;
    final s = await AvaOnDeviceStt.I.startDictation(
      lang: 'en',
      onText: (t) {
        if (!mounted) return;
        setState(() {
          _input.text = t;
          _input.selection = TextSelection.collapsed(offset: t.length);
        });
      },
    );
    if (!mounted) return;
    if (s == null) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Couldn’t start voice-to-text.')));
      return;
    }
    setState(() { _stt = s; _sttActive = true; });
  }

  Future<void> _stopVoiceToText() async {
    final s = _stt;
    if (s == null) return;
    setState(() => _sttActive = false);
    final text = await s.stop();
    if (!mounted) return;
    setState(() {
      if (text.isNotEmpty) {
        _input.text = text;
        _input.selection = TextSelection.collapsed(offset: text.length);
      }
      _stt = null;
    });
  }

  Widget _composer() {
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 10),
      decoration: const BoxDecoration(
        color: Zine.paper2,
        border: Border(top: BorderSide(color: Zine.ink, width: Zine.bw)),
      ),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        // Top icon row — attach + mic sit above the field so the input itself
        // can run full-width and rectangular for more typing space.
        Row(children: [
          // Attach a file → saves it to the user's AvaTOK Google Drive folder.
          IconButton(
            padding: EdgeInsets.zero,
            constraints: const BoxConstraints(minWidth: 36, minHeight: 36),
            icon: PhosphorIcon(PhosphorIcons.paperclip(PhosphorIconsStyle.bold), color: Zine.ink, size: 24),
            onPressed: _busy ? null : _attachFile,
            tooltip: 'Attach a file (saved to AvaLibrary + indexed for Ava)',
          ),
          const SizedBox(width: 4),
          // Mic → voice call (online) or dictation (on-device). Tap again to stop
          // dictation.
          IconButton(
            padding: EdgeInsets.zero,
            constraints: const BoxConstraints(minWidth: 36, minHeight: 36),
            icon: PhosphorIcon(
                _sttActive
                    ? PhosphorIcons.stopCircle(PhosphorIconsStyle.fill)
                    : PhosphorIcons.microphone(PhosphorIconsStyle.fill),
                color: _sttActive ? Zine.coral : Zine.blueInk, size: 24),
            onPressed: _sttActive ? _stopVoiceToText : _startVoiceToText,
            tooltip: _sttActive ? 'Stop voice-to-text' : 'Voice call or dictate',
          ),
        ]),
        const SizedBox(height: 6),
        // Bottom row — full-width rectangular field + send button.
        Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
          Expanded(
            child: Container(
              decoration: BoxDecoration(
                color: Zine.card,
                borderRadius: BorderRadius.circular(2),
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
      ]),
    );
  }
}
