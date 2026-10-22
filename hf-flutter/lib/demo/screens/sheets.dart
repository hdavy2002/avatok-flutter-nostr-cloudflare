import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../data/demo_mode.dart';
import '../../data/repos/auth_repo.dart';
import '../../data/services.dart';
import '../../data/telemetry.dart';
import '../data.dart';
import '../state.dart';
import '../theme.dart';
import '../widgets.dart';
import '../call_kit.dart';
import 'call_real.dart';
import 'signup_sheet.dart';

/// Sheet top: bandhani border + drag handle.
class SheetFrame extends StatelessWidget {
  const SheetFrame({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(color: C.ivory, borderRadius: BorderRadius.vertical(top: Radius.circular(28))),
      clipBehavior: Clip.antiAlias,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Stack(
            children: [
              const Valance(height: 66),
              Positioned(
                top: 10,
                left: 0,
                right: 0,
                child: Center(child: Container(width: 48, height: 6, decoration: BoxDecoration(color: C.gold, borderRadius: BorderRadius.circular(999)))),
              ),
            ],
          ),
          child,
        ],
      ),
    );
  }
}

/// Fan sign-up: name, email, WhatsApp number (HF-REEL-1). Opens when a guest taps Call now, Book or ♥.
/// Real WhatsApp-code sign-up (HF-WIRE-2) unless this is a demo build; tests pass [repo] to force the real one.
class SignUpSheet extends StatelessWidget {
  const SignUpSheet({super.key, this.reason, this.repo, this.login = false});

  final String? reason;
  final AuthRepo? repo;
  final bool login;

  @override
  Widget build(BuildContext context) {
    if (repo == null && DemoMode.on) return _DemoSignUpSheet(reason: reason, login: login);
    return RealSignUpSheet(repo: repo ?? Services.instance.authRepo, reason: reason, login: login);
  }
}

class _DemoSignUpSheet extends StatefulWidget {
  const _DemoSignUpSheet({this.reason, this.login = false});

  final String? reason;
  final bool login;

  @override
  State<_DemoSignUpSheet> createState() => _DemoSignUpSheetState();
}

class _DemoSignUpSheetState extends State<_DemoSignUpSheet> {
  late bool _login = widget.login;
  final _name = TextEditingController();
  final _email = TextEditingController();
  final _wa = TextEditingController();
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    _email.dispose();
    _wa.dispose();
    super.dispose();
  }

  void _submit() {
    final digits = _wa.text.replaceAll(RegExp(r'\D'), '');
    if (_name.text.trim().isEmpty) {
      setState(() => _error = 'Please type your name.');
      return;
    }
    if (!_email.text.contains('@')) {
      setState(() => _error = 'Please type a real email.');
      return;
    }
    if (digits.length != 10) {
      setState(() => _error = 'WhatsApp number should be 10 digits.');
      return;
    }
    demo.signUp(_name.text, _email.text, digits);
    Navigator.of(context).pop(true);
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SheetFrame(
        child: Padding(
          padding: EdgeInsets.fromLTRB(26, 8, 26, MediaQuery.paddingOf(context).bottom + 20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text('ONE STEP ${widget.reason == null ? 'TO CONTINUE' : widget.reason!.toUpperCase()}', style: t(14, color: C.ruby, ls: 0.14)),
              const SizedBox(height: 4),
              Text(_login ? 'Log in' : 'Create account', style: t(32, color: C.maroon, ls: 0.03, h: 1.05)),
              TextButton(
                key: const Key('su-switch-mode'),
                onPressed: () => setState(() {
                  _login = !_login;
                  _error = null;
                }),
                child: Text(_login ? 'Create account' : 'Log in', style: t(17, color: C.maroon)),
              ),
              const SizedBox(height: 4),
              Text("Three things, then you're in. Your number is never shown to anyone.", style: t(15, color: C.deep, w: FontWeight.w700, h: 1.4)),
              const SizedBox(height: 16),
              Text('Your name', style: t(15)),
              const SizedBox(height: 6),
              TextField(controller: _name, textCapitalization: TextCapitalization.words, style: t(17, w: FontWeight.w700), decoration: const InputDecoration(hintText: 'Tara Sharma')),
              const SizedBox(height: 12),
              Text('Email', style: t(15)),
              const SizedBox(height: 6),
              TextField(controller: _email, keyboardType: TextInputType.emailAddress, style: t(17, w: FontWeight.w700), decoration: const InputDecoration(hintText: 'you@example.com')),
              const SizedBox(height: 12),
              Text.rich(TextSpan(children: [
                TextSpan(text: 'WhatsApp number  ', style: t(15)),
                TextSpan(text: 'for call alerts and reminders', style: t(14, color: C.muted, w: FontWeight.w700)),
              ])),
              const SizedBox(height: 6),
              Row(
                children: [
                  Container(
                    height: 58,
                    padding: const EdgeInsets.symmetric(horizontal: 14),
                    alignment: Alignment.center,
                    decoration: BoxDecoration(color: C.gold, borderRadius: BorderRadius.circular(14), border: Border.all(color: C.deep, width: 3)),
                    child: Text('+91', style: t(17)),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: TextField(controller: _wa, keyboardType: TextInputType.phone, style: t(17, w: FontWeight.w700), decoration: const InputDecoration(hintText: '98765 43210')),
                  ),
                ],
              ),
              if (_error != null) ...[
                const SizedBox(height: 10),
                Text(_error!, style: t(14, color: C.ruby)),
              ],
              const SizedBox(height: 20),
              TicketButton(label: 'CONTINUE', maroon: true, stubIcon: Icons.arrow_forward_rounded, onTap: _submit),
            ],
          ),
        ),
      ),
    );
  }
}

