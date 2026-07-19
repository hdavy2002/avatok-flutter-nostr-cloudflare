import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/analytics.dart';
import '../../../core/money_api.dart';
import '../../../core/ui/avatok_dark.dart';
import '../../../core/ui/zine_widgets.dart';
import '../../avadial/pstn_forwarding_setup.dart' show PstnForwardingSetupScreen;
import '../../wallet/wallet_screen.dart';

/// [RECEPT-ONBOARD-1] AI-Receptionist onboarding (plan §B,
/// Specs/PLAN-2026-07-19-onboarding-bonus-analytics.md — the step copy below is
/// the owner's EXACT wording; do not "improve" it).
///
/// Two entry points, both triggered from receptionist_section.dart when a
/// toggle flips ON (the toggle itself never changes state until the flow
/// completes — cancel/back = no change):
///
///   • [showReceptionistAgentOnboarding] — the multi-step AI Voice Agent
///     wizard: cost intro → balance check (≥3 tokens or top-up) → scope
///     (cell/app/all) → DID number ("Free in Beta") → forwarding conditions
///     (cell scope only; reuses [PstnForwardingSetupScreen], never rebuilt) →
///     privacy copy → token summary → save.
///   • [showReceptionistVoicemailSheet] — the one-screen Voice mail sheet
///     (1 token per voicemail) → save.
///
/// Saving is delegated to the caller via `onFinish` so this flow never has to
/// know the rest of the settings payload (the PUT overwrites every column, so
/// only receptionist_section's `_save` — which owns the full field set — may
/// talk to ReceptionistApi.saveSettings; a minimal save from here would wipe
/// the owner's note/greeting/language).
///
/// Analytics: every step entry emits `recept_onboarding_step` {step, mode} so
/// drop-off per step is visible in PostHog; `done` / `cancelled` close the
/// funnel.

/// Agent scope values — MUST match the server's allow-list in
/// worker/src/routes/receptionist.ts (anything else coerces to null = "all").
const String kAgentScopeCell = 'cell';
const String kAgentScopeApp = 'app';
const String kAgentScopeAll = 'all';

/// Opens the multi-step AI Voice Agent wizard. Returns the chosen scope
/// ('cell'|'app'|'all') after a successful save, or null when the user backed
/// out (caller must leave the toggle unchanged).
Future<String?> showReceptionistAgentOnboarding(
  BuildContext context, {
  required Future<bool> Function(String scope) onFinish,
  String initialScope = kAgentScopeAll,
}) {
  return Navigator.of(context).push<String>(MaterialPageRoute(
    fullscreenDialog: true,
    builder: (_) => _AgentOnboardingScreen(
      onFinish: onFinish,
      initialScope: initialScope,
    ),
  ));
}

/// One-screen Voice mail sheet (plan §B, voicemail-mode). Returns true after a
/// successful save; false/null = cancelled, caller leaves the toggle unchanged.
Future<bool> showReceptionistVoicemailSheet(
  BuildContext context, {
  required Future<bool> Function() onConfirm,
}) async {
  Analytics.capture('recept_onboarding_step', {'step': 'vm_cost', 'mode': 'vm'});
  final ok = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    backgroundColor: AD.overlaySheet,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(AD.rSheet)),
    ),
    builder: (ctx) => _VoicemailSheet(onConfirm: onConfirm),
  );
  Analytics.capture('recept_onboarding_step',
      {'step': ok == true ? 'done' : 'cancelled', 'mode': 'vm'});
  return ok == true;
}

class _VoicemailSheet extends StatefulWidget {
  final Future<bool> Function() onConfirm;
  const _VoicemailSheet({required this.onConfirm});
  @override
  State<_VoicemailSheet> createState() => _VoicemailSheetState();
}

class _VoicemailSheetState extends State<_VoicemailSheet> {
  bool _saving = false;

  Future<void> _continue() async {
    setState(() => _saving = true);
    final ok = await widget.onConfirm();
    if (!mounted) return;
    setState(() => _saving = false);
    if (ok) {
      Navigator.of(context).pop(true);
    } else {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Couldn’t save — check your connection and try again.')));
    }
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 10, 16, 16),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Container(
            width: 40, height: 4,
            decoration: BoxDecoration(
              color: AD.borderControl,
              borderRadius: BorderRadius.circular(100),
            ),
          ),
          const SizedBox(height: 16),
          Row(children: [
            ZineIconBadge(
                icon: PhosphorIcons.voicemail(PhosphorIconsStyle.fill),
                color: AD.iconVideo, size: 36),
            const SizedBox(width: 12),
            Expanded(child: Text('Voice mail', style: ADText.rowName())),
          ]),
          const SizedBox(height: 12),
          Align(
            alignment: Alignment.centerLeft,
            child: Text(
              'Each voicemail costs 1 token. All messages appear in your Inbox.',
              style: ADText.preview(c: AD.textPrimary),
            ),
          ),
          const SizedBox(height: 18),
          AdButton(
            label: _saving ? 'Saving…' : 'Continue',
            fullWidth: true,
            loading: _saving,
            onPressed: _saving ? null : _continue,
          ),
        ]),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Agent wizard
