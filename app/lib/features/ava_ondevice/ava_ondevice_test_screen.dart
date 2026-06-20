/// Ava on-device test screen (Phase A).
///
/// Exercises the on-device pipeline end-to-end, isolated from the production Ava
/// path so testing stays clean:
///   • CHAT: type a request → the on-device router decides LOCAL vs CLOUD.
///       - LOCAL  → Qwen3.5-0.8B answers on-device, STREAMED (typewriter), grounded
///                  in any matching on-device memory.
///       - CLOUD  → escalates to the existing Workers-AI path (AvaAiClient).
///   • MEMORY: paste text (a note, a "conversation", file text) → ingest into the
///       on-device vector store with live "Ingesting / Ingested ✓" status →
///       search it offline.
///
/// Plain Material on purpose (a dev/QA surface) — zero design-system risk.
library;

import 'package:flutter/material.dart';

import '../../core/ava_ai_client.dart';
import '../../core/ava_ondevice_llm.dart';
import '../../core/ava_ondevice_rag.dart';

class AvaOnDeviceTestScreen extends StatefulWidget {
  const AvaOnDeviceTestScreen({super.key});

  @override
  State<AvaOnDeviceTestScreen> createState() => _AvaOnDeviceTestScreenState();
}

class _AvaOnDeviceTestScreenState extends State<AvaOnDeviceTestScreen> {
  final _llm = AvaOnDeviceLlm.I;
  final _rag = AvaOnDeviceRag.I;

  final _promptCtrl = TextEditingController(text: 'what is your name');
  final _ingestNameCtrl = TextEditingController(text: 'note 1');
  final _ingestBodyCtrl = TextEditingController();
  final _searchCtrl = TextEditingController();
  final _scrollCtrl = ScrollController();

  bool _busy = false;
  String _answer = '';
  String _routeLabel = '';
  String _engineLabel = '';
  OnDeviceMetrics? _metrics;

  bool _ingesting = false;
  List<RagHit> _hits = const [];

