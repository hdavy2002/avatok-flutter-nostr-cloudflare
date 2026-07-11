import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/analytics.dart';
import '../../core/business_agent_api.dart';
import '../../core/disk_cache.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';

/// "My AI calls" — caller-side history of calls I made to OTHER people's Ava AI
/// Voice Agents (Specs/PLAN-2026-07-11-dialpad-business-calls-ava-voice-agent.md
/// §12.11). Deliberately NOT in Messenger — the channel split (§6) means a
/// caller never gets a chat artifact from a business call; this is the one
/// place a paying/talking caller can find their own transcript again.
///
/// Entry point: a tile inside Settings → Ava Business Agent (see
/// business_agent_section.dart) — never surfaced from Messenger.
///
/// Per-account local cache (DiskCache, which is already scoped to
/// [AccountScope.id] — see core/disk_cache.dart) so the list paints instantly
/// on reopen instead of waiting on a round-trip, mirroring the receptionist
/// settings mirror pattern. The server is still authoritative; the cache is a
/// paint-fast layer only.
class MyAiCallsScreen extends StatefulWidget {
  const MyAiCallsScreen({super.key});
  @override
  State<MyAiCallsScreen> createState() => _MyAiCallsScreenState();
}

class _MyAiCallsScreenState extends State<MyAiCallsScreen> {
  static const String _cacheKey = 'my_ai_calls_cache_v1';

  bool _loading = true;
  bool _available = true;
  List<MyAiCall> _calls = const [];
  String? _cursor;
  bool _loadingMore = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    // 1) Instant paint from the local cache.
    try {
      final raw = await DiskCache.read(_cacheKey);
      if (raw != null && mounted) {
        final j = jsonDecode(raw) as Map;
        final list = (j['calls'] as List? ?? const [])
            .whereType<Map>().map((m) => MyAiCall.fromJson(m.cast<String, dynamic>())).toList();
        setState(() { _calls = list; _loading = list.isEmpty; });
      }
    } catch (_) {/* no/invalid cache — fall through */}

    // 2) Authoritative refresh.
    final res = await BusinessAgentApi.myCalls();
    if (!mounted) return;
    setState(() {
      _loading = false;
      _available = res.available;
      if (res.available) {
        _calls = res.calls;
        _cursor = res.nextCursor;
      }
    });
    if (res.available) await _writeCache();
    Analytics.capture('my_ai_calls_opened', {'count': _calls.length, 'available': _available});
  }

  Future<void> _writeCache() async {
    try {
      await DiskCache.write(_cacheKey, jsonEncode({
        'calls': _calls.map((c) => {
              'call_id': c.callId, 'service_name': c.serviceName, 'owner_name': c.ownerName,
              'started_at': c.startedAt.toUtc().millisecondsSinceEpoch,
              'duration_sec': c.durationSec, 'resolved': c.resolved, 'summary': c.summary,
            }).toList(),
      }));
    } catch (_) {/* best-effort */}
  }

  Future<void> _loadMore() async {
    if (_loadingMore || _cursor == null) return;
    setState(() => _loadingMore = true);
    final res = await BusinessAgentApi.myCalls(cursor: _cursor);
    if (!mounted) return;
    setState(() {
      _loadingMore = false;
      if (res.available) {
        _calls = [..._calls, ...res.calls];
        _cursor = res.nextCursor;
      }
    });
    if (res.available) await _writeCache();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: AppBar(
        backgroundColor: Zine.paper,
        elevation: 0,
        title: Text('My AI calls', style: ZineText.value(size: 17)),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
          : !_available
              ? _emptyState('My AI calls isn’t available on your account yet.')
              : _calls.isEmpty
                  ? _emptyState('Calls you make to Ava AI agents (other people’s '
                      'business numbers) will show up here — with the full '
                      'transcript, so you never lose what you paid for.')
                  : RefreshIndicator(
                      onRefresh: _load,
                      child: ListView.separated(
                        padding: const EdgeInsets.all(16),
                        itemCount: _calls.length + (_cursor != null ? 1 : 0),
                        separatorBuilder: (_, __) => const SizedBox(height: 10),
                        itemBuilder: (context, i) {
                          if (i >= _calls.length) {
                            _loadMore();
                            return const Padding(
                              padding: EdgeInsets.symmetric(vertical: 16),
                              child: Center(child: SizedBox(
                                  width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))),
                            );
                          }
                          return _callTile(_calls[i]);
                        },
                      ),
                    ),
    );
  }

  Widget _emptyState(String text) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Icon(PhosphorIcons.phoneCall(PhosphorIconsStyle.duotone), size: 42, color: Zine.inkMute),
          const SizedBox(height: 12),
          Text(text, textAlign: TextAlign.center, style: ZineText.sub(size: 13)),
        ]),
      ),
    );
  }

  Widget _callTile(MyAiCall c) {
    return ZinePressable(
      onTap: () => Navigator.of(context).push(
          MaterialPageRoute(builder: (_) => _MyAiCallDetailScreen(call: c))),
      color: Zine.card,
      radius: BorderRadius.circular(Zine.rSm),
      boxShadow: Zine.shadowXs,
      padding: const EdgeInsets.all(13),
      child: Row(children: [
        ZineIconBadge(icon: PhosphorIcons.robot(PhosphorIconsStyle.fill), color: Zine.lilac, size: 36),
        const SizedBox(width: 10),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(
              c.serviceName.isEmpty
                  ? (c.ownerName.isEmpty ? 'Ava AI agent' : c.ownerName)
                  : '${c.serviceName} by ${c.ownerName.isEmpty ? 'owner' : c.ownerName}',
              style: ZineText.value(size: 13.5),
            ),
            const SizedBox(height: 2),
            Text(_summaryLine(c), style: ZineText.sub(size: 11.5), maxLines: 2, overflow: TextOverflow.ellipsis),
            const SizedBox(height: 2),
            Text(_when(c.startedAt), style: ZineText.tag(size: 10.5, color: Zine.inkMute)),
          ]),
        ),
        Icon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold), size: 16, color: Zine.inkMute),
      ]),
    );
  }

  String _summaryLine(MyAiCall c) {
    if (c.summary.isNotEmpty) return c.summary;
    final mins = (c.durationSec / 60).ceil();
    return c.resolved ? '${mins}m call · resolved' : '${mins}m call';
  }

  String _when(DateTime dt) {
    final now = DateTime.now();
    final d = now.difference(dt);
    if (d.inDays == 0) return 'Today ${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
    if (d.inDays == 1) return 'Yesterday';
    if (d.inDays < 7) return '${d.inDays}d ago';
    return '${dt.day}/${dt.month}/${dt.year}';
  }
}

