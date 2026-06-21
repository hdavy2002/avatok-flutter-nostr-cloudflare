import 'dart:convert';
import 'dart:io';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:record/record.dart';

import '../../core/apps_service.dart';
import '../../core/ava_local_mode.dart';
import '../../core/ava_memory/ava_profile_memory.dart';
import '../../core/ava_ondevice_rag.dart';
import '../../core/ava_ondevice_stt.dart';
import '../../core/ava_planner.dart';
import '../../core/ava_quality.dart';
import '../../core/brain_api.dart';
import '../../core/config.dart';
import '../../core/kokoro_voice.dart';
import '../../core/ui/mic_input_sheet.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../avabrain/brain_settings_screen.dart';

/// AvaChat (Phase 9) — a ChatGPT-style conversation with the user's OWN
/// AvaBrain: their messages, files, images and voice notes. Answers come from
/// `/api/brain/chat` (RAG over uid-scoped Vectorize + the knowledge graph) and
/// carry tappable SOURCE CARDS (open the thread / file, play the voicemail).
/// History is server-side (the user's InboxDO, conv 'brain') so it follows the
/// account across devices — nothing here needs extra per-account scoping.
class AvaChatScreen extends StatefulWidget {
  const AvaChatScreen({super.key});
  @override
  State<AvaChatScreen> createState() => _AvaChatScreenState();
}

class _ChatMsg {
  final bool mine;
  final String text;
  final List<Map<String, dynamic>> sources;
  const _ChatMsg(this.mine, this.text, {this.sources = const []});
}

class _AvaChatScreenState extends State<AvaChatScreen> {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  final _audio = AudioPlayer();
  final _recorder = AudioRecorder();
  final List<_ChatMsg> _msgs = [];
  bool _thinking = false;
  bool _loadingHistory = true;
  String? _playingRef;
  // Voice input (on-device Whisper): live dictation + record-then-transcribe.
  SttSession? _stt;
  bool _sttActive = false;
  bool _recording = false;
  bool _transcribing = false;
  String? _recPath;
  // Source of the last Ava answer (memory|rag|tool|llm|hybrid) so a correction
  // right after can be attributed — corrections of memory-backed answers matter.
  String _lastAnswerSource = '';

  static const _suggestions = <String>[
    'Find my voicemail about…',
    'What did … send me last week?',
    'Summarise my latest group chat',
    'Which files did I get recently?',
  ];

  @override
  void initState() {
    super.initState();
    _loadHistory();
    _audio.onPlayerComplete.listen((_) { if (mounted) setState(() => _playingRef = null); });
  }

  @override
  void dispose() {
    _input.dispose();
    _scroll.dispose();
    _audio.dispose();
    _stt?.cancel();
    _recorder.dispose();
    super.dispose();
  }

  // ---- mic menu: record audio OR convert voice to text ----
  void _openMicMenu() {
    FocusScope.of(context).unfocus();
    showMicInputSheet(
      context,
      recordSubtitle: 'Record, then drop the words in the box',
      onRecordAudio: _recordToText,
      onVoiceToText: _startVoiceToText,
    );
  }

  // Live on-device dictation — fills the input box as the user speaks.
  Future<void> _startVoiceToText() async {
    if (_sttActive) return;
    final lang = KokoroVoicePref.current.sttLang;
    final s = await AvaOnDeviceStt.I.startDictation(
      lang: lang,
      onText: (t) {
        if (!mounted) return;
        setState(() {
          _input.text = t;
          _input.selection = TextSelection.collapsed(offset: t.length);
        });
      },
    );
    if (s == null) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Voice-to-text needs microphone access')));
      }
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

