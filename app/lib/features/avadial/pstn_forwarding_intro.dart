import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/account_storage.dart';
import '../../core/analytics.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../../shell/shell_v2.dart' show kPstnVoicemailDid;
import 'avadial_theme.dart';
import 'pstn_forwarding_setup.dart';

/// [AVA-RCPT-CONSENT-1] (owner decision 2026-07-16, PLAN-2026-07-16
/// receptionist/guardian doc): carrier voicemail forwarding is ON BY DEFAULT
/// for every AvaTOK user, and that default is surfaced through an
/// informed-consent screen instead of being switched on silently. This file
/// is that screen — both the full-screen route [PstnForwardingIntroScreen]
/// (existing users, pushed once from shell_v2.dart) and the embeddable
/// [PstnForwardingIntroBody] (new users, embedded as an onboarding step body
/// in onboarding_flow.dart's `_composeSteps()`).
///
/// Both surfaces run the SAME dial+persist sequence via
/// [pstnEnableAllForwarding] (pstn_forwarding_setup.dart) — this file must
/// never dial an MMI code or write toggle state itself. On Continue, all
/// three carrier codes (`*61*`/`*67*`/`*62*`) are dialed in order; a failure
/// on one does not stop the others, and a failed code is left OFF (per
/// [pstnDialAndPersist]'s contract) while the carrier's response/error text
/// is shown inline.
///
/// The "seen" marker is per-account (see [pstnIntroSeen]/[markPstnIntroSeen])
/// so this shows once per account, not once per device — a parent and child
/// sharing a phone each get their own consent moment.
class PstnForwardingIntroScreen extends StatelessWidget {
  const PstnForwardingIntroScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AvaDialTheme.bg,
      body: SafeArea(
        child: PstnForwardingIntroBody(
          onFinished: () {
            if (Navigator.of(context).canPop()) Navigator.of(context).pop();
          },
        ),
      ),
    );
  }
}

/// Per-account marker: has this account already been shown (and either
/// completed or skipped) the voicemail-forwarding intro? Namespaced via
/// [scopedKey] — never a raw global key (one phone, multiple accounts).
const String _kIntroSeenKey = 'pstn_forwarding_intro_seen';
final FlutterSecureStorage _introSec = const FlutterSecureStorage();

Future<bool> pstnIntroSeen() async {
  final v = await readScoped(_introSec, _kIntroSeenKey);
  return v == '1';
}

Future<void> markPstnIntroSeen() async {
  try {
    await _introSec.write(key: scopedKey(_kIntroSeenKey), value: '1');
  } catch (_) {/* best-effort — never block the flow on a storage write */}
}

/// The explainer + CTA content, with no [Scaffold]/[AppBar] of its own so it
/// can be embedded directly inside another screen's chrome (the onboarding
/// step's SingleChildScrollView + progress dots) or wrapped in a bare one
/// (see [PstnForwardingIntroScreen] above).
///
/// [onFinished] fires once — after Continue's dial sequence completes, or
/// immediately on "Not now" — so the caller (onboarding flow / shell route)
/// can advance without knowing anything about MMI codes or carrier responses.
class PstnForwardingIntroBody extends StatefulWidget {
  final VoidCallback onFinished;
  const PstnForwardingIntroBody({super.key, required this.onFinished});

  @override
  State<PstnForwardingIntroBody> createState() => _PstnForwardingIntroBodyState();
}

class _PstnForwardingIntroBodyState extends State<PstnForwardingIntroBody> {
  static const String _did = kPstnVoicemailDid;
  static final FlutterSecureStorage _sec = const FlutterSecureStorage();

  bool _running = false;
  bool _done = false;
  PstnForwardKind? _inFlight; // the code currently being dialed, for the spinner
  final Map<PstnForwardKind, PstnDialResult> _results = {};

  @override
  void initState() {
    super.initState();
    Analytics.screenViewed('avadial', 'pstn_forwarding_intro');
  }

  Future<void> _continue() async {
    if (_running || _done) return;
    setState(() => _running = true);
    Analytics.capture('pstn_forward_intro_continue_tapped');
    await pstnEnableAllForwarding(
      did: _did,
      storage: _sec,
      onEach: (kind, result) {
        // Per-code progress + carrier response/error, shown live as each
        // code lands — see class doc: a failure never stops the sequence.
        Analytics.capture('pstn_forward_enable_result', {
          'code': result.dialedCode ?? kind.analyticsKind,
          'kind': kind.analyticsKind,
          'ok': result.ok,
          'codes_source': result.codesSource ?? 'default',
          if (result.carrier != null) 'carrier': result.carrier!,
          if (result.mccmnc != null) 'mccmnc': result.mccmnc!,
        });
        if (!mounted) return;
        setState(() {
          _inFlight = kind;
          _results[kind] = result;
        });
      },
    );
    if (!mounted) return;
    await markPstnIntroSeen();
    final allOk = _results.values.every((r) => r.ok);
    Analytics.capture('pstn_forward_intro_done', {'skipped': false, 'all_ok': allOk});
    setState(() {
      _running = false;
      _done = true;
    });
    widget.onFinished();
  }

  Future<void> _skip() async {
    if (_running) return;
    Analytics.capture('pstn_forward_intro_skip_tapped');
    await markPstnIntroSeen();
    Analytics.capture('pstn_forward_intro_done', {'skipped': true});
    widget.onFinished();
  }

