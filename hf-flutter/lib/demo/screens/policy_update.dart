import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../../core/brand.dart';
import '../../data/demo_mode.dart';
import '../../data/repos/policy_repo.dart';
import '../../data/repos/settings_repo.dart' show ExternalLinks;
import '../../data/services.dart';
import '../desi.dart';
import '../theme.dart';
import '../widgets.dart';

/// [HF-APP-PARITY-PROFILE] Wraps the whole app (see main.dart). While a signed-in person has a pending policy update, a full-screen
/// prompt sits on top of everything until she taps "I agree". Signed-out people and demo mode are never blocked, and a failed check
/// never blocks either.
class PolicyGate extends StatefulWidget {
  const PolicyGate({super.key, required this.child, this.controller, this.account});

  final Widget? child;

  /// Tests pass their own; the app builds one on the live API.
  final PolicyGateController? controller;

  /// Tests pass their own; the app listens to `Services.instance.authAccount`.
  final ValueListenable<String?>? account;

  @override
  State<PolicyGate> createState() => _PolicyGateState();
}

class _PolicyGateState extends State<PolicyGate> {
  PolicyGateController? _controller;
  ValueListenable<String?>? _account;

  PolicyGateController get _c => _controller!;

  @override
  void initState() {
    super.initState();
    if (widget.controller == null && widget.account == null && DemoMode.on) return; // demo build: nothing to check
    _controller = widget.controller ?? PolicyGateController(PolicyRepo(Services.instance.api));
    _account = widget.account ?? Services.instance.authAccount;
    _c.addListener(_changed);
    _account!.addListener(_accountChanged);
    _accountChanged();
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  void _accountChanged() => unawaited(_c.check(_account!.value));

  @override
  void dispose() {
    _controller?.removeListener(_changed);
    _account?.removeListener(_accountChanged);
    if (widget.controller == null) _controller?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final child = widget.child ?? const SizedBox.shrink();
    final c = _controller;
    final update = c?.pending;
    if (c == null || update == null) return child;
    return Stack(children: [
      Positioned.fill(child: child),
      Positioned.fill(
        child: PolicyUpdateScreen(update: update, accepting: c.accepting, error: c.error, onAgree: () => unawaited(c.accept())),
      ),
    ]);
  }
}

/// The prompt itself: what changed, links to read the pages, one big "I agree".
class PolicyUpdateScreen extends StatelessWidget {
  const PolicyUpdateScreen({super.key, required this.update, required this.onAgree, this.accepting = false, this.error});

  final PolicyUpdate update;
  final VoidCallback onAgree;
  final bool accepting;
  final String? error;

  Future<void> _open(BuildContext context, PolicyItem p) async {
    final path = p.path.startsWith('/') ? p.path : '/${p.path}';
    final ok = await ExternalLinks.open(Uri.parse(Brand.url(path)));
    if (!ok && context.mounted) toast(context, 'We could not open the page. Please try again.');
  }

  @override
  Widget build(BuildContext context) {
    final label = accepting ? 'Saving…' : (error != null ? 'Try again' : 'I agree');
    return Material(
      color: C.ivory,
      child: SafeArea(
        child: Column(children: [
          Expanded(
            child: ListView(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
              children: [
                const DesiHero(
                  eyebrow: 'Please read',
                  title: 'Our rules have changed',
                  sub: 'Read what is new, then tap I agree to carry on.',
                  ghost: 'Niyam badle hain',
                  tone: DesiTone.rani,
                ),
                const SizedBox(height: 14),
                DesiCard(
                  title: 'What changed',
                  corner: DesiCorner.none,
                  child: Text(
                    update.note ?? 'We updated the pages below.',
                    key: const Key('policy-note'),
                    style: t(16, w: FontWeight.w600, h: 1.45),
                  ),
                ),
                const SizedBox(height: 14),
                DesiCard(
                  title: 'Read the pages',
                  tone: DesiTone.lav,
                  child: Column(children: [
                    for (var i = 0; i < update.pending.length; i++)
                      _LinkRow(
                        key: Key('policy-link-${update.pending[i].policy}'),
                        title: update.pending[i].title,
                        last: i == update.pending.length - 1,
                        onTap: () => unawaited(_open(context, update.pending[i])),
                      ),
                  ]),
                ),
                const SizedBox(height: 8),
                const DesiMogra(),
              ],
            ),
          ),
          Container(
            padding: const EdgeInsets.fromLTRB(16, 10, 16, 14),
            decoration: const BoxDecoration(color: C.white, border: Border(top: BorderSide(color: C.line))),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              if (error != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Text(error!, key: const Key('policy-error'), textAlign: TextAlign.center, style: t(15, color: C.ruby, w: FontWeight.w700)),
                ),
              ChunkyButton(key: const Key('policy-agree'), label: label, height: 56, onTap: accepting ? null : onAgree),
            ]),
          ),
        ]),
      ),
    );
  }
}

class _LinkRow extends StatelessWidget {
  const _LinkRow({super.key, required this.title, required this.onTap, this.last = false});

  final String title;
  final VoidCallback onTap;
  final bool last;

  @override
  Widget build(BuildContext context) => Semantics(
        button: true,
        child: InkWell(
          onTap: onTap,
          child: Container(
            constraints: const BoxConstraints(minHeight: 52),
            decoration: BoxDecoration(border: last ? null : const Border(bottom: BorderSide(color: C.line))),
            child: Row(children: [
              const Icon(Icons.description_rounded, color: C.lav, size: 22),
              const SizedBox(width: 12),
              Expanded(child: Text(title, style: t(16, w: FontWeight.w800))),
              const Icon(Icons.chevron_right_rounded, color: C.maroon),
            ]),
          ),
        ),
      );
}