  // Record a clip, then transcribe once and drop the text into the box. (AvaChat
  // is a text brain, so "record audio" becomes text the user can review + send.)
  Future<void> _recordToText() async {
    if (_recording) {
      setState(() { _recording = false; _transcribing = true; });
      String path = '';
      try { path = await _recorder.stop() ?? ''; } catch (_) {}
      if (path.isEmpty) { if (mounted) setState(() => _transcribing = false); return; }
      final lang = KokoroVoicePref.current.sttLang;
      final text = await AvaOnDeviceStt.I.transcribeFile(path, lang);
      try { await File(path).delete(); } catch (_) {}
      if (!mounted) return;
      setState(() {
        _transcribing = false;
        if (text.isNotEmpty) {
          final joined = _input.text.isEmpty ? text : '${_input.text} $text';
          _input.text = joined;
          _input.selection = TextSelection.collapsed(offset: joined.length);
        }
      });
      return;
    }
    if (!await _recorder.hasPermission()) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Microphone permission needed')));
      }
      return;
    }
    final dir = await getTemporaryDirectory();
    _recPath = '${dir.path}/avachat_rec_${DateTime.now().millisecondsSinceEpoch}.wav';
    await _recorder.start(
      const RecordConfig(encoder: AudioEncoder.wav, sampleRate: 16000, numChannels: 1),
      path: _recPath!,
    );
    setState(() => _recording = true);
  }

  Future<void> _loadHistory() async {
    try {
      final rows = await BrainApi.history();
      final out = <_ChatMsg>[];
      for (final m in rows) {
        final kind = (m['kind'] ?? 'text').toString();
        final body = (m['body'] ?? '').toString();
        if (kind == 'brain') {
          // body = {"text": ..., "sources": [...]}
          try {
            final j = jsonDecode(body) as Map<String, dynamic>;
            out.add(_ChatMsg(false, (j['text'] ?? '').toString(),
                sources: ((j['sources'] as List?) ?? const [])
                    .map((e) => (e as Map).cast<String, dynamic>())
                    .toList()));
          } catch (_) {
            out.add(_ChatMsg(false, body));
          }
        } else {
          out.add(_ChatMsg((m['sender'] ?? '') != 'brain', body));
        }
      }
      if (mounted) setState(() { _msgs.addAll(out); _loadingHistory = false; });
      _jump();
    } catch (_) {
      if (mounted) setState(() => _loadingHistory = false);
    }
  }

  void _jump() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) _scroll.jumpTo(_scroll.position.maxScrollExtent);
    });
  }

  Future<void> _send([String? preset]) async {
    final text = (preset ?? _input.text).trim();
    if (text.isEmpty || _thinking) return;
    _input.clear();
    // If the prior turn was Ava and this looks like a correction, log it —
    // corrections-per-100-messages is a top quality signal.
    final prevWasAva = _msgs.isNotEmpty && !_msgs.last.mine;
    AvaQuality.maybeCorrection(
        surface: 'avachat',
        prevWasAva: prevWasAva,
        text: text,
        answerSource: _lastAnswerSource.isEmpty ? null : _lastAnswerSource);
    setState(() { _msgs.add(_ChatMsg(true, text)); _thinking = true; });
    _jump();

    // Update Ava's on-device intuition about the user (topics, hours, length,
    // style cues). Cheap counting, runs in any mode so memory builds up even
    // before Local Ava AI is switched on.
    // ignore: unawaited_futures
    AvaProfileMemory.I.observeUserMessage(text);

    // Local Ava AI active → answer on-device (works offline). Otherwise the
    // cloud brain handles it exactly as before.
    if (AvaLocalMode.I.isActive) {
      // Remember this turn (only if substantive) so future on-device finds can
      // recall it — greetings/acks are skipped to keep the index small.
      // ignore: unawaited_futures
      AvaOnDeviceRag.I.rememberMessage('You', text, name: 'avachat');
      try {
        await _handleLocal(text);
        return;
      } catch (_) {/* fall through to cloud */}
    }
    await _handleCloud(text);
  }

  /// On-device path: route → APPS (Composio, with confirm) / LOCAL (retrieval-
  /// first from the on-device store) / CLOUD (escalate). Retrieval-first keeps
  /// "find" fast — we return the matching snippets, not a long generation.
  Future<void> _handleLocal(String text) async {
    // Intent is decided by the deterministic planner for the obvious offline
    // cases, and by the SMART CLOUD model for everything else — never by the
    // 350M (it's unreliable at classification). A clear app action runs the
    // tool; a clear memory lookup is answered on-device; anything else goes to
    // the cloud brain, which understands messy phrasing.
    final plan = AvaPlanner.plan(text);
    final isApps = plan != null &&
        plan.scope == PlanScope.apps &&
        plan.confidence >= AvaPlanner.kExecuteThreshold;
    if (!mounted) return;
    if (isApps) {
      final ok = await _confirmAction(text);
      if (!mounted) return;
      if (!ok) { _addAva('Okay, cancelled.'); return; }
      final tsw = Stopwatch()..start();
      final res = await AppsService.I.run(text);
      final lower = res.toLowerCase();
      final succeeded = res.isNotEmpty &&
          !lower.startsWith('top up') &&
          !lower.contains('something went wrong');
      AvaQuality.tool(
        tool: AvaQuality.toolGuess(text),
        succeeded: succeeded,
        ms: tsw.elapsedMilliseconds,
        reason: succeeded
            ? 'ok'
            : (lower.contains('top up') ? 'premium_required' : 'error'),
      );
      AvaQuality.answer(
        surface: 'avachat',
        source: 'tool',
        grounded: succeeded,
        sourcesFound: succeeded ? 1 : 0,
        ok: succeeded,
        userText: text,
      );
      _lastAnswerSource = 'tool';
      _addAva(res);
      return;
    }
    // Everything else → the smart cloud brain (it retrieves the user's data
    // server-side AND generates). No on-device generation anymore.
    await _handleCloud(text);
  }

  Future<void> _handleCloud(String text) async {
    try {
      final reply = await BrainApi.chat(text);
      if (!mounted) return;
      AvaQuality.answer(
        surface: 'avachat',
        source: 'llm',
        grounded: reply.sources.isNotEmpty,
        citations: reply.sources.length,
        sourcesFound: reply.sources.length,
        userText: text,
      );
      _lastAnswerSource = 'llm';
      setState(() {
        _msgs.add(_ChatMsg(false, reply.answer.isEmpty ? "I couldn't find anything for that." : reply.answer, sources: reply.sources));
        _thinking = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _msgs.add(const _ChatMsg(false, "I couldn't reach your AvaBrain just now — please try again."));
        _thinking = false;
      });
    }
    _jump();
  }

  void _addAva(String text, {List<Map<String, dynamic>> sources = const []}) {
    if (!mounted) return;
    setState(() {
      _msgs.add(_ChatMsg(false, text, sources: sources));
      _thinking = false;
    });
    _jump();
  }

  Future<bool> _confirmAction(String text) async {
    return await showDialog<bool>(
          context: context,
          builder: (ctx) => AlertDialog(
            title: const Text('Run this in your apps?'),
            content: Text(
                'Ava will do this via your connected apps (online):\n\n“$text”'),
            actions: [
              TextButton(
                  onPressed: () => Navigator.pop(ctx, false),
                  child: const Text('Cancel')),
              FilledButton(
                  onPressed: () => Navigator.pop(ctx, true),
                  child: const Text('Run')),
            ],
          ),
        ) ??
        false;
  }

  Future<void> _tapSource(Map<String, dynamic> s) async {
    final kind = (s['kind'] ?? '').toString();
    if (kind == 'voicemail') {
      final ref = (s['media_ref'] ?? s['ref'] ?? '').toString();
      if (ref.isEmpty) return;
      if (_playingRef == ref) {
        await _audio.stop();
        setState(() => _playingRef = null);
        return;
      }
      try {
        await _audio.stop();
        await _audio.play(UrlSource('$kBlossomBaseUrl/$ref'));
        setState(() => _playingRef = ref);
      } catch (_) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
              const SnackBar(content: Text("Couldn't play this voice note")));
        }
      }
      return;
    }
    // Messages / files: deep-link targets live in other apps; show the snippet
    // context for now (thread/file deep links ride on AvaInbox / AvaLibrary).
    final where = kind == 'file' ? 'AvaLibrary' : 'AvaTok';
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Open in $where: ${(s['name'] ?? s['ref'] ?? '').toString()}')));
    }
  }

  void _newConversation() {
    setState(() => _msgs.clear());
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Zine.paper,
      body: SafeArea(
        bottom: false,
        child: Column(children: [
          _header(),
          Expanded(
            child: _loadingHistory
                ? const Center(child: CircularProgressIndicator(color: Zine.blueInk))
                : _msgs.isEmpty
                    ? _empty()
                    : ListView.builder(
                        controller: _scroll,
                        padding: const EdgeInsets.fromLTRB(16, 14, 16, 8),
                        itemCount: _msgs.length + (_thinking ? 1 : 0),
                        itemBuilder: (_, i) => i == _msgs.length ? _typing() : _bubble(_msgs[i]),
                      ),
          ),
          if (_msgs.isEmpty && !_loadingHistory) _chips(),
          _inputBar(),
        ]),
      ),
    );
  }

  // Header band (§8): paper-2 fill, ink bottom border, lilac AI badge +
  // Nunito wordmark + mono tag. Keeps new-conversation + settings actions.
  Widget _header() => Container(
        decoration: const BoxDecoration(
          color: Zine.paper2,
          border: Border(bottom: BorderSide(color: Zine.ink, width: Zine.bw)),
        ),
        padding: const EdgeInsets.fromLTRB(14, 10, 14, 12),
        child: Row(children: [
          const ZineBackButton(),
          const SizedBox(width: 12),
          ZineIconBadge(icon: PhosphorIcons.sparkle(PhosphorIconsStyle.fill), color: Zine.lilac, size: 38),
          const SizedBox(width: 11),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
              const ZineMarkTitle(pre: 'Ava', mark: 'Chat', fontSize: 23, markColor: Zine.lilac, textAlign: TextAlign.left),
              const SizedBox(height: 1),
              Text('your personal ai'.toUpperCase(), style: ZineText.kicker(size: 10)),
            ]),
          ),
          ZineBackButton(
            icon: PhosphorIcons.notePencil(PhosphorIconsStyle.bold),
            onTap: _newConversation,
          ),
          const SizedBox(width: 9),
          ZineBackButton(
            icon: PhosphorIcons.brain(PhosphorIconsStyle.bold),
            onTap: () => Navigator.of(context).push(
                MaterialPageRoute(builder: (_) => const BrainSettingsScreen())),
          ),
        ]),
      );

  Widget _empty() => Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Container(
            width: 84, height: 84,
            decoration: const BoxDecoration(
              color: Zine.lilac,
              shape: BoxShape.circle,
              border: Border.fromBorderSide(BorderSide(color: Zine.ink, width: Zine.bwLg)),
              boxShadow: Zine.shadow,
            ),
            child: Center(
              child: PhosphorIcon(PhosphorIcons.sparkle(PhosphorIconsStyle.fill), color: Zine.ink, size: 36),
            ),
          ),
          const SizedBox(height: 18),
          Text('Ask your AvaBrain anything', style: ZineText.cardTitle(size: 21), textAlign: TextAlign.center),
          const SizedBox(height: 8),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 48),
            child: Text(
              'It knows your own messages, files, images and voice notes — and only answers you.',
              textAlign: TextAlign.center, style: ZineText.sub(size: 13.5),
            ),
          ),
        ]),
      );

  Widget _chips() => SizedBox(
        height: 46,
        child: ListView(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
          children: [
            for (final s in _suggestions)
              Padding(
                padding: const EdgeInsets.only(right: 8),
                child: ZineSticker(
                  s,
                  icon: PhosphorIcons.sparkle(PhosphorIconsStyle.bold),
                  onTap: () { _input.text = s.endsWith('…') ? s.substring(0, s.length - 1) : s; },
                ),
              ),
          ],
        ),
      );

  // Chat bubbles (§7.14): 2.5px ink border, radius 16 with one squared corner
  // toward the sender; me = lime, AI = lilac, Nunito 700 13.5.
  Widget _bubble(_ChatMsg m) {
    final bubble = Container(
      margin: const EdgeInsets.symmetric(vertical: 5),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * .82),
      decoration: BoxDecoration(
        color: m.mine ? Zine.lime : Zine.lilac,
        border: Zine.border,
        boxShadow: Zine.shadowXs,
        borderRadius: BorderRadius.only(
          topLeft: const Radius.circular(16), topRight: const Radius.circular(16),
          bottomLeft: Radius.circular(m.mine ? 16 : 4), bottomRight: Radius.circular(m.mine ? 4 : 16),
        ),
      ),
      child: Text(m.text,
          style: const TextStyle(
              fontFamily: ZineText.body, fontWeight: FontWeight.w700,
              fontSize: 13.5, height: 1.4, color: Zine.ink)),
    );
    return Column(
      crossAxisAlignment: m.mine ? CrossAxisAlignment.end : CrossAxisAlignment.start,
      children: [
        Align(alignment: m.mine ? Alignment.centerRight : Alignment.centerLeft, child: bubble),
        if (m.sources.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 2, bottom: 6),
            child: Wrap(spacing: 7, runSpacing: 7, children: [for (final s in m.sources) _sourceCard(s)]),
          ),
      ],
    );
  }

  Widget _sourceCard(Map<String, dynamic> s) {
    final kind = (s['kind'] ?? '').toString();
    final playing = kind == 'voicemail' && _playingRef == (s['media_ref'] ?? s['ref'] ?? '').toString();
    final (icon, label) = switch (kind) {
      'voicemail' => (
          playing ? PhosphorIcons.stopCircle(PhosphorIconsStyle.fill) : PhosphorIcons.playCircle(PhosphorIconsStyle.fill),
          (s['name'] ?? 'Voice note').toString()),
      'file' => (PhosphorIcons.file(PhosphorIconsStyle.bold), (s['name'] ?? 'File').toString()),
      _ => (PhosphorIcons.chatCircle(PhosphorIconsStyle.bold), (s['name'] ?? 'Message').toString()),
    };
    final snippet = (s['snippet'] ?? '').toString();
    return ZinePressable(
      onTap: () => _tapSource(s),
      radius: BorderRadius.circular(14),
      boxShadow: Zine.shadowXs,
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      child: Container(
        constraints: const BoxConstraints(maxWidth: 250),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          ZineIconBadge(icon: icon, color: Zine.lilac, size: 28),
          const SizedBox(width: 8),
          Flexible(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
              Text(label, maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: ZineText.value(size: 12.5)),
              if (snippet.isNotEmpty)
                Text(snippet, maxLines: 2, overflow: TextOverflow.ellipsis,
                    style: ZineText.sub(size: 11.5)),
            ]),
          ),
        ]),
      ),
    );
  }

  Widget _typing() => Align(
        alignment: Alignment.centerLeft,
        child: Container(
          margin: const EdgeInsets.symmetric(vertical: 6),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
          decoration: BoxDecoration(
            color: Zine.lilac,
            border: Zine.border,
            boxShadow: Zine.shadowXs,
            borderRadius: const BorderRadius.only(
              topLeft: Radius.circular(16), topRight: Radius.circular(16),
              bottomLeft: Radius.circular(4), bottomRight: Radius.circular(16),
            ),
          ),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            const SizedBox(
              width: 13, height: 13,
              child: CircularProgressIndicator(strokeWidth: 2.4, color: Zine.ink),
            ),
            const SizedBox(width: 8),
            Text('THINKING…', style: ZineText.tag(size: 10.5)),
          ]),
        ),
      );

  // Input bar: paper-2 band with top ink border, ink-bordered pill field and
  // the lime send circle (the ONE lime primary on this screen).
  Widget _inputBar() {
    final voiceBusy = _sttActive || _recording || _transcribing;
    final hint = _sttActive
        ? 'Listening…'
        : _recording
            ? 'Recording…'
            : _transcribing
                ? 'Transcribing…'
                : 'Ask your AvaBrain…';
    return Container(
      decoration: const BoxDecoration(
        color: Zine.paper2,
        border: Border(top: BorderSide(color: Zine.ink, width: Zine.bw)),
      ),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(8, 10, 14, 12),
          child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
            // Mic → slide-out menu (record audio / convert voice to text).
            IconButton(
              tooltip: 'Voice',
              icon: PhosphorIcon(
                  PhosphorIcons.microphone(
                      voiceBusy ? PhosphorIconsStyle.fill : PhosphorIconsStyle.bold),
                  color: voiceBusy ? Zine.mintInk : Zine.ink, size: 24),
              onPressed: _transcribing ? null : _openMicMenu,
            ),
            Expanded(
              child: Container(
                decoration: BoxDecoration(
                  color: Zine.card,
                  borderRadius: BorderRadius.circular(24),
                  border: Zine.border,
                  boxShadow: Zine.shadowXs,
                ),
                child: TextField(
                  controller: _input,
                  minLines: 1, maxLines: 4,
                  textInputAction: TextInputAction.send,
                  onSubmitted: (_) => _send(),
                  cursorColor: Zine.blueInk,
                  style: ZineText.input(size: 15),
                  decoration: InputDecoration(
                    hintText: hint,
                    hintStyle: ZineText.input(size: 15).copyWith(color: Zine.placeholder, fontWeight: FontWeight.w700),
                    isDense: true,
                    filled: false,
                    border: InputBorder.none,
                    enabledBorder: InputBorder.none,
                    focusedBorder: InputBorder.none,
                    contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                  ),
                ),
              ),
            ),
            const SizedBox(width: 10),
            _trailingButton(),
          ]),
        ),
      ),
    );
  }

  // Send, or a stop button while a voice session is live.
  Widget _trailingButton() {
    if (_sttActive || _recording) {
      return ZinePressable(
        onTap: _sttActive ? _stopVoiceToText : _recordToText,
        color: Zine.coral,
        radius: BorderRadius.circular(100),
        boxShadow: Zine.shadowXs,
        child: const SizedBox(
          width: 46, height: 46,
          child: Center(child: Icon(Icons.stop_rounded, color: Colors.white, size: 24)),
        ),
      );
    }
    return ZinePressable(
      onTap: _thinking ? null : _send,
      color: _thinking ? Zine.paper2 : Zine.lime,
      radius: BorderRadius.circular(100),
      boxShadow: Zine.shadowXs,
      child: SizedBox(
        width: 46, height: 46,
        child: Center(
          child: PhosphorIcon(
            PhosphorIcons.arrowUp(PhosphorIconsStyle.bold),
            size: 21, color: _thinking ? Zine.inkMute : Zine.ink,
          ),
        ),
      ),
    );
  }
}
