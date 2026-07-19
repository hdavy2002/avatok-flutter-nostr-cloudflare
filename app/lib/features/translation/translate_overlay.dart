// TranslateOverlay — the on-call "Translate" menu (sits on top of the video).
// Drop into the call screen's Stack:
//
//   TranslateOverlay(context: 'consult', refId: bookingId)
//
// Tap "Translate" → language dropdown → incoming voice plays in the chosen
// language. Billing: $3/hour in Tokens (5/min). The two owner-specified
// pop-ups (no Tokens to start / Tokens utilized mid-call) both offer an
// in-call wallet top-up so translation can continue.
//
// Zine: AI = lilac. The pill is an ink-bordered card pill (lilac when active);
// the billing notice is a mono sticker; sheets/dialogs live on paper.
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/money_api.dart';
import '../../core/remote_config.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
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
        'You have utilized your Tokens for your voice translation. '
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
        "You don't have Tokens in your wallet to listen to live translation. "
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

  // ── Tokens pop-ups + in-call top-up ─────────────────────────────────────

  Future<void> _fundsDialog(String message, {String? retryLang, bool resume = false}) async {
    if (!mounted) return;
    await showDialog<void>(
      context: context,
      builder: (dCtx) => AlertDialog(
        backgroundColor: Zine.paper,
        shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(Zine.r),
            side: const BorderSide(color: Zine.ink, width: Zine.bw)),
        title: Row(children: [
          ZineIconBadge(icon: PhosphorIcons.coins(PhosphorIconsStyle.bold), color: Zine.mint),
          const SizedBox(width: 10),
          Expanded(child: Text('Tokens needed', style: ZineText.cardTitle(size: 17))),
        ]),
        content: Text(message, style: ZineText.sub(size: 14.5)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dCtx),
              child: Text('NOT NOW', style: ZineText.tag(size: 12, color: Zine.inkSoft))),
          ZineButton(
            label: 'Top up wallet',
            fontSize: 16,
            onPressed: () async {
              Navigator.pop(dCtx);
              final done = await _topupSheet();
              if (!mounted || !done) return;
              if (resume) {
                final ok = await _engine.resume();
                if (!ok && mounted) _snack('Top-up not confirmed yet — tap Translate again once your Tokens arrive.');
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
        decoration: BoxDecoration(
          color: Zine.paper,
          borderRadius: const BorderRadius.vertical(top: Radius.circular(Zine.r)),
          border: const Border(top: BorderSide(color: Zine.ink, width: Zine.bw)),
        ),
        padding: EdgeInsets.fromLTRB(20, 16, 20, 20 + MediaQuery.of(sCtx).viewPadding.bottom),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Top up Tokens', style: ZineText.cardTitle()),
          const SizedBox(height: 6),
          const ZineSticker('\$3 PER HOUR · 5 TOKENS / MIN', kind: ZineStickerKind.hint),
          const SizedBox(height: 14),
          Wrap(spacing: 10, runSpacing: 10, children: [
            for (final usd in const [3, 5, 10, 20])
              ZineSticker(
                '\$$usd',
                kind: ZineStickerKind.ok, // lime = pay action on a paper sheet
                onTap: () => Navigator.pop(sCtx, usd * 100),
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
        backgroundColor: Zine.paper,
        shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(Zine.r),
            side: const BorderSide(color: Zine.ink, width: Zine.bw)),
        title: Text('Finish the top-up', style: ZineText.cardTitle(size: 17)),
        content: Text('Complete the payment in your browser, then come back and tap Done.',
            style: ZineText.sub(size: 14.5)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dCtx, false),
              child: Text('CANCEL', style: ZineText.tag(size: 12, color: Zine.inkSoft))),
          ZineButton(label: 'Done', fontSize: 16, onPressed: () => Navigator.pop(dCtx, true)),
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
          // The "Translate" pill — ink-bordered card pill, lilac when active (AI).
          GestureDetector(
            onTap: _busy ? null : (active ? _stop : _openMenu),
            onLongPress: active ? _openMenu : null,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
              decoration: BoxDecoration(
                color: active ? Zine.lilac : Zine.card,
                borderRadius: BorderRadius.circular(100),
                border: Border.all(color: Zine.ink, width: Zine.bw),
                boxShadow: Zine.shadowXs,
              ),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                _busy || s == TranslationState.connecting
                    ? const SizedBox(width: 16, height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2, color: Zine.ink))
                    : PhosphorIcon(PhosphorIcons.translate(PhosphorIconsStyle.bold), color: Zine.ink, size: 17),
                const SizedBox(width: 6),
                Text(
                  active ? '${translationLangLabel(lang ?? '')} · tap to stop' : 'Translate',
                  style: ZineText.value(size: 13, color: Zine.ink, weight: FontWeight.w700),
                ),
              ]),
            ),
          ),
          if (active)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: ValueListenableBuilder<int>(
                valueListenable: _engine.billedMinutes,
                builder: (_, min, __) => Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  decoration: BoxDecoration(
                    color: Zine.card,
                    borderRadius: BorderRadius.circular(100),
                    border: Border.all(color: Zine.ink, width: 2),
                    boxShadow: Zine.shadowXs,
                  ),
                  child: Text(
                    '$min MIN · ${TranslationApi.quoteCoins(min)} TOKENS (\$3/H)',
                    style: ZineText.tag(size: 10.5, color: Zine.inkSoft),
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
      decoration: const BoxDecoration(
        color: Zine.paper,
        borderRadius: BorderRadius.vertical(top: Radius.circular(Zine.r)),
        border: Border(top: BorderSide(color: Zine.ink, width: Zine.bw)),
      ),
      padding: const EdgeInsets.fromLTRB(20, 14, 20, 0),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Center(child: Container(width: 36, height: 4, margin: const EdgeInsets.only(bottom: 12),
            decoration: BoxDecoration(color: Zine.inkMute, borderRadius: BorderRadius.circular(2)))),
        Row(children: [
          ZineIconBadge(icon: PhosphorIcons.translate(PhosphorIconsStyle.bold), color: Zine.lilac),
          const SizedBox(width: 10),
          Expanded(child: Text('Select language', style: ZineText.cardTitle())),
        ]),
        const SizedBox(height: 6),
        Text('Incoming voice translated live · \$3 per hour in Tokens',
            style: ZineText.sub(size: 13)),
        const SizedBox(height: 10),
        ZineField(
          controller: _search,
          hint: 'Search 70+ languages',
          leadIcon: PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold),
          onChanged: (v) => setState(() => _q = v.trim().toLowerCase()),
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
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Zine.rSm)),
                tileColor: sel ? Zine.lilac : null,
                title: Text(l.label,
                    style: ZineText.value(size: 14.5, weight: sel ? FontWeight.w800 : FontWeight.w600)),
                trailing: sel
                    ? PhosphorIcon(PhosphorIcons.check(PhosphorIconsStyle.bold), color: Zine.ink, size: 18)
                    : null,
                onTap: () => Navigator.pop(context, l.code),
              );
            },
          ),
        ),
      ]),
    );
  }
}
