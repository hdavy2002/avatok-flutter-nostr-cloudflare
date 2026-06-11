// TranslateOverlay — the on-call "Translate" menu (transparent, sits on top of
// the video). Drop into the call screen's Stack:
//
//   TranslateOverlay(context: 'consult', refId: bookingId)
//
// Tap "Translate" → language dropdown → incoming voice plays in the chosen
// language. Billing: $3/hour in AvaCoins (5/min). The two owner-specified
// pop-ups (no AvaCoins to start / AvaCoins utilized mid-call) both offer an
// in-call wallet top-up so translation can continue.
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/money_api.dart';
import '../../core/remote_config.dart';
import '../../core/theme.dart';
import 'translation_api.dart';
import 'translation_engine.dart';
import 'translation_langs.dart';

class TranslateOverlay extends StatefulWidget {
  final String context;          // consult | live | conference
  final String refId;            // booking / listing / conversation id
  final double top;              // distance below the top bar (positioned mode)
  final bool inline;             // true → render just the pill (e.g. in a top bar)
  const TranslateOverlay({super.key, required this.context, required this.refId, this.top = 56, this.inline = false});

  @override
  State<TranslateOverlay> createState() => _TranslateOverlayState();
}

class _TranslateOverlayState extends State<TranslateOverlay> {
  late final TranslationEngine _engine = TranslationEngine(context: widget.context, ref: widget.refId);
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _engine.state.addListener(_onState);
  }

  @override
  void dispose() {
    _engine.state.removeListener(_onState);
    _engine.dispose();
    super.dispose();
  }

  void _onState() {
    if (!mounted) return;
    final s = _engine.state.value;
    if (s == TranslationState.fundsExhausted) {
      // Pop-up #2 — coins ran out mid-call.
      _fundsDialog(
        'You have utilized your AvaCoins for your voice translation. '
        'Please top up your wallet to add some more coins.',
        resume: true,
      );
    }
    setState(() {});
  }

  // ── actions ────────────────────────────────────────────────────────────────

  Future<void> _openMenu() async {
    if (RemoteConfig.translationEnabled == false) {
      _snack('Live translation is currently unavailable.');
      return;
    }
    final lang = await showModalBottomSheet<String>(
      context: context, isScrollControlled: true, backgroundColor: Colors.transparent,
      builder: (_) => _LanguageSheet(current: _engine.targetLang.value),
    );
    if (lang == null || !mounted) return;
    await _start(lang);
  }

  Future<void> _start(String lang) async {
    setState(() => _busy = true);
    final err = await _engine.start(lang);
    if (!mounted) return;
    setState(() => _busy = false);
    if (err == 'insufficient_avacoins') {
      // Pop-up #1 — nothing in the wallet to start with.
      _fundsDialog(
        "You don't have AvaCoins in your wallet to listen to live translation. "
        'Top up your wallet to start hearing the call in ${translationLangLabel(lang)}.',
        retryLang: lang,
      );
    } else if (err == 'disabled') {
      _snack('Live translation is currently unavailable.');
    } else if (err != null) {
      _snack('Could not start translation — try again.');
    }
  }

  Future<void> _stop() async {
    setState(() => _busy = true);
    await _engine.stop();
    if (mounted) setState(() => _busy = false);
  }

  // ── AvaCoins pop-ups + in-call top-up ─────────────────────────────────────

  Future<void> _fundsDialog(String message, {String? retryLang, bool resume = false}) async {
    if (!mounted) return;
    await showDialog<void>(
      context: context,
      builder: (dCtx) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        title: const Row(children: [
          Icon(Icons.account_balance_wallet_outlined, color: AvaColors.coral),
          SizedBox(width: 8),
          Expanded(child: Text('AvaCoins needed', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800))),
        ]),
        content: Text(message, style: const TextStyle(height: 1.4)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dCtx), child: const Text('Not now')),
          FilledButton.icon(
            style: FilledButton.styleFrom(backgroundColor: AvaColors.brand),
            icon: const Icon(Icons.add_card, size: 18),
            label: const Text('Top up wallet'),
            onPressed: () async {
              Navigator.pop(dCtx);
              final done = await _topupSheet();
              if (!mounted || !done) return;
              if (resume) {
                final ok = await _engine.resume();
                if (!ok && mounted) _snack('Top-up not confirmed yet — tap Translate again once your AvaCoins arrive.');
              } else if (retryLang != null) {
                await _start(retryLang);
              }
            },
          ),
        ],
      ),
    );
  }

  /// In-call top-up: quick amounts → Stripe checkout in the browser; the call
  /// keeps running underneath.
  Future<bool> _topupSheet() async {
    int? cents = await showModalBottomSheet<int>(
      context: context, backgroundColor: Colors.transparent,
      builder: (sCtx) => Container(
        decoration: const BoxDecoration(color: Colors.white, borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
        padding: EdgeInsets.fromLTRB(20, 16, 20, 20 + MediaQuery.of(sCtx).viewPadding.bottom),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          const Text('Top up AvaCoins', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
          const SizedBox(height: 4),
          const Text('Voice translation costs \$3 per hour (5 AvaCoins per minute).',
              style: TextStyle(color: AvaColors.sub, fontSize: 13)),
          const SizedBox(height: 14),
          Wrap(spacing: 10, runSpacing: 10, children: [
            for (final usd in const [3, 5, 10, 20])
              ActionChip(
                label: Text('\$$usd', style: const TextStyle(fontWeight: FontWeight.w800)),
                onPressed: () => Navigator.pop(sCtx, usd * 100),
              ),
          ]),
        ]),
      ),
    );
    if (cents == null || !mounted) return false;
    final t = await MoneyApi.topup(cents);
    final url = t['checkout_url']?.toString();
    if (url == null || url.isEmpty) {
      _snack('Top-up is currently unavailable.');
      return false;
    }
    try { await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication); } catch (_) {}
    if (!mounted) return false;
    // Let the user confirm once Stripe finishes (webhook credits the wallet).
    final ok = await showDialog<bool>(
      context: context,
      builder: (dCtx) => AlertDialog(
        title: const Text('Finish the top-up'),
        content: const Text('Complete the payment in your browser, then come back and tap Done.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dCtx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(dCtx, true), child: const Text('Done')),
        ],
      ),
    );
    return ok == true;
  }

  void _snack(String msg) {
    if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  // ── render ────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final s = _engine.state.value;
    final active = s == TranslationState.active;
    final lang = _engine.targetLang.value;

    final content = Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.end, children: [
          // The transparent "Translate" pill menu.
          Material(
            color: active ? AvaColors.brand.withValues(alpha: 0.85) : Colors.black38,
            borderRadius: BorderRadius.circular(22),
            child: InkWell(
              borderRadius: BorderRadius.circular(22),
              onTap: _busy ? null : (active ? _stop : _openMenu),
              onLongPress: active ? _openMenu : null,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  _busy || s == TranslationState.connecting
                      ? const SizedBox(width: 16, height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                      : const Icon(Icons.translate, color: Colors.white, size: 17),
                  const SizedBox(width: 6),
                  Text(
                    active ? '${translationLangLabel(lang ?? '')} · tap to stop' : 'Translate',
                    style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 13),
                  ),
                ]),
              ),
            ),
          ),
          if (active)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: ValueListenableBuilder<int>(
                valueListenable: _engine.billedMinutes,
                builder: (_, min, __) => Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  decoration: BoxDecoration(color: Colors.black38, borderRadius: BorderRadius.circular(12)),
                  child: Text(
                    '$min min · ${TranslationApi.quoteCoins(min)} AvaCoins (\$3/h)',
                    style: const TextStyle(color: Colors.white70, fontSize: 11, fontWeight: FontWeight.w600),
                  ),
                ),
              ),
            ),
        ]);

    if (widget.inline) return content;
    return Positioned(right: 12, top: widget.top, child: SafeArea(child: content));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Language picker — one dropdown ("Select language"), searchable.
