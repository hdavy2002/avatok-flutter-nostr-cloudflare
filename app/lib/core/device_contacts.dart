import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:drift/drift.dart' show Value;
import 'package:flutter/foundation.dart';
import 'package:flutter_contacts/flutter_contacts.dart';
import 'package:share_plus/share_plus.dart';

import 'analytics.dart';
import 'api_auth.dart';
import 'ava_log.dart';
import 'config.dart';
import 'db.dart';
import 'referral_service.dart';

/// One phone number from the user's address book, optionally matched to an
/// AvaTok account (uid) when that person already uses the app. Thin view over the
/// [DeviceContactRow] SQLite cache so UI code never touches drift types directly.
@immutable
class DeviceContact {
  final String name;
  final String rawPhone;
  final String phoneNorm;
  final String uid; // non-empty ⇒ already on AvaTok
  final String handle;
  final String avatarUrl;
  final String matchDisplayName;

  const DeviceContact({
    required this.name,
    required this.rawPhone,
    required this.phoneNorm,
    this.uid = '',
    this.handle = '',
    this.avatarUrl = '',
    this.matchDisplayName = '',
  });

  bool get onAvatok => uid.isNotEmpty;
  // Now that people are added by phone number, show them by the name the user
  // saved in their OWN phone address book (WhatsApp-style) — fall back to the
  // AvaTOK display name, then the raw number.
  String get displayName => name.isNotEmpty
      ? name
      : (matchDisplayName.isNotEmpty ? matchDisplayName : rawPhone);
  /// Human-friendly subtitle — the phone number (WhatsApp-style).
  String get subtitle => rawPhone;

  factory DeviceContact.fromRow(DeviceContactRow r) => DeviceContact(
        name: r.name,
        rawPhone: r.rawPhone,
        phoneNorm: r.phoneNorm,
        uid: r.uid,
        handle: r.handle,
        avatarUrl: r.avatarUrl,
        matchDisplayName: r.matchDisplayName,
      );
}

/// Local-first device-contacts pipeline.
///
/// The whole point: the "Add contact" sheet must feel INSTANT. So the device
/// address book is cached in per-account SQLite ([DeviceContactsCache]); the UI
/// reads/watches that cache (zero OS calls on open) while this service refreshes
/// it in the BACKGROUND — re-reading the phone book, diffing new/removed numbers
/// into SQLite, then asking the backend which numbers are already on AvaTOK and
/// annotating those rows. Triggered on cold start and on every app resume.
///
/// Everything is best-effort and never throws into the UI. Timings + failures
/// are reported to PostHog (`contacts_sync` / `error_occurred`) so a slow or
/// failing sync is diagnosable per user (pull by their phone/email).
class DeviceContactsService {
  static bool _syncing = false; // single-flight guard
  static int _lastSyncMs = 0; // throttle resume-triggered refreshes
  // The address book rarely changes, but a full read of a big book is ~10–20s
  // and was running on EVERY resume (every couple of minutes) — a real drag.
  // Throttle resume-triggered reads to once every few hours; cold start and
  // pull-to-refresh pass force:true and always get a fresh read immediately.
  static const _minIntervalMs = 3 * 60 * 60 * 1000; // ≤ one device re-read per 3h on resume

  /// Normalize to the same E.164-ish shape the Worker's `normalizePhone` uses
  /// (strip everything but digits/+, force a leading +), so client and server
  /// hash the SAME string and matches line up.
  static String normPhone(String raw) {
    var t = raw.replaceAll(RegExp(r'[^\d+]'), '');
    if (t.isEmpty) return t;
    if (!t.startsWith('+')) t = '+$t';
    return t;
  }

  /// True if contacts permission is already granted (no prompt). Mobile only.
  static Future<bool> hasPermission() async {
    if (!Platform.isAndroid && !Platform.isIOS) return false;
    try {
      return await FlutterContacts.requestPermission(readonly: true);
    } catch (_) {
      return false;
    }
  }

  static Future<bool> requestPermission() => hasPermission();

  /// Instant, offline-safe read from the SQLite cache (on-AvaTOK first).
  static Future<List<DeviceContact>> cached() async =>
      (await Db.I.deviceContactsOnce()).map(DeviceContact.fromRow).toList();

  /// Reactive cache — the sheet binds to this so background sync repaints live.
  static Stream<List<DeviceContact>> watch() =>
      Db.I.watchDeviceContacts().map((rows) => rows.map(DeviceContact.fromRow).toList());