/// Call now: sign-up if needed → confirm sheet → call screen. Low balance sends to Top up.
Future<void> startCall(BuildContext context, Influencer who) {
  return requireAccount(context, () {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: C.clear,
      builder: (_) => CallsBridge.real ? RealCallConfirmSheet(who: who) : CallConfirmSheet(who: who),
    );
  }, reason: 'to call ${who.name.split(' ').first}');
}

class CallConfirmSheet extends StatelessWidget {
  const CallConfirmSheet({super.key, required this.who});

  final Influencer who;

  @override
  Widget build(BuildContext context) {
    final minutes = (demo.balance / who.rate).floor();
    final enough = minutes >= 3;
    final first = who.name.split(' ').first;
    // [HF-APP-DESI-6] approved call confirm sheet
    return CallSheetFrame(
      child: Padding(
        padding: EdgeInsets.fromLTRB(20, 0, 20, MediaQuery.paddingOf(context).bottom + 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            CallSheetHead(who: who, title: 'Call ${who.name}?'),
            const SizedBox(height: 14),
            CallSheetHisaab(rate: '₹${who.rate} per minute', wallet: inr(demo.balance), talk: 'up to $minutes min'),
            const SizedBox(height: 12),
            CallPrivacyNote(first: first),
            const SizedBox(height: 16),
            if (enough)
              CallPill(
                label: 'CALL NOW',
                icon: Icons.call_rounded,
                tag: '₹${who.rate}/min',
                onTap: () {
                  final go = GoRouter.of(context);
                  Navigator.of(context).pop();
                  go.push('/call/${who.id}');
                },
              )
            else ...[
              Text('You need at least ₹20 in your wallet to call. Top up to keep going.', textAlign: TextAlign.center, style: t(15, color: C.ruby, w: FontWeight.w800, h: 1.4)),
              const SizedBox(height: 12),
              CallPill(
                label: 'TOP UP',
                kind: CallPillKind.gold,
                icon: Icons.add_rounded,
                onTap: () {
                  final go = GoRouter.of(context);
                  Navigator.of(context).pop();
                  go.push('/topup');
                },
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// Account entry points shared by guest tabs. The protected child is not built.
class AccountInvitation extends StatelessWidget {
  const AccountInvitation({super.key, required this.reason});
  final String reason;

  @override
  Widget build(BuildContext context) => Scaffold(
    body: SafeArea(child: Center(child: SingleChildScrollView(
      padding: const EdgeInsets.all(28),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        const Icon(Icons.person_outline_rounded, size: 64, color: C.maroon),
        const SizedBox(height: 20),
        Text(reason, textAlign: TextAlign.center, style: t(24, color: C.maroon)),
        const SizedBox(height: 12),
        Text('Log in or create an account to continue.', textAlign: TextAlign.center, style: t(17)),
        const SizedBox(height: 24),
        const AccountButtons(),
      ]),
    ))),
  );
}

class AccountButtons extends StatelessWidget {
  const AccountButtons({super.key});

  Future<void> _open(BuildContext context, bool login) async {
    Telemetry.event('hf_auth_entry', {'mode': login ? 'login' : 'create'});
    final completed = await showModalBottomSheet<bool>(
      context: context, isScrollControlled: true, useSafeArea: true,
      backgroundColor: Colors.transparent,
      builder: (_) => SignUpSheet(login: login),
    );
    Telemetry.event('hf_auth_outcome', {'completed': completed == true, 'mode': login ? 'login' : 'create'});
  }

  @override
  Widget build(BuildContext context) => Column(children: [
    TicketButton(label: 'Log in', maroon: true, stubIcon: Icons.login_rounded,
      onTap: () => _open(context, true)),
    const SizedBox(height: 12),
    TextButton(onPressed: () => _open(context, false), child: Text('Create account', style: t(17, color: C.maroon))),
  ]);
}
