/// Ava on-device test screen (Phase A — step 1).
///
/// A self-contained harness to PROVE Qwen3-0.6B runs fully on-device/offline via
/// Cactus, before any of it is wired into the real Ava chat pipeline. It does NOT
/// touch the server Ava path ([AvaAiClient]) — it talks straight to
/// [AvaOnDeviceLlm]. Flow: Load model (downloads ~once) → type a prompt → Send →
/// read Qwen's reply + speed metrics. Turn on Airplane mode to confirm it's
/// genuinely offline.
///
/// Deliberately plain Material (a dev/test surface) so it compiles cleanly and
/// carries no design-system risk. Reachable from Settings → "Ava on-device".
library;

import 'package:flutter/material.dart';

import '../../core/ava_ondevice_llm.dart';

class AvaOnDeviceTestScreen extends StatefulWidget {
  const AvaOnDeviceTestScreen({super.key});

  @override
  State<AvaOnDeviceTestScreen> createState() => _AvaOnDeviceTestScreenState();
}

class _AvaOnDeviceTestScreenState extends State<AvaOnDeviceTestScreen> {
  final _svc = AvaOnDeviceLlm.I;
  final _promptCtrl = TextEditingController(
      text: 'In one sentence, what is the capital of France?');
  final _scrollCtrl = ScrollController();

  bool _busy = false; // a completion is in flight
  String _answer = '';
  OnDeviceMetrics? _metrics;

  @override
  void dispose() {
    _promptCtrl.dispose();
    _scrollCtrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() => _busy = true);
    await _svc.ensureReady();
    if (mounted) setState(() => _busy = false);
  }

  Future<void> _send() async {
    final prompt = _promptCtrl.text.trim();
    if (prompt.isEmpty || _busy) return;
    setState(() {
      _busy = true;
      _answer = '';
      _metrics = null;
    });
    final reply = await _svc.ask(prompt);
    if (!mounted) return;
    setState(() {
      _answer = reply.text;
      _metrics = reply.metrics;
      _busy = false;
    });
    // scroll the answer into view
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollCtrl.hasClients) {
        _scrollCtrl.animateTo(_scrollCtrl.position.maxScrollExtent,
            duration: const Duration(milliseconds: 250), curve: Curves.easeOut);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Ava on-device (Qwen3-0.6B)'),
        actions: [
          IconButton(
            tooltip: 'Unload model',
            icon: const Icon(Icons.power_settings_new),
            onPressed: _busy
                ? null
                : () {
                    _svc.unload();
                    setState(() {
                      _answer = '';
                      _metrics = null;
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
            const SizedBox(height: 12),
            _offlineHint(),
            const SizedBox(height: 16),
            TextField(
              controller: _promptCtrl,
              minLines: 1,
              maxLines: 4,
              decoration: const InputDecoration(
                labelText: 'Prompt',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: FilledButton.icon(
                    onPressed: _busy ? null : _send,
                    icon: const Icon(Icons.send),
                    label: const Text('Send (on-device)'),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 20),
            if (_answer.isNotEmpty) _answerCard(),
          ],
        ),
      ),
    );
  }

  Widget _statusCard() {
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: ValueListenableBuilder<OnDeviceStatus>(
          valueListenable: _svc.status,
          builder: (context, status, _) {
            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Icon(_statusIcon(status), color: _statusColor(status)),
                    const SizedBox(width: 8),
                    Expanded(
                      child: ValueListenableBuilder<String>(
                        valueListenable: _svc.statusLine,
                        builder: (context, line, _) => Text(
                          line,
                          style: const TextStyle(
                              fontWeight: FontWeight.w600, fontSize: 14.5),
                        ),
                      ),
                    ),
                  ],
                ),
                if (status == OnDeviceStatus.downloading) ...[
                  const SizedBox(height: 10),
                  ValueListenableBuilder<double>(
                    valueListenable: _svc.downloadProgress,
                    builder: (context, p, _) => LinearProgressIndicator(
                        value: p > 0 ? p : null),
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
                        : 'Load model (~first run downloads ≈400 MB)'),
                  ),
                ],
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _offlineHint() {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Colors.amber.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: Colors.amber.withValues(alpha: 0.5)),
      ),
      child: const Row(
        children: [
          Icon(Icons.wifi_off, size: 18),
          SizedBox(width: 8),
          Expanded(
            child: Text(
              'Once the model is loaded, turn on Airplane mode and send again — '
              'replies should still work, proving it runs fully offline.',
              style: TextStyle(fontSize: 12.5),
            ),
          ),
        ],
      ),
    );
  }

  Widget _answerCard() {
    final m = _metrics;
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Qwen3-0.6B (on-device)',
                style: TextStyle(fontWeight: FontWeight.w700, fontSize: 13)),
            const SizedBox(height: 8),
            SelectableText(_answer, style: const TextStyle(fontSize: 15)),
            if (m != null) ...[
              const Divider(height: 22),
              Wrap(
                spacing: 14,
                runSpacing: 4,
                children: [
                  _metric('${m.tokensPerSecond.toStringAsFixed(1)} tok/s'),
                  _metric('TTFT ${m.timeToFirstTokenMs.toStringAsFixed(0)} ms'),
                  _metric('total ${m.totalTimeMs.toStringAsFixed(0)} ms'),
                  _metric('${m.totalTokens} tokens'),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _metric(String text) => Text(text,
      style: TextStyle(fontSize: 11.5, color: Colors.grey.shade600));

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
