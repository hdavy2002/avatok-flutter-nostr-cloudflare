import 'dart:async';
import 'dart:convert';

import '../../../core/ava_log.dart';
import '../../../core/disk_cache.dart';
import '../avadial_channel.dart';
import '../device_contacts.dart';

/// Verdict a user (or the AI filter) assigned to an SMS sender.
enum SmsVerdict { spam, ham }

/// Account-scoped SMS spam labels (AVA-SMS). This is the ONLY thing AvaTOK persists
/// about SMS: a map of `normKey(number) → verdict`. It NEVER stores message bodies —
/// those live only in the OS SMS provider (device-data boundary). Persisted via
/// [DiskCache], which is already keyed on `AccountScope.id`, so a parent + child on
/// one shared phone keep independent spam labels.
///
/// The AI Inbox/Spam segmented control in [SmsThreadsScreen] resolves a thread's
/// bucket as: a user label here wins; otherwise the community score from the local
/// spam snapshot (warn-threshold and above → Spam). This store only owns the manual/
/// sticky labels; the score comes from the snapshot the spam shield already writes.
class SmsSpamStore {
  SmsSpamStore._();
  static final SmsSpamStore I = SmsSpamStore._();

  static const _kCache = 'avadial_sms_labels';

  // normKey(number) → verdict string ('spam'|'ham'). Cached in memory after first
  // load; the on-disk copy is account-scoped by DiskCache.
  Map<String, String>? _cache;

  Future<Map<String, String>> _load() async {
    if (_cache != null) return _cache!;
    try {
      final raw = await DiskCache.read(_kCache);
      if (raw == null || raw.isEmpty) {
        _cache = <String, String>{};
      } else {
        final m = jsonDecode(raw) as Map<String, dynamic>;
        _cache = m.map((k, v) => MapEntry(k, '$v'));
      }
    } catch (e) {
      AvaLog.I.log('avadial', 'sms labels load failed: $e');
      _cache = <String, String>{};
    }
    return _cache!;
  }

  Future<void> _save() async {
    try {
      await DiskCache.write(_kCache, jsonEncode(_cache ?? const {}));
    } catch (e) {
      AvaLog.I.log('avadial', 'sms labels save failed: $e');
    }
  }

  /// The user's explicit verdict for [number], or null if unlabelled.
  Future<SmsVerdict?> verdictFor(String number) async {
    final m = await _load();
    switch (m[DeviceContacts.normKey(number)]) {
      case 'spam':
        return SmsVerdict.spam;
      case 'ham':
        return SmsVerdict.ham;
      default:
        return null;
    }
  }

  /// Mark a sender as spam (sticky). Local only — the optional community report is
  /// the caller's job (spamShield-gated).
  Future<void> markSpam(String number) => _set(number, SmsVerdict.spam);

  /// Move a sender back to the inbox (explicit not-spam).
  Future<void> markHam(String number) => _set(number, SmsVerdict.ham);

  /// Drop any explicit label (fall back to the community score).
  Future<void> clearLabel(String number) async {
    final m = await _load();
    m.remove(DeviceContacts.normKey(number));
    await _save();
  }

  Future<void> _set(String number, SmsVerdict v) async {
    final m = await _load();
    m[DeviceContacts.normKey(number)] = v == SmsVerdict.spam ? 'spam' : 'ham';
    await _save();
  }

  /// Drop the in-memory cache (wire into the account-switch teardown so labels
  /// never bleed across accounts before the next scoped read).
  void clear() => _cache = null;

  /// SHA-256 helper for a community report payload (never logs a raw number).
  static String hash(String number) => AvaDialChannel.hashE164(number);
}