// ---------------------------------------------------------------------------

enum _Step { cost, balance, scope, did, forwarding, privacy, summary }

extension on _Step {
  String get analyticsName {
    switch (this) {
      case _Step.cost: return 'cost_intro';
      case _Step.balance: return 'balance_check';
      case _Step.scope: return 'scope_choice';
      case _Step.did: return 'did_number';
      case _Step.forwarding: return 'forwarding_conditions';
      case _Step.privacy: return 'privacy';
      case _Step.summary: return 'token_summary';
    }
  }
}

class _AgentOnboardingScreen extends StatefulWidget {
  final Future<bool> Function(String scope) onFinish;
  final String initialScope;
  const _AgentOnboardingScreen({required this.onFinish, required this.initialScope});
  @override
  State<_AgentOnboardingScreen> createState() => _AgentOnboardingScreenState();
}

class _AgentOnboardingScreenState extends State<_AgentOnboardingScreen> {
  int _idx = 0;
  String _scope = kAgentScopeAll;
  bool _saving = false;

  // Balance step — needs ≥3 tokens (1 minute of agent runway) to proceed.
  static const int _needTokens = 3;
  int? _balance; // null = still loading / fetch failed
  bool _balLoading = true;

  /// The step sequence. Forwarding conditions only exist for a scope that
  /// includes cell calls (plan §B5) — the scope is always chosen before the
  /// forwarding step is reached, so recomputing the list on scope change is safe.
  List<_Step> get _steps => [
        _Step.cost,
        _Step.balance,
        _Step.scope,
        _Step.did,
        if (_scope != kAgentScopeApp) _Step.forwarding,
        _Step.privacy,
        _Step.summary,
      ];

  _Step get _step => _steps[_idx];

  @override
  void initState() {
    super.initState();
    final s = widget.initialScope;
    if (s == kAgentScopeCell || s == kAgentScopeApp || s == kAgentScopeAll) {
      _scope = s;
    }
    _trackStep();
    _fetchBalance();
  }

  void _trackStep() {
    Analytics.capture('recept_onboarding_step',
        {'step': _step.analyticsName, 'mode': 'agent'});
  }

