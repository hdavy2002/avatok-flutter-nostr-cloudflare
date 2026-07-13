import 'dart:async';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/feature_flags.dart';
import '../../core/money_api.dart';
import '../../core/paid_call_api.dart';
import '../../core/remote_config.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';

/// Paid-call pre-connect prompt (Specs/PLAN-2026-07-11-dialpad-business-calls-
/// ava-voice-agent.md §3B, Phase B2). Shown to the CALLER before connecting,
/// for either a human paid line or a paid AI agent. Full-screen, Ava-styled:
/// price/min → callee's length options → computed total → wallet check →
/// Confirm/Cancel. Gated on [RemoteConfig.paidCalls] by the caller (dialpad
/// `_dial()` flow) — this widget itself does not re-check the flag so it can
/// also be unit/preview-tested in isolation.
///
/// On Confirm, this screen validates the quote ([PaidCallApi.prepare]) and then
/// does the wallet hold + billing-ticker arm ([PaidCallApi.confirm], server
/// contract: confirmPaidCallRoute holds escrow keyed by call_id) — so a
/// low-balance caller sees the "top up or pick a shorter length" state before
/// Navigator ever pops. The caller flow is responsible for calling
/// [PaidCallApi.cancel] with the same callId if it aborts after this screen
/// already produced a hold (identity-gate 403, abandoned dial — §11 also
/// auto-refunds server-side on RING_TIMEOUT, this is belt-and-braces).
class PaidCallPromptResult {
  final int minutes;
  /// The call_id the escrow hold is keyed to (== the CallRoom id). Kept under
  /// the historical `holdId` name so existing call sites read unchanged.
  final String holdId;
  const PaidCallPromptResult({required this.minutes, required this.holdId});
}

/// Push this route before dialing when [PaidCallApi.offer] returns a non-null
/// offer for the number being called. [calleeUid] is the resolved account the
/// escrow settles to; [callId] the CallRoom id the dial will use. Returns null
/// if the caller cancels.
Future<PaidCallPromptResult?> showPaidCallPrompt(
  BuildContext context, {
  required PaidCallOffer offer,
  required String to,
  required String calleeUid,
  required String callId,
  String? serviceId,
}) {
  return Navigator.of(context).push<PaidCallPromptResult>(
    MaterialPageRoute(
      fullscreenDialog: true,
      builder: (_) => PaidCallPromptScreen(
          offer: offer, to: to, calleeUid: calleeUid, callId: callId, serviceId: serviceId),
    ),
  );
}

class PaidCallPromptScreen extends StatefulWidget {
  final PaidCallOffer offer;
  final String to;
  final String calleeUid;
  final String callId;
  final String? serviceId;
  const PaidCallPromptScreen({
    super.key, required this.offer, required this.to,
    required this.calleeUid, required this.callId, this.serviceId,
  });

  @override
  State<PaidCallPromptScreen> createState() => _PaidCallPromptScreenState();
}

