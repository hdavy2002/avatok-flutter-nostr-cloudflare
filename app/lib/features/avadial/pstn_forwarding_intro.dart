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
import 'pstn_forwarding_wizard.dart';

/// [AVA-RCPT-CONSENT-1] (owner decision 2026-07-16, PLAN-2026-07-16
/// receptionist/guardian doc): carrier voicemail forwarding is ON BY DEFAULT
/// for every AvaTOK user, and that default is surfaced through an
/// informed-consent screen instead of being switched on silently. This file
/// is that screen — both the full-screen route [PstnForwardingIntroScreen]
/// (existing users, pushed once from shell_v2.dart) and the embeddable
/// [PstnForwardingIntroBody] (new users, embedded as an onboarding step body
/// in onboarding_flow.dart's `_composeSteps()`).
///
/// [AVA-RCPT-VERIFY-1] (owner decision 2026-07-17): both surfaces embed the
/// SAME sequential dial-and-verify wizard ([PstnForwardingWizard]) — this
/// file must never dial an MMI code or write toggle state itself. Each of
/// the three conditions is a button the user taps; a row only turns green
/// after the CARRIER confirms the forwarding is registered (status-code
/// query), and Continue unlocks only once every row is verified or skipped.
/// The old Continue-dials-all-three-blind sequence is gone — it left users
/// believing voicemail was on when no code had actually registered.
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
///
/// [AVA-RCPT-CONSENT-2 2026-07-17] `encryptedSharedPreferences: true` here —
/// PostHog showed `pstn_forward_intro_shown` firing again on this device
/// hours after a completed Continue (`pstn_forward_intro_done` with
/// `all_ok: true`), with no `account_switch` and no `secure_storage_corrupt`
/// event in between, i.e. the seen marker didn't survive a real process
/// restart even though the write never errored. This file's storage instance
/// (and pstn_forwarding_setup.dart's) was the DEFAULT (legacy, non-
/// EncryptedSharedPreferences) Android mode — [IdentityStore] deliberately
/// opted OUT of that same default for the identical reliability reason. Both
/// now match IdentityStore's option.
const String _kIntroSeenKey = 'pstn_forwarding_intro_seen';
final FlutterSecureStorage _introSec = const FlutterSecureStorage(
  aOptions: AndroidOptions(encryptedSharedPreferences: true),
);

/// Seen if EITHER the local marker says so, OR the user already has all three
/// carrier-forwarding conditions confirmed on. The second check is a second,
/// independent brake — so a user who already granted forwarding is never
/// re-asked even if some future bug loses the marker again — and directly
/// answers "if I've allowed it, stop bothering me" regardless of how the
/// marker itself is doing.
Future<bool> pstnIntroSeen() async {
  final v = await readScoped(_introSec, _kIntroSeenKey);
  if (v == '1') return true;
  final alreadyOn = await _forwardingAlreadyOn();
  if (alreadyOn) {
    Analytics.capture('pstn_forward_intro_seen_via_toggle_state');
    await markPstnIntroSeen(); // heal the marker so the fallback isn't needed again
  }
  return alreadyOn;
}

/// True only when all three carrier-forwarding conditions are CONFIRMED on —
/// [pstnDialAndPersist] persists a toggle's value only after the carrier
/// accepts the code, never optimistically — so this can't false-positive on a
/// forwarding attempt that actually failed.
Future<bool> _forwardingAlreadyOn() async {
  try {
    final missed = await readScoped(_introSec, PstnForwardKind.missed.storageKey);
    final declined = await readScoped(_introSec, PstnForwardKind.declined.storageKey);
    final unreachable = await readScoped(_introSec, PstnForwardKind.unreachable.storageKey);
    return missed == '1' && declined == '1' && unreachable == '1';
  } catch (_) {
    return false; // never let a storage error block the caller
  }
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
  // [AVA-RCPT-CONSENT-2] Same encryptedSharedPreferences option as [_introSec]
  // above — this is the storage the per-toggle "confirmed on" state
  // ([_forwardingAlreadyOn]) is persisted to, so it needs the same reliability
  // fix or the fallback "already granted" check would be reading storage that
  // can go missing across a real process restart.
  static final FlutterSecureStorage _sec = const FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  // [AVA-RCPT-VERIFY-1] The dial-everything-on-Continue sequence is GONE —
  // the embedded wizard drives per-condition dial + carrier verification, and
  // Continue only closes the screen once every condition is verified/skipped.
  bool _allDone = false;
  int _verifiedCount = 0;

  @override
  void initState() {
    super.initState();
    Analytics.screenViewed('avadial', 'pstn_forwarding_intro');
  }

  Future<void> _continue() async {
    Analytics.capture('pstn_forward_intro_continue_tapped');
    await markPstnIntroSeen();
    Analytics.capture('pstn_forward_intro_done',
        {'skipped': false, 'verified_count': _verifiedCount, 'all_done': _allDone});
    widget.onFinished();
  }

  Future<void> _skip() async {
    Analytics.capture('pstn_forward_intro_skip_tapped');
    await markPstnIntroSeen();
    Analytics.capture('pstn_forward_intro_done',
        {'skipped': true, 'verified_count': _verifiedCount});
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
          // [AVA-RCPT-VERIFY-1] One button per condition, unlocked in order.
          // Each tap dials the code in the background, then the carrier is
          // asked to CONFIRM before the row goes green — see the wizard's doc.
          PstnForwardingWizard(
            did: _did,
            storage: _sec,
            onProgress: (allDone, verifiedCount) {
              if (!mounted) return;
              setState(() {
                _allDone = allDone;
                _verifiedCount = verifiedCount;
              });
            },
          ),
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
                  'A row only turns green after your carrier confirms the '
                  'forwarding is on — no guesswork.',
                  style: ADText.preview(c: AD.textSecondary).copyWith(fontSize: 12.5),
                ),
              ),
            ]),
          ),
          const SizedBox(height: 28),
          AdButton(
            label: _allDone ? 'Continue' : 'Finish the steps above',
            onPressed: _allDone ? _continue : null,
            fullWidth: true,
            fontSize: 21,
            icon: _allDone ? PhosphorIcons.arrowRight(PhosphorIconsStyle.bold) : null,
          ),
          const SizedBox(height: 14),
          ZineLink(
            'Not now',
            fontSize: 14,
            onTap: _skip,
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

}
