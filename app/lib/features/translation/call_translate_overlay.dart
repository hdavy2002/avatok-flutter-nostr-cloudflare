import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart' show defaultTargetPlatform, TargetPlatform;
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/money_api.dart';
import '../../core/remote_config.dart';
import '../../core/ui/zine.dart';
import 'call_translation_controller.dart';
import 'call_translation_audio_bridge.dart';
import 'translation_langs.dart';

/// CallScreen overlay for Android 1:1 audio and video calls. It is hidden while
/// either master flag is false or the pinned decoded-playback bridge is absent.
class CallTranslateOverlay extends StatefulWidget {
  const CallTranslateOverlay({super.key, required this.callRef});
  final String callRef;
  @override State<CallTranslateOverlay> createState() => _CallTranslateOverlayState();
}

class _CallTranslateOverlayState extends State<CallTranslateOverlay> {
  CallTranslationController? _controller;
  bool _nativeSupported = false;
  bool _fundsDialogShown = false;
  bool _providerDialogShown = false;
  bool _hadActiveTranslation = false;
  @override
  void initState() {
    super.initState();
    _initializeBridge();
  }

  Future<void> _initializeBridge() async {
    final bridge = CallTranslationAudioBridge.instance;
    final supported = await bridge.isSupported();
    if (!mounted) return;
    final controller = CallTranslationController(callRef: widget.callRef, bridge: bridge);
    controller.state.addListener(_changed);
    setState(() {
      _nativeSupported = supported;
      _controller = controller;
    });
  }

  @override void dispose() { final c = _controller; c?.state.removeListener(_changed); c?.dispose(); super.dispose(); }
  void _changed() {
    if (!mounted) return;
    setState(() {});
    final controller = _controller;
    if (controller == null) return;
    final s = controller.state.value;
    if (s == CallTranslationState.active) _hadActiveTranslation = true;
    if (s == CallTranslationState.failed && _hadActiveTranslation) {
      final why = controller.failure.value;
      if (why == CallTranslationFailure.insufficientTokens && !_fundsDialogShown) {
        _fundsDialogShown = true;
        WidgetsBinding.instance.addPostFrameCallback((_) { if (mounted) _showFundsDialog(); });
      } else if (why != CallTranslationFailure.insufficientTokens && !_providerDialogShown) {
        _providerDialogShown = true;
        final terminal = why == CallTranslationFailure.circuitOpen;
        WidgetsBinding.instance.addPostFrameCallback((_) { if (mounted) _showProviderStoppedDialog(terminal); });
      }
    }
    if (s == CallTranslationState.idle) _hadActiveTranslation = false;
  }

