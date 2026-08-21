// STREAM-LANE: depends on the currently-commented-out pubspec entries
// `stream_video_flutter` / `stream_video_push_notification` (see
// app/pubspec.yaml and stream_lane.dart's library comment). SDK imports will
// not resolve until those two lines are uncommented.
//
// A thin FOREGROUND in-app ringing screen only — the system incoming-call UI
// (lock-screen / full-screen intent) is owned by the SDK's native push layer
// (stream_push_glue.dart's background handler), not by this widget. Visual
// language mirrors features/avatok/incoming_business_call_screen.dart (AD.*
// tokens, PhosphorIcons accept/decline row) WITHOUT importing that file.
library;

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:stream_video_flutter/stream_video_flutter.dart';

import '../core/avatar.dart';
import '../core/ui/avatok_dark.dart';
import '../core/ui/messenger_theme.dart';
import 'stream_call_service.dart';

/// Global navigator key access point so [StreamLane.init]'s
/// `incomingCall` listener can push this screen without threading a
/// BuildContext through the SDK callback. Set once from the app shell.
class StreamIncomingScreen extends StatelessWidget {
  const StreamIncomingScreen({super.key, required this.call});

  final Call call;

  /// Shown by [StreamLane] when a call rings in while the app is foregrounded.
  /// Uses the root navigator so it can appear over whatever screen is open,
  /// mirroring how the old lane's branded incoming screen is surfaced from
  /// push_service.dart.
  static void showForCall(Call call) {
    final ctx = navigatorKeyForStreamLane.currentContext;
    if (ctx == null) return;
    Navigator.of(ctx, rootNavigator: true).push(
      MaterialPageRoute(
        fullscreenDialog: true,
        builder: (_) => StreamIncomingScreen(call: call),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    // verified: packages/stream_video/lib/src/models/call_metadata.dart
    // (`class CallUser` has `id`/`name`/`image`) +
    // packages/stream_video/lib/src/call_state.dart (`CallState.createdByUser`
    // is a `CallUser`, defaulting to `CallUser.empty()`). There is no
    // `callerId`/`createdBy` field directly on `CallState`.
    final caller = call.state.value.createdByUser;
    final callerName = caller.name.isNotEmpty ? caller.name : caller.id;
    return Scaffold(
      backgroundColor: AD.bg,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: Msg.s5, vertical: Msg.s6),
          child: Column(
            children: [
              const Spacer(),
              Avatar(seed: callerName, name: callerName, size: 120),
              const SizedBox(height: Msg.s4),
              Text(
                callerName,
                style: const TextStyle(
                  color: AD.textPrimary,
                  fontSize: 24,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 4),
              const Text(
                'Incoming AvaTOK call…',
                style: TextStyle(color: AD.textSecondary, fontSize: 14),
              ),
              const Spacer(),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                children: [
                  _ringButton(
                    icon: PhosphorIcons.phoneDisconnect(PhosphorIconsStyle.fill),
                    bg: AD.primaryBadge,
                    onTap: () async {
                      await StreamCallService.instance.decline(call);
                      if (context.mounted) Navigator.of(context).maybePop();
                    },
                  ),
                  _ringButton(
                    icon: PhosphorIcons.phone(PhosphorIconsStyle.fill),
                    bg: AD.haldi,
                    onTap: () => StreamCallService.instance.accept(context, call),
                  ),
                ],
              ),
              const SizedBox(height: Msg.s5),
            ],
          ),
        ),
      ),
    );
  }

  Widget _ringButton({
    required PhosphorIconData icon,
    required Color bg,
    required VoidCallback onTap,
  }) {
    return InkWell(
      onTap: onTap,
      customBorder: const CircleBorder(),
      child: Container(
        width: 68,
        height: 68,
        decoration: BoxDecoration(shape: BoxShape.circle, color: bg),
        child: Icon(icon, color: AD.tabActiveLabel, size: 30),
      ),
    );
  }
}

/// Root navigator key the app shell must assign (mirrors the pattern used
/// elsewhere in this app for surfacing UI from a non-widget callback — see
/// main.dart's `RootFlow`). Left unassigned (null context) is a safe no-op:
/// a ring with no attached navigator simply doesn't show the foreground
/// screen, and the SDK's own native ring UI still covers background/killed.
final GlobalKey<NavigatorState> navigatorKeyForStreamLane = GlobalKey<NavigatorState>();
