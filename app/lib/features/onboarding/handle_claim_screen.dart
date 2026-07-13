import 'dart:async';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/guest_session.dart';
import '../../core/ui/avatok_dark.dart';
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
        body: Container(
          color: AD.bg,
          child: SafeArea(child: Center(child: Padding(
            padding: const EdgeInsets.all(40),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              Container(
                width: 120, height: 120,
                decoration: BoxDecoration(shape: BoxShape.circle, color: AD.primaryBadge, boxShadow: AD.overlayShadow),
                child: const Icon(Icons.verified_rounded, size: 56, color: Colors.white),
              ),
              const SizedBox(height: 24),
              Text("It's yours!", style: ADText.appTitle().copyWith(fontSize: 34), textAlign: TextAlign.center),
              const SizedBox(height: 10),
              Text('@$_clean', style: ADText.rowName(c: AD.iconSearch)),
              const SizedBox(height: 12),
              ConstrainedBox(constraints: const BoxConstraints(maxWidth: 280),
                child: Text("Locked in and reserved. Let's set up the rest of you.",
                    style: ADText.preview(c: AD.textSecondary), textAlign: TextAlign.center)),
              const SizedBox(height: 26),
              AdButton(label: 'Keep going', onPressed: widget.onClaimed,
                  icon: PhosphorIcons.arrowRight(PhosphorIconsStyle.bold)),
            ]),
          ))),
        ),
      );
    }

    final canPop = Navigator.of(context).canPop();
    return Scaffold(
      body: Container(
        color: AD.bg,
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(24, 12, 24, 24),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              // head: back (if any) + step pips
              Row(
                mainAxisAlignment:
                    canPop ? MainAxisAlignment.spaceBetween : MainAxisAlignment.end,
                children: [
                  if (canPop) const AdBackButton(),
                  Row(mainAxisSize: MainAxisSize.min, children: [
                    for (var i = 1; i <= 3; i++) ...[
                      Container(width: 9, height: 9, decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: i == 1 ? AD.primaryBadge : AD.card,
                        border: Border.all(color: AD.borderControl, width: 1))),
                      const SizedBox(width: 7),
                    ],
                    const SizedBox(width: 4),
                    Text('STEP 1 / 3', style: ADText.sectionLabel()),
                  ]),
                ],
              ),
              Expanded(
                child: SingleChildScrollView(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    const SizedBox(height: 34),
                    Center(
                      child: Container(
                        width: 116, height: 116,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: AD.card,
                          border: Border.all(color: AD.borderControl, width: 1),
                          boxShadow: AD.overlayShadow,
                        ),
                        child: Center(
                          child: PhosphorIcon(PhosphorIcons.sparkle(PhosphorIconsStyle.fill),
                              size: 46, color: AD.primaryBadge),
                        ),
                      ),
                    ),
                    const SizedBox(height: 14),
                    Text.rich(
                      TextSpan(children: [
                        const TextSpan(text: 'Pick your '),
                        TextSpan(text: 'handle', style: const TextStyle(color: AD.primaryBadge)),
                      ]),
                      textAlign: TextAlign.center,
                      style: ADText.appTitle().copyWith(fontSize: 38, height: 1.08),
                    ),
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
                                  style: ADText.preview(c: AD.textSecondary).copyWith(
                                      fontWeight: FontWeight.w900, color: AD.textPrimary)),
                            ],
                          ),
                          style: ADText.preview(c: AD.textSecondary),
                          textAlign: TextAlign.center,
                        ),
                      ),
                    ),
                    const SizedBox(height: 34),
                    AdField(
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
                          AdSticker('@$s', onTap: () {
                            _ctrl.text = s;
                            _onChanged(s);
                          }),
                      ]),
                    ],
                    const SizedBox(height: 22),
                  ]),
                ),
              ),
              AdButton(
                label: 'Claim my handle',
                icon: PhosphorIcons.arrowRight(PhosphorIconsStyle.bold),
                fullWidth: true,
                fontSize: 21,
                loading: _reserving,
                onPressed: _avail == true && !_reserving ? _claim : null,
              ),
              const SizedBox(height: 18),
              Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                Text('already on AvaTOK? ', style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 14)),
                ZineLink('log in', onTap: widget.onHaveAccount, fontSize: 14, underline: AD.iconSearch),
              ]),
              const SizedBox(height: 16),
              Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                PhosphorIcon(PhosphorIcons.lockKey(PhosphorIconsStyle.fill),
                    size: 14, color: AD.iconSearch),
                const SizedBox(width: 8),
                Text('reserved instantly · no email yet', style: ADText.sectionLabel(c: AD.textTertiary)),
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
      sticker = AdSticker('checking…',
          kind: AdStickerKind.hint,
          icon: PhosphorIcons.dotsThree(PhosphorIconsStyle.bold));
    } else if (v.isEmpty) {
      sticker = AdSticker('3–20 letters, numbers or _',
          kind: AdStickerKind.hint,
          icon: PhosphorIcons.pencilSimple(PhosphorIconsStyle.fill));
    } else if (_avail == true) {
      sticker = AdSticker('@$v is available',
          kind: AdStickerKind.ok,
          icon: PhosphorIcons.checkCircle(PhosphorIconsStyle.fill));
    } else if (_avail == false) {
      sticker = AdSticker(_msg == null || _msg == 'Taken' ? '@$v is taken' : _msg!,
          kind: AdStickerKind.no,
          icon: PhosphorIcons.xCircle(PhosphorIconsStyle.fill));
    } else {
      sticker = AdSticker('keep going — min 3 chars',
          kind: AdStickerKind.hint,
          icon: PhosphorIcons.dotsThree(PhosphorIconsStyle.bold));
    }
    return Row(children: [
      Flexible(child: sticker),
      const Spacer(),
      if (v.isNotEmpty)
        Text.rich(
          TextSpan(text: 'avatok.me/', children: [
            TextSpan(text: v, style: ADText.statCaption(c: AD.iconSearch).copyWith(fontSize: 12)),
          ]),
          style: ADText.statCaption(c: AD.textTertiary).copyWith(fontSize: 12),
        ),
    ]);
  }
}