  Future<void> _showFundsDialog() async {
    await showDialog<void>(context: context, builder: (d) => AlertDialog(
      title: const Text('Translation stopped'),
      content: const Text('You do not have enough Tokens to continue live translation. Your call is still connected.'),
      actions: [
        TextButton(onPressed: () => Navigator.pop(d), child: const Text('Not now')),
        TextButton(onPressed: () async {
          Navigator.pop(d);
          final topup = await MoneyApi.topup(500);
          final url = topup['checkout_url']?.toString();
          if (url != null && url.isNotEmpty) {
            try { await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication); } catch (_) {}
          }
        }, child: const Text('Top up Tokens')),
      ],
    ));
  }

  Future<void> _showProviderStoppedDialog(bool terminalForCall) async {
    await showDialog<void>(context: context, builder: (d) => AlertDialog(
      title: Text(terminalForCall ? 'Translation unavailable' : 'Translation stopped'),
      content: Text(terminalForCall
          // Circuit breaker tripped: 3 provider failures in one call. Saying
          // "try again" here would be a lie — start() refuses from now on.
          ? 'Translation is unavailable for this call. Original call audio has been restored and your call is still connected.'
          : 'Live translation became unavailable. Original call audio has been restored and your call is still connected.'),
      actions: [TextButton(onPressed: () => Navigator.pop(d), child: const Text('OK'))],
    ));
  }

  Future<void> _pick() async {
    final lang = await showModalBottomSheet<String>(
      context: context, backgroundColor: Zine.paper,
      isScrollControlled: true,
      builder: (_) => const _CallTranslationLanguagePicker(),
    );
    if (lang == null || !mounted) return;
    _fundsDialogShown = false;
    _providerDialogShown = false;
    _hadActiveTranslation = false;
    final error = await _controller?.start(lang);
    if (!mounted || error == null) return;
    final message = error == 'source_capture_unavailable'
        ? 'Live translation is not ready on this device yet.'
        : error == 'insufficient_tokens'
            ? 'You need at least 5 Tokens to start live translation.'
            : error == 'unavailable_for_call'
                ? 'Translation is unavailable for this call. Your call is unchanged.'
                : 'Live translation could not start. Your call is unchanged.';
    await showDialog<void>(context: context, builder: (d) => AlertDialog(
      title: const Text('Translate unavailable'),
      content: Text(message),
      actions: [
        TextButton(onPressed: () => Navigator.pop(d), child: const Text('NOT NOW')),
        if (error == 'insufficient_tokens')
          TextButton(onPressed: () async {
            Navigator.pop(d);
            final topup = await MoneyApi.topup(500);
            final url = topup['checkout_url']?.toString();
            if (url != null && url.isNotEmpty) {
              try { await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication); } catch (_) {}
            }
          }, child: const Text('Top up Tokens')),
      ],
    ));
  }

  @override Widget build(BuildContext context) {
    if (defaultTargetPlatform != TargetPlatform.android || !RemoteConfig.translationEnabled || !RemoteConfig.callTranslationEnabled) return const SizedBox.shrink();
    final controller = _controller;
    if (!_nativeSupported || controller == null || !controller.available) return const SizedBox.shrink();
    final active = controller.active;
    final preparing = controller.preparing;
    final stalled = controller.state.value == CallTranslationState.stalled;
    final label = preparing
        ? (controller.state.value == CallTranslationState.recovering
            ? 'Reconnecting translation…'
            : 'Starting translation…')
        : active
            ? '${translationLangLabel(controller.targetLanguage.value ?? '')} · Stop translation'
            : 'Translate';
    return SafeArea(child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.end, children: [
      GestureDetector(
        onTap: preparing ? null : (active ? controller.stop : _pick),
        child: Container(padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9), decoration: BoxDecoration(color: active ? Zine.lilac : Zine.card, borderRadius: BorderRadius.circular(100), border: Border.all(color: Zine.ink, width: Zine.bw), boxShadow: Zine.shadowXs), child: Row(mainAxisSize: MainAxisSize.min, children: [PhosphorIcon(PhosphorIcons.translate(PhosphorIconsStyle.bold), size: 17), const SizedBox(width: 6), Text(label, style: ZineText.value(size: 13, weight: FontWeight.w700))])),
      ),
      if (active) ...[
        const SizedBox(height: 5),
        ValueListenableBuilder<int>(valueListenable: controller.billedTokens, builder: (_, tokens, __) => ValueListenableBuilder<int>(valueListenable: controller.elapsedSeconds, builder: (_, elapsed, __) => Text('5/min · $tokens Tokens · ${elapsed ~/ 60}:${(elapsed % 60).toString().padLeft(2, '0')}', style: ZineText.tag(size: 10)))),
        // Dead-air guard: the plugin has already restored the original audio,
        // so this line explains what the user is hearing rather than warning
        // about a broken call.
        if (stalled)
          Text('Translator catching up… you are hearing the original voice', textAlign: TextAlign.right, style: ZineText.tag(size: 10)),
        ValueListenableBuilder<bool>(
          valueListenable: controller.qualityDegraded,
          builder: (_, degraded, __) => degraded && !stalled
              ? Text('Translation quality is unstable on this connection', textAlign: TextAlign.right, style: ZineText.tag(size: 10))
              : const SizedBox.shrink(),
        ),
      ],
    ]));
  }
}

class _CallTranslationLanguagePicker extends StatefulWidget {
  const _CallTranslationLanguagePicker();

  @override
  State<_CallTranslationLanguagePicker> createState() => _CallTranslationLanguagePickerState();
}

class _CallTranslationLanguagePickerState extends State<_CallTranslationLanguagePicker> {
  final _search = TextEditingController();
  String _query = '';

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final q = _query.trim().toLowerCase();
    final languages = q.isEmpty
        ? kTranslationLangs
        : kTranslationLangs.where((item) =>
            item.label.toLowerCase().contains(q) || item.code.toLowerCase().contains(q)).toList();
    return SafeArea(
      child: SizedBox(
        height: MediaQuery.sizeOf(context).height * .78,
        child: Column(children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 18, 20, 10),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Translate incoming voice', style: ZineText.cardTitle()),
              const SizedBox(height: 6),
              Text('Choose your language · 5 Tokens per started minute', style: ZineText.sub(size: 13)),
              const SizedBox(height: 14),
              TextField(
                controller: _search,
                autofocus: true,
                onChanged: (value) => setState(() => _query = value),
                decoration: const InputDecoration(
                  prefixIcon: Icon(Icons.search),
                  hintText: 'Search languages',
                  border: OutlineInputBorder(),
                ),
              ),
            ]),
          ),
          Expanded(
            child: languages.isEmpty
                ? const Center(child: Text('No matching language'))
                : ListView.builder(
                    itemCount: languages.length,
                    itemBuilder: (_, index) {
                      final item = languages[index];
                      return ListTile(
                        title: Text(item.label),
                        subtitle: Text(item.code),
                        onTap: () => Navigator.pop(context, item.code),
                      );
                    },
                  ),
          ),
        ]),
      ),
    );
  }
}