  Future<void> _fetchBalance() async {
    setState(() => _balLoading = true);
    try {
      final b = await MoneyApi.balance();
      if (!mounted) return;
      setState(() {
        _balance = (b['balance'] as num?)?.toInt();
        _balLoading = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _balLoading = false);
    }
  }

  bool get _balanceOk => (_balance ?? 0) >= _needTokens;

  bool get _canContinue {
    if (_saving) return false;
    if (_step == _Step.balance) return _balanceOk;
    return true;
  }

  Future<void> _next() async {
    if (_idx >= _steps.length - 1) {
      await _finish();
      return;
    }
    setState(() => _idx++);
    _trackStep();
  }

  void _back() {
    if (_idx == 0) {
      Analytics.capture('recept_onboarding_step',
          {'step': 'cancelled', 'mode': 'agent'});
      Navigator.of(context).pop();
      return;
    }
    setState(() => _idx--);
    _trackStep();
  }

  Future<void> _finish() async {
    setState(() => _saving = true);
    final ok = await widget.onFinish(_scope);
    if (!mounted) return;
    setState(() => _saving = false);
    if (ok) {
      Analytics.capture('recept_onboarding_step',
          {'step': 'done', 'mode': 'agent', 'scope': _scope});
      Navigator.of(context).pop(_scope);
    } else {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Couldn’t save — check your connection and try again.')));
    }
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _back();
      },
      child: Scaffold(
        backgroundColor: AD.bg,
        appBar: AppBar(
          backgroundColor: AD.overlaySheet,
          surfaceTintColor: Colors.transparent,
          elevation: 0,
          shape: const Border(bottom: BorderSide(color: AD.borderControl, width: 1)),
          leading: AdBackButton(onTap: _back),
          iconTheme: const IconThemeData(color: AD.textPrimary),
          title: Text('AI Voice Agent', style: ADText.rowName()),
        ),
        body: SafeArea(
          child: Column(children: [
            Expanded(
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  Text('STEP ${_idx + 1} OF ${_steps.length}',
                      style: ADText.sectionLabel()),
                  const SizedBox(height: 10),
                  _buildStep(),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 12),
              child: AdButton(
                label: _saving
                    ? 'Saving…'
                    : (_idx >= _steps.length - 1 ? 'Done' : 'Continue'),
                fullWidth: true,
                loading: _saving,
                onPressed: _canContinue ? _next : null,
              ),
            ),
          ]),
        ),
      ),
    );
  }

  Widget _buildStep() {
    switch (_step) {
      case _Step.cost: return _costStep();
      case _Step.balance: return _balanceStep();
      case _Step.scope: return _scopeStep();
      case _Step.did: return _didStep();
      case _Step.forwarding: return _forwardingStep();
      case _Step.privacy: return _privacyStep();
      case _Step.summary: return _summaryStep();
    }
  }

  // ── Step 1: cost intro (owner's exact copy, plan §B1) ─────────────────────
  Widget _costStep() {
    return _stepCard(
      icon: PhosphorIcons.coins(PhosphorIconsStyle.fill),
      title: 'What it costs',
      children: [
        Text(
          'An AI conversation costs 3 tokens/min, calls capped at 3 minutes to '
          'save you money.',
          style: ADText.preview(c: AD.textPrimary),
        ),
      ],
    );
  }

  // ── Step 2: balance check (≥3 tokens, else top-up CTA + blocked Continue) ─
  Widget _balanceStep() {
    return _stepCard(
      icon: PhosphorIcons.wallet(PhosphorIconsStyle.fill),
      title: 'Your token balance',
      children: [
        if (_balLoading)
          Row(children: [
            const SizedBox(width: 16, height: 16,
                child: CircularProgressIndicator(strokeWidth: 2)),
            const SizedBox(width: 10),
            Text('Checking your wallet…', style: ADText.preview()),
          ])
        else ...[
          Text(
            _balance == null
                ? 'Couldn’t read your wallet — check your connection.'
                : 'You have $_balance token${_balance == 1 ? '' : 's'}.',
            style: ADText.preview(c: AD.textPrimary),
          ),
          const SizedBox(height: 6),
          Text(
            _balanceOk
                ? 'That’s enough to get started (you need at least $_needTokens).'
                : 'You need at least $_needTokens tokens — one minute of Ava '
                    'talking to a caller — to turn the agent on.',
            style: ADText.preview(),
          ),
          if (!_balanceOk) ...[
            const SizedBox(height: 14),
            AdButton(
              label: 'Top up your wallet',
              variant: AdButtonVariant.teal,
              fullWidth: true,
              onPressed: () async {
                Analytics.capture('recept_onboarding_step',
                    {'step': 'topup_cta', 'mode': 'agent'});
                await Navigator.of(context).push(MaterialPageRoute<void>(
                    builder: (_) => const WalletScreen()));
                if (mounted) await _fetchBalance();
              },
            ),
          ],
          const SizedBox(height: 10),
          GestureDetector(
            onTap: _fetchBalance,
            child: Text('Refresh balance',
                style: ADText.preview(c: AD.textSecondary)),
          ),
        ],
      ],
    );
  }

  // ── Step 3: scope choice (plan §B3) ───────────────────────────────────────
  Widget _scopeStep() {
    return _stepCard(
      icon: PhosphorIcons.phoneCall(PhosphorIconsStyle.fill),
      title: 'Where should Ava answer?',
      children: [
        _scopeTile(kAgentScopeCell, 'Cell phone calls',
            'Calls to your phone number, via your virtual number.'),
        const SizedBox(height: 8),
        _scopeTile(kAgentScopeApp, 'AvaTOK-to-AvaTOK calls',
            'Calls from other AvaTOK users inside the app.'),
        const SizedBox(height: 8),
        _scopeTile(kAgentScopeAll, 'Both',
            'Ava answers everywhere you miss a call.'),
      ],
    );
  }

  Widget _scopeTile(String value, String title, String sub) {
    final active = _scope == value;
    return ZinePressable(
      onTap: () => setState(() => _scope = value),
      color: AD.card,
      borderColor: active ? AD.primaryBadge : AD.borderControl,
      radius: BorderRadius.circular(AD.rInput),
      boxShadow: const [],
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      child: Row(children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: ADText.rowName()),
            const SizedBox(height: 2),
            Text(sub, style: ADText.preview()),
          ]),
        ),
        const SizedBox(width: 8),
        Icon(
          active
              ? PhosphorIcons.checkCircle(PhosphorIconsStyle.fill)
              : PhosphorIcons.circle(PhosphorIconsStyle.bold),
          size: 22,
          color: active ? AD.primaryBadge : AD.textTertiary,
        ),
      ]),
    );
  }

  // ── Step 4: DID number — 700/month greyed + bright green "Free in Beta" ───
  Widget _didStep() {
    return _stepCard(
      icon: PhosphorIcons.hash(PhosphorIconsStyle.fill),
      title: 'Your virtual phone number',
      children: [
        Text(
          'You need a virtual phone number so your carrier can hand Ava the '
          'calls you can’t take.',
          style: ADText.preview(c: AD.textPrimary),
        ),
        const SizedBox(height: 14),
        Row(children: [
          Text(
            '700 tokens/month',
            style: ADText.rowName(c: AD.textTertiary)
                .copyWith(decoration: TextDecoration.lineThrough,
                    decorationColor: AD.textTertiary),
          ),
          const SizedBox(width: 10),
          _greenPill('Free in Beta'),
        ]),
      ],
    );
  }

  /// Bright green pill, AdChip-shaped (same paddings/radius/typography) but
  /// pinned to [AD.online] green — plan §B4 wants it unmissably "free".
  Widget _greenPill(String label) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
      decoration: BoxDecoration(
        color: AD.online,
        borderRadius: BorderRadius.circular(100),
        border: Border.all(color: AD.online, width: 1),
      ),
      child: Text(label,
          style: TextStyle(fontFamily: ADText.family,
              fontWeight: FontWeight.w800, fontSize: 12.5, color: Colors.white)),
    );
  }

  // ── Step 5 (cell/all only): forwarding conditions — reuse the existing
  //    dial-and-verify screen, never rebuild it (plan §B5). ──────────────────
  Widget _forwardingStep() {
    return _stepCard(
      icon: PhosphorIcons.arrowBendUpRight(PhosphorIconsStyle.fill),
      title: 'When should your carrier hand calls to Ava?',
      children: [
        Text(
          'Pick the conditions: when you reject a call, when your phone is '
          'off, and when you’re not picking up. Each one dials a short '
          'carrier code and only turns green once your carrier confirms it.',
          style: ADText.preview(c: AD.textPrimary),
        ),
        const SizedBox(height: 14),
        AdButton(
          label: 'Set up call forwarding',
          variant: AdButtonVariant.teal,
          fullWidth: true,
          onPressed: () {
            Analytics.capture('recept_onboarding_step',
                {'step': 'forwarding_opened', 'mode': 'agent'});
            Navigator.of(context).push(MaterialPageRoute<void>(
                builder: (_) => const PstnForwardingSetupScreen()));
          },
        ),
        const SizedBox(height: 10),
        Text(
          'You can change these any time in Settings → Voicemail.',
          style: ADText.preview(),
        ),
      ],
    );
  }

  // ── Step 6: privacy copy (owner's exact text, plan §B6) ───────────────────
  Widget _privacyStep() {
    return _stepCard(
      icon: PhosphorIcons.shieldCheck(PhosphorIconsStyle.fill),
      title: 'Your privacy',
      children: [
        Text(
          'Under these conditions your call is diverted to your DiD number by '
          'YOUR phone company. No SMS, OTP or text messages are forwarded, '
          'and no information leaves your phone — this is standard carrier '
          'call routing.',
          style: ADText.preview(c: AD.textPrimary),
        ),
      ],
    );
  }

  // ── Step 7: token summary (owner's exact copy, plan §B7) ──────────────────
  Widget _summaryStep() {
    return _stepCard(
      icon: PhosphorIcons.receipt(PhosphorIconsStyle.fill),
      title: 'What you’ll pay',
      children: [
        _summaryRow('700 tokens/month for your number', pill: 'Free in Beta'),
        const SizedBox(height: 8),
        _summaryRow('3 tokens/min while Ava talks to your callers'),
        const SizedBox(height: 8),
        _summaryRow('Max 3 min per call'),
      ],
    );
  }

  Widget _summaryRow(String text, {String? pill}) {
    return Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Padding(
        padding: const EdgeInsets.only(top: 5, right: 8),
        child: Container(
          width: 4, height: 4,
          decoration:
              const BoxDecoration(color: AD.textTertiary, shape: BoxShape.circle),
        ),
      ),
      Expanded(child: Text(text, style: ADText.preview(c: AD.textPrimary))),
      if (pill != null) ...[
        const SizedBox(width: 8),
        _greenPill(pill),
      ],
    ]);
  }

  Widget _stepCard({
    required IconData icon,
    required String title,
    required List<Widget> children,
  }) {
    return AdCard(
      padding: const EdgeInsets.all(14),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          ZineIconBadge(icon: icon, color: AD.iconVideo, size: 36),
          const SizedBox(width: 12),
          Expanded(child: Text(title, style: ADText.rowName())),
        ]),
        const SizedBox(height: 12),
        ...children,
      ]),
    );
  }
}
