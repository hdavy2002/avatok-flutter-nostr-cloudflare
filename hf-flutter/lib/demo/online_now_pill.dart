import 'dart:async';

import 'package:flutter/material.dart';

import '../data/api_exception.dart';
import '../data/repos/presence_repo.dart';
import '../data/services.dart';
import 'presence_bridge.dart';
import 'theme.dart';

/// The feed's top pill "N online now". Real mode reads `GET /api/hf/online-count` every 60 seconds and
/// hides itself when the call fails; demo mode shows [demoCount].
class OnlineNowPill extends StatefulWidget {
  const OnlineNowPill({super.key, required this.demoCount, this.fetch, this.interval = const Duration(seconds: 60)});

  final int demoCount;

  /// Tests inject this; the app uses [PresenceRepo.onlineCount].
  final Future<int> Function()? fetch;
  final Duration interval;

  @override
  State<OnlineNowPill> createState() => _OnlineNowPillState();
}

class _OnlineNowPillState extends State<OnlineNowPill> {
  int? _count;
  Timer? _timer;

  Future<int> _fetch() => (widget.fetch ?? PresenceRepo(Services.instance.api).onlineCount)();

  Future<void> _refresh() async {
    try {
      final c = await _fetch();
      if (mounted) setState(() => _count = c);
    } on ApiException {
      if (mounted) setState(() => _count = null);
    } catch (_) {
      if (mounted) setState(() => _count = null);
    }
  }

  @override
  void initState() {
    super.initState();
    if (PresenceBridge.real) {
      _refresh();
      _timer = Timer.periodic(widget.interval, (_) => _refresh());
    } else {
      _count = widget.demoCount;
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = _count;
    if (c == null) return const SizedBox.shrink();
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
      decoration: BoxDecoration(
        color: C.onlineBg,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: C.onlineLine, width: 2),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(width: 9, height: 9, decoration: const BoxDecoration(shape: BoxShape.circle, color: C.onlineDot)),
          const SizedBox(width: 8),
          Text('$c online now', style: t(14, color: C.onlineInk, ls: 0.04)),
        ],
      ),
    );
  }
}