  /// Background sync: read the device book → diff into SQLite → match against
  /// AvaTOK → annotate. [force] bypasses the throttle (cold start / pull-to-
  /// refresh); resume uses the throttle to avoid hammering the OS address book.
  static Future<void> refresh({bool force = false, String source = 'unknown'}) async {
    // Concurrent / throttled calls are normal (cold start + sheet open + resume
    // can overlap) — record them so we can see how often a sync is skipped.
    if (_syncing) {
      Analytics.capture('contacts_sync_skipped', {'reason': 'in_flight', 'source': source});
      return;
    }
    if (!Platform.isAndroid && !Platform.isIOS) {
      Analytics.capture('contacts_sync_skipped', {'reason': 'unsupported_platform', 'source': source});
      return;
    }
    final startMs = DateTime.now().millisecondsSinceEpoch;
    if (!force && startMs - _lastSyncMs < _minIntervalMs) {
      Analytics.capture('contacts_sync_skipped', {
        'reason': 'throttled', 'source': source,
        'since_last_ms': startMs - _lastSyncMs,
      });
      return;
    }
    _syncing = true;
    Analytics.capture('contacts_sync_started', {'source': source, 'forced': force});
    var deviceReadMs = 0, matchMs = 0, deviceCount = 0, matchedCount = 0;
    var rawContactCount = 0, phoneCountRaw = 0, newCount = 0, removedCount = 0;
    var matchStatus = 0, matchError = '';
    try {
      // 1) Permission. If denied, leave whatever cache we have and report it.
      final permT0 = DateTime.now().millisecondsSinceEpoch;
      final granted = await FlutterContacts.requestPermission(readonly: true);
      Analytics.capture('contacts_permission', {
        'granted': granted, 'source': source,
        'ask_ms': DateTime.now().millisecondsSinceEpoch - permT0,
      });
      if (!granted) {
        Analytics.capture('contacts_sync', {'result': 'perm_denied', 'source': source});
        return;
      }

      // 2) Read the device address book.
      final readT0 = DateTime.now().millisecondsSinceEpoch;
      final raw = await FlutterContacts.getContacts(
        withProperties: true,
        withPhoto: false,
        deduplicateProperties: true,
      );
      rawContactCount = raw.length;
      // phoneNorm -> (rawPhone, name). First non-empty name wins per number.
      final byNorm = <String, ({String raw, String name})>{};
      for (final c in raw) {
        final name = c.displayName.trim();
        for (final p in c.phones) {
          final rawNum = p.number.trim();
          if (rawNum.isEmpty) continue;
          phoneCountRaw++;
          final norm = normPhone(rawNum);
          if (norm.length < 4) continue; // junk
          final existing = byNorm[norm];
          if (existing == null || (existing.name.isEmpty && name.isNotEmpty)) {
            byNorm[norm] = (raw: rawNum, name: name);
          }
        }
      }
      deviceReadMs = DateTime.now().millisecondsSinceEpoch - readT0;
      deviceCount = byNorm.length;

      // 3) Diff into SQLite: upsert all current numbers, prune deleted ones.
      // We DON'T touch match columns here (Companion omits them ⇒ unchanged on
      // replace would reset; so we read existing match state and carry it over).
      final existingRows = {for (final r in await Db.I.deviceContactsOnce()) r.phoneNorm: r};
      // Diff counts (how much the book churned since last sync) — useful to see
      // whether "new contact not showing" is an ingest gap or a match gap.
      newCount = byNorm.keys.where((k) => !existingRows.containsKey(k)).length;
      removedCount = existingRows.keys.where((k) => !byNorm.containsKey(k)).length;
      final nowMs = DateTime.now().millisecondsSinceEpoch;
      final companions = <DeviceContactsCacheCompanion>[];
      byNorm.forEach((norm, v) {
        final prev = existingRows[norm];
        companions.add(DeviceContactsCacheCompanion.insert(
          phoneNorm: norm,
          rawPhone: Value(v.raw),
          name: Value(v.name),
          // Carry forward any prior match so a number we already know is on
          // AvaTOK keeps its badge until the fresh match result arrives.
          uid: Value(prev?.uid ?? ''),
          handle: Value(prev?.handle ?? ''),
          avatarUrl: Value(prev?.avatarUrl ?? ''),
          matchDisplayName: Value(prev?.matchDisplayName ?? ''),
          matchedAt: Value(prev?.matchedAt ?? 0),
          updatedAt: Value(nowMs),
        ));
      });
      final writeT0 = DateTime.now().millisecondsSinceEpoch;
      await Db.I.upsertDeviceContacts(companions);
      await Db.I.pruneDeviceContacts(byNorm.keys.toSet());
      final dbWriteMs = DateTime.now().millisecondsSinceEpoch - writeT0;

      // 4) Ask the backend which numbers are on AvaTOK. We send ONE contact
      // entry per number with the normalized phone in BOTH `name` and `phones`
      // so we can map the result back precisely: the enhanced Worker echoes the
      // matched `phone`; an older Worker echoes our `name` (= the phone) — either
      // way we recover the phoneNorm key. Best-effort: offline keeps the cache.
      final phones = byNorm.keys.toList();
      if (phones.isNotEmpty) {
        final matchT0 = DateTime.now().millisecondsSinceEpoch;
        try {
          final res = await ApiAuth.postJson(
            kContactsSyncUrl,
            {'contacts': phones.map((p) => {'name': p, 'phones': [p]}).toList()},
            timeout: const Duration(seconds: 12),
          );
          matchMs = DateTime.now().millisecondsSinceEpoch - matchT0;
          matchStatus = res.statusCode;
          if (res.statusCode == 200) {
            final j = jsonDecode(res.body) as Map<String, dynamic>;
            final matched = ((j['matched'] as List?) ?? const []);
            // Reset stale matches first so people who left AvaTOK lose the badge.
            await Db.I.clearDeviceMatches();
            for (final m in matched) {
              final mm = (m as Map).cast<String, dynamic>();
              final uid = (mm['uid'] ?? '').toString();
              if (uid.isEmpty) continue;
              // Prefer the echoed `phone`; fall back to `name` (older Worker).
              final key = normPhone((mm['phone'] ?? mm['name'] ?? '').toString());
              if (key.length < 4 || !byNorm.containsKey(key)) continue;
              await Db.I.applyDeviceMatch(
                phoneNorm: key,
                uid: uid,
                handle: (mm['handle'] ?? '').toString(),
                avatarUrl: (mm['avatar_url'] ?? '').toString(),
                displayName: (mm['display_name'] ?? '').toString(),
                matchedAt: nowMs,
              );
              matchedCount++;
            }
          } else {
            Analytics.error(
                domain: 'contacts', code: 'match_http_${res.statusCode}',
                action: 'refresh', message: 'contacts match returned ${res.statusCode}',
                extra: {'source': source, 'sent': phones.length});
          }
        } catch (e) {
          matchMs = DateTime.now().millisecondsSinceEpoch - matchT0;
          matchError = e.runtimeType.toString();
          // Offline/timeout — keep the cache; report so latency is diagnosable.
          Analytics.error(
              domain: 'contacts', code: 'match_failed', action: 'refresh',
              message: e.toString(), extra: {'source': source, 'match_ms': matchMs});
        }
        // Dedicated match-perf event (separate from the full sync) so the match
        // round-trip and hit-rate are queryable on their own.
        Analytics.capture('contacts_match_result', {
          'source': source,
          'status': matchStatus,
          'sent_count': phones.length,
          'matched_count': matchedCount,
          'match_ms': matchMs,
          'hit_rate': phones.isEmpty ? 0 : (matchedCount * 100 ~/ phones.length),
          if (matchError.isNotEmpty) 'error_type': matchError,
        });
      }

      Analytics.capture('contacts_sync', {
        'result': 'ok',
        'source': source,
        'forced': force,
        'raw_contacts': rawContactCount,
        'phones_raw': phoneCountRaw,
        'device_count': deviceCount, // unique normalized numbers
        'new_count': newCount,
        'removed_count': removedCount,
        'matched_count': matchedCount,
        'hit_rate': deviceCount == 0 ? 0 : (matchedCount * 100 ~/ deviceCount),
        'device_read_ms': deviceReadMs,
        'db_write_ms': dbWriteMs,
        'match_ms': matchMs,
        'match_status': matchStatus,
        'total_ms': DateTime.now().millisecondsSinceEpoch - startMs,
      });
      AvaLog.I.log('contacts',
          'sync ok src=$source device=$deviceCount new=$newCount matched=$matchedCount readMs=$deviceReadMs matchMs=$matchMs');
    } catch (e) {
      Analytics.error(
          domain: 'contacts', code: 'sync_failed', action: 'refresh', message: e.toString(),
          extra: {'source': source, 'total_ms': DateTime.now().millisecondsSinceEpoch - startMs});
    } finally {
      _syncing = false;
      _lastSyncMs = DateTime.now().millisecondsSinceEpoch;
    }
  }

