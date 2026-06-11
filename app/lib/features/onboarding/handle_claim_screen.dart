import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/analytics.dart';
import '../../core/guest_session.dart';
import '../../core/theme.dart';

/// L0 entry — the FIRST thing a new user sees (Trust Ladder, §3).
/// One field: pick a unique @handle. It is reserved server-side immediately
/// (guest token), then the visitor walks STRAIGHT into the app to browse as an
/// L0 guest. No sign-up wall — an account is only asked for later, when an
/// action needs one (AccountGate). Time-to-app target: under 15 seconds.
class HandleClaimScreen extends StatefulWidget {
  /// A handle was claimed (or already reserved) → enter the app as a guest.
  final VoidCallback onClaimed;

  /// "I already have an account" → go to sign-in.
  final VoidCallback onHaveAccount;
  const HandleClaimScreen({super.key, required this.onClaimed, required this.onHaveAccount});
  @override
  State<HandleClaimScreen> createState() => _HandleClaimScreenState();
}

class _HandleClaimScreenState extends State<HandleClaimScreen> {
  final _ctrl = TextEditingController();
  Timer? _debounce;
  bool _checking = false;
  bool? _avail;
  String? _msg;
  bool _reserving = false;

  @override
  void initState() {
    super.initState();
    Analytics.capture('handle_claim_viewed', const {});
    // Already reserved on this device? Skip straight through.
    GuestSession.reservedHandle().then((h) {
      if (h != null && h.isNotEmpty && mounted) widget.onClaimed();
    });
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _ctrl.dispose();
    super.dispose();
  }

  void _onChanged(String v) {
    _debounce?.cancel();
    setState(() { _avail = null; _msg = null; _checking = v.trim().isNotEmpty; });
    if (v.trim().isEmpty) { setState(() => _checking = false); return; }
    _debounce = Timer(const Duration(milliseconds: 400), () async {
      final r = await GuestSession.checkHandle(_ctrl.text);
      if (!mounted) return;
      setState(() { _checking = false; _avail = r.ok; _msg = r.ok ? null : (r.message ?? 'Taken'); });
    });
  }

  Future<void> _claim() async {
    if (_avail != true || _reserving) return;
    setState(() => _reserving = true);
    final r = await GuestSession.reserve(_ctrl.text);
    if (!mounted) return;
    setState(() => _reserving = false);
    if (r.ok) {
      Analytics.capture('handle_claimed', const {});
      widget.onClaimed();
    } else {
      setState(() { _avail = false; _msg = r.message; });
    }
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            const Spacer(),
            const Icon(Icons.alternate_email, size: 56, color: AvaColors.brand),
            const SizedBox(height: 16),
            Text('Pick your handle',
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
            const SizedBox(height: 8),
            Text('That\'s all we need for now — it\'s reserved instantly and it\'s yours.',
                textAlign: TextAlign.center,
                style: TextStyle(color: cs.onSurfaceVariant, height: 1.4)),
            const SizedBox(height: 28),
            TextField(
              controller: _ctrl,
              autofocus: true,
              onChanged: _onChanged,
              decoration: InputDecoration(
                prefixText: '@',
                hintText: 'yourname',
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(14)),
                suffixIcon: _checking
                    ? const Padding(
                        padding: EdgeInsets.all(12),
                        child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)))
                    : _avail == true
                        ? const Icon(Icons.check_circle, color: Color(0xFF10B981))
                        : _avail == false
                            ? Icon(Icons.cancel, color: cs.error)
                            : null,
              ),
            ),
            if (_msg != null) ...[
              const SizedBox(height: 8),
              Text(_msg!, style: TextStyle(color: cs.error, fontSize: 13)),
            ],
            const SizedBox(height: 20),
            FilledButton(
              style: FilledButton.styleFrom(
                  backgroundColor: AvaColors.brand,
                  padding: const EdgeInsets.symmetric(vertical: 14)),
              onPressed: _avail == true && !_reserving ? _claim : null,
              child: _reserving
                  ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Text('Claim my handle'),
            ),
            TextButton(
              onPressed: widget.onHaveAccount, // existing users go to sign-in
              child: const Text('I already have an account'),
            ),
            const Spacer(),
          ]),
        ),
      ),
    );
  }
}
