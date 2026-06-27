import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'account_storage.dart';
import 'ui/zine.dart';
import 'ui/zine_widgets.dart';

/// Under-18 terms acceptance gate.
///
/// When a user's birth year makes them a minor (< 18), they must read and accept
/// a short, minor-specific set of terms before their profile can be saved. The
/// acceptance is remembered per account (a parent + child share one phone — see
/// the rulebook's per-account scoping rule) so we don't re-prompt on every save.
class MinorTerms {
  MinorTerms._();
  static const _ss = FlutterSecureStorage();
  static const _key = 'minor_terms_accepted_v1';

  static Future<bool> _accepted() async {
    try {
      final v = await readScoped(_ss, _key);
      return v == '1';
    } catch (_) {
      return false;
    }
  }

  static Future<void> _remember() async {
    try {
      await _ss.write(key: scopedKey(_key), value: '1');
    } catch (_) {/* best-effort */}
  }

  /// Ensure the minor-terms have been accepted. Returns true to allow the save
  /// to proceed. Non-minors always pass. A minor who has already accepted passes
  /// silently; otherwise the terms sheet is shown and the result reflects their
  /// choice (true = accepted, false = declined / dismissed).
  static Future<bool> ensureAccepted(BuildContext context, {required bool isMinor}) async {
    if (!isMinor) return true;
    if (await _accepted()) return true;
    if (!context.mounted) return false;
    final ok = await _showSheet(context);
    if (ok) await _remember();
    return ok;
  }

  static Future<bool> _showSheet(BuildContext context) async {
    final res = await showModalBottomSheet<bool>(
      context: context,
      backgroundColor: Zine.paper,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(22))),
      builder: (ctx) => DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.78,
        maxChildSize: 0.92,
        minChildSize: 0.5,
        builder: (ctx, scroll) => Padding(
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('TERMS FOR USERS UNDER 18', style: ZineText.kicker()),
            const SizedBox(height: 8),
            Text('Because your birth year says you are under 18, please read and '
                'accept these terms before continuing.', style: ZineText.sub(size: 13)),
            const SizedBox(height: 12),
            Expanded(
              child: SingleChildScrollView(
                controller: scroll,
                child: Text(_termsBody, style: ZineText.sub(size: 13)),
              ),
            ),
            const SizedBox(height: 12),
            ZineButton(
              label: 'I have read and accept these terms',
              variant: ZineButtonVariant.blue,
              fullWidth: true, fontSize: 15, trailingIcon: false,
              onPressed: () => Navigator.pop(ctx, true),
            ),
            const SizedBox(height: 8),
            Center(child: TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: Text('Not now', style: ZineText.link(size: 14, color: Zine.inkSoft)),
            )),
          ]),
        ),
      ),
    );
    return res ?? false;
  }

  static const String _termsBody =
      'These terms are in addition to the AvaTOK Terms of Service and Privacy '
      'Policy and apply to anyone under the age of 18.\n\n'
      '1. Parent or guardian consent. If you are under 18, you confirm that a '
      'parent or legal guardian has reviewed these terms and agrees to your use '
      'of AvaTOK. A parent or guardian is responsible for supervising your use '
      'of the app.\n\n'
      '2. Keep yourself safe. Never share personal information — your home '
      'address, school, real phone number, passwords, or financial details — '
      'with people you do not know and trust. Your AvaTOK number lets you stay '
      'in touch without giving out your real number.\n\n'
      '3. Be kind and lawful. Do not send, request, or share content that is '
      'sexual, violent, hateful, bullying, or otherwise harmful or illegal. '
      'Treat other people with respect.\n\n'
      '4. Safety monitoring. To help protect younger users, AvaTOK may use '
      'automated safety features (such as Ava Guardian) to detect grooming, '
      'scams, and other unsafe behaviour, and may limit or restrict accounts '
      'that put a minor at risk. Some adult-oriented or paid features may be '
      'unavailable to under-18 accounts.\n\n'
      '5. AI features. Ava is an AI assistant and can make mistakes. Do not rely '
      'on Ava for medical, legal, financial, or other important decisions — talk '
      'to a trusted adult or a qualified professional.\n\n'
      '6. Getting help. If something or someone online makes you feel unsafe or '
      'uncomfortable, stop, save what happened, and tell a parent, guardian, or '
      'another trusted adult straight away. You can block and report anyone on '
      'AvaTOK.\n\n'
      'By tapping "I have read and accept these terms" you confirm that you (and '
      'your parent or guardian) understand and agree to the above.';
}
