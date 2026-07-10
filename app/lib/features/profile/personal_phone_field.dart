import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';

/// [AVA-IDGATE-1] Personal phone number — UNVERIFIED contact data.
///
/// WAS: a Firebase SMS-OTP confirmation flow (owner request 2026-07-08).
/// NOW: a plain text field. The SMS OTP is gone, because ALL phone verification was
/// removed on 2026-07-10 and Firebase phone auth is no longer a dependency.
///
/// WHY THE FIELD SURVIVED THE CULL: the owner asked to keep the option to add a
/// personal number, and there is a real use for it — the QR/share card. What it must
/// NEVER be again is a trust signal.
///
/// THIS NUMBER IS NOT VERIFIED AND MUST NOT GATE ANYTHING.
/// It is a string the user typed. It proves nothing:
///   • It is never checked against a carrier.
///   • It is not used for safety, moderation, or any lawful-request response.
///   • Nothing anywhere may branch on it.
/// The UI says so explicitly, so that nobody downstream — user or engineer —
/// mistakes it for the verified number it used to be. Identity is established by the
/// liveness check (see features/identity/public_action_gate.dart), and by nothing else.
///
/// The public API ([initialPhone], [initiallyVerified], [onVerified]) is unchanged so
/// existing call sites compile untouched. `initiallyVerified` is now ignored, and
/// [onVerified] fires on SAVE — meaning "the user entered this", never "we checked it".
class PersonalPhoneField extends StatefulWidget {
  final String initialPhone;

  /// Ignored. Retained only so existing call sites keep compiling. No phone number
  /// in this app is verified any more.
  final bool initiallyVerified;

  /// Fires when the user saves a number. NOT a verification callback.
  final ValueChanged<String> onVerified;

  const PersonalPhoneField({
    super.key,
    this.initialPhone = '',
    this.initiallyVerified = false,
    required this.onVerified,
  });

  @override
  State<PersonalPhoneField> createState() => _PersonalPhoneFieldState();
}

class _PersonalPhoneFieldState extends State<PersonalPhoneField> {
  static const _screen = 'profile_personal_phone';
  late final TextEditingController _phoneCtrl;
  bool _saved = false;

  @override
  void initState() {
    super.initState();
    _phoneCtrl = TextEditingController(
        text: widget.initialPhone.isNotEmpty ? widget.initialPhone : '+');
  }

  @override
  void dispose() {
    _phoneCtrl.dispose();
    super.dispose();
  }

  void _save() {
    final v = _phoneCtrl.text.trim();
    // Loosest possible sanity check. This is a contact string, not a credential —
    // rejecting an unusual but real number would be a worse failure than storing a
    // malformed one, because nothing depends on it being well-formed.
    if (v.length < 5) {
      setState(() => _saved = false);
      return;
    }
    Analytics.capture('personal_phone_saved', {'screen': _screen, 'verified': false});
    widget.onVerified(v);
    setState(() => _saved = true);
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(children: [
          Icon(PhosphorIcons.phone(PhosphorIconsStyle.bold), size: 18, color: Zine.inkSoft),
          const SizedBox(width: 8),
          Text('Personal phone (optional)', style: ZineText.cardTitle(size: 15)),
        ]),
        const SizedBox(height: 6),
        Text(
          'Shown on your share card if you turn that on. We don\'t verify it, '
          'don\'t text it, and it has no effect on your account.',
          style: ZineText.sub(size: 12, color: Zine.inkMute),
        ),
        const SizedBox(height: 10),
        ZineField(
          controller: _phoneCtrl,
          label: 'Phone number',
          keyboardType: TextInputType.phone,
          inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9+\-\s()]'))],
          onChanged: (_) { if (_saved) setState(() => _saved = false); },
        ),
        const SizedBox(height: 8),
        Row(children: [
          ZineButton(label: 'Save', fontSize: 15, onPressed: _save),
          if (_saved) ...[
            const SizedBox(width: 10),
            Text('Saved', style: ZineText.sub(size: 13, color: Zine.inkMute)),
          ],
        ]),
      ],
    );
  }
}
