import 'package:flutter/material.dart';

import '../avaphone/ava_phone_screen.dart';

/// [DIALPAD-BIZ-CALLS] Opens the dialpad with [number] already typed in, ready
/// to dial — the number is NOT auto-dialed, the user still presses call. This
/// is how a tapped AvaTOK number (a contact's profile, a shared contact card,
/// etc.) connects the friend channel (email) to the business channel
/// (AvaTOK number / dialpad). See Specs/PLAN-2026-07-11-dialpad-business-
/// calls-ava-voice-agent.md §2/§8 Phase A.
///
/// Always pushes a fresh [AvaPhoneScreen] (the dialer's home) which, given a
/// non-empty [AvaPhoneScreen.initialDialNumber], opens the dialpad sheet
/// pre-filled on first frame.
void openDialpadWithNumber(BuildContext context, String number) {
  final digits = number.trim();
  if (digits.isEmpty) return;
  Navigator.push(
    context,
    MaterialPageRoute(builder: (_) => AvaPhoneScreen(initialDialNumber: digits)),
  );
}
