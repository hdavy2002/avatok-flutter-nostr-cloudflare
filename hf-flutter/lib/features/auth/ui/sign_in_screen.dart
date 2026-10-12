import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/auth/session.dart';
import '../../../core/links.dart';
import '../../../core/router/deep_links.dart';
import '../../../core/router/nav.dart';
import '../../../core/router/pending_intent.dart';
import '../data/registration_progress.dart';
import '../../../core/router/routes.dart';
import '../../../core/theme/hf_theme.dart';
import '../../../core/widgets/hf_page_header.dart';
import '../../../core/widgets/widgets.dart';
import '../../welcome/data/ack_service.dart';
import '../data/auth_messages.dart';
import '../data/sign_in_controller.dart';
import 'auth_visuals.dart';
import 'code_boxes.dart';
import 'email_code_form.dart';
import '../data/remembered_accounts.dart';

/// Copy of the sign-in screens. Matches the website's WhatsApp sign-in, in simple English.
abstract final class SignInCopy {
  static const String title = 'Your next hello';
  static const String numberHint = "We'll send a code on WhatsApp.";
  static const String prefix = '+91';
  static const String numberLabel = 'WhatsApp number';
  static const String numberPlaceholder = '10-digit number';
  static const String sendCode = 'Send WhatsApp OTP';
  static const String ageTick =
      "I'm 18 or over and I agree to the terms and safety rules.";
  static const String terms = 'Terms';
  static const String safety = 'Safety';

  static const String codeTitle = 'Verify WhatsApp';
  static String sentTo(String masked) =>
      'We sent a 6-digit code on WhatsApp to $masked.';
  static const String verify = 'Verify and continue';
  static const String resend = 'Send a new code';
  static String resendIn(int s) => 'Send a new code in ${s}s';
  static const String changeNumber = 'Change number';
}

/// `/sign-in?next=`: WhatsApp number, then the 6-digit code. Opened by `requireSignIn` (pushed: closes with
/// `true`) or by the router's sign-in rule (replaces the stack: goes to `next`, else Home).
class SignInScreen extends ConsumerStatefulWidget {
  const SignInScreen({super.key, this.next, this.secondNumber = false});

  final String? next;
  final bool secondNumber;

  @override
  ConsumerState<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends ConsumerState<SignInScreen> {
  late final SignInController _c;
  final TextEditingController _phone = TextEditingController();
  final TextEditingController _code = TextEditingController();
  final FocusNode _phoneFocus = FocusNode();
  final FocusNode _codeFocus = FocusNode();
  List<RememberedAccount> _accounts = [];
  bool _landing = true;
  bool _emailBusy = false;
  RememberedAccounts get _remembered => RememberedAccounts(ref.read(secureStoreProvider));

  @override
  void initState() {
    super.initState();
    final ack = ref.read(ackServiceProvider);
    _c = SignInController(
      api: ref.read(apiClientProvider),
      redeem: (ticket, {String? phone}) => ref
          .read(sessionProvider.notifier)
          .signInWithTicket(ticket, phone: phone),
      onNewAccount: () =>
          ref.read(registrationProgressProvider).markNewAccount(),
      afterSignIn: ({required bool tickedNow}) =>
          ack.syncToServer(tickedNow: tickedNow),
      readAcked: () async => (await ack.readLocal()) != null,
    );
    unawaited(_c.init());
    _landing = widget.next == null && !widget.secondNumber;
    if (widget.secondNumber) _c.setRegistration(true);
    unawaited(_loadAccounts());
    final next = Routes.safeNext(widget.next);
    if (next != null) unawaited(ref.read(pendingIntentProvider).save(next));
    _c.trackStarted(next == null ? 'direct' : DeepLinks.telemetryPath(next));
    _c.addListener(_onChange);
  }

  SignInStep _lastStep = SignInStep.number;

  Future<void> _loadAccounts() async {
    final accounts = await _remembered.read();
    if (mounted) setState(() => _accounts = accounts);
  }

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
    final account = ref.read(sessionProvider);
    if (account.user != null) {
      try {
        await _remembered.remember(RememberedAccount(uid: account.user!.id,
          label: account.me?.displayName ?? account.user!.label, phone: _c.e164));
      } catch (_) { /* Remembering a choice never blocks a verified sign-in. */ }
    }
    await _finishSignIn();
  }

