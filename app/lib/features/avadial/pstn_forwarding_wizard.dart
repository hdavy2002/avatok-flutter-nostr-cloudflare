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
/// [AVA-RCPT-SILENT-1] `needsVisibleDial`: the silent USSD path is blocked on
/// this device, so before ANYTHING appears in the user's phone app we show a
/// reassurance card — what the code is, that it's the standard carrier code
/// for call forwarding, and that it's safe — and the user chooses "dial it
/// for me" (phone app opens, pre-filled) or "I'll dial it myself".
/// [AVA-VM-PAID-1] `paid` = this condition costs money and the paid tier isn't
/// unlocked, so the row is inert: greyed, green PAID pill, no "Turn on", no
/// "Skip for now" (there is nothing to skip). Distinct from `locked`, which
/// means "your turn hasn't come up yet in the sequence" and resolves on its own.
enum _StepState {
  locked, paid, ready, dialing, needsVisibleDial, awaitReturn, verifying, verified, failed, skipped,
}

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
  /// Last machine-readable failure per kind — decides what "Check again"
  /// does: re-request permission, or silently re-ask the carrier.
  final Map<PstnForwardKind, String?> _failKind = {};
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
    // [AVA-VM-PAID-1] Cancel any paid condition still live at the carrier from
    // before the paywall, BEFORE reading stored state — it persists the toggle
    // off, so reading after means the row reflects reality rather than the
    // stale pre-paywall "on". Silent-only and self-guarded; see the helper.
    await pstnCancelLockedPaidConditions(storage: widget.storage, codes: _codes);
    for (final kind in _order) {
      if (pstnConditionLocked(kind)) {
        _state[kind] = _StepState.paid;
        continue;
      }
      final stored = await readScoped(widget.storage, kind.storageKey);
      _state[kind] = stored == '1' ? _StepState.verified : _StepState.locked;
    }
    _unlockNext();
    if (!mounted) return;
    setState(() => _loading = false);
    _reportProgress();
  }

  /// The first non-terminal step becomes ready; everything after it stays
  /// locked. Terminal = verified/skipped/paid.
  ///
  /// [AVA-VM-PAID-1] `paid` MUST count as terminal here and in
  /// [_reportProgress]. A paid row can never be actioned, so if it counted as a
  /// blocker it would sit un-terminal forever: the sequence would never unlock
  /// the row beneath it, and the intro screen's `allDone` would never fire —
  /// permanently disabling the Continue button and dead-ending onboarding.
  void _unlockNext() {
    bool blockerSeen = false;
    for (final kind in _order) {
      final s = _state[kind]!;
      if (s == _StepState.verified ||
          s == _StepState.skipped ||
          s == _StepState.paid) continue;
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
    // [AVA-VM-PAID-1] `paid` counts as done — see [_unlockNext]. Without it the
    // intro screen's Continue button never enables.
    final done = _order.every((k) =>
        _state[k] == _StepState.verified ||
        _state[k] == _StepState.skipped ||
        _state[k] == _StepState.paid);
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
  /// [visible] false (default): fully silent attempt — nothing may appear on
  /// screen. true: the user has SEEN the reassurance card and tapped "dial it
  /// for me", so the phone app opening with the pre-filled code is expected.
  Future<void> _enable(PstnForwardKind kind, {bool visible = false}) async {
    // [AVA-VM-PAID-1] Hard backstop. The UI never offers a way in, but this is
    // the one function that spends the owner's money at the carrier, so it
    // refuses a locked condition outright rather than trusting the widget tree.
    if (pstnConditionLocked(kind)) {
      Analytics.capture('pstn_paid_condition_enable_blocked',
          {'kind': kind.analyticsKind});
      return;
    }
    final s = _state[kind]!;
    if (s != _StepState.ready && s != _StepState.failed && s != _StepState.needsVisibleDial) {
      return;
    }
    _attempts[kind] = (_attempts[kind] ?? 0) + 1;
    Analytics.capture('pstn_wizard_button_tapped',
        {'kind': kind.analyticsKind, 'attempt': _attempts[kind]!, 'visible': visible});
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
      allowFallback: visible,
    );
    if (!mounted) return;
    if (!result.ok) {
      if (result.errorKind == 'ussd_unavailable' && !visible) {
        // Silent path blocked on this device — explain BEFORE anything shows
        // up in the user's phone app ([AVA-RCPT-SILENT-1]).
        Analytics.capture('pstn_wizard_reassure_shown', {'kind': kind.analyticsKind});
        setState(() {
          _state[kind] = _StepState.needsVisibleDial;
          _detail[kind] = null;
        });
      } else {
        setState(() {
          _state[kind] = _StepState.failed;
          _detail[kind] = result.error;
          _failKind[kind] = result.errorKind;
        });
      }
      _reportProgress();
      return;
    }
    if (visible) {
      // The phone app is opening with the code — the user leaves AvaTOK. We
      // verify silently the moment they come back (lifecycle hook below), and
      // the attest buttons cover devices where even that check is blocked.
      setState(() {
        _state[kind] = _StepState.awaitReturn;
        _detail[kind] = null;
      });
      _reportProgress();
      return;
    }
    // Silent dial accepted. If the carrier's own reply to the ENABLE code
    // already names our voicemail number, that IS the confirmation — no
    // second query needed. Otherwise ask via the status code.
    final enableResp = result.response;
    if (enableResp != null && pstnResponseNamesDid(enableResp, widget.did)) {
      await pstnPersistVerified(kind: kind, on: true, storage: widget.storage);
      Analytics.capture('pstn_wizard_verified', {
        'kind': kind.analyticsKind,
        'attempts': _attempts[kind] ?? 0,
        'via': 'enable_response',
      });
      setState(() {
        _state[kind] = _StepState.verified;
        _detail[kind] = null;
        _unlockNext();
      });
      _reportProgress();
      return;
    }
    await _verify(kind);
  }

  /// "Check again" on a failed row. A permission failure needs the full
  /// enable flow re-run (so the grant dialog can come back); anything else —
  /// e.g. the user just dialed the code manually — only needs the carrier
  /// asked again, silently.
  Future<void> _verifyRetry(PstnForwardKind kind) async {
    Analytics.capture('pstn_wizard_check_again',
        {'kind': kind.analyticsKind, 'fail_kind': _failKind[kind] ?? 'none'});
    if (_failKind[kind] == 'no_permission') {
      _failKind[kind] = null;
      await _enable(kind);
      return;
    }
    _failKind[kind] = null;
    await _verify(kind);
  }

  /// "I'll dial it myself" from the reassurance card — hand over the exact
  /// code with the safety explanation and a re-check path.
  void _manualDial(PstnForwardKind kind) {
    Analytics.capture('pstn_wizard_manual_chosen', {'kind': kind.analyticsKind});
    setState(() {
      _state[kind] = _StepState.failed;
      _detail[kind] =
          'Open your phone app, dial ${_enableCodeFor(kind)} and press call — '
          "it's the standard code phone companies use to switch on call "
          'forwarding, completely safe. Then come back and tap "Check again".';
    });
    _reportProgress();
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
      // The carrier answered but its reply didn't name our number. On most
      // carriers that means forwarding is NOT registered — but some word the
      // status reply without echoing the number, so we ASK rather than
      // assert ([AVA-RCPT-SILENT-1]): attest buttons + the manual code.
      Analytics.capture('pstn_wizard_manual_shown', {'kind': kind.analyticsKind});
      setState(() {
        _state[kind] = _StepState.awaitReturn;
        _detail[kind] =
            "We couldn't confirm this is on yet. If your phone company showed "
            "you a confirmation, tap \"It turned on\". If not, dial "
            '${_enableCodeFor(kind)} from your phone app — the standard, safe '
            'code carriers use for call forwarding — then come back.';
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
    // [AVA-VM-PAID-1] Paid rows read as "unavailable, not broken": same dimming
    // as a sequence-locked row, but with the PAID pill carrying the reason.
    final paid = s == _StepState.paid;
    return Opacity(
      opacity: locked || paid ? 0.45 : 1,
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
                Row(children: [
                  Flexible(
                    child: Text(_title(kind),
                        style: ADText.rowName().copyWith(fontSize: 14.5)),
                  ),
                  // [AVA-VM-PAID-1] Green PAID pill (owner's explicit choice
                  // 2026-07-17 over an amber one, accepting that green also
                  // means "confirmed" elsewhere on this screen).
                  if (paid) ...[
                    const SizedBox(width: 8),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                      decoration: BoxDecoration(
                        color: AD.online.withValues(alpha: 0.16),
                        borderRadius: BorderRadius.circular(7),
                        border: Border.all(color: AD.online, width: 1),
                      ),
                      child: Text('PAID',
                          style: ADText.preview(c: AD.online).copyWith(
                            fontSize: 10,
                            fontWeight: FontWeight.w800,
                            letterSpacing: 0.4,
                          )),
                    ),
                  ],
                ]),
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
            Text(detail,
                style: ADText.preview(
                  c: s == _StepState.failed ? AD.danger : AD.textSecondary,
                ).copyWith(fontSize: 12)),
          ],
          if (s == _StepState.needsVisibleDial) ...[
            const SizedBox(height: 10),
            Text(
              'Your phone won\'t let AvaTOK do this quietly in the background, '
              'so your phone app will open with the code '
              '${_enableCodeFor(kind)} filled in. That code is the standard, '
              'safe instruction phone companies worldwide use to switch on '
              'call forwarding — it only talks to your phone company and '
              'can\'t read or change anything on your phone.',
              style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 12.5),
            ),
            const SizedBox(height: 8),
            Row(children: [
              Expanded(
                child: AdButton(
                  label: 'Dial it for me',
                  fontSize: 13.5,
                  onPressed: () => _enable(kind, visible: true),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: AdButton(
                  label: "I'll dial it myself",
                  fontSize: 13.5,
                  onPressed: () => _manualDial(kind),
                ),
              ),
            ]),
          ],
          if (s == _StepState.awaitReturn) ...[
            const SizedBox(height: 10),
            if (detail == null)
              Text(
                'Your phone app showed your phone company\'s reply to the '
                'forwarding code (a standard, safe carrier code). What did it say?',
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
        _StepState.dialing => 'Setting up with your phone company…',
        _StepState.verifying => 'Asking your phone company to confirm…',
        _StepState.needsVisibleDial => 'One small step needed',
        _StepState.awaitReturn => 'Waiting for confirmation',
        _StepState.verified => 'On — confirmed with your phone company',
        _StepState.skipped => 'Skipped — you can enable it later',
        // [AVA-VM-PAID-1] Says what it is and what it costs us, without
        // promising a purchase flow that doesn't exist yet.
        _StepState.paid => 'Part of a paid upgrade — coming soon',
        _ => null,
      };

  Widget _trailing(PstnForwardKind kind, _StepState s) {
    switch (s) {
      case _StepState.dialing:
      // [AVA-RCPT-VERIFY-2] `awaitReturn` (dialed the carrier code, waiting for
      // the user to come back from the dialer) was missing here — Dart requires
      // enum switches to be exhaustive, so the whole release build failed with
      // "'_StepState' is not exhaustively matched". It shows the same spinner as
      // its neighbours: the row's _statusLine already says "Waiting for
      // confirmation", and verification starts the moment the app resumes.
      case _StepState.awaitReturn:
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
      case _StepState.needsVisibleDial:
        return const SizedBox.shrink(); // choices render inline in the card body
      case _StepState.failed:
        return AdButton(label: 'Check again', fontSize: 13, onPressed: () => _verifyRetry(kind));
      case _StepState.ready:
        return AdButton(label: 'Turn on', fontSize: 13, onPressed: () => _enable(kind));
      case _StepState.locked:
        return PhosphorIcon(PhosphorIcons.lockSimple(PhosphorIconsStyle.bold),
            size: 18, color: AD.textTertiary);
      // [AVA-VM-PAID-1] No "Turn on" — the whole point is that this cannot be
      // switched on. The PAID pill next to the title carries the reason; this
      // is just the lock glyph, tinted green to match it.
      case _StepState.paid:
        return PhosphorIcon(PhosphorIcons.lockSimple(PhosphorIconsStyle.fill),
            size: 18, color: AD.online);
    }
  }
}
