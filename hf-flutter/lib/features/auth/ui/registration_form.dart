import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/api/api_error.dart';
import '../../../core/auth/session.dart';
import '../../../core/links.dart';
import '../../../core/storage/account_storage.dart';
import '../../../core/theme/hf_theme.dart';
import '../../../core/widgets/widgets.dart';
import '../../kyc/ui/identity_kyc_screen.dart';
import '../data/identity_api.dart';
import 'email_code_form.dart';
import 'identity_header.dart';

class RegistrationForm extends ConsumerStatefulWidget {
  const RegistrationForm({super.key, required this.onSaved});
  final Future<void> Function(String) onSaved;
  @override
  ConsumerState<RegistrationForm> createState() => _RegistrationFormState();
}

class _RegistrationFormState extends ConsumerState<RegistrationForm> {
  final _first = TextEditingController();
  final _last = TextEditingController();
  final _username = TextEditingController();
  final _accepted = <String>{};
  int _step = 2;
  bool _busy = false;
  bool _kycNow = false;
  bool _emailCodeSent = false;
  String? _availableUsername;
  String? _error;
  late final String? _owner;
  IdentityApi get _api => IdentityApi(ref.read(apiClientProvider));
  bool get _mine => _owner != null && AccountScope.id == _owner;

  @override
  void initState() { super.initState(); _owner = AccountScope.id; }

  @override
  void dispose() { _first.dispose(); _last.dispose(); _username.dispose(); super.dispose(); }

  void _nameNext() {
    if (_first.text.trim().isEmpty || _last.text.trim().isEmpty) {
      setState(() => _error = 'Enter your first and last name.'); return;
    }
    setState(() { _step = 5; _error = null; });
  }

  Future<void> _checkUsername() async {
    if (_busy || !_mine) return;
    final username = _username.text.trim().toLowerCase();
    if (!RegExp(r'^[a-z][a-z0-9_.]{2,29}$').hasMatch(username)) {
      setState(() => _error = 'Use 3–30 characters: letters, numbers, underscores or dots. Start with a letter.'); return;
    }
    setState(() { _busy = true; _error = null; _availableUsername = null; });
    try {
      final available = await _api.usernameAvailable(username);
      if (!mounted || !_mine || _username.text.trim().toLowerCase() != username) return;
      setState(() {
        _availableUsername = available ? username : null;
        _error = available ? null : 'That username is taken. Please choose another.';
      });
    } on ApiError catch (e) { if (mounted && _mine) setState(() => _error = e.userMessage); }
    finally { if (mounted) setState(() => _busy = false); }
  }

  Future<void> _save() async {
    if (_busy || !_mine || _accepted.length != IdentityApi.policies.length || _availableUsername == null) return;
    setState(() { _busy = true; _error = null; });
    try {
      await _api.register(firstName: _first.text, lastName: _last.text, username: _availableUsername!);
      if (!mounted || !_mine) return;
      await ref.read(sessionProvider.notifier).refreshMe();
      if (!mounted || !_mine) return;
      if (_kycNow) {
        await Navigator.of(context).push<void>(MaterialPageRoute(builder: (_) => const IdentityKycScreen()));
      }
      if (mounted && _mine) await widget.onSaved('${_first.text.trim()} ${_last.text.trim()}');
    } on ApiError catch (e) { if (mounted && _mine) setState(() => _error = e.userMessage); }
    finally { if (mounted) setState(() => _busy = false); }
  }

  static const _legal = [
    ('terms', 'Terms of Service', '/terms'),
    ('privacy', 'Privacy Policy', '/privacy'),
    ('disclaimer', 'Disclaimers', '/disclaimer'),
    ('community', 'Community rules', '/community-guidelines'),
    ('engagement', 'Rules of engagement', '/rules-of-engagement'),
  ];

