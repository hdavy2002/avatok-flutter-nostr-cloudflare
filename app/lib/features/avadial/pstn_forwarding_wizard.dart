import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/account_storage.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import 'pstn_forwarding_setup.dart';

/// [AVA-RCPT-VERIFY-1] (owner decision 2026-07-17, after the rgoa/Airtel
/// incident): the ONLY thing that turns a forwarding condition green is the
/// CARRIER confirming it. This wizard is that flow — three sequential
/// buttons, one per forwarding condition (missed → declined → unreachable):
///
///   1. User taps a button → we await the CALL_PHONE grant, then dial the
///      enable code in the background (USSD first, ACTION_CALL fallback — the
///      user may get bounced to the phone app / Truecaller; that's fine).
///   2. We then dial the carrier's STATUS code (`*#61#` etc.) and
///      digit-match our DID in the response. Match → green tick, next button
///      unlocks. This works across global carriers because the NUMBER in the
///      status response is language-agnostic.
///   3. If the carrier says it's NOT registered, we show the exact code so
///      the user can dial it manually from the keypad, with "I dialed it —
///      check again" re-running verification.
///   4. If we can't read the carrier's answer at all (some OEM/carrier
///      combos block the USSD API; the ACTION_CALL fallback shows the result
///      in the phone app where we can't see it), the user attests what their
///      screen showed — attested state is recorded as such in analytics.
///
/// The wizard re-runs verification automatically when the app resumes, so a
/// user who was kicked out to the dialer mid-flow comes back to an updated
/// button, not a stale spinner. State is persisted per-account ONLY on
/// carrier confirmation (or explicit attestation) via [pstnPersistVerified].
///
/// Embedded by BOTH the informed-consent intro (pstn_forwarding_intro.dart)
/// and Settings → Voicemail (pstn_forwarding_setup.dart) — one flow, one
/// source of truth, per the owner's "replace both screens" decision.
enum _StepState { locked, ready, dialing, awaitReturn, verifying, verified, failed, skipped }

class PstnForwardingWizard extends StatefulWidget {
  final String did;
  final FlutterSecureStorage storage;
  /// Show a "Turn off" affordance on verified rows (Settings context).
  final bool showTurnOff;
  /// Fired whenever the overall state changes; `allDone` is true when every
  /// condition is verified, attested, or skipped — the intro screen uses it
  /// to enable its Continue button.
  final void Function(bool allDone, int verifiedCount)? onProgress;
  const PstnForwardingWizard({
    super.key,
    required this.did,
    required this.storage,
    this.showTurnOff = false,
    this.onProgress,
  });

  @override
  State<PstnForwardingWizard> createState() => _PstnForwardingWizardState();
}

