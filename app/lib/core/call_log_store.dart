import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

enum CallDir { incoming, outgoing, missed }

class CallEntry {
  final String name;
  final String seed;
  final bool video;
  final CallDir dir;
  final int ts; // epoch seconds
  const CallEntry({required this.name, required this.seed, required this.video, required this.dir, required this.ts});

  Map<String, dynamic> toJson() => {'name': name, 'seed': seed, 'video': video, 'dir': dir.name, 'ts': ts};
  factory CallEntry.fromJson(Map<String, dynamic> j) => CallEntry(
        name: (j['name'] ?? '').toString(),
        seed: (j['seed'] ?? '').toString(),
        video: j['video'] == true,
        dir: CallDir.values.byName((j['dir'] ?? 'outgoing').toString()),
        ts: (j['ts'] as num?)?.toInt() ?? 0,
      );

  String get timeLabel {
    final d = DateTime.fromMillisecondsSinceEpoch(ts * 1000);
    final now = DateTime.now();
    final sameDay = d.year == now.year && d.month == now.month && d.day == now.day;
    if (sameDay) return '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
    final y = now.subtract(const Duration(days: 1));
    if (d.year == y.year && d.month == y.month && d.day == y.day) return 'Yesterday';
    return '${d.day}/${d.month}';
  }
}

/// Local call history (most recent first, capped).
class CallLogStore {
  static const _key = 'avatok_call_log';
  final FlutterSecureStorage _s;
  CallLogStore([FlutterSecureStorage? s])
      : _s = s ??
            const FlutterSecureStorage(
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
            );

  Future<List<CallEntry>> load() async {
    final raw = await _s.read(key: _key);
    if (raw == null || raw.isEmpty) return [];
    try {
      return (jsonDecode(raw) as List)
          .cast<Map<String, dynamic>>()
          .map(CallEntry.fromJson)
          .toList();
    } catch (_) {
      return [];
    }
  }

  Future<void> add(CallEntry e) async {
    final list = await load();
    list.insert(0, e);
    final capped = list.take(100).toList();
    await _s.write(key: _key, value: jsonEncode(capped.map((x) => x.toJson()).toList()));
  }
}
