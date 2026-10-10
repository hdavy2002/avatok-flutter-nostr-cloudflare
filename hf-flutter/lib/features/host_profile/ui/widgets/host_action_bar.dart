import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/analytics/analytics.dart';
import '../../../../core/api/api_error.dart';
import '../../../../core/auth/session.dart';
import '../../../../core/config/flags.dart';
import '../../../../core/router/nav.dart';
import '../../../../core/router/routes.dart';
import '../../../../core/theme/hf_tokens.dart';
import '../../../../core/widgets/widgets.dart';
import '../../data/host_profile.dart';
import '../../data/host_profile_providers.dart';
import '../../host_profile_strings.dart';

/// The sticky bottom action of the profile.
///
/// - Calls are off (flag): a disabled "Calls open soon".
/// - A women-only host and a caller who has not joined that space: "Verify to call", which explains the
///   space and opens the lanes screen.
/// - Online: **Call** (sign in first, then the call confirm step of HF-NATIVE-5).
/// - Busy or offline: **Notify me** (sign in first, then `POST /api/hf/hosts/:slug/notify`).
class HostActionBar extends ConsumerStatefulWidget {
  const HostActionBar({super.key, required this.profile});

  final HostProfile profile;

  @override
  ConsumerState<HostActionBar> createState() => _HostActionBarState();
}

class _HostActionBarState extends ConsumerState<HostActionBar> {
  bool _busy = false;
  bool? _subscribedOverride;
  String? _message;
  bool _messageIsError = false;

  HostProfile get _p => widget.profile;

  Future<void> _call() async {
    unawaited(Analytics.capture('hf_app_call_tapped', {'slug': _p.slug, 'status': _p.status.name}));
    if (!await requireSignIn(context, ref)) return;
    if (!mounted) return;
    await ref.read(callConfirmOpenerProvider)(context, _p.slug);
  }

  Future<void> _verifyToCall() async {
    if (!await requireSignIn(context, ref)) return;
    if (!mounted) return;
    // Signing in may already show this person's lane (the account was verified before): then just call.
    if (ref.read(sessionProvider).me?.womenLane == true) {
      await _call();
      return;
    }
    unawaited(GoRouter.of(context).push<Object?>(Routes.lanesOf('women')));
  }

  Future<void> _toggleNotify(bool subscribed) async {
    if (_busy) return;
    final turnOn = !subscribed;
    if (!await requireSignIn(context, ref)) return;
    if (!mounted) return;
    setState(() {
      _busy = true;
      _message = null;
    });
    final sw = Stopwatch()..start();
    try {
      final now = await setNotifyMe(ref.read(apiClientProvider), _p.slug, on: turnOn);
      if (!mounted) return;
      setState(() {
        _busy = false;
        _subscribedOverride = now;
        _messageIsError = false;
        _message = now ? HostProfileStrings.notifyOn : HostProfileStrings.notifyOff;
      });
      unawaited(Analytics.capture('hf_app_notify_me', {'slug': _p.slug, 'on': now, 'outcome': 'ok', 'ms': sw.elapsedMilliseconds}));
    } on ApiError catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _messageIsError = true;
        _message = e.userMessage;
      });
      unawaited(Analytics.capture('hf_app_notify_me', {
        'slug': _p.slug,
        'on': turnOn,
        'outcome': 'error',
        'reason': e.code,
        'status': e.status,
        'ms': sw.elapsedMilliseconds,
      }));
    }
  }

  @override
  Widget build(BuildContext context) {
    final callsOn = ref.watch(flagsProvider).when(data: (f) => f.hfCallsEnabled, loading: () => true, error: (_, __) => true);
    final inWomenLane = ref.watch(sessionProvider.select((s) => s.me?.womenLane ?? false));
    final remoteSubscribed =
        ref.watch(notifyStatusProvider(_p.slug)).when(data: (v) => v, loading: () => false, error: (_, __) => false);
    final subscribed = _subscribedOverride ?? remoteSubscribed;

    final String? note;
    final Widget button;
    if (!callsOn) {
      note = null;
      button = const HfButton(label: HostProfileStrings.callsSoon, onPressed: null);
    } else if (_p.womenOnly && !inWomenLane) {
      note = HostProfileStrings.womenLaneNote;
      button = HfButton(label: HostProfileStrings.verifyToCall, icon: Icons.verified_user_rounded, onPressed: _verifyToCall);
    } else if (_p.status == HostPresence.online) {
      note = null;
      button = HfButton(label: HostProfileStrings.call, icon: Icons.call_rounded, onPressed: _call);
    } else {
      note = _p.status == HostPresence.busy
          ? HostProfileStrings.hostOnCall(_p.displayName)
          : HostProfileStrings.hostOffline(_p.displayName);
      button = HfButton(
        label: subscribed
            ? HostProfileStrings.notifyStop
            : (_p.status == HostPresence.busy ? HostProfileStrings.notifyBusy : HostProfileStrings.notifyOffline),
        icon: subscribed ? Icons.notifications_off_rounded : Icons.notifications_active_rounded,
        kind: subscribed ? HfButtonKind.secondary : HfButtonKind.primary,
        loading: _busy,
        onPressed: () => _toggleNotify(subscribed),
      );
    }

    return Material(
      color: HfColors.white,
      elevation: 8,
      shadowColor: const Color(0x2246113E),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(HfSpacing.page, 12, HfSpacing.page, 12),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (note != null) ...[
                Text(note, style: HfText.note, textAlign: TextAlign.center),
                const SizedBox(height: 8),
              ],
              if (_message != null) ...[
                Semantics(
                  liveRegion: true,
                  child: Text(
                    _message!,
                    style: HfText.bodyStrong.copyWith(color: _messageIsError ? HfColors.accent : HfColors.orchid),
                    textAlign: TextAlign.center,
                  ),
                ),
                const SizedBox(height: 8),
              ],
              button,
            ],
          ),
        ),
      ),
    );
  }
}