  @override
  Widget build(BuildContext context) {
    final hPad = ZineBreakpoints.pagePadding(context);
    return SingleChildScrollView(
      padding: EdgeInsets.fromLTRB(hPad, 8, hPad, 24),
      child: Column(
        children: [
          const SizedBox(height: 12),
          Container(
            width: 116, height: 116,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: AD.card,
              border: Border.all(color: AD.borderControl, width: 1),
              boxShadow: AD.overlayShadow,
            ),
            child: Center(
              child: PhosphorIcon(PhosphorIcons.voicemail(PhosphorIconsStyle.fill),
                  size: 46, color: AD.textPrimary),
            ),
          ),
          const SizedBox(height: 18),
          Text.rich(
            TextSpan(children: [
              const TextSpan(text: 'Your Ava '),
              TextSpan(text: 'Voicemail box', style: const TextStyle(color: AD.primaryBadge)),
            ]),
            textAlign: TextAlign.center,
            style: ADText.appTitle().copyWith(
                fontSize: ZineBreakpoints.heroTextSize(context, regular: 30), height: 1.08),
          ),
          const SizedBox(height: 12),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 340),
            child: Text(
              'Under three circumstances, your carrier sends the call to your Ava '
              'voicemail instead of ringing out. Priya answers, takes the message, '
              'and it shows up in your Inbox — with a transcript.',
              textAlign: TextAlign.center,
              style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 14.5),
            ),
          ),
          const SizedBox(height: 24),
          _circumstanceRow(PhosphorIcons.phoneX(PhosphorIconsStyle.bold), AD.danger,
              'You decline the call', 'or your line is busy'),
          const SizedBox(height: 12),
          _circumstanceRow(PhosphorIcons.phone(PhosphorIconsStyle.bold), AD.iconSearch,
              "You don't answer", "within your carrier's ring window"),
          const SizedBox(height: 12),
          _circumstanceRow(PhosphorIcons.wifiSlash(PhosphorIconsStyle.bold), AD.iconVideo,
              'Your phone is off or unreachable', 'no signal, airplane mode, powered off'),
          const SizedBox(height: 20),
          AdCard(
            color: AD.card,
            radius: Zine.rSm,
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              PhosphorIcon(PhosphorIcons.checkCircle(PhosphorIconsStyle.fill),
                  size: 18, color: AD.online),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  'This is on by default. Your carrier will show a notification '
                  'confirming call forwarding is on.',
                  style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 12.5),
                ),
              ),
            ]),
          ),
          if (_running || _done) ...[
            const SizedBox(height: 20),
            _progressCard(),
          ],
          const SizedBox(height: 28),
          AdButton(
            label: _running ? 'Turning on…' : 'Continue',
            onPressed: _running ? null : _continue,
            fullWidth: true,
            fontSize: 21,
            loading: _running,
            icon: _running ? null : PhosphorIcons.arrowRight(PhosphorIconsStyle.bold),
          ),
          const SizedBox(height: 14),
          ZineLink(
            'Not now',
            fontSize: 14,
            onTap: _running ? null : _skip,
            underline: AD.iconSearch,
          ),
          const SizedBox(height: 6),
          Text('You can turn this on later in Settings → Voicemail.',
              textAlign: TextAlign.center,
              style: ADText.preview(c: AD.textTertiary).copyWith(fontSize: 11.5)),
        ],
      ),
    );
  }

  Widget _circumstanceRow(IconData icon, Color accent, String title, String sub) => AdCard(
        radius: Zine.rSm,
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        child: Row(children: [
          ZineIconBadge(icon: icon, color: accent),
          const SizedBox(width: 14),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: ADText.rowName().copyWith(fontSize: 14.5)),
              const SizedBox(height: 2),
              Text(sub, style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 12)),
            ]),
          ),
        ]),
      );

  Widget _progressCard() => AdCard(
        color: AvaDialTheme.surface2,
        radius: Zine.rSm,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          for (final kind in const [
            PstnForwardKind.missed,
            PstnForwardKind.declined,
            PstnForwardKind.unreachable,
          ])
            _codeStatusRow(kind),
          if (_results.values.any((r) => !r.ok)) ...[
            const Divider(height: 20, thickness: 1, color: AD.borderHairline),
            Text(
              _results.values.firstWhere((r) => !r.ok).error ??
                  "Your carrier didn't accept one of the codes.",
              style: ADText.preview(c: AD.danger).copyWith(fontSize: 12),
            ),
          ],
        ]),
      );

  Widget _codeStatusRow(PstnForwardKind kind) {
    final label = switch (kind) {
      PstnForwardKind.missed => 'No answer',
      PstnForwardKind.declined => 'Declined / busy',
      PstnForwardKind.unreachable => 'Off / unreachable',
    };
    final result = _results[kind];
    Widget trailing;
    if (result != null) {
      trailing = PhosphorIcon(
        result.ok
            ? PhosphorIcons.checkCircle(PhosphorIconsStyle.fill)
            : PhosphorIcons.xCircle(PhosphorIconsStyle.fill),
        size: 18,
        color: result.ok ? AD.online : AD.danger,
      );
    } else if (_inFlight == kind && _running) {
      trailing = const SizedBox(
          width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2));
    } else {
      trailing = PhosphorIcon(PhosphorIcons.circle(PhosphorIconsStyle.bold),
          size: 18, color: AD.textTertiary);
    }
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(children: [
        Expanded(child: Text(label, style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 13))),
        trailing,
      ]),
    );
  }
}
