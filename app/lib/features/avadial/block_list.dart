import 'dart:async';
import 'dart:convert';

import '../../core/analytics.dart';
import '../../core/ava_log.dart';
import '../../core/disk_cache.dart';
import 'avadial_channel.dart';
import 'avadial_refresh.dart';

/// One blocked/labelled number. This is AVA metadata (the user's own labels +
/// spam-report history) — account-scoped and eligible for the encrypted backup
/// (plan §4.7), distinct from the OS-level [BlockedNumberContract] which only the
/// default dialer can write.
class BlockEntry {
  final String number;
  final String? label; // e.g. "Robocall", "Telemarketer"
  final bool reportedSpam;
  final int ts; // epoch ms

  const BlockEntry({
    required this.number,
    this.label,
    this.reportedSpam = false,
    required this.ts,
  });

  Map<String, dynamic> toJson() => {
        'number': number,
        if (label != null) 'label': label,
        'reportedSpam': reportedSpam,
        'ts': ts,
      };

  factory BlockEntry.fromJson(Map<String, dynamic> j) => BlockEntry(
        number: '${j['number']}',
        label: j['label'] as String?,
        reportedSpam: j['reportedSpam'] == true,
        ts: (j['ts'] as num?)?.toInt() ?? 0,
      );
}

/// Account-scoped block list (plan §4.1 Block tab).
///
/// Two layers (spike §4):
///   1. Ava metadata — persisted per-account via [DiskCache] (which is already
///      keyed on `AccountScope.id`), so a parent + child on one phone keep separate
///      block lists. Rides the existing encrypted backup.
///   2. System block — write-through to `BlockedNumberContract` via the channel,
///      which SILENTLY no-ops unless AvaDial is the default dialer
///      ([AvaDialChannel.canBlockNumbers]). We never assume it succeeded.
class BlockList {
  BlockList._();
  static final BlockList I = BlockList._();

  static const _kCache = 'avadial_blocklist';

  Future<List<BlockEntry>> load() async {
    try {
      final raw = await DiskCache.read(_kCache);
      if (raw == null || raw.isEmpty) return [];
      final list = (jsonDecode(raw) as List<dynamic>)
          .whereType<Map>()
          .map((m) => BlockEntry.fromJson(m.map((k, v) => MapEntry('$k', v))))
          .toList();
      return list;
    } catch (e) {
      AvaLog.I.log('avadial', 'blocklist load failed: $e');
      return [];
    }
  }

  Future<void> _save(List<BlockEntry> entries) async {
    try {
      await DiskCache.write(_kCache, jsonEncode(entries.map((e) => e.toJson()).toList()));
      // Wake every listening Calls tab so a number blocked on Contacts/Logs shows
      // up on the Block tab immediately (owner bug report, pic 6).
      bumpAvaDial();
    } catch (e) {
      AvaLog.I.log('avadial', 'blocklist save failed: $e');
    }
  }

  /// Block a number (upsert). Also attempts the OS-level block (best-effort).
  Future<List<BlockEntry>> block(String number, {String? label, bool reportedSpam = false}) async {
    final entries = await load();
    entries.removeWhere((e) => e.number == number);
    entries.insert(
      0,
      BlockEntry(
        number: number,
        label: label,
        reportedSpam: reportedSpam,
        ts: DateTime.now().millisecondsSinceEpoch,
      ),
    );
    await _save(entries);
    unawaited(AvaDialChannel.I.systemBlock(number)); // no-op unless default dialer
    // No raw number in analytics (plan §4 / rulebook) — hash it.
    Analytics.capture('avadial_block_added', {
      'number_hash': AvaDialChannel.hashE164(number),
      'reported_spam': reportedSpam,
    });
    return entries;
  }

  Future<List<BlockEntry>> unblock(String number) async {
    final entries = await load();
    entries.removeWhere((e) => e.number == number);
    await _save(entries);
    unawaited(AvaDialChannel.I.systemUnblock(number));
    Analytics.capture('avadial_block_removed', {'number_hash': AvaDialChannel.hashE164(number)});
    return entries;
  }

  /// Report a number as spam (feeds the community pool — the actual worker report
  /// call is Phase 2a; here we record the local intent + block it). Blocks by
  /// default so a reported spammer stops calling.
  Future<List<BlockEntry>> reportSpam(String number, {String? label}) async {
    final entries = await block(number, label: label, reportedSpam: true);
    Analytics.capture('avadial_spam_reported', {'number_hash': AvaDialChannel.hashE164(number)});
    return entries;
  }

  Future<bool> isBlocked(String number) async {
    final entries = await load();
    return entries.any((e) => e.number == number);
  }
}