  Future<void> _finishSignIn() async {
    if (!mounted) return;
    final router = GoRouter.of(context);
    final next = Routes.safeNext(widget.next);
    if (next != null) await ref.read(pendingIntentProvider).save(next);
    if (!mounted) return;
    if (await ref.read(ackServiceProvider).needsWelcomeNow()) {
      if (!mounted) return;
      final accepted = await router.push<bool>(Routes.welcomeTo(next));
      if (!mounted) return;
      if (accepted != true) {
        await ref.read(pendingIntentProvider).clear();
        if (mounted) router.go(Routes.home);
        return;
      }
    }
    if (await ref.read(registrationProgressProvider).needsName()) {
      if (!mounted) return;
      final named = await router.push<bool>(Routes.completeProfileTo(next));
      if (!mounted) return;
      if (named != true) {
        await ref.read(pendingIntentProvider).clear();
        if (mounted) router.go(Routes.home);
        return;
      }
    }
    await ref.read(pendingIntentProvider).clear();
    if (!mounted) return;
    if (router.canPop()) {
      router.pop(true);
    } else {
      router.go(next ?? Routes.home);
    }
  }

  void _back() {
    if (_c.step == SignInStep.code) {
      _c.changeNumber();
    } else {
      unawaited(ref.read(pendingIntentProvider).clear());
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
          onPopInvokedWithResult: (didPop, result) {
            if (!didPop) {
              _c.changeNumber();
            } else if (result != true) {
              unawaited(ref.read(pendingIntentProvider).clear());
            }
          },
          child: Scaffold(
            body: AuthViewport(
              child: _landing ? _welcome() : _form(onCode),
            ),
          ),
        );
      },
    );
  }

  Widget _form(bool onCode) {
    return Builder(
      builder: (context) => ListView(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 28),
        children: [
          AuthBackRow(onBack: _back, step: onCode && _c.registration ? 1 : null),
          if (onCode)
            AuthIdentityHero(
              title: SignInCopy.codeTitle,
              subtitle: SignInCopy.sentTo(_c.phoneMasked ?? ''),
              photo: AuthPhotoKind.whatsappOtp,
              sticker: const _WhatsAppBadge(),
            )
          else if (widget.secondNumber)
            const AuthIdentityHero(
              title: 'Add your second WhatsApp number',
              subtitle: 'Create a separate account with another WhatsApp number you control.',
              photo: AuthPhotoKind.secondWhatsapp,
              photoHeight: 200,
            )
          else if (_c.registration)
            const AuthIdentityHero(
              title: 'Create your account',
              subtitle: 'Start with a WhatsApp number you control.',
              photo: AuthPhotoKind.whatsappOtp,
              photoHeight: 180,
            )
          else ...[
            const AuthPhoto(kind: AuthPhotoKind.login, height: 156),
            const SizedBox(height: 12),
            Text('Welcome back', style: HfText.of(context, HfText.headline)),
            Text('Log in to continue your journey.', style: HfText.of(context, HfText.note)),
            const SizedBox(height: 14),
          ],
          if (!onCode && !_c.registration && !widget.secondNumber) ...[
            AuthSurfaceCard(child: EmailCodeForm(onVerified: _finishSignIn,
              enabled: !_c.sending && !_c.verifying,
              onBusyChanged: (busy) { if (mounted) setState(() => _emailBusy = busy); })),
            const Padding(padding: EdgeInsets.symmetric(vertical: 16), child: Row(children: [
              Expanded(child: Divider()), Padding(padding: EdgeInsets.symmetric(horizontal: 16), child: Text('OR')), Expanded(child: Divider()),
            ])),
          ],
          HfCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: onCode ? _codeStep() : _numberStep(),
            ),
          ),
          const SizedBox(height: 16),
          if (!onCode && _accounts.length > 1) ...[
            Text('Your accounts', style: HfText.of(context, HfText.section)),
            const Text('Choose an account, then verify its WhatsApp code.'),
            for (final account in _accounts) Card(child: ListTile(
              leading: const CircleAvatar(child: Icon(Icons.person_outline)),
              title: Text(account.label), subtitle: Text(account.masked),
              onTap: _emailBusy || _c.sending ? null : () { _phone.text = normalizeIndianMobile(account.phone); _c.setDigits(_phone.text); _c.setRegistration(false); },
              trailing: IconButton(tooltip: 'Forget this account', icon: const Icon(Icons.close), onPressed: () async {
                await _remembered.forget(account.uid); await _loadAccounts();
              }),
            )),
          ],
          if (!onCode && !widget.secondNumber) HfButton(label: 'Add another WhatsApp number', kind: HfButtonKind.text,
            onPressed: _emailBusy || _c.sending ? null : () => Navigator.of(context).push<void>(MaterialPageRoute(builder: (_) => SignInScreen(next: widget.next, secondNumber: true)))),
          Text(
            'Your number stays private from other people.',
            style: HfText.of(context, HfText.note),
            textAlign: TextAlign.center,
          ),
        ],
      ),
    );
  }

  Widget _welcome() => ListView(padding: const EdgeInsets.fromLTRB(20, 40, 20, 28), children: [
    Text('Find people, services\nand conversations\nthat fit you',
      textAlign: TextAlign.center, style: HfText.of(context, HfText.hero)),
    const SizedBox(height: 12),
    Text('A safer, kinder place to talk,\nlearn and get support.',
      textAlign: TextAlign.center, style: HfText.of(context, HfText.body)),
    const SizedBox(height: 18),
    const AuthPhoto(kind: AuthPhotoKind.welcome, height: 300,
      sticker: AuthSticker('Good people\nbrighter days')),
    const SizedBox(height: 18),
    HfButton(label: 'Log in', icon: Icons.arrow_forward, onPressed: () => setState(() { _landing = false; _c.setRegistration(false); })),
    const SizedBox(height: 12),
    HfButton(label: 'Sign up', kind: HfButtonKind.secondary, icon: Icons.arrow_forward,
      onPressed: () => setState(() { _landing = false; _c.setRegistration(true); })),
    const SizedBox(height: 20),
    const AuthCallout(icon: Icons.verified_user_outlined, title: 'Safe and trusted',
      body: 'Your privacy matters. Conversations stay private and people are verified.'),
  ]);

  // ----------------------------------------------------------- number step

  List<Widget> _numberStep() {
    final phoneError = _c.errorField == 'phone' ? _c.error : null;
    return [
      if (widget.secondNumber) ...[
        const AuthCallout(
          icon: Icons.phone_in_talk_outlined,
          title: 'A second number, a separate account',
          body: 'Enter another WhatsApp number you can access. We send a verification code; the app does not detect or verify a physical SIM in this phone.',
          tint: HfColors.butter,
        ),
        const SizedBox(height: 16),
      ],
      Wrap(
        spacing: 8,
        runSpacing: 0,
        children: [
          HfChip(
            label: 'Log in',
            selected: !_c.registration,
            onTap: _emailBusy || _c.sending ? null : () => _c.setRegistration(false),
          ),
          HfChip(
            label: 'Create account',
            selected: _c.registration,
            onTap: _emailBusy || _c.sending ? null : () => _c.setRegistration(true),
          ),
        ],
      ),
      const SizedBox(height: 16),
      Text(
        widget.secondNumber
            ? 'Enter the WhatsApp number for your other account. We verify access using an OTP; we do not detect or verify a physical SIM in this phone.'
            : _c.registration
            ? 'Your account starts with a verified WhatsApp number. Please accept the age and safety rules below.'
            : SignInCopy.numberHint,
        style: HfText.of(context, HfText.note),
      ),
      const SizedBox(height: HfSpacing.gapLarge),
      if (widget.secondNumber) ...[
        Text('Country or region', style: HfText.of(context, HfText.bodyStrong)),
        const SizedBox(height: 8),
        const InputDecorator(
          decoration: InputDecoration(),
          child: Row(children: [Text('🇮🇳'), SizedBox(width: 10), Text('India (+91)'), Spacer(), Icon(Icons.expand_more)]),
        ),
        const SizedBox(height: 16),
        Text('WhatsApp number', style: HfText.of(context, HfText.bodyStrong)),
        const SizedBox(height: 8),
      ],
      Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Builder(
            builder: (context) {
              final dark = HfBrightness.isDark(context);
              return Container(
                height: 56,
                padding: const EdgeInsets.symmetric(horizontal: 16),
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: dark ? HfColors.darkTile : HfColors.surfaceSoft,
                  borderRadius: BorderRadius.circular(HfRadius.input),
                  border: Border.all(
                    color: dark ? HfColors.darkLine : HfColors.line,
                  ),
                ),
                child: Text(
                  SignInCopy.prefix,
                  style: HfText.of(context, HfText.bodyStrong),
                ),
              );
            },
          ),
          const SizedBox(width: 12),
          Expanded(
            child: TextField(
              key: const ValueKey<String>('signin-phone'),
              controller: _phone,
              enabled: !_emailBusy && !_c.sending,
              focusNode: _phoneFocus,
              keyboardType: TextInputType.phone,
              textInputAction: TextInputAction.done,
              inputFormatters: const [IndianMobileFormatter()],
              style: HfText.of(context, HfText.body),
              decoration: InputDecoration(
                hintText: SignInCopy.numberPlaceholder,
                errorText: phoneError,
                errorMaxLines: 3,
              ),
              onChanged: _c.setDigits,
              onSubmitted: (_) {
                if (!_emailBusy && _c.canSend) _c.sendCode();
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
        onPressed: !_emailBusy && _c.canSend ? _c.sendCode : null,
      ),
    ];
  }

  // ------------------------------------------------------------- code step

  List<Widget> _codeStep() {
    final codeError = _c.errorField == 'code' || _c.errorField == 'phone'
        ? _c.error
        : null;
    return [
      Text(
        'Enter 6-digit code',
        style: HfText.of(context, HfText.section),
      ),
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
            style: HfText.note.copyWith(
              color: HfBrightness.isDark(context)
                  ? HfColors.blushLight
                  : HfColors.accent,
            ),
          ),
        ),
      ],
      if (_c.notice != null) ...[
        const SizedBox(height: 10),
        Semantics(
          liveRegion: true,
          child: Text(
            _c.notice!,
            key: const ValueKey<String>('signin-notice'),
            style: HfText.of(context, HfText.note),
          ),
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
        Center(
          child: Container(
            margin: const EdgeInsets.symmetric(vertical: 10),
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
            decoration: BoxDecoration(
              color: HfBrightness.isDark(context)
                  ? HfColors.darkTile
                  : HfColors.surfaceSoft,
              borderRadius: BorderRadius.circular(HfRadius.pillRadius),
            ),
            child: Text(
              SignInCopy.resendIn(_c.resendIn),
              key: const ValueKey<String>('signin-resend-wait'),
              style: HfText.of(context, HfText.badge),
              textAlign: TextAlign.center,
            ),
          ),
        )
      else
        HfButton(
          label: SignInCopy.resend,
          kind: HfButtonKind.text,
          loading: _c.sending,
          onPressed: _c.canResend ? _c.resend : null,
        ),
      HfButton(
        label: SignInCopy.changeNumber,
        kind: HfButtonKind.text,
        onPressed: _c.changeNumber,
      ),
    ];
  }
}