// ─────────────────────────────────────────────────────────────────────────────
class _LanguageSheet extends StatefulWidget {
  final String? current;
  const _LanguageSheet({this.current});
  @override
  State<_LanguageSheet> createState() => _LanguageSheetState();
}

class _LanguageSheetState extends State<_LanguageSheet> {
  final _search = TextEditingController();
  String _q = '';

  @override
  Widget build(BuildContext context) {
    final list = kTranslationLangs
        .where((l) => _q.isEmpty || l.label.toLowerCase().contains(_q) || l.code.toLowerCase().contains(_q))
        .toList();
    return Container(
      height: MediaQuery.of(context).size.height * 0.65,
      decoration: const BoxDecoration(color: Colors.white, borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
      padding: const EdgeInsets.fromLTRB(20, 14, 20, 0),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Center(child: Container(width: 36, height: 4, margin: const EdgeInsets.only(bottom: 12),
            decoration: BoxDecoration(color: AvaColors.line, borderRadius: BorderRadius.circular(2)))),
        const Text('Select language', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
        const SizedBox(height: 2),
        const Text('Incoming voice will be translated live · \$3 per hour in AvaCoins',
            style: TextStyle(color: AvaColors.sub, fontSize: 12.5)),
        const SizedBox(height: 10),
        TextField(
          controller: _search,
          onChanged: (v) => setState(() => _q = v.trim().toLowerCase()),
          decoration: InputDecoration(
            hintText: 'Search 70+ languages', isDense: true,
            prefixIcon: const Icon(Icons.search, size: 19),
            border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
          ),
        ),
        const SizedBox(height: 6),
        Expanded(
          child: ListView.builder(
            itemCount: list.length,
            itemBuilder: (_, i) {
              final l = list[i];
              final sel = l.code == widget.current;
              return ListTile(
                dense: true,
                title: Text(l.label, style: TextStyle(fontWeight: sel ? FontWeight.w800 : FontWeight.w500)),
                trailing: sel ? const Icon(Icons.check, color: AvaColors.brand, size: 18) : null,
                onTap: () => Navigator.pop(context, l.code),
              );
            },
          ),
        ),
      ]),
    );
  }
}
