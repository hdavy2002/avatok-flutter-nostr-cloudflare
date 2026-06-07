import 'package:flutter/material.dart';

import '../../core/account_restore.dart';
import '../../core/logo.dart';
import '../../core/theme.dart';

/// Shown to a RETURNING user (the server already has their account) when we
/// couldn't silently restore their key — or when the server was unreachable.
/// It deliberately offers NO "claim a new handle" path, so an existing user can
/// never accidentally create a second account and think their data is lost.
class RestoreScreen extends StatefulWidget {
  final RestoreState state;
  final VoidCallback onRestored; // identity re-installed → go to dashboard
  final VoidCallback onRetry;    // re-run the restore check (for `unavailable`)
  final VoidCallback onSignOut;  // bail out to welcome
  const RestoreScreen({
    super.key,
    required this.state,
    required this.onRestored,
    required this.onRetry,
    required this.onSignOut,
  });
  @override
  State<RestoreScreen> createState() => _RestoreScreenState();
}

class _RestoreScreenState extends State<RestoreScreen> {
  final _pass = TextEditingController();
  final _key = TextEditingController();
  bool _useKey = false;
  bool _obscure = true;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _pass.dispose();
    _key.dispose();
    super.dispose();
  }

  bool get _unavailable => widget.state.outcome == RestoreOutcome.unavailable;

  Future<void> _submit() async {
    setState(() { _busy = true; _error = null; });
    bool ok;
    if (_useKey) {
      ok = await AccountRestore.recoverWithKey(widget.state, _key.text);
    } else {
      ok = await AccountRestore.recoverWithPassword(widget.state, _pass.text);
    }
    if (!mounted) return;
    if (ok) { widget.onRestored(); return; }
    setState(() {
      _busy = false;
      _error = _useKey
          ? "That recovery key doesn't match this account. Paste the nsec you saved at sign-up."
          : 'That password didn\'t unlock your account. Try again, or use your recovery key.';
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.white,
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(28, 40, 28, 24),
          child: _unavailable ? _unavailableBody() : _recoveryBody(),
        ),
      ),
    );
  }

  // ── Couldn't reach the server: retry, never onboarding ──────────────────────
  Widget _unavailableBody() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SizedBox(height: 24),
        const AvaLogo(size: 52),
        const SizedBox(height: 22),
        Text('Can’t reach AvaTOK',
            style: Theme.of(context).textTheme.displayLarge?.copyWith(fontSize: 32)),
        const SizedBox(height: 10),
        const Text(
            'We couldn’t load your account just now. Check your connection and try '
            'again — we won’t set you up as a new user.',
            style: TextStyle(color: AvaColors.sub, fontSize: 15, height: 1.5)),
        const SizedBox(height: 28),
        SizedBox(
          width: double.infinity,
          child: FilledButton(onPressed: widget.onRetry, child: const Text('Try again')),
        ),
        const SizedBox(height: 12),
        Center(child: TextButton(onPressed: widget.onSignOut,
            child: const Text('Sign out', style: TextStyle(color: AvaColors.sub)))),
      ],
    );
  }

  // ── Account exists, couldn't auto-restore: recover with password or nsec ─────
  Widget _recoveryBody() {
    final name = (widget.state.displayName ?? '').trim();
    final handle = (widget.state.handle ?? '').trim();
    final hello = name.isNotEmpty ? 'Welcome back, $name' : 'Welcome back';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SizedBox(height: 24),
        const AvaLogo(size: 52),
        const SizedBox(height: 22),
        Text(hello, style: Theme.of(context).textTheme.displayLarge?.copyWith(fontSize: 34)),
        const SizedBox(height: 6),
        Text(
          handle.isNotEmpty
              ? 'This phone doesn’t have your @$handle account keys yet. Restore them to get your messages back.'
              : 'This phone doesn’t have your account keys yet. Restore them to get your messages back.',
          style: const TextStyle(color: AvaColors.sub, fontSize: 15, height: 1.5),
        ),
        const SizedBox(height: 32),
        if (!_useKey) ...[
          _label('YOUR PASSWORD'),
          _box(child: Row(children: [
            Expanded(child: TextField(
              controller: _pass, obscureText: _obscure,
              decoration: _bare('••••••••'), style: const TextStyle(fontSize: 16),
              onSubmitted: (_) => _submit(),
            )),
            IconButton(
              icon: Icon(_obscure ? Icons.visibility_outlined : Icons.visibility_off_outlined,
                  color: AvaColors.sub, size: 20),
              onPressed: () => setState(() => _obscure = !_obscure),
            ),
          ])),
        ] else ...[
          _label('RECOVERY KEY (nsec)'),
          _box(child: TextField(
            controller: _key, autocorrect: false,
            decoration: _bare('nsec1…'), style: const TextStyle(fontSize: 14),
            minLines: 1, maxLines: 2,
            onSubmitted: (_) => _submit(),
          )),
          const Padding(
            padding: EdgeInsets.only(left: 4, top: 8),
            child: Text('The private key you were told to save at sign-up.',
                style: TextStyle(color: AvaColors.sub, fontSize: 12)),
          ),
        ],
        if (_error != null) ...[
          const SizedBox(height: 16),
          Text(_error!, style: const TextStyle(color: AvaColors.danger, fontSize: 13)),
        ],
        const SizedBox(height: 24),
        SizedBox(
          width: double.infinity,
          child: FilledButton(
            onPressed: _busy ? null : _submit,
            child: _busy
                ? const SizedBox(height: 20, width: 20,
                    child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                : const Text('Restore my account'),
          ),
        ),
        const SizedBox(height: 14),
        Center(
          child: TextButton(
            onPressed: () => setState(() { _useKey = !_useKey; _error = null; }),
            child: Text(_useKey ? 'Use my password instead' : 'Use my recovery key instead',
                style: const TextStyle(color: AvaColors.brand, fontWeight: FontWeight.w700)),
          ),
        ),
        Center(child: TextButton(onPressed: widget.onSignOut,
            child: const Text('Sign out', style: TextStyle(color: AvaColors.sub)))),
      ],
    );
  }

  Widget _label(String t) => Padding(
        padding: const EdgeInsets.only(left: 4, bottom: 8),
        child: Text(t, style: const TextStyle(
            color: AvaColors.sub, fontSize: 12, letterSpacing: 1.2, fontWeight: FontWeight.w700)),
      );

  Widget _box({required Widget child}) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
        decoration: BoxDecoration(color: AvaColors.soft, borderRadius: BorderRadius.circular(16)),
        child: child,
      );

  InputDecoration _bare(String hint) => InputDecoration(
        hintText: hint,
        hintStyle: const TextStyle(color: Color(0xFFAAB0B8)),
        border: InputBorder.none, isDense: true,
        contentPadding: const EdgeInsets.symmetric(vertical: 14),
      );
}
