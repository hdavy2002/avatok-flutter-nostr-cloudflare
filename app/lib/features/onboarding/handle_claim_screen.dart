import 'dart:async';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/guest_session.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';

/// L0 entry — the FIRST thing a new user sees (Trust Ladder, §3).
/// One field: pick a unique @handle. It is reserved server-side immediately
/// (guest token), then the visitor walks STRAIGHT into the app to browse as an
/// L0 guest. No sign-up wall — an account is only asked for later, when an
/// action needs one (AccountGate). Time-to-app target: under 15 seconds.
///
/// Visuals: AvaTOK design system ("Pick Your Handle" reference screen) —
/// crest hero, @-field with lime prefix cell, availability stickers,
/// suggestion chips when taken, full-screen lime-seal success overlay.
class HandleClaimScreen extends StatefulWidget {
  /// A handle was claimed (or already reserved) → enter the app as a guest.
  final VoidCallback onClaimed;

  /// "already on AvaTOK? log in" → go to sign-in.
  final VoidCallback onHaveAccount;
  const HandleClaimScreen({super.key, required this.onClaimed, required this.onHaveAccount});
  @override
  State<HandleClaimScreen> createState() => _HandleClaimScreenState();
}

class _HandleClaimScreenState extends State<HandleClaimScreen> {
  final _ctrl = TextEditingController();
  Timer? _debounce;
  bool _checking = false;
  bool? _avail;
  String? _msg;
  bool _reserving = false;
  bool _claimed = false;

  @override
  void initState() {
    super.initState();
    Analytics.capture('handle_claim_viewed', const {});
    // Already reserved on this device? Skip straight through.
    GuestSession.reservedHandle().then((h) {
      if (h != null && h.isNotEmpty && mounted) widget.onClaimed();
    });
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _ctrl.dispose();
    super.dispose();
  }

  String get _clean => _ctrl.text.trim().toLowerCase();

  void _onChanged(String v) {
    _debounce?.cancel();
    setState(() { _avail = null; _msg = null; _checking = v.trim().isNotEmpty; });
    if (v.trim().isEmpty) { setState(() => _checking = false); return; }
    _debounce = Timer(const Duration(milliseconds: 400), () async {
      final r = await GuestSession.checkHandle(_ctrl.text);
      if (!mounted) return;
      setState(() { _checking = false; _avail = r.ok; _msg = r.ok ? null : (r.message ?? 'Taken'); });
    });
  }

  Future<void> _claim() async {
    if (_avail != true || _reserving) return;
    setState(() => _reserving = true);
    final r = await GuestSession.reserve(_ctrl.text);
    if (!mounted) return;
    setState(() => _reserving = false);
    if (r.ok) {
      Analytics.capture('handle_claimed', const {});
      setState(() => _claimed = true); // "It's yours!" seal, then keep going
    } else {
      setState(() { _avail = false; _msg = r.message; });
    }
  }

  List<String> get _suggestions {
    final b = _clean;
    if (b.isEmpty) return const [];
    return ['${b}_', '${b}x', 'real$b', '${b}26'];
  }

