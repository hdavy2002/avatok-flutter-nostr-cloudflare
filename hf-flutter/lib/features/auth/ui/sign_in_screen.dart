import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/auth/session.dart';
import '../../../core/links.dart';
import '../../../core/router/deep_links.dart';
import '../../../core/router/nav.dart';
import '../../../core/router/routes.dart';
import '../../../core/theme/hf_tokens.dart';
import '../../../core/widgets/widgets.dart';
import '../../welcome/data/ack_service.dart';
import '../data/auth_messages.dart';
import '../data/sign_in_controller.dart';
import 'code_boxes.dart';

/// Copy of the sign-in screens. Matches the website's WhatsApp sign-in, in simple English.
abstract final class SignInCopy {
  static const String title = 'Sign in with WhatsApp';
  static const String numberHint = "We'll send a 6-digit code on WhatsApp to sign you in.";
  static const String prefix = '+91';
  static const String numberLabel = 'WhatsApp number';
  static const String numberPlaceholder = '10-digit number';
  static const String sendCode = 'Send code on WhatsApp';
  static const String ageTick = "I'm 18 or over and I agree to the terms and safety rules.";
  static const String terms = 'Terms';
  static const String safety = 'Safety';

  static const String codeTitle = 'Enter the code';
  static String sentTo(String masked) => 'We sent a 6-digit code on WhatsApp to $masked.';
  static const String verify = 'Verify and log in';
  static const String resend = 'Send a new code';
  static String resendIn(int s) => 'Send a new code in ${s}s';
  static const String changeNumber = 'Change number';
}

/// `/sign-in?next=`: WhatsApp number, then the 6-digit code. Opened by `requireSignIn` (pushed: closes with
/// `true`) or by the router's sign-in rule (replaces the stack: goes to `next`, else Home).
class SignInScreen extends ConsumerStatefulWidget {
  const SignInScreen({super.key, this.next});

  final String? next;