  @override
  Widget build(BuildContext context) {
    ref.watch(sessionProvider);
    if (!_mine) return const Center(child: Text('Your account changed. Reopen registration to continue.'));
    final (title, subtitle) = switch (_step) {
      2 => ('Verify your email', "Enter your email address and we'll send a verification code."),
      4 => ('What should we call you?', "This is how you'll appear on your profile."),
      5 => ('Choose your username', 'This will be your unique identity on the app.'),
      6 => ('Unlock more conversations', 'Complete KYC to talk to more influencers and access verified spaces.'),
      _ => ('Review and accept', 'Please read and agree to continue.'),
    };
    return Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 520),
      child: ListView(padding: const EdgeInsets.fromLTRB(20, 4, 20, 32), children: [
        IdentityHeader(title: _step == 2 && _emailCodeSent ? 'Enter email code' : title,
          subtitle: _step == 2 && _emailCodeSent ? 'Verify the code sent to your email address.' : subtitle,
          step: _step == 2 && _emailCodeSent ? 3 : _step),
        HfCard(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (_step == 2) EmailCodeForm(verification: true,
            onChallengeChanged: (sent) { if (mounted) setState(() => _emailCodeSent = sent); },
            onVerified: () async { if (mounted && _mine) setState(() => _step = 4); }),
          if (_step == 4) ...[
            TextField(key: const ValueKey('registration-first-name'), controller: _first,
              textCapitalization: TextCapitalization.words, maxLength: 40,
              decoration: const InputDecoration(labelText: 'First name', counterText: '')),
            const SizedBox(height: 12),
            TextField(key: const ValueKey('registration-last-name'), controller: _last,
              textCapitalization: TextCapitalization.words, maxLength: 40,
              decoration: const InputDecoration(labelText: 'Last name', counterText: '')),
            const SizedBox(height: 16), HfButton(label: 'Continue', onPressed: _nameNext),
          ],
          if (_step == 5) ...[
            const Text('Your username cannot be changed later.'),
            const SizedBox(height: 16),
            TextField(key: const ValueKey('registration-username'), controller: _username,
              enabled: !_busy, autocorrect: false, maxLength: 30,
              inputFormatters: [FilteringTextInputFormatter.allow(RegExp('[a-zA-Z0-9_.]'))],
              decoration: const InputDecoration(labelText: 'Username'),
              onChanged: (_) => setState(() { _availableUsername = null; _error = null; })),
            if (_availableUsername != null) const Text('Available'),
            HfButton(label: 'Check availability', kind: HfButtonKind.secondary, loading: _busy, onPressed: _checkUsername),
            const SizedBox(height: 12),
            HfButton(label: 'Continue', onPressed: _availableUsername == null ? null : () => setState(() => _step = 6)),
          ],
          if (_step == 6) ...[
            const Text('Women-only, LGBTQ+, and some influencer conversations require full KYC. Your identity details stay private.'),
            const SizedBox(height: 16),
            const ListTile(leading: Icon(Icons.lock_outline), title: Text('Verified once. Stored securely.'),
              subtitle: Text('Verification opens after you finish accepting the account policies.')),
            HfButton(label: 'Do KYC now', onPressed: () => setState(() { _kycNow = true; _step = 7; })),
            HfButton(label: 'Maybe later', kind: HfButtonKind.secondary,
              onPressed: () => setState(() { _kycNow = false; _step = 7; })),
          ],
          if (_step == 7) ...[
            for (final policy in _legal) Row(children: [
              Checkbox(value: _accepted.contains(policy.$1), onChanged: _busy ? null : (v) => setState(() {
                if (v == true) { _accepted.add(policy.$1); } else { _accepted.remove(policy.$1); }
              })),
              Expanded(child: Text('I agree to the ${policy.$2}', style: HfText.of(context, HfText.note))),
              IconButton(tooltip: 'Read ${policy.$2}', icon: const Icon(Icons.chevron_right),
                onPressed: () => LinkOpener.instance.site(policy.$3)),
            ]),
            const SizedBox(height: 16),
            HfButton(key: const ValueKey('registration-create'), label: 'Finish creating account', loading: _busy,
              onPressed: _accepted.length == _legal.length ? _save : null),
          ],
          if (_error != null) Padding(padding: const EdgeInsets.only(top: 12),
            child: Semantics(liveRegion: true, child: Text(_error!))),
        ])),
        if (_step > 2) HfButton(label: 'Back', kind: HfButtonKind.text, onPressed: _busy ? null : () => setState(() {
          _step = _step == 4 ? 2 : _step - 1; _error = null;
        })),
      ])));
  }
}
