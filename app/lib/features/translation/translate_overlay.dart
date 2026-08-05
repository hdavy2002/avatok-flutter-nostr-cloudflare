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
// [UI-ZINE-DARK-1] Dark v2. AI still reads as lilac, but it is now the dark
// system's SATURATED lilac carrying WHITE ink — the old pale `Zine.lilac` chip
// with near-black `Zine.ink` on it would have inverted into black-on-black.
// Sheets/dialogs sit on `AD.overlaySheet` / `AD.popover`.
import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/money_api.dart';
import '../../core/remote_config.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/zine_widgets.dart';
import 'translation_api.dart';
import 'translation_engine.dart';
import 'translation_langs.dart';

/// AI accent for this surface — the dark system's saturated lilac. Not `const`
/// (`familyByName` is a lookup), so it can't sit in a `const` constructor.
final Color _aiAccent = AD.familyByName('lilac').solid;

/// Money/top-up accent (the coins badge).
final Color _coinAccent = AD.familyByName('mint').solid;

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
      // Pop-up #2 — Tokens ran out mid-call.
      _fundsDialog(
        'You have utilized your Tokens for your voice translation. '
        'Please top up your wallet to add some more Tokens.',
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
        backgroundColor: AD.popover,
        shape: RoundedRectangleBorder(
            borderRadius: Msg.brLg,
            side: const BorderSide(color: AD.borderControl, width: 1)),
        title: Row(children: [
          ZineIconBadge(
              icon: PhosphorIcons.coins(PhosphorIconsStyle.fill),
              color: _coinAccent),
          const SizedBox(width: Msg.s3),
          Expanded(
              child: Text('Tokens needed',
                  style: ADText.threadName().copyWith(fontSize: 17))),
        ]),
        content: Text(message,
            style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 14)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dCtx),
              child: Text('Not now',
                  style: ADText.tabLabel(c: AD.textSecondary)
                      .copyWith(fontSize: 13))),
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
        decoration: const BoxDecoration(
          color: AD.overlaySheet,
          borderRadius: Msg.brSheetTop,
          border: Border(top: BorderSide(color: AD.borderHairline, width: 1)),
        ),
        padding: EdgeInsets.fromLTRB(Msg.s5, Msg.s4, Msg.s5, 20 + MediaQuery.of(sCtx).viewPadding.bottom),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Top up Tokens',
              style: ADText.threadName().copyWith(fontSize: 19)),
          const SizedBox(height: Msg.s1),
          const ZineSticker('\$3 per hour · 5 tokens / min',
              kind: ZineStickerKind.hint),
          const SizedBox(height: Msg.s4),
          Wrap(spacing: Msg.s3, runSpacing: Msg.s3, children: [
            for (final usd in const [3, 5, 10, 20])
              ZineSticker(
                '\$$usd',
                kind: ZineStickerKind.ok, // the pay action
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
        backgroundColor: AD.popover,
        shape: RoundedRectangleBorder(
            borderRadius: Msg.brLg,
            side: const BorderSide(color: AD.borderControl, width: 1)),
        title: Text('Finish the top-up',
            style: ADText.threadName().copyWith(fontSize: 17)),
        content: Text('Complete the payment in your browser, then come back and tap Done.',
            style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 14)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dCtx, false),
              child: Text('Cancel',
                  style: ADText.tabLabel(c: AD.textSecondary)
                      .copyWith(fontSize: 13))),
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
          // The "Translate" toggle chip — card surface, saturated lilac when
          // active (AI). A toggle chip IS one of the shapes Msg.rPill covers.
          //
          // [UI-ZINE-DARK-1] INVERTED USE CAUGHT: both fills were LIGHT
          // (`Zine.lilac` / `Zine.card`) and the glyph + label were near-BLACK
          // `Zine.ink`. Straight token-swapping the ink to white would have put
          // white on a near-white chip. Both fills went dark, and the ink went
          // white — which clears 4.5:1 against AD.card AND against the lilac
          // solid, so one ink colour serves both states.
          GestureDetector(
            onTap: _busy ? null : (active ? _stop : _openMenu),
            onLongPress: active ? _openMenu : null,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: Msg.s4, vertical: Msg.s3),
              decoration: BoxDecoration(
                color: active ? _aiAccent : AD.card,
                borderRadius: Msg.brPill,
                border: Border.all(
                    color: active ? _aiAccent : AD.borderControl, width: 1),
                // Floats over live video — Msg.lift is the one permitted shadow.
                boxShadow: Msg.lift,
              ),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                _busy || s == TranslationState.connecting
                    ? const SizedBox(width: 16, height: 16,
                        child: CircularProgressIndicator(
                            strokeWidth: 2, color: AD.textPrimary))
                    : PhosphorIcon(
                        PhosphorIcons.translate(PhosphorIconsStyle.regular),
                        color: AD.textPrimary, size: 17),
                const SizedBox(width: Msg.s1),
                Text(
                  active ? '${translationLangLabel(lang ?? '')} · tap to stop' : 'Translate',
                  style: ADText.rowName(c: AD.textPrimary).copyWith(fontSize: 13),
                ),
              ]),
            ),
          ),
          if (active)
            Padding(
              padding: const EdgeInsets.only(top: Msg.s1),
              child: ValueListenableBuilder<int>(
                valueListenable: _engine.billedMinutes,
                builder: (_, min, __) => Container(
                  padding: const EdgeInsets.symmetric(
                      horizontal: Msg.s3, vertical: Msg.s1),
                  decoration: BoxDecoration(
                    color: AD.card,
                    // A status badge IS one of the Msg.rPill shapes.
                    borderRadius: Msg.brPill,
                    border: Border.all(color: AD.borderControl, width: 1),
                    boxShadow: Msg.lift,
                  ),
                  child: Text(
                    '$min min · ${TranslationApi.quoteCoins(min)} tokens (\$3/h)',
                    style: ADText.statCaption(c: AD.textSecondary),
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
        color: AD.overlaySheet,
        borderRadius: Msg.brSheetTop,
        border: Border(top: BorderSide(color: AD.borderHairline, width: 1)),
      ),
      padding: const EdgeInsets.fromLTRB(Msg.s5, Msg.s4, Msg.s5, 0),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        // The sheet drag handle is genuinely a pill.
        Center(
            child: Container(
                width: 36, height: 4,
                margin: const EdgeInsets.only(bottom: Msg.s3),
                decoration: BoxDecoration(
                    color: AD.textTertiary, borderRadius: Msg.brPill))),
        Row(children: [
          ZineIconBadge(
              icon: PhosphorIcons.translate(PhosphorIconsStyle.fill),
              color: _aiAccent),
          const SizedBox(width: Msg.s3),
          Expanded(
              child: Text('Select language',
                  style: ADText.threadName().copyWith(fontSize: 19))),
        ]),
        const SizedBox(height: Msg.s1),
        Text('Incoming voice translated live · \$3 per hour in Tokens',
            style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 13)),
        const SizedBox(height: Msg.s3),
        ZineField(
          controller: _search,
          hint: 'Search 70+ languages',
          leadIcon: PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.regular),
          onChanged: (v) => setState(() => _q = v.trim().toLowerCase()),
        ),
        const SizedBox(height: Msg.s1),
        Expanded(
          child: ListView.builder(
            itemCount: list.length,
            itemBuilder: (_, i) {
              final l = list[i];
              final sel = l.code == widget.current;
              // Selected row = raised surface + an accent check, the messenger
              // idiom. It used to be a PALE lilac tile with near-black ink —
              // keeping that fill on a dark sheet would have needed a second
              // ink colour for one row. Weight (600 vs 400) carries the state.
              return ListTile(
                dense: true,
                shape: RoundedRectangleBorder(borderRadius: Msg.brMd),
                tileColor: sel ? AD.cardHover : null,
                title: Text(l.label,
                    style: sel
                        ? ADText.rowName(c: AD.textPrimary)
                        : ADText.bubbleBody(c: AD.textPrimary)),
                trailing: sel
                    ? PhosphorIcon(PhosphorIcons.check(PhosphorIconsStyle.regular),
                        color: Msg.accent, size: 18)
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
