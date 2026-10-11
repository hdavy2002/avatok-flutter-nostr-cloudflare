import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/analytics/analytics.dart';
import '../../../core/auth/session.dart';
import '../../../core/router/pending_intent.dart';
import '../../../core/router/routes.dart';
import '../../../core/theme/hf_tokens.dart';
import '../../me/ui/name_sheet.dart';
import '../data/registration_progress.dart';

/// Cancelling retains the account's required-name marker for the next privileged action.
class CompleteProfileScreen extends ConsumerStatefulWidget {
  const CompleteProfileScreen({super.key, this.next});
  final String? next;

  @override
  ConsumerState<CompleteProfileScreen> createState() => _CompleteProfileScreenState();
}

class _CompleteProfileScreenState extends ConsumerState<CompleteProfileScreen> {
  String? _ownerUid;
  bool _finished = false;

  String? get _uid {
    final session = ref.read(sessionProvider);
    return session.isSignedIn ? (session.user?.id ?? session.me?.uid) : null;
  }

  @override
  void initState() {
    super.initState();
    _ownerUid = _uid;
    _track('viewed');
  }

  void _track(String outcome) {
    if (_ownerUid == null || _uid != _ownerUid) return;
    unawaited(Analytics.capture('hf_app_registration_step', {
      'step': 'name', 'outcome': outcome,
    }));
  }

  Future<void> _cancel() async {
    if (_finished) return;
    _finished = true;
    _track('cancelled');
    if (_uid == _ownerUid) await ref.read(pendingIntentProvider).clear();
    if (!mounted) return;
    final router = GoRouter.of(context);
    if (router.canPop()) { router.pop(false); } else { router.go(Routes.home); }
  }

  Future<void> _saved(String _) async {
    final uid = _ownerUid;
    if (_finished || uid == null || _uid != uid) return;
    await ref.read(registrationProgressProvider).complete(expectedUid: uid);
    if (!mounted || _uid != uid) return;
    await ref.read(sessionProvider.notifier).refreshMe();
    if (!mounted || _uid != uid) return;
    await ref.read(pendingIntentProvider).clear();
    if (!mounted || _uid != uid) return;
    _finished = true;
    _track('completed');
    final router = GoRouter.of(context);
    if (router.canPop()) { router.pop(true); } else { router.go(Routes.safeNext(widget.next) ?? Routes.home); }
  }

  @override
  Widget build(BuildContext context) => PopScope(
    canPop: false,
    onPopInvokedWithResult: (didPop, _) { if (!didPop) _cancel(); },
    child: Scaffold(
      appBar: AppBar(title: const Text('One last introduction'),
        leading: IconButton(tooltip: 'Keep browsing', icon: const Icon(Icons.arrow_back_rounded),
          onPressed: _cancel)),
      body: SafeArea(child: Padding(padding: const EdgeInsets.only(top: HfSpacing.gap),
        child: NameSheet(onSaved: _saved))),
    ),
  );
}