  /// Back-compat entry point — chat_list calls this on cold start. Forces a
  /// full refresh regardless of the resume throttle.
  static Future<void> syncAndMatch([String? _ownerNpub]) =>
      refresh(force: true, source: 'cold_start');

  /// Share the "join me on AvaTok" invite for [c] via the native share sheet.
  static Future<void> invite(DeviceContact c, {String? myHandle}) async {
    final who = c.displayName.isNotEmpty ? c.displayName.split(' ').first : 'there';
    await Share.share(_inviteMessage(who, handle: myHandle), subject: 'Join me on AvaTok');
  }

  /// Generic invite (no specific contact) — used by the drawer "Invite" entry.
  static Future<void> shareGenericInvite({String? myHandle}) async {
    await Share.share(_inviteMessage('there', handle: myHandle), subject: 'Join me on AvaTok');
  }

  static String _inviteMessage(String who, {String? handle}) {
    final link = (handle != null && handle.isNotEmpty)
        ? ReferralService.inviteLink(handle)
        : kDownloadUrl;
    return 'Hey $who, I\'m on AvaTok — come join me. It\'s an AI-powered messenger: '
        'Ava, your in-chat assistant, can watch for scams, reply for you when '
        'you\'re away, and pull up files mid-chat — and you can share with up to '
        '25 people. Join with my link: $link';
  }
}