/// Full transcript, view + download, for one AI call the caller made.
class _MyAiCallDetailScreen extends StatefulWidget {
  final MyAiCall call;
  const _MyAiCallDetailScreen({required this.call});
  @override
  State<_MyAiCallDetailScreen> createState() => _MyAiCallDetailScreenState();
}

class _MyAiCallDetailScreenState extends State<_MyAiCallDetailScreen> {
  bool _loading = true;
  MyAiCallTranscript? _t;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final t = await BusinessAgentApi.myCallTranscript(widget.call.callId);
    if (!mounted) return;
    setState(() { _t = t; _loading = false; });
  }

  Future<void> _download() async {
    final t = _t;
    if (t == null) return;
    try {
      final dir = await getTemporaryDirectory();
      final safe = widget.call.callId.replaceAll(RegExp(r'[^a-zA-Z0-9_-]'), '_');
      final f = File('${dir.path}/ava_ai_call_$safe.txt');
      await f.writeAsString(t.toPlainText(), flush: true);
      await Share.shareXFiles([XFile(f.path, mimeType: 'text/plain')], subject: 'Ava AI call transcript');
      Analytics.capture('my_ai_call_transcript_downloaded', {'call_id': widget.call.callId});
    } catch (_) {/* best-effort */}
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.call;
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: AppBar(
        backgroundColor: Zine.paper,
        elevation: 0,
        title: Text(c.serviceName.isEmpty ? 'AI call' : c.serviceName, style: ZineText.value(size: 16)),
        actions: [
          if (_t != null)
            IconButton(
              icon: Icon(PhosphorIcons.downloadSimple(PhosphorIconsStyle.bold), color: Zine.ink),
              onPressed: _download,
            ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
          : _t == null
              ? Center(child: Text('Couldn’t load this transcript.', style: ZineText.sub(size: 13)))
              : ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    if (_t!.whatTheAgentDid.isNotEmpty) ...[
                      ZineCard(
                        radius: Zine.rSm,
                        boxShadow: Zine.shadowXs,
                        color: Zine.mint,
                        child: Text(_t!.whatTheAgentDid, style: ZineText.value(size: 13)),
                      ),
                      const SizedBox(height: 14),
                    ],
                    for (final t in _t!.turns)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 10),
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Text(t.speaker == 'caller' ? 'You' : 'Ava', style: ZineText.tag(size: 10.5, color: Zine.inkMute)),
                          const SizedBox(height: 2),
                          Text(t.text, style: ZineText.sub(size: 13.5)),
                        ]),
                      ),
                  ],
                ),
    );
  }
}
