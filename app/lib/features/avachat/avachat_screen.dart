import 'dart:convert';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/material.dart';

import '../../core/brain_api.dart';
import '../../core/config.dart';
import '../../core/theme.dart';
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
  static const _accent = Color(0xFFA06AF0); // AvaChat brand color (registry)
  final _input = TextEditingController();
  final _scroll = ScrollController();
  final _audio = AudioPlayer();
  final List<_ChatMsg> _msgs = [];
  bool _thinking = false;
  bool _loadingHistory = true;
  String? _playingRef;

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
    super.dispose();
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
    setState(() { _msgs.add(_ChatMsg(true, text)); _thinking = true; });
    _jump();
    try {
      final reply = await BrainApi.chat(text);
      if (!mounted) return;
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
      backgroundColor: AvaColors.bg,
      appBar: AppBar(
        backgroundColor: AvaColors.bg,
        elevation: 0,
        iconTheme: const IconThemeData(color: AvaColors.ink),
        title: Row(children: [
          Container(
            width: 34, height: 34,
            decoration: BoxDecoration(color: _accent.withValues(alpha: .14), borderRadius: BorderRadius.circular(10)),
            child: const Icon(Icons.auto_awesome, color: _accent, size: 19),
          ),
          const SizedBox(width: 10),
          const Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Text('AvaChat', style: TextStyle(color: AvaColors.ink, fontSize: 17, fontWeight: FontWeight.w700)),
            Text('Your personal AI', style: TextStyle(color: AvaColors.sub, fontSize: 11.5)),
          ]),
        ]),
        actions: [
          IconButton(
            tooltip: 'New conversation',
            icon: const Icon(Icons.add_comment_outlined, color: AvaColors.ink),
            onPressed: _newConversation,
          ),
          IconButton(
            tooltip: 'AvaBrain settings',
            icon: const Icon(Icons.psychology_outlined, color: AvaColors.ink),
            onPressed: () => Navigator.of(context).push(
                MaterialPageRoute(builder: (_) => const BrainSettingsScreen())),
          ),
        ],
      ),
      body: Column(children: [
        Expanded(
          child: _loadingHistory
              ? const Center(child: CircularProgressIndicator(color: _accent))
              : _msgs.isEmpty
                  ? _empty()
                  : ListView.builder(
                      controller: _scroll,
                      padding: const EdgeInsets.fromLTRB(14, 12, 14, 8),
                      itemCount: _msgs.length + (_thinking ? 1 : 0),
                      itemBuilder: (_, i) => i == _msgs.length ? _typing() : _bubble(_msgs[i]),
                    ),
        ),
        if (_msgs.isEmpty && !_loadingHistory) _chips(),
        _inputBar(),
      ]),
    );
  }

  Widget _empty() => Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Container(
            width: 72, height: 72,
            decoration: BoxDecoration(color: _accent.withValues(alpha: .12), shape: BoxShape.circle),
            child: const Icon(Icons.auto_awesome, color: _accent, size: 34),
          ),
          const SizedBox(height: 14),
          const Text('Ask your AvaBrain anything', style: TextStyle(color: AvaColors.ink, fontSize: 17, fontWeight: FontWeight.w700)),
          const SizedBox(height: 6),
          const Padding(
            padding: EdgeInsets.symmetric(horizontal: 40),
            child: Text(
              'It knows your own messages, files, images and voice notes — and only answers you.',
              textAlign: TextAlign.center, style: TextStyle(color: AvaColors.sub, fontSize: 13.5),
            ),
          ),
        ]),
      );

  Widget _chips() => SizedBox(
        height: 44,
        child: ListView(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.symmetric(horizontal: 12),
          children: [
            for (final s in _suggestions)
              Padding(
                padding: const EdgeInsets.only(right: 8),
                child: ActionChip(
                  label: Text(s, style: const TextStyle(fontSize: 12.5, color: AvaColors.ink)),
                  backgroundColor: AvaColors.soft,
                  side: const BorderSide(color: AvaColors.line),
                  onPressed: () { _input.text = s.endsWith('…') ? s.substring(0, s.length - 1) : s; },
                ),
              ),
          ],
        ),
      );

  Widget _bubble(_ChatMsg m) {
    final bubble = Container(
      margin: const EdgeInsets.symmetric(vertical: 4),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * .82),
      decoration: BoxDecoration(
        color: m.mine ? _accent : AvaColors.soft,
        borderRadius: BorderRadius.only(
          topLeft: const Radius.circular(16), topRight: const Radius.circular(16),
          bottomLeft: Radius.circular(m.mine ? 16 : 4), bottomRight: Radius.circular(m.mine ? 4 : 16),
        ),
      ),
      child: Text(m.text, style: TextStyle(color: m.mine ? Colors.white : AvaColors.ink, fontSize: 14.5, height: 1.35)),
    );
    return Column(
      crossAxisAlignment: m.mine ? CrossAxisAlignment.end : CrossAxisAlignment.start,
      children: [
        Align(alignment: m.mine ? Alignment.centerRight : Alignment.centerLeft, child: bubble),
        if (m.sources.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 2, bottom: 6),
            child: Wrap(spacing: 6, runSpacing: 6, children: [for (final s in m.sources) _sourceCard(s)]),
          ),
      ],
    );
  }

  Widget _sourceCard(Map<String, dynamic> s) {
    final kind = (s['kind'] ?? '').toString();
    final playing = kind == 'voicemail' && _playingRef == (s['media_ref'] ?? s['ref'] ?? '').toString();
    final (icon, label) = switch (kind) {
      'voicemail' => (playing ? Icons.stop_circle : Icons.play_circle_fill, (s['name'] ?? 'Voice note').toString()),
      'file' => (Icons.insert_drive_file, (s['name'] ?? 'File').toString()),
      _ => (Icons.chat_bubble_outline, (s['name'] ?? 'Message').toString()),
    };
    final snippet = (s['snippet'] ?? '').toString();
    return InkWell(
      onTap: () => _tapSource(s),
      borderRadius: BorderRadius.circular(12),
      child: Container(
        constraints: const BoxConstraints(maxWidth: 260),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        decoration: BoxDecoration(
          color: AvaColors.bg,
          border: Border.all(color: AvaColors.line),
          borderRadius: BorderRadius.circular(12),
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Icon(icon, color: _accent, size: 20),
          const SizedBox(width: 8),
          Flexible(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
              Text(label, maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: AvaColors.ink, fontSize: 12.5, fontWeight: FontWeight.w600)),
              if (snippet.isNotEmpty)
                Text(snippet, maxLines: 2, overflow: TextOverflow.ellipsis,
                    style: const TextStyle(color: AvaColors.sub, fontSize: 11.5)),
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
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          decoration: BoxDecoration(color: AvaColors.soft, borderRadius: BorderRadius.circular(16)),
          child: const SizedBox(
            width: 36, height: 10,
            child: LinearProgressIndicator(color: _accent, backgroundColor: AvaColors.line, minHeight: 3),
          ),
        ),
      );

  Widget _inputBar() => SafeArea(
        top: false,
        child: Container(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 10),
          decoration: const BoxDecoration(
            color: AvaColors.bg,
            border: Border(top: BorderSide(color: AvaColors.line)),
          ),
          child: Row(children: [
            Expanded(
              child: TextField(
                controller: _input,
                minLines: 1, maxLines: 4,
                textInputAction: TextInputAction.send,
                onSubmitted: (_) => _send(),
                decoration: InputDecoration(
                  hintText: 'Ask your AvaBrain…',
                  hintStyle: const TextStyle(color: AvaColors.sub, fontSize: 14),
                  filled: true, fillColor: AvaColors.soft,
                  contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                  border: OutlineInputBorder(borderRadius: BorderRadius.circular(22), borderSide: BorderSide.none),
                ),
              ),
            ),
            const SizedBox(width: 8),
            Material(
              color: _thinking ? AvaColors.line : _accent,
              shape: const CircleBorder(),
              child: InkWell(
                customBorder: const CircleBorder(),
                onTap: _thinking ? null : _send,
                child: const Padding(
                  padding: EdgeInsets.all(11),
                  child: Icon(Icons.arrow_upward, color: Colors.white, size: 21),
                ),
              ),
            ),
          ]),
        ),
      );
}
