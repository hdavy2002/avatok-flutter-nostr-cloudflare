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
import 'auth_visuals.dart';
import 'email_code_form.dart';

class RegistrationForm extends ConsumerStatefulWidget {
  const RegistrationForm({super.key, required this.onSaved, required this.onCancel});
  final Future<void> Function(String) onSaved;
  final VoidCallback onCancel;
  @override
  ConsumerState<RegistrationForm> createState() => _RegistrationFormState();
}

class _RegistrationFormState extends ConsumerState<RegistrationForm> {
  final _first = TextEditingController();
  final _last = TextEditingController();
  final _username = TextEditingController();
  final _accepted = <String>{};
  final _policyVersions = <String, String>{};
  int _step = 2;
  bool _loaded = false;
  bool _busy = false;
  bool _kycNow = false;
  bool _emailCodeSent = false;
  String? _availableUsername;
  String? _error;
  String? _email;
  int? _emailExpiresAt;
  late final String? _owner;
  late final String? _serverUid;
  IdentityApi get _api => IdentityApi(ref.read(apiClientProvider));
  bool get _mine => _owner != null && AccountScope.id == _owner;

  @override
  void initState() {
    super.initState();
    _owner = AccountScope.id;
    _serverUid = ref.read(sessionProvider).me?.uid ?? _owner;
    unawaited(_load());
  }

  @override
  void dispose() { _first.dispose(); _last.dispose(); _username.dispose(); super.dispose(); }

  void _apply(RegistrationDraft draft) {
    if (draft.uid != _serverUid) throw ApiError.badResponse(200);
    _first.text = draft.firstName;
    _last.text = draft.lastName;
    _username.text = draft.username;
    _availableUsername = draft.username.isEmpty ? null : draft.username;
    _kycNow = draft.kycNow ?? false;
    _accepted..clear()..addAll(draft.acceptedPolicyVersions.keys);
    _policyVersions..clear()..addAll(draft.policyVersions);
    _email = draft.email;
    _emailExpiresAt = draft.emailExpiresAt;
    _emailCodeSent = draft.step == 3;
    _step = draft.step == 3 ? 2 : draft.step;
    _loaded = true;
  }

  Future<void> _load() async {
    if (_busy || !_mine) return;
    setState(() { _busy = true; _error = null; });
    try {
      final draft = await _api.registration();
      if (!mounted || !_mine) return;
      setState(() => _apply(draft));
      if (draft.complete) await widget.onSaved('${draft.firstName} ${draft.lastName}'.trim());
    } on ApiError catch (e) {
      if (mounted && _mine) setState(() => _error = e.userMessage);
    } finally { if (mounted && _mine) setState(() => _busy = false); }
  }

  Future<void> _persist(String step, Map<String, Object?> fields, {int? next}) async {
    if (_busy || !_mine) return;
    setState(() { _busy = true; _error = null; });
    try {
      final draft = await _api.saveStep(step, fields);
      if (!mounted || !_mine) return;
      setState(() { _apply(draft); if (next != null && !draft.complete) _step = next; });
    } on ApiError catch (e) {
      if (mounted && _mine) setState(() => _error = e.userMessage);
    } finally { if (mounted && _mine) setState(() => _busy = false); }
  }