class _PstnForwardingWizardState extends State<PstnForwardingWizard>
    with WidgetsBindingObserver {
  static const List<PstnForwardKind> _order = [
    PstnForwardKind.missed,
    PstnForwardKind.declined,
    PstnForwardKind.unreachable,
  ];

  final Map<PstnForwardKind, _StepState> _state = {
    for (final k in _order) k: _StepState.locked,
  };
  final Map<PstnForwardKind, String?> _detail = {}; // carrier response / error line
  final Map<PstnForwardKind, int> _attempts = {};
  PstnCarrierCodes? _codes;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    Analytics.capture('pstn_wizard_shown', {'turn_off': widget.showTurnOff});
    _init();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  Future<void> _init() async {
    _codes = await pstnResolveCarrierCodes();
    for (final kind in _order) {
      final stored = await readScoped(widget.storage, kind.storageKey);
      _state[kind] = stored == '1' ? _StepState.verified : _StepState.locked;
    }
    _unlockNext();
    if (!mounted) return;
    setState(() => _loading = false);
    _reportProgress();
  }

  /// The first non-terminal step becomes ready; everything after it stays
  /// locked. Terminal = verified/skipped.
  void _unlockNext() {
    bool blockerSeen = false;
    for (final kind in _order) {
      final s = _state[kind]!;
      if (s == _StepState.verified || s == _StepState.skipped) continue;
      if (!blockerSeen) {
        if (s == _StepState.locked) _state[kind] = _StepState.ready;
        blockerSeen = true;
      } else if (s != _StepState.locked) {
        // Anything in-flight past the first blocker keeps its state (e.g. a
        // failed row the user is retrying) — never regress it to locked.
      }
    }
  }

  void _reportProgress() {
    final done = _order.every((k) =>
        _state[k] == _StepState.verified || _state[k] == _StepState.skipped);
    final verified = _order.where((k) => _state[k] == _StepState.verified).length;
    widget.onProgress?.call(done, verified);
  }

  // ── lifecycle: returning from the dialer/Truecaller re-verifies ────────────
  @override
  void didChangeAppLifecycleState(AppLifecycleState lifecycle) {
    if (lifecycle != AppLifecycleState.resumed) return;
    for (final kind in _order) {
      if (_state[kind] == _StepState.awaitReturn) {
        Analytics.capture('pstn_wizard_resume_verify', {'kind': kind.analyticsKind});
        _verify(kind);
        break; // one at a time — the flow is sequential by design
      }
    }
  }

  // ── actions ────────────────────────────────────────────────────────────────
  Future<void> _enable(PstnForwardKind kind) async {
    if (_state[kind] != _StepState.ready && _state[kind] != _StepState.failed) return;
    _attempts[kind] = (_attempts[kind] ?? 0) + 1;
    Analytics.capture('pstn_wizard_button_tapped',
        {'kind': kind.analyticsKind, 'attempt': _attempts[kind]!});
    setState(() {
      _state[kind] = _StepState.dialing;
      _detail[kind] = null;
    });
    final result = await pstnDialAndPersist(
      kind: kind,
      wantOn: true,
      did: widget.did,
      storage: widget.storage,
      codes: _codes,
    );
    if (!mounted) return;
    if (!result.ok) {
      setState(() {
        _state[kind] = _StepState.failed;
        _detail[kind] = result.error;
      });
      _reportProgress();
      return;
    }
    // Dial accepted — but acceptance is NOT proof. Ask the carrier.
    await _verify(kind);
  }

  Future<void> _verify(PstnForwardKind kind) async {
    setState(() => _state[kind] = _StepState.verifying);
    final v = await pstnVerifyForwarding(kind: kind, did: widget.did, codes: _codes);
    if (!mounted) return;
    if (v.checked && v.verified) {
      await pstnPersistVerified(kind: kind, on: true, storage: widget.storage);
      Analytics.capture('pstn_wizard_verified',
          {'kind': kind.analyticsKind, 'attempts': _attempts[kind] ?? 0});
      setState(() {
        _state[kind] = _StepState.verified;
        _detail[kind] = null;
        _unlockNext();
      });
    } else if (v.checked) {
      // Carrier answered and forwarding is NOT registered — the enable code
      // didn't take. Hand the user the exact code for a manual keypad dial.
      Analytics.capture('pstn_wizard_manual_shown', {'kind': kind.analyticsKind});
      setState(() {
        _state[kind] = _StepState.failed;
        _detail[kind] =
            "Your carrier says this isn't on yet. Dial ${_enableCodeFor(kind)} "
            'from your phone keypad, then come back and tap "Check again".';
      });
    } else {
      // Could not read the carrier's answer (USSD blocked / fallback used) —
      // the phone app showed the result where we can't see it. Ask the user.
      setState(() {
        _state[kind] = _StepState.awaitReturn;
        _detail[kind] = null;
      });
    }
    _reportProgress();
  }

  Future<void> _attest(PstnForwardKind kind, bool itWorked) async {
    Analytics.capture('pstn_wizard_attested',
        {'kind': kind.analyticsKind, 'on': itWorked});
    if (itWorked) {
      await pstnPersistVerified(kind: kind, on: true, storage: widget.storage);
      if (!mounted) return;
      setState(() {
        _state[kind] = _StepState.verified;
        _detail[kind] = null;
        _unlockNext();
      });
    } else {
      if (!mounted) return;
      setState(() {
        _state[kind] = _StepState.failed;
        _detail[kind] =
            'Dial ${_enableCodeFor(kind)} from your phone keypad, then come '
            'back and tap "Check again".';
      });
    }
    _reportProgress();
  }

  void _skip(PstnForwardKind kind) {
    Analytics.capture('pstn_wizard_skip', {'kind': kind.analyticsKind});
    setState(() {
      _state[kind] = _StepState.skipped;
      _detail[kind] = null;
      _unlockNext();
    });
    _reportProgress();
  }

  Future<void> _turnOff(PstnForwardKind kind) async {
    setState(() => _state[kind] = _StepState.dialing);
    final result = await pstnDialAndPersist(
      kind: kind,
      wantOn: false,
      did: widget.did,
      storage: widget.storage,
      codes: _codes,
    );
    if (!mounted) return;
    setState(() {
      if (result.ok) {
        _state[kind] = _StepState.ready;
        _detail[kind] = null;
      } else {
        _state[kind] = _StepState.verified; // still on — the disable didn't take
        _detail[kind] = result.error;
      }
    });
    _reportProgress();
  }

  String _enableCodeFor(PstnForwardKind kind) {
    final template = (_codes ?? PstnCarrierCodes.defaults).enableTemplate(kind);
    return template.replaceAll('{did}', widget.did);
  }

  // ── UI ─────────────────────────────────────────────────────────────────────
  static String _title(PstnForwardKind kind) => switch (kind) {
        PstnForwardKind.missed => 'Missed calls',
        PstnForwardKind.declined => 'Declined / busy calls',
        PstnForwardKind.unreachable => 'Phone off or unreachable',
      };

  static String _sub(PstnForwardKind kind) => switch (kind) {
        PstnForwardKind.missed => "No answer within your carrier's ring window",
        PstnForwardKind.declined => 'You decline, or your line is busy',
        PstnForwardKind.unreachable => 'No signal, airplane mode, or powered off',
      };

  static IconData _icon(PstnForwardKind kind) => switch (kind) {
        PstnForwardKind.missed => PhosphorIcons.phone(PhosphorIconsStyle.bold),
        PstnForwardKind.declined => PhosphorIcons.phoneX(PhosphorIconsStyle.bold),
        PstnForwardKind.unreachable => PhosphorIcons.wifiSlash(PhosphorIconsStyle.bold),
      };

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 32),
        child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
      );
    }
    return Column(children: [
      for (final kind in _order) ...[
        _stepCard(kind),
        if (kind != _order.last) const SizedBox(height: 10),
      ],
    ]);
  }

  Widget _stepCard(PstnForwardKind kind) {
    final s = _state[kind]!;
    final detail = _detail[kind];
    final locked = s == _StepState.locked;
    return Opacity(
      opacity: locked ? 0.45 : 1,
      child: AdCard(
        radius: Zine.rSm,
        padding: const EdgeInsets.all(14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            ZineIconBadge(
              icon: s == _StepState.verified
                  ? PhosphorIcons.check(PhosphorIconsStyle.bold)
                  : _icon(kind),
              color: s == _StepState.verified ? AD.online : AD.iconVideo,
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(_title(kind), style: ADText.rowName().copyWith(fontSize: 14.5)),
                const SizedBox(height: 2),
                Text(_statusLine(s) ?? _sub(kind),
                    style: ADText.preview(
                      c: s == _StepState.verified ? AD.online : AD.textSecondary,
                    ).copyWith(fontSize: 12)),
              ]),
            ),
            const SizedBox(width: 10),
            _trailing(kind, s),
          ]),
          if (detail != null) ...[
            const SizedBox(height: 10),
            Text(detail, style: ADText.preview(c: AD.danger).copyWith(fontSize: 12)),
          ],
          if (s == _StepState.awaitReturn) ...[
            const SizedBox(height: 10),
            Text(
              'Your phone showed the result of the forwarding code. '
              'What did it say?',
              style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 12.5),
            ),
            const SizedBox(height: 8),
            Row(children: [
              Expanded(
                child: AdButton(
                  label: 'It turned on',
                  fontSize: 13.5,
                  onPressed: () => _attest(kind, true),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: AdButton(
                  label: "It didn't work",
                  fontSize: 13.5,
                  onPressed: () => _attest(kind, false),
                ),
              ),
            ]),
          ],
          if (s == _StepState.ready || s == _StepState.failed) ...[
            const SizedBox(height: 4),
            Align(
              alignment: Alignment.centerRight,
              child: ZineLink('Skip for now',
                  fontSize: 12, onTap: () => _skip(kind), underline: AD.iconSearch),
            ),
          ],
        ]),
      ),
    );
  }

  String? _statusLine(_StepState s) => switch (s) {
        _StepState.dialing => 'Dialing the carrier code…',
        _StepState.verifying => 'Asking your carrier to confirm…',
        _StepState.awaitReturn => 'Waiting for confirmation',
        _StepState.verified => 'On — confirmed with your carrier',
        _StepState.skipped => 'Skipped — you can enable it later',
        _ => null,
      };

  Widget _trailing(PstnForwardKind kind, _StepState s) {
    switch (s) {
      case _StepState.dialing:
      case _StepState.verifying:
        return const SizedBox(
            width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2));
      case _StepState.verified:
        if (widget.showTurnOff) {
          return ZineLink('Turn off',
              fontSize: 12, onTap: () => _turnOff(kind), underline: AD.iconSearch);
        }
        return PhosphorIcon(PhosphorIcons.checkCircle(PhosphorIconsStyle.fill),
            size: 22, color: AD.online);
      case _StepState.skipped:
        return ZineLink('Enable',
            fontSize: 12,
            onTap: () {
              setState(() => _state[kind] = _StepState.ready);
            },
            underline: AD.iconSearch);
      case _StepState.failed:
        return AdButton(label: 'Check again', fontSize: 13, onPressed: () => _enable(kind));
      case _StepState.ready:
        return AdButton(label: 'Turn on', fontSize: 13, onPressed: () => _enable(kind));
      case _StepState.locked:
        return PhosphorIcon(PhosphorIcons.lockSimple(PhosphorIconsStyle.bold),
            size: 18, color: AD.textTertiary);
    }
  }
}