class _WhatsAppBadge extends StatelessWidget {
  const _WhatsAppBadge();

  @override
  Widget build(BuildContext context) => Container(
    width: 62,
    height: 62,
    decoration: const BoxDecoration(
      color: Color(0xFF25D366),
      shape: BoxShape.circle,
      border: Border.fromBorderSide(BorderSide(color: Colors.white, width: 5)),
      boxShadow: HfShadows.segment,
    ),
    child: const Icon(Icons.phone_rounded, color: Colors.white, size: 32),
  );
}

/// Explicit registration consent, never inferred from another account on this phone.
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
                Padding(
                  padding: const EdgeInsets.fromLTRB(12, 12, 12, 12),
                  child: Semantics(
                    checked: value,
                    child: HfCheckMark(checked: value),
                  ),
                ),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.only(top: 12),
                    child: Text(
                      SignInCopy.ageTick,
                      style: HfText.of(context, HfText.body),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
        Wrap(
          children: [
            TextButton(
              onPressed: () => LinkOpener.instance.site('/terms'),
              child: const Text(SignInCopy.terms),
            ),
            TextButton(
              onPressed: () => LinkOpener.instance.site('/safety'),
              child: const Text(SignInCopy.safety),
            ),
          ],
        ),
      ],
    );
  }
}
