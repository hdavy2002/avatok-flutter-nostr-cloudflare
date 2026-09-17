
import '../../core/localization/ui_text.dart';

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/guest_session.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/zine_widgets.dart';
import '../../core/ui/messenger_theme.dart';

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
    UiLocaleScope.watch(context);
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
                child: PhosphorIcon(PhosphorIcons.sealCheck(PhosphorIconsStyle.fill),
                    size: 56, color: Colors.white),
              ),
              const SizedBox(height: 24),
              UiText(UiMessage.m_it_s_yours_e4ffd474a3, style: ADText.appTitle().copyWith(fontSize: 34), textAlign: TextAlign.center),
              const SizedBox(height: Msg.s2),
              Text('@$_clean', style: ADText.rowName(c: AD.iconSearch)),
              const SizedBox(height: 12),
              ConstrainedBox(constraints: const BoxConstraints(maxWidth: 280),
                child: UiText(UiMessage.m_locked_in_and_reserved_let_fe62345337,
                    style: ADText.preview(c: AD.textSecondary), textAlign: TextAlign.center)),
              const SizedBox(height: Msg.s5),
              AdButton(label: uiCopy(UiMessage.m_keep_going_9d7fd0e0bd), onPressed: widget.onClaimed,
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
                      const SizedBox(width: Msg.s2),
                    ],
                    const SizedBox(width: 4),
                    UiText(UiMessage.m_step_1_3_8adfbfa132, style: ADText.sectionLabel()),
                  ]),
                ],
              ),
              Expanded(
                child: SingleChildScrollView(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    const SizedBox(height: Msg.s6),
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
                    const SizedBox(height: Msg.s3),
                    Text.rich(
                      TextSpan(children: [
                         TextSpan(text: uiCopy(UiMessage.m_pick_your_422d86c758)),
                        TextSpan(text: uiCopy(UiMessage.m_handle_c2a116aa91), style: const TextStyle(color: AD.primaryBadge)),
                      ]),
                      textAlign: TextAlign.center,
                      style: ADText.appTitle().copyWith(fontSize: 38, height: 1.08),
                    ),
                    const SizedBox(height: Msg.s3),
                    Center(
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 300),
                        child: Text.rich(
                          TextSpan(
                            text: uiCopy(UiMessage.m_that_s_all_we_need_400eb1bccd),
                            children: [
                              TextSpan(
                                  text: uiCopy(UiMessage.m_yours_to_own_0ad42d4005),
                                  style: ADText.preview(c: AD.textSecondary).copyWith(
                                      fontWeight: FontWeight.w700, color: AD.textPrimary)),
                            ],
                          ),
                          style: ADText.preview(c: AD.textSecondary),
                          textAlign: TextAlign.center,
                        ),
                      ),
                    ),
                    const SizedBox(height: Msg.s6),
                    AdField(
                      controller: _ctrl,
                      label: uiCopy(UiMessage.m_your_handle_c92454ecd9),
                      labelIcon: PhosphorIcons.at(PhosphorIconsStyle.bold),
                      hint: uiCopy(UiMessage.m_yourname_22f6e39681),
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
                      const SizedBox(height: Msg.s3),
                      Wrap(spacing: 8, runSpacing: 8, children: [
                        for (final s in _suggestions)
                          AdSticker('@$s', onTap: () {
                            _ctrl.text = s;
                            _onChanged(s);
                          }),
                      ]),
                    ],
                    const SizedBox(height: Msg.s5),
                  ]),
                ),
              ),
              AdButton(
                label: uiCopy(UiMessage.m_claim_my_handle_8be4546d02),
                icon: PhosphorIcons.arrowRight(PhosphorIconsStyle.bold),
                fullWidth: true,
                fontSize: 21,
                loading: _reserving,
                onPressed: _avail == true && !_reserving ? _claim : null,
              ),
              const SizedBox(height: Msg.s4),
              Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                UiText(UiMessage.m_already_on_avatok_e9f91abec6, style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 14)),
                ZineLink('log in', onTap: widget.onHaveAccount, fontSize: 14, underline: AD.iconSearch),
              ]),
              const SizedBox(height: 16),
              Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                PhosphorIcon(PhosphorIcons.lockKey(PhosphorIconsStyle.fill),
                    size: 14, color: AD.iconSearch),
                const SizedBox(width: 8),
                UiText(UiMessage.m_reserved_instantly_no_email_yet_8de1c4f769, style: ADText.sectionLabel(c: AD.textTertiary)),
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
      sticker = AdSticker(_msg == null || _msg == 'Taken' ? uiCopy(UiMessage.m_v_is_taken_9529087df2, {'v': (v).toString()}) : _msg!,
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
          TextSpan(text: uiCopy(UiMessage.m_avatok_me_462b428dc6), children: [
            TextSpan(text: v, style: ADText.statCaption(c: AD.iconSearch).copyWith(fontSize: 12)),
          ]),
          style: ADText.statCaption(c: AD.textTertiary).copyWith(fontSize: 12),
        ),
    ]);
  }
}