  Future<void> _nameNext() async {
    if (_first.text.trim().isEmpty || _last.text.trim().isEmpty) {
      setState(() => _error = 'Enter your first and last name.'); return;
    }
    await _persist('name', {'firstName': _first.text, 'lastName': _last.text}, next: 5);
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
      await _api.register(firstName: _first.text, lastName: _last.text, username: _availableUsername!,
        acceptedPolicyVersions: {for (final policy in _accepted) policy: _policyVersions[policy]!});
      if (!mounted || !_mine) return;
      await ref.read(sessionProvider.notifier).refreshMe();
      if (!mounted || !_mine) return;
      if (_kycNow) {
        await Navigator.of(context).push<void>(MaterialPageRoute(builder: (_) => const IdentityKycScreen()));
      }
      if (mounted && _mine) await widget.onSaved('${_first.text.trim()} ${_last.text.trim()}');
    } on ApiError catch (e) {
      if (mounted && _mine) setState(() {
        _error = e.userMessage;
        if (e.code == 'username_taken' || e.code == 'username_reserved') { _step = 5; _availableUsername = null; }
        if (e.code == 'policy_versions_required') _loaded = false;
      });
    }
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
    if (!_loaded) return Center(child: Column(mainAxisSize: MainAxisSize.min, children: [
      if (_busy) const CircularProgressIndicator(),
      if (_error != null) Text(_error!),
      if (!_busy) HfButton(label: 'Retry registration', onPressed: _load),
    ]));
    if (_step == 1) return const Center(child: Text('Verify your WhatsApp number by signing in again to continue registration.'));
    if (_step == 8) return const Center(child: Text('Your account has been created.'));
    final (title, subtitle, photo) = switch (_step) {
      2 => (_emailCodeSent ? 'Enter email code' : 'Verify your email',
        _emailCodeSent ? 'We sent a 6-digit code to your email address.' : "Enter your email address and we'll send a verification code.",
        _emailCodeSent ? AuthPhotoKind.emailOtp : AuthPhotoKind.email),
      4 => ('What should we call you?', "This is how you'll appear on your profile.", AuthPhotoKind.name),
      5 => ('Choose your username', 'This will be your unique identity on the app.', AuthPhotoKind.username),
      6 => ('Unlock more conversations', 'Complete KYC for protected spaces and creator publishing.', AuthPhotoKind.kyc),
      _ => ('Review and accept', 'Please read and agree to continue.', AuthPhotoKind.policies),
    };
    final visualStep = _step == 2 && _emailCodeSent ? 3 : _step;
    return ListView(padding: const EdgeInsets.fromLTRB(20, 8, 20, 28), children: [
        AuthBackRow(onBack: _busy ? () {} : _step > 2 ? () => setState(() {
          _step = _step == 4 ? 2 : _step - 1; _error = null;
        }) : widget.onCancel, step: visualStep),
        AuthIdentityHero(title: title, subtitle: subtitle, photo: photo,
          guide: _error != null ? BeaverPose.oops : BeaverPose.idle,
          photoHeight: _step == 6 || _step == 7 ? 176 : 188,
          sticker: _step == 4 ? const AuthSticker('Nice to\nmeet you!')
            : _step == 5 ? const AuthSticker('Be\nyou', color: HfColors.blush)
            : _step == 7 ? const AuthSticker("Let's get\nstarted!", color: HfColors.blush)
            : null),
        AuthSurfaceCard(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (_step == 2) EmailCodeForm(verification: true,
            showHeading: false,
            initialEmail: _email, challengeExpiresAt: _emailExpiresAt,
            onChallengeChanged: (sent) { if (mounted) setState(() => _emailCodeSent = sent); },
            onVerified: _load),
          if (_step == 4) ...[
            TextField(key: const ValueKey('registration-first-name'), controller: _first,
              enabled: !_busy,
              textCapitalization: TextCapitalization.words, maxLength: 40,
              decoration: const InputDecoration(labelText: 'First name', counterText: '')),
            const SizedBox(height: 12),
            TextField(key: const ValueKey('registration-last-name'), controller: _last,
              enabled: !_busy,
              textCapitalization: TextCapitalization.words, maxLength: 40,
              decoration: const InputDecoration(labelText: 'Last name', counterText: '')),
            const SizedBox(height: 16), HfButton(label: 'Continue', loading: _busy, onPressed: _busy ? null : _nameNext),
          ],
          if (_step == 5) ...[
            const AuthCallout(icon: Icons.info_outline, title: 'Choose carefully',
              body: 'Your username cannot be changed later.', tint: HfColors.butter),
            const SizedBox(height: 16),
            TextField(key: const ValueKey('registration-username'), controller: _username,
              enabled: !_busy, autocorrect: false, maxLength: 30,
              inputFormatters: [FilteringTextInputFormatter.allow(RegExp('[a-zA-Z0-9_.]'))],
              decoration: const InputDecoration(labelText: 'Username'),
              onChanged: (_) => setState(() { _availableUsername = null; _error = null; })),
            if (_availableUsername != null) const Text('Available'),
            HfButton(label: 'Check availability', kind: HfButtonKind.secondary, loading: _busy, onPressed: _checkUsername),
            const SizedBox(height: 10),
            Text('Suggestions for you', style: HfText.of(context, HfText.badge)),
            const SizedBox(height: 8),
            Wrap(spacing: 8, runSpacing: 8, children: [
              for (final suggestion in const ['maya', 'maya.connect', 'maya_27'])
                ActionChip(label: Text(suggestion), onPressed: _busy ? null : () {
                  _username.text = suggestion;
                  setState(() { _availableUsername = null; _error = null; });
                }),
            ]),
            const SizedBox(height: 12),
            HfButton(label: 'Continue', onPressed: _busy || _availableUsername == null ? null
              : () => _persist('username', {'username': _availableUsername}, next: 6)),
          ],
          if (_step == 6) ...[
            const AuthCallout(icon: Icons.lock_outline, title: 'Private by design',
              body: 'Women-only, LGBTQ+, and some influencer conversations require full KYC. Your identity details stay private.'),
            const SizedBox(height: 16),
            const ListTile(leading: Icon(Icons.verified_user_outlined), title: Text('Verified once. Stored securely.'),
              subtitle: Text('We use industry-standard encryption to protect your information.')),
            HfButton(label: 'Do KYC now', loading: _busy,
              onPressed: _busy ? null : () => _persist('kyc', {'kycNow': true}, next: 7)),
            HfButton(label: 'Maybe later', kind: HfButtonKind.secondary,
              onPressed: _busy ? null : () => _persist('kyc', {'kycNow': false}, next: 7)),
          ],
          if (_step == 7) ...[
            for (final policy in _legal) Column(children: [Row(children: [
              Checkbox(value: _accepted.contains(policy.$1), onChanged: _busy ? null : (v) {
                final accepted = {..._accepted};
                if (v == true) { accepted.add(policy.$1); } else { accepted.remove(policy.$1); }
                unawaited(_persist('policies', {'acceptedPolicyVersions': {
                  for (final name in accepted) name: _policyVersions[name],
                }}, next: 7));
              }),
              Expanded(child: Text('I agree to the ${policy.$2}', style: HfText.of(context, HfText.note))),
              IconButton(tooltip: 'Read ${policy.$2}', icon: const Icon(Icons.chevron_right),
                onPressed: () => LinkOpener.instance.site(policy.$3)),
            ]), const Divider()]),
            const SizedBox(height: 16),
            HfButton(key: const ValueKey('registration-create'), label: 'Create account', loading: _busy,
              onPressed: _accepted.length == _legal.length ? _save : null),
          ],
          if (_error != null) Padding(padding: const EdgeInsets.only(top: 12),
            child: Semantics(liveRegion: true, child: Text(_error!))),
        ])),
      ]);
  }
}