  @override
  void dispose() {
    _promptCtrl.dispose();
    _ingestNameCtrl.dispose();
    _ingestBodyCtrl.dispose();
    _searchCtrl.dispose();
    _scrollCtrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() => _busy = true);
    await _llm.ensureReady();
    if (mounted) setState(() => _busy = false);
  }

  Future<void> _showCatalog() async {
    final models = await _llm.debugCatalog();
    if (!mounted) return;
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Cactus catalog (device view)'),
        content: SizedBox(
          width: double.maxFinite,
          child: ListView(
            shrinkWrap: true,
            children: models
                .map((m) => Padding(
                      padding: const EdgeInsets.symmetric(vertical: 3),
                      child: SelectableText(m,
                          style: const TextStyle(fontSize: 12.5)),
                    ))
                .toList(),
          ),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx), child: const Text('Close')),
        ],
      ),
    );
  }

  Future<void> _send() async {
    final prompt = _promptCtrl.text.trim();
    if (prompt.isEmpty || _busy) return;
    setState(() {
      _busy = true;
      _answer = '';
      _metrics = null;
      _routeLabel = 'Routing…';
      _engineLabel = '';
    });

    // 1) Route + gather any on-device context (used for both local and cloud).
    final decision = await _llm.route(prompt);
    final context = await _rag.contextFor(prompt);
    if (!mounted) return;

    if (decision.isLocal) {
      setState(() {
        _routeLabel = 'LOCAL · on-device';
        _engineLabel = 'Qwen3.5-0.8B';
      });
      final streamed = await _llm.askStream(prompt, context: context);
      streamed.stream.listen((chunk) {
        if (!mounted) return;
        setState(() => _answer += chunk);
        _autoScroll();
      });
      final reply = await streamed.done;
      if (!mounted) return;
      setState(() {
        if (_answer.trim().isEmpty) _answer = reply.text;
        _metrics = reply.metrics;
        _busy = false;
      });
    } else {
      setState(() {
        _routeLabel = 'CLOUD · Workers AI';
        _engineLabel = 'escalated';
      });
      final ans = await AvaAiClient.I.ask(message: prompt, context: context);
      if (!mounted) return;
      setState(() {
        _answer = ans.blocked
            ? '[cloud unavailable offline or blocked: ${ans.reason ?? '—'}]\n${ans.answer}'
            : ans.answer;
        _metrics = null;
        _busy = false;
      });
    }
    _autoScroll();
  }

  Future<void> _ingest() async {
    final name = _ingestNameCtrl.text.trim().isEmpty
        ? 'note'
        : _ingestNameCtrl.text.trim();
    final body = _ingestBodyCtrl.text.trim();
    if (body.isEmpty) return;
    setState(() => _ingesting = true);
    await _rag.ingestText(name: name, content: body);
    if (!mounted) return;
    setState(() {
      _ingesting = false;
      _ingestBodyCtrl.clear();
    });
  }

  Future<void> _search() async {
    final q = _searchCtrl.text.trim();
    if (q.isEmpty) return;
    setState(() => _busy = true);
    final hits = await _rag.search(q, limit: 5);
    if (!mounted) return;
    setState(() {
      _hits = hits;
      _busy = false;
    });
  }

  void _autoScroll() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollCtrl.hasClients) {
        _scrollCtrl.animateTo(_scrollCtrl.position.maxScrollExtent,
            duration: const Duration(milliseconds: 200), curve: Curves.easeOut);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Ava on-device (Qwen3.5-0.8B)'),
        actions: [
          IconButton(
            tooltip: 'Unload model',
            icon: const Icon(Icons.power_settings_new),
            onPressed: _busy
                ? null
                : () {
                    _llm.unload();
                    setState(() {
                      _answer = '';
                      _metrics = null;
                      _routeLabel = '';
                    });
                  },
          ),
        ],
      ),
      body: SafeArea(
        child: ListView(
          controller: _scrollCtrl,
          padding: const EdgeInsets.all(16),
          children: [
            _statusCard(),
            const SizedBox(height: 16),
            _chatCard(),
            const SizedBox(height: 16),
            _memoryCard(),
          ],
        ),
      ),
    );
  }

  // ── status ───────────────────────────────────────────────────────────────────
  Widget _statusCard() {
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: ValueListenableBuilder<OnDeviceStatus>(
          valueListenable: _llm.status,
          builder: (context, status, _) {
            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(children: [
                  Icon(_statusIcon(status), color: _statusColor(status)),
                  const SizedBox(width: 8),
                  Expanded(
                    child: ValueListenableBuilder<String>(
                      valueListenable: _llm.statusLine,
                      builder: (context, line, _) => Text(line,
                          style: const TextStyle(
                              fontWeight: FontWeight.w600, fontSize: 14.5)),
                    ),
                  ),
                ]),
                if (status == OnDeviceStatus.downloading) ...[
                  const SizedBox(height: 10),
                  ValueListenableBuilder<double>(
                    valueListenable: _llm.downloadProgress,
                    builder: (context, p, _) =>
                        LinearProgressIndicator(value: p > 0 ? p : null),
                  ),
                ],
                if (status == OnDeviceStatus.initializing) ...[
                  const SizedBox(height: 10),
                  const LinearProgressIndicator(),
                ],
                if (status == OnDeviceStatus.idle ||
                    status == OnDeviceStatus.error) ...[
                  const SizedBox(height: 12),
                  OutlinedButton.icon(
                    onPressed: _busy ? null : _load,
                    icon: const Icon(Icons.download),
                    label: Text(status == OnDeviceStatus.error
                        ? 'Retry load'
                        : 'Load model (first run downloads ≈600 MB)'),
                  ),
                ],
                Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton.icon(
                    onPressed: _showCatalog,
                    icon: const Icon(Icons.list, size: 18),
                    label: const Text('Show catalog models'),
                  ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }

  // ── chat ─────────────────────────────────────────────────────────────────────
  Widget _chatCard() {
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Ask Ava',
                style: TextStyle(fontWeight: FontWeight.w700, fontSize: 13)),
            const SizedBox(height: 10),
            TextField(
              controller: _promptCtrl,
              minLines: 1,
              maxLines: 4,
              decoration: const InputDecoration(
                labelText: 'Request',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 10),
            FilledButton.icon(
              onPressed: _busy ? null : _send,
              icon: const Icon(Icons.send),
              label: const Text('Send'),
            ),
            if (_routeLabel.isNotEmpty) ...[
              const SizedBox(height: 12),
              Wrap(spacing: 8, children: [
                Chip(
                  label: Text(_routeLabel),
                  visualDensity: VisualDensity.compact,
                  backgroundColor: _routeLabel.startsWith('LOCAL')
                      ? Colors.green.withValues(alpha: 0.15)
                      : Colors.blue.withValues(alpha: 0.15),
                ),
                if (_engineLabel.isNotEmpty)
                  Chip(
                      label: Text(_engineLabel),
                      visualDensity: VisualDensity.compact),
              ]),
            ],
            if (_answer.isNotEmpty) ...[
              const SizedBox(height: 12),
              SelectableText(_answer, style: const TextStyle(fontSize: 15)),
            ],
            if (_metrics != null) ...[
              const SizedBox(height: 10),
              Text(
                '${_metrics!.tokensPerSecond.toStringAsFixed(1)} tok/s · '
                'TTFT ${_metrics!.timeToFirstTokenMs.toStringAsFixed(0)} ms · '
                '${_metrics!.totalTokens} tokens',
                style: TextStyle(fontSize: 11.5, color: Colors.grey.shade600),
              ),
            ],
          ],
        ),
      ),
    );
  }

  // ── memory ───────────────────────────────────────────────────────────────────
  Widget _memoryCard() {
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(children: [
              const Text('On-device memory',
                  style: TextStyle(fontWeight: FontWeight.w700, fontSize: 13)),
              const Spacer(),
              ValueListenableBuilder<int>(
                valueListenable: _rag.docCount,
                builder: (context, n, _) => Text('$n in vector store',
                    style:
                        TextStyle(fontSize: 11.5, color: Colors.grey.shade600)),
              ),
            ]),
            const SizedBox(height: 10),
            TextField(
              controller: _ingestNameCtrl,
              decoration: const InputDecoration(
                labelText: 'Name',
                isDense: true,
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _ingestBodyCtrl,
              minLines: 2,
              maxLines: 6,
              decoration: const InputDecoration(
                labelText: 'Text to remember (note / pasted conversation / file text)',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 8),
            Row(children: [
              OutlinedButton.icon(
                onPressed: (_busy || _ingesting) ? null : _ingest,
                icon: _ingesting
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2))
                    : const Icon(Icons.add),
                label: const Text('Ingest'),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: ValueListenableBuilder<String>(
                  valueListenable: _rag.ingestStatus,
                  builder: (context, s, _) => Text(s,
                      style: TextStyle(
                          fontSize: 12,
                          color: s.contains('✓')
                              ? Colors.green.shade700
                              : Colors.grey.shade700)),
                ),
              ),
            ]),
            const Divider(height: 26),
            TextField(
              controller: _searchCtrl,
              decoration: InputDecoration(
                labelText: 'Search memory',
                isDense: true,
                border: const OutlineInputBorder(),
                suffixIcon: IconButton(
                  icon: const Icon(Icons.search),
                  onPressed: _busy ? null : _search,
                ),
              ),
              onSubmitted: (_) => _search(),
            ),
            if (_hits.isNotEmpty) ...[
              const SizedBox(height: 10),
              ..._hits.map((h) => Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('${h.source}  ·  d=${h.distance.toStringAsFixed(2)}',
                            style: TextStyle(
                                fontSize: 11, color: Colors.grey.shade600)),
                        Text(
                          h.content.length > 160
                              ? '${h.content.substring(0, 160)}…'
                              : h.content,
                          style: const TextStyle(fontSize: 13.5),
                        ),
                      ],
                    ),
                  )),
            ],
          ],
        ),
      ),
    );
  }

  IconData _statusIcon(OnDeviceStatus s) => switch (s) {
        OnDeviceStatus.ready => Icons.check_circle,
        OnDeviceStatus.error => Icons.error,
        OnDeviceStatus.downloading => Icons.cloud_download,
        OnDeviceStatus.initializing => Icons.memory,
        OnDeviceStatus.idle => Icons.circle_outlined,
      };

  Color _statusColor(OnDeviceStatus s) => switch (s) {
        OnDeviceStatus.ready => Colors.green,
        OnDeviceStatus.error => Colors.red,
        _ => Colors.blueGrey,
      };
}