class _PaidCallPromptScreenState extends State<PaidCallPromptScreen> {
  int? _selectedMinutes;
  int _balance = 0;
  bool _loadingBalance = true;
  bool _confirming = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    if (widget.offer.lengthOptions.isNotEmpty) {
      _selectedMinutes = widget.offer.lengthOptions.first;
    }
    Analytics.capture('paid_call_offer_shown', {
      'to': widget.to, 'rate': widget.offer.rate, 'is_agent': widget.offer.isAgent,
    });
    _loadBalance();
  }

  Future<void> _loadBalance() async {
    final b = await MoneyApi.balance();
    if (!mounted) return;
    setState(() {
      _balance = (b['balance'] as num?)?.toInt() ?? (b['coins'] as num?)?.toInt() ?? 0;
      _loadingBalance = false;
    });
  }

  int get _total => widget.offer.totalFor(_selectedMinutes ?? 0);
  bool get _canAfford => !_loadingBalance && _balance >= _total;

  Future<void> _confirm() async {
    final mins = _selectedMinutes;
    if (mins == null || _confirming) return;
    setState(() { _confirming = true; _error = null; });
    Analytics.capture('duration_selected', {'to': widget.to, 'minutes': mins});
    Analytics.capture('wallet_check', {'to': widget.to, 'minutes': mins, 'total': _total});
    // Server contract (call_billing_routes.ts): prepare = quote/validation
    // only; confirm = the actual escrow hold + CallRoom billing-ticker arm,
    // keyed by call_id. Both run here so a low-balance caller sees the error
    // in-place instead of after the sheet already popped.
    final quote = await PaidCallApi.prepare(
      callee: widget.calleeUid, minutes: mins, callId: widget.callId,
    );
    if (!mounted) return;
    if (quote['ok'] != true) {
      setState(() {
        _confirming = false;
        _error = 'Couldn’t start the call — try again.';
      });
      Analytics.capture('wallet_passed', {'to': widget.to, 'ok': false, 'reason': (quote['error'] ?? '').toString()});
      return;
    }
    final res = await PaidCallApi.confirm(
      callee: widget.calleeUid, minutes: mins, callId: widget.callId,
    );
    if (!mounted) return;
    if (res['ok'] != true) {
      final reason = (res['reason'] ?? res['error'] ?? '').toString();
      setState(() {
        _confirming = false;
        _error = reason == 'WALLET_INSUFFICIENT'
            ? 'Not enough tokens for $mins min. Pick a shorter length or top up.'
            : 'Couldn’t start the call — try again.';
      });
      Analytics.capture('wallet_passed', {'to': widget.to, 'ok': false, 'reason': reason});
      return;
    }
    Analytics.capture('wallet_passed', {'to': widget.to, 'ok': true});
    Analytics.capture('escrow_created', {'to': widget.to, 'minutes': mins, 'total': _total});
    if (!mounted) return;
    Navigator.of(context).pop(PaidCallPromptResult(minutes: mins, holdId: widget.callId));
  }

  @override
  Widget build(BuildContext context) {
    final o = widget.offer;
    return Scaffold(
      backgroundColor: AD.bg,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Row(children: [
              ZineIconBadge(icon: PhosphorIcons.coins(PhosphorIconsStyle.fill), color: AD.incomingCall, size: 44),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(o.isAgent ? 'Paid Ava AI call' : 'Paid call', style: ADText.threadName()),
                  if (o.calleeName.isNotEmpty)
                    Text(o.calleeName, style: ADText.preview()),
                ]),
              ),
            ]),
            const SizedBox(height: 20),
            AdCard(
              radius: AD.rListCard,
              boxShadow: const [],
              color: AD.card,
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('This call costs ${o.rate} tokens per minute.', style: ADText.rowName()),
                const SizedBox(height: 4),
                Text('You’ll only be charged for the minutes you actually use — anything unused is refunded.',
                    style: ADText.preview()),
              ]),
            ),
            const SizedBox(height: 18),
            Text('CHOOSE A LENGTH', style: ADText.sectionLabel()),
            const SizedBox(height: 9),
            Wrap(spacing: 8, runSpacing: 8, children: [
              for (final m in o.lengthOptions)
                AdChip(
                  label: '$m min',
                  active: _selectedMinutes == m,
                  onTap: () => setState(() { _selectedMinutes = m; _error = null; }),
                ),
            ]),
            const SizedBox(height: 20),
            AdCard(
              radius: AD.rListCard,
              boxShadow: const [],
              color: AD.headerFooter,
              child: Row(children: [
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text('Total', style: ADText.preview()),
                    Text('$_total tokens', style: ADText.rowName()),
                  ]),
                ),
                if (_loadingBalance)
                  const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                else
                  Text('Balance: $_balance', style: ADText.preview(
                      c: _canAfford ? AD.textSecondary : AD.danger)),
              ]),
            ),
            // [PLAN §11] "Escrow is a HOLD, never an immediate charge" — spelled
            // out explicitly under the total so the caller never mistakes the
            // hold for a charge before anyone's even answered.
            const SizedBox(height: 8),
            Text(
              'Tokens are only held now — charging starts when the call is answered. '
              'Unused minutes are refunded automatically.',
              textAlign: TextAlign.center,
              style: ADText.preview(),
            ),
            if (_error != null) ...[
              const SizedBox(height: 10),
              AdErrorMsg(_error!),
            ],
            const Spacer(),
            AdButton(
              label: _confirming ? 'Confirming…' : 'Confirm & call',
              loading: _confirming,
              fullWidth: true,
              onPressed: (_selectedMinutes == null || _confirming || (!_loadingBalance && !_canAfford))
                  ? null
                  : _confirm,
            ),
            // ZineButton has no subtitle slot — the same reassurance repeated
            // briefly just under the button, right where the tap happens.
            const SizedBox(height: 6),
            Text(
              'Tokens are held, not charged, until the call connects.',
              textAlign: TextAlign.center,
              style: ADText.preview(),
            ),
            const SizedBox(height: 10),
            AdButton(
              label: 'Cancel',
              variant: AdButtonVariant.ghost,
              fullWidth: true,
              onPressed: _confirming ? null : () {
                Analytics.capture('paid_call_prompt_abandoned', {'to': widget.to});
                Navigator.of(context).pop();
              },
            ),
          ]),
        ),
      ),
    );
  }
}

/// End-of-time local beeps (§3B "Beep tones near the end warn the caller"). Both
/// clients know the agreed duration, so each schedules its OWN warning beeps at
/// T-60s and T-10s — purely local, no server audio touches the P2P media (see
/// the P2P-constraint note in the plan). Call [start] once the paid call
/// connects with the agreed [minutes]; call [cancel] on any call-end path.
class CallCountdown {
  Timer? _t60;
  Timer? _t10;
  final AudioPlayer _player = AudioPlayer();
  bool _disposed = false;

  static String _assetRel(String p) => p.startsWith('assets/') ? p.substring(7) : p;

  void start(int minutes) {
    cancel();
    final total = Duration(minutes: minutes);
    final at60 = total - const Duration(seconds: 60);
    final at10 = total - const Duration(seconds: 10);
    if (!at60.isNegative) _t60 = Timer(at60, () => _beep('60s left'));
    if (!at10.isNegative) _t10 = Timer(at10, () => _beep('10s left'));
  }

  Future<void> _beep(String label) async {
    if (_disposed) return;
    try {
      // Reuse the app's existing short call-tone asset (busy_tone.wav) as the
      // warning beep — same audioplayers/AssetSource pattern as RingbackPlayer.
      // TODO: swap in a dedicated short "end-of-time" beep asset once designed;
      // the busy tone is close enough in length/character for the MVP warning.
      await _player.setReleaseMode(ReleaseMode.release);
      await _player.play(AssetSource(_assetRel(kBusyToneAsset)));
    } catch (_) {
      // Fallback if the asset can't play for any reason — still gives the
      // caller SOME signal that time is running out.
      // TODO: replace with a purpose-built beep; SystemSound is a stand-in.
      unawaited(SystemSound.play(SystemSoundType.alert));
    }
  }

  void cancel() {
    _t60?.cancel();
    _t10?.cancel();
    _t60 = null;
    _t10 = null;
  }

  void dispose() {
    _disposed = true;
    cancel();
    _player.dispose();
  }
}
