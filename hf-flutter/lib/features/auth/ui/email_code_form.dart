import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/api/api_error.dart';
import '../../../core/analytics/analytics.dart';
import '../../../core/auth/session.dart';
import '../../../core/auth/clerk_client.dart';
import '../../../core/storage/account_storage.dart';
import '../../../core/theme/hf_theme.dart';
import '../../../core/widgets/widgets.dart';
import '../data/identity_api.dart';
import 'code_boxes.dart';

class EmailCodeForm extends ConsumerStatefulWidget {
  const EmailCodeForm({super.key, required this.onVerified, this.verification = false,
    this.enabled = true, this.onBusyChanged, this.onChallengeChanged, this.initialEmail, this.challengeExpiresAt});
  final Future<void> Function() onVerified;
  final bool verification;
  final bool enabled;
  final ValueChanged<bool>? onBusyChanged;
  final ValueChanged<bool>? onChallengeChanged;
  final String? initialEmail;
  final int? challengeExpiresAt;
  @override
  ConsumerState<EmailCodeForm> createState() => _EmailCodeFormState();
}

class _EmailCodeFormState extends ConsumerState<EmailCodeForm> {
  final _email = TextEditingController();
  final _code = TextEditingController();
  final _focus = FocusNode();
  Timer? _timer;
  bool _sent = false;
  bool _busy = false;
  int _remaining = 0;
  String? _error;
  EmailChallenge? _challenge;
  late final String? _owner;
  bool get _mine => !widget.verification || (_owner != null && _owner == AccountScope.id);
  IdentityApi get _api => IdentityApi(ref.read(apiClientProvider));

  @override
  void initState() {
    super.initState(); _owner = AccountScope.id;
    _email.text = widget.initialEmail ?? '';
    // Challenge metadata is restored for this account, never the OTP itself.
    _sent = widget.verification && _email.text.isNotEmpty &&
        (widget.challengeExpiresAt ?? 0) > DateTime.now().millisecondsSinceEpoch;
  }

  @override
  void dispose() {
    _timer?.cancel(); _email.dispose(); _code.dispose(); _focus.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    if (!widget.enabled || !_mine || _busy || _remaining > 0) return;
    if (!RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$').hasMatch(_email.text.trim())) {
      setState(() => _error = 'Enter a valid email address.'); return;
    }
    setState(() { _busy = true; _error = null; });
    widget.onBusyChanged?.call(true);
    final owner = AccountScope.id;
    try {
      var gap = 30;
      if (widget.verification) {
        gap = await _api.sendEmail(_email.text);
      } else {
        final clerk = ref.read(clerkProvider);
        if (clerk is! ClerkEmailApi) throw StateError('Email sign-in is unavailable. Please use WhatsApp.');
        _challenge = await (clerk as ClerkEmailApi).startEmailCode(_email.text);
      }
      if (!mounted || (widget.verification && AccountScope.id != owner)) return;
      setState(() { _sent = true; _remaining = gap; });
      widget.onChallengeChanged?.call(true);
      _timer?.cancel();
      _timer = Timer.periodic(const Duration(seconds: 1), (t) {
        if (!mounted || _remaining <= 1) { t.cancel(); if (mounted) setState(() => _remaining = 0); }
        else { setState(() => _remaining--); }
      });
    } on ApiError catch (e) { if (mounted) setState(() => _error = _message(e)); }
    catch (_) { if (mounted) setState(() => _error = 'We could not send an email code. Try again or use WhatsApp.'); }
    finally { if (mounted) { setState(() => _busy = false); widget.onBusyChanged?.call(false); } }
  }

  String _message(ApiError e) => e.status == 404 || e.status == 503
      ? 'Email verification is unavailable right now. Please try again later or use WhatsApp to log in.'
      : e.userMessage;

  Future<void> _verify() async {
    if (!widget.enabled || !_mine || _busy || _code.text.length != 6) return;
    setState(() { _busy = true; _error = null; });
    widget.onBusyChanged?.call(true);
    final owner = AccountScope.id;
    try {
      if (widget.verification) {
        await _api.verifyEmail(_email.text, _code.text);
        if (!mounted || AccountScope.id != owner) return;
      } else {
        final challenge = _challenge;
        if (challenge == null) return;
        final result = await ref.read(sessionProvider.notifier).signInWithEmailCode(challenge, _code.text);
        if (!result.isComplete) { if (mounted) setState(() => _error = result.error); return; }
      }
      if (!mounted || !_mine) return;
      final uid = ref.read(sessionProvider).user?.id ?? AccountScope.id;
      if (uid != null) await Analytics.identify(uid, email: _email.text.trim());
      await Analytics.capture('hf_app_email_verified', {'outcome': 'ok', 'purpose': widget.verification ? 'registration' : 'login'});
      if (mounted && _mine) await widget.onVerified();
    } on EmailSecondFactor catch (e) {
      if (mounted) setState(() { _challenge = e.challenge; _code.clear(); _error = 'Enter the new email code to confirm this device.'; });
    } on ApiError catch (e) { if (mounted) setState(() => _error = _message(e)); }
    catch (_) { if (mounted) setState(() => _error = 'We could not verify that code. Please try again.'); }
    finally { if (mounted) { setState(() => _busy = false); widget.onBusyChanged?.call(false); } }
  }

  @override
  Widget build(BuildContext context) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
    Text(_sent ? 'Enter email code' : widget.verification ? 'Verify your email' : 'Log in with email',
      style: HfText.of(context, HfText.section)),
    const SizedBox(height: 12),
    if (!_sent) TextField(key: const ValueKey('identity-email'), controller: _email,
      enabled: widget.enabled && !_busy, keyboardType: TextInputType.emailAddress, autofillHints: const [AutofillHints.email],
      decoration: const InputDecoration(labelText: 'Email address', prefixIcon: Icon(Icons.mail_outline)),
      onSubmitted: (_) => _send())
    else ...[
      Text('We sent a 6-digit code to ${_email.text.trim()}.', style: HfText.of(context, HfText.note)),
      const SizedBox(height: 12),
      CodeBoxes(controller: _code, focusNode: _focus, enabled: widget.enabled && !_busy,
        sourceLabel: 'email', fieldKey: const ValueKey('identity-email-code'),
        hasError: _error != null, onCompleted: _verify),
    ],
    if (_error != null) Padding(padding: const EdgeInsets.only(top: 10),
      child: Semantics(liveRegion: true, child: Text(_error!, style: HfText.of(context, HfText.note)))),
    const SizedBox(height: 14),
    if (!_sent && _remaining > 0) Text('You can request a new code in ${_remaining}s.'),
    HfButton(label: _sent ? 'Verify and continue' : 'Send email OTP', loading: _busy,
      onPressed: _busy || !widget.enabled || (!_sent && _remaining > 0) ? null : _sent ? _verify : _send),
    if (_sent) ...[
      HfButton(label: _remaining > 0 ? 'Resend in ${_remaining}s' : 'Resend code',
        kind: HfButtonKind.text, onPressed: _remaining > 0 || _busy ? null : _send),
      HfButton(label: 'Change email', kind: HfButtonKind.secondary,
        onPressed: _busy ? null : () {
          setState(() { _sent = false; _code.clear(); _error = null; });
          widget.onChallengeChanged?.call(false);
        }),
    ],
  ]);
}