  @override
  Widget build(BuildContext context) {
    if (_claimed) {
      return Scaffold(
        body: ZineSuccessOverlay(
          icon: Icons.verified_rounded,
          headline: "It's yours!",
          accentLine: '@$_clean',
          sub: "Locked in and reserved. Let's set up the rest of you.",
          ctaLabel: 'Keep going',
          onCta: widget.onClaimed,
        ),
      );
    }

    final canPop = Navigator.of(context).canPop();
    return Scaffold(
      body: ZinePaper(
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(24, 12, 24, 24),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              // head: back (if any) + step pips
              Row(
                mainAxisAlignment:
                    canPop ? MainAxisAlignment.spaceBetween : MainAxisAlignment.end,
                children: [
                  if (canPop) const ZineBackButton(),
                  const ZineStepPips(total: 3, active: 1),
                ],
              ),
              Expanded(
                child: SingleChildScrollView(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    const SizedBox(height: 34),
                    const Center(child: ZineCrest()),
                    const SizedBox(height: 14),
                    const ZineMarkTitle(pre: 'Pick your ', mark: 'handle', fontSize: 38),
                    const SizedBox(height: 14),
                    Center(
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 300),
                        child: Text.rich(
                          TextSpan(
                            text: "That's all we need for now — it's reserved instantly, and it's ",
                            children: [
                              TextSpan(
                                  text: 'yours to own.',
                                  style: ZineText.sub().copyWith(
                                      fontWeight: FontWeight.w900, color: Zine.ink)),
                            ],
                          ),
                          style: ZineText.sub(),
                          textAlign: TextAlign.center,
                        ),
                      ),
                    ),
                    const SizedBox(height: 34),
                    ZineField(
                      controller: _ctrl,
                      label: 'your handle',
                      labelIcon: PhosphorIcons.at(PhosphorIconsStyle.bold),
                      hint: 'yourname',
                      leadText: '@',
                      autofocus: true,
                      maxLength: 20,
                      error: _avail == false,
                      onChanged: _onChanged,
                      onSubmitted: (_) => _claim(),
                    ),
                    const SizedBox(height: 12),
                    _statusLine(),
                    if (_avail == false && _msg != null) ...[
                      const SizedBox(height: 14),
                      Wrap(spacing: 8, runSpacing: 8, children: [
                        for (final s in _suggestions)
                          ZineSticker('@$s', onTap: () {
                            _ctrl.text = s;
                            _onChanged(s);
                          }),
                      ]),
                    ],
                    const SizedBox(height: 22),
                  ]),
                ),
              ),
              ZineButton(
                label: 'Claim my handle',
                icon: PhosphorIcons.arrowRight(PhosphorIconsStyle.bold),
                fullWidth: true,
                fontSize: 21,
                loading: _reserving,
                onPressed: _avail == true && !_reserving ? _claim : null,
              ),
              const SizedBox(height: 18),
              Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                Text('already on AvaTOK? ', style: ZineText.tag(size: 14, color: Zine.inkSoft)),
                ZineLink('log in', onTap: widget.onHaveAccount, fontSize: 14),
              ]),
              const SizedBox(height: 16),
              Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                PhosphorIcon(PhosphorIcons.lockKey(PhosphorIconsStyle.fill),
                    size: 14, color: Zine.blueInk),
                const SizedBox(width: 8),
                Text('reserved instantly · no email yet', style: ZineText.kicker()),
              ]),
            ]),
          ),
        ),
      ),
    );
  }

  Widget _statusLine() {
    final v = _clean;
    Widget sticker;
    if (_checking) {
      sticker = ZineSticker('checking…',
          kind: ZineStickerKind.hint,
          icon: PhosphorIcons.dotsThree(PhosphorIconsStyle.bold));
    } else if (v.isEmpty) {
      sticker = ZineSticker('3–20 letters, numbers or _',
          kind: ZineStickerKind.hint,
          icon: PhosphorIcons.pencilSimple(PhosphorIconsStyle.fill));
    } else if (_avail == true) {
      sticker = ZineSticker('@$v is available',
          kind: ZineStickerKind.ok,
          icon: PhosphorIcons.checkCircle(PhosphorIconsStyle.fill));
    } else if (_avail == false) {
      sticker = ZineSticker(_msg == null || _msg == 'Taken' ? '@$v is taken' : _msg!,
          kind: ZineStickerKind.no,
          icon: PhosphorIcons.xCircle(PhosphorIconsStyle.fill));
    } else {
      sticker = ZineSticker('keep going — min 3 chars',
          kind: ZineStickerKind.hint,
          icon: PhosphorIcons.dotsThree(PhosphorIconsStyle.bold));
    }
    return Row(children: [
      Flexible(child: sticker),
      const Spacer(),
      if (v.isNotEmpty)
        Text.rich(
          TextSpan(text: 'avatok.me/', children: [
            TextSpan(text: v, style: ZineText.tag(size: 12, color: Zine.blueInk)),
          ]),
          style: ZineText.tag(size: 12, color: Zine.inkSoft),
        ),
    ]);
  }
}