  @override
  ConsumerState<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends ConsumerState<SignInScreen> {
  late final SignInController _c;
  final TextEditingController _phone = TextEditingController();
  final TextEditingController _code = TextEditingController();
  final FocusNode _phoneFocus = FocusNode();
  final FocusNode _codeFocus = FocusNode();

  @override
  void initState() {
    super.initState();
    final ack = ref.read(ackServiceProvider);
    _c = SignInController(
      api: ref.read(apiClientProvider),
      redeem: (ticket, {String? phone}) =>
          ref.read(sessionProvider.notifier).signInWithTicket(ticket, phone: phone),
      afterSignIn: ({required bool tickedNow}) => ack.syncToServer(tickedNow: tickedNow),
      readAcked: () async => (await ack.readLocal()) != null,
    );
    unawaited(_c.init());
    final next = widget.next;
    _c.trackStarted(next == null ? 'direct' : DeepLinks.telemetryPath(next));
    _c.addListener(_onChange);
  }

  SignInStep _lastStep = SignInStep.number;

  void _onChange() {
    if (_c.step == _lastStep) return;
    _lastStep = _c.step;
    if (_c.step == SignInStep.code) {
      _code.clear();
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _codeFocus.requestFocus();
      });
    } else {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _phoneFocus.requestFocus();
      });
    }
  }

  @override
  void dispose() {
    _c.removeListener(_onChange);
    _c.dispose();
    _phone.dispose();
    _code.dispose();
    _phoneFocus.dispose();
    _codeFocus.dispose();
    super.dispose();
  }

  Future<void> _verify() async {
    final ok = await _c.verify(_code.text);
    if (!mounted) return;
    if (!ok) {
      _code.clear();
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _codeFocus.requestFocus();
      });
      return;
    }
    final router = GoRouter.of(context);
    if (router.canPop()) {
      router.pop(true);
    } else {
      router.go(widget.next ?? Routes.home);
    }
  }

  void _back() {
    if (_c.step == SignInStep.code) {
      _c.changeNumber();
    } else {
      popOrHome(context);
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: _c,
      builder: (context, _) {
        final onCode = _c.step == SignInStep.code;
        return PopScope(
          canPop: !onCode,
          onPopInvokedWithResult: (didPop, _) {
            if (!didPop) _c.changeNumber();
          },
          child: Scaffold(
            appBar: AppBar(
              automaticallyImplyLeading: false,
              leading: IconButton(
                tooltip: 'Back',
                icon: const Icon(Icons.arrow_back_rounded),
                onPressed: _back,
              ),
              title: Text(onCode ? SignInCopy.codeTitle : SignInCopy.title),
            ),
            body: SafeArea(
              child: ListView(
                padding: const EdgeInsets.all(HfSpacing.page),
                children: onCode ? _codeStep() : _numberStep(),
              ),
            ),
          ),
        );
      },
    );
  }

  // ----------------------------------------------------------- number step

  List<Widget> _numberStep() {
    final phoneError = _c.errorField == 'phone' ? _c.error : null;
    return [
      const Text(SignInCopy.numberHint, style: HfText.bodyText),
      const SizedBox(height: HfSpacing.gapLarge),
      Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            height: 56,
            padding: const EdgeInsets.symmetric(horizontal: 16),
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: HfColors.lilac,
              borderRadius: BorderRadius.circular(HfRadius.control),
              border: Border.all(color: HfColors.line, width: 1.5),
            ),
            child: const Text(SignInCopy.prefix, style: HfText.bodyStrong),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: TextField(
              key: const ValueKey<String>('signin-phone'),
              controller: _phone,
              focusNode: _phoneFocus,
              keyboardType: TextInputType.phone,
              textInputAction: TextInputAction.done,
              inputFormatters: const [IndianMobileFormatter()],
              style: HfText.bodyText,
              decoration: InputDecoration(
                labelText: SignInCopy.numberLabel,
                hintText: SignInCopy.numberPlaceholder,
                errorText: phoneError,
                errorMaxLines: 3,
              ),
              onChanged: _c.setDigits,
              onSubmitted: (_) {
                if (_c.canSend) _c.sendCode();
              },
            ),
          ),
        ],
      ),
      if (_c.needsTick) ...[
        const SizedBox(height: HfSpacing.gap),
        _AgeTick(value: _c.ageTick, onChanged: _c.setAgeTick),
      ],
      const SizedBox(height: HfSpacing.gapLarge),
      HfButton(
        label: SignInCopy.sendCode,
        icon: Icons.chat_bubble_outline_rounded,
        loading: _c.sending,
        onPressed: _c.canSend ? _c.sendCode : null,
      ),
    ];
  }

  // ------------------------------------------------------------- code step

  List<Widget> _codeStep() {
    final codeError = _c.errorField == 'code' || _c.errorField == 'phone' ? _c.error : null;
    return [
      Text(SignInCopy.sentTo(_c.phoneMasked ?? ''), style: HfText.bodyText),
      const SizedBox(height: HfSpacing.gapLarge),
      CodeBoxes(
        controller: _code,
        focusNode: _codeFocus,
        enabled: !_c.verifying,
        hasError: codeError != null,
        onCompleted: _verify,
      ),
      if (codeError != null) ...[
        const SizedBox(height: 10),
        Semantics(
          liveRegion: true,
          child: Text(
            codeError,
            key: const ValueKey<String>('signin-error'),
            style: HfText.note.copyWith(color: HfColors.accent),
          ),
        ),
      ],
      if (_c.notice != null) ...[
        const SizedBox(height: 10),
        Semantics(
          liveRegion: true,
          child: Text(_c.notice!, key: const ValueKey<String>('signin-notice'), style: HfText.note),
        ),
      ],
      const SizedBox(height: HfSpacing.gapLarge),
      ListenableBuilder(
        listenable: _code,
        builder: (context, _) => HfButton(
          label: SignInCopy.verify,
          loading: _c.verifying,
          onPressed: _code.text.length == 6 && !_c.sending ? _verify : null,
        ),
      ),
      const SizedBox(height: HfSpacing.gap),
      if (_c.resendIn > 0)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 14),
          child: Text(
            SignInCopy.resendIn(_c.resendIn),
            key: const ValueKey<String>('signin-resend-wait'),
            style: HfText.note,
            textAlign: TextAlign.center,
          ),
        )
      else
        HfButton(
          label: SignInCopy.resend,
          kind: HfButtonKind.text,
          loading: _c.sending,
          onPressed: _c.canResend ? _c.resend : null,
        ),
      HfButton(label: SignInCopy.changeNumber, kind: HfButtonKind.text, onPressed: _c.changeNumber),
    ];
  }
}

/// The 18+ tick, shown only when Welcome did not run on this device.
class _AgeTick extends StatelessWidget {
  const _AgeTick({required this.value, required this.onChanged});

  final bool value;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        InkWell(
          key: const ValueKey<String>('signin-age-tick'),
          borderRadius: BorderRadius.circular(HfRadius.control),
          onTap: () => onChanged(!value),
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: HfSpacing.tap),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Checkbox(
                  value: value,
                  onChanged: (v) => onChanged(v ?? false),
                  activeColor: HfColors.plum,
                  checkColor: HfColors.cream,
                ),
                const Expanded(
                  child: Padding(
                    padding: EdgeInsets.only(top: 12),
                    child: Text(SignInCopy.ageTick, style: HfText.bodyText),
                  ),
                ),
              ],
            ),
          ),
        ),
        Wrap(
          children: [
            TextButton(onPressed: () => LinkOpener.instance.site('/terms'), child: const Text(SignInCopy.terms)),
            TextButton(onPressed: () => LinkOpener.instance.site('/safety'), child: const Text(SignInCopy.safety)),
          ],
        ),
      ],
    );
  }
}
