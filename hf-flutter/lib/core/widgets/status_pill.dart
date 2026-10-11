import 'package:flutter/widgets.dart';

import 'hf_status_pill.dart';

/// A host's presence on the profile and the cards.
enum HostPresence {
  online,
  busy,
  offline;

  /// Maps the server's `status` string (`online | busy | offline`). Anything else is offline.
  static HostPresence parse(Object? status) {
    switch ('$status') {
      case 'online':
        return HostPresence.online;
      case 'busy':
        return HostPresence.busy;
      default:
        return HostPresence.offline;
    }
  }
}

/// The original presence pill, kept for existing screens: now a thin wrapper over [HfStatusPill] (same words and
/// colours as the new design). Pass `animate: false` in widget tests (a repeating animation never settles).
class StatusPill extends StatelessWidget {
  const StatusPill({super.key, required this.presence, this.animate = true});

  final HostPresence presence;
  final bool animate;

  @override
  Widget build(BuildContext context) => HfStatusPill(
        status: switch (presence) {
          HostPresence.online => HfPresence.online,
          HostPresence.busy => HfPresence.busy,
          HostPresence.offline => HfPresence.offline,
        },
        animate: animate,
      );
}
