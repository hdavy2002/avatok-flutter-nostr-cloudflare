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

/// Normalize a raw phone to the Worker's E.164-ish shape (digits/+ only, leading
/// +). Top-level so it can run inside a background isolate.
String _normPhoneIso(String raw) {
  var t = raw.replaceAll(RegExp(r'[^\d+]'), '');
  if (t.isEmpty) return t;
  if (!t.startsWith('+')) t = '+$t';
  return t;
}

/// Runs in a BACKGROUND ISOLATE (via `compute`): normalize + de-dupe the address
/// book so the CPU-heavy regex/dedup never touches the UI thread. Input is plain,
/// isolate-transferable maps `[{name, email, phones:[raw,...]}]`; output is one
/// entry per unique normalized number `[{norm, raw, name, email}]` (first
/// non-empty name/email wins).
List<Map<String, String>> _parseDeviceContacts(List<Map<String, dynamic>> contacts) {
  final byNorm = <String, Map<String, String>>{};
  for (final c in contacts) {
    final name = (c['name'] as String? ?? '').trim();
    final email = (c['email'] as String? ?? '').trim();
    for (final raw in (c['phones'] as List? ?? const [])) {
      final rawNum = (raw as String? ?? '').trim();
      if (rawNum.isEmpty) continue;
      final norm = _normPhoneIso(rawNum);
      if (norm.length < 4) continue; // junk
      final existing = byNorm[norm];
      if (existing == null) {
        byNorm[norm] = {'norm': norm, 'raw': rawNum, 'name': name, 'email': email};
      } else {
        if ((existing['name'] ?? '').isEmpty && name.isNotEmpty) existing['name'] = name;
        if ((existing['email'] ?? '').isEmpty && email.isNotEmpty) existing['email'] = email;
      }
    }
  }
  return byNorm.values.toList();
}

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
  final String email; // first email saved for this contact in the device book (may be empty)
  final bool hasWhatsapp; // contact is (likely) on WhatsApp — drives the WhatsApp invite icon

  const DeviceContact({
    required this.name,
    required this.rawPhone,
    required this.phoneNorm,
    this.uid = '',
    this.handle = '',
    this.avatarUrl = '',
    this.matchDisplayName = '',
    this.email = '',
    this.hasWhatsapp = false,
  });

  bool get onAvatok => uid.isNotEmpty;
  bool get hasEmail => email.isNotEmpty;
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
        email: r.email,
        hasWhatsapp: r.hasWhatsapp != 0,
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
  static int _lastSyncMs = 0; // throttle
  // Freshness comes from the OS contacts CHANGE LISTENER (startWatching) — we sync
  // the instant the address book actually changes, not on a timer. This is just a
  // safety net for platforms where the change callback doesn't fire: at most one
  // background re-read per DAY. `ensureFresh` reads only when the mirror is empty
  // or older than this; `force:true` (pull-to-refresh) always reads now.
  static const _minIntervalMs = 24 * 60 * 60 * 1000; // ≤ one safety re-read per day

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

  /// Create a NEW contact in the device's native address book. Requests WRITE
  /// permission (readonly:false) first. Returns true on success. Used when a
  /// searched number isn't on AvaTOK and isn't in the book yet, so the user can
  /// save them with a name/email/notes and have it synced to their phone.
  static Future<bool> createDeviceContact({
    required String firstName,
    required String lastName,
    required String phoneE164,
    String email = '',
    String notes = '',
  }) async {
    if (!Platform.isAndroid && !Platform.isIOS) return false;
    try {
      final granted = await FlutterContacts.requestPermission(readonly: false);
      if (!granted) {
        Analytics.capture('device_contact_create', const {'ok': false, 'reason': 'perm_denied'});
        return false;
      }
      final c = Contact(
        name: Name(first: firstName.trim(), last: lastName.trim()),
        phones: [Phone(phoneE164.trim())],
        emails: email.trim().isNotEmpty ? [Email(email.trim())] : [],
        notes: notes.trim().isNotEmpty ? [Note(notes.trim())] : [],
      );
      await c.insert();
      Analytics.capture('device_contact_create', {
        'ok': true, 'has_email': email.trim().isNotEmpty, 'has_notes': notes.trim().isNotEmpty,
      });
      return true;
    } catch (e) {
      Analytics.error(domain: 'contacts', code: 'create_failed',
          action: 'create_device_contact', message: e.toString());
      return false;
    }
  }

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

      // 2) Read the device book — NO photos, NO accounts. WhatsApp-account
      // detection was the costly part of the read; dropping it makes the read
      // markedly smaller + faster (the Invite screen shows a WhatsApp option for
      // everyone — wa.me works whether or not the person uses WhatsApp).
      final readT0 = DateTime.now().millisecondsSinceEpoch;
      final raw = await FlutterContacts.getContacts(
        withProperties: true,
        withPhoto: false,
        withAccounts: false,
        deduplicateProperties: true,
      );
      rawContactCount = raw.length;
      // Serialize to plain, isolate-transferable maps (light field copies), chunked
      // so even this pass can't block the UI thread on a huge book.
      final serial = <Map<String, dynamic>>[];
      var _ser = 0;
      for (final c in raw) {
        serial.add({
          'name': c.displayName,
          'email': c.emails.isNotEmpty ? c.emails.first.address : '',
          'phones': [for (final p in c.phones) p.number],
        });
        if (++_ser % 500 == 0) await Future<void>.delayed(Duration.zero);
      }
      // Normalize + de-dupe in a BACKGROUND ISOLATE. The CPU-heavy regex/dedup
      // never touches the UI thread, so a 20k-contact book can't freeze the app —
      // works the same on any phone regardless of address-book size.
      final parsed = await compute(_parseDeviceContacts, serial);
      deviceReadMs = DateTime.now().millisecondsSinceEpoch - readT0;
      deviceCount = parsed.length;
      phoneCountRaw = parsed.length;

      // 3) Diff into SQLite: upsert current numbers, prune removed. Carry prior
      // match/email state forward; write in chunks so a huge book is never one
      // giant blocking transaction.
      final existingRows = {for (final r in await Db.I.deviceContactsOnce()) r.phoneNorm: r};
      final normSet = <String>{};
      newCount = 0;
      final nowMs = DateTime.now().millisecondsSinceEpoch;
      final companions = <DeviceContactsCacheCompanion>[];
      for (final v in parsed) {
        final norm = v['norm']!;
        normSet.add(norm);
        final prev = existingRows[norm];
        if (prev == null) newCount++;
        final email = v['email'] ?? '';
        companions.add(DeviceContactsCacheCompanion.insert(
          phoneNorm: norm,
          rawPhone: Value(v['raw'] ?? ''),
          name: Value(v['name'] ?? ''),
          email: Value(email.isNotEmpty ? email : (prev?.email ?? '')),
          // No per-contact WhatsApp detection — wa.me works for anyone.
          hasWhatsapp: const Value(1),
          uid: Value(prev?.uid ?? ''),
          handle: Value(prev?.handle ?? ''),
          avatarUrl: Value(prev?.avatarUrl ?? ''),
          matchDisplayName: Value(prev?.matchDisplayName ?? ''),
          matchedAt: Value(prev?.matchedAt ?? 0),
          updatedAt: Value(nowMs),
        ));
      }
      removedCount = existingRows.keys.where((k) => !normSet.contains(k)).length;
      final writeT0 = DateTime.now().millisecondsSinceEpoch;
      // ONE write (not chunked): the watch() stream re-maps ALL rows on every DB
      // change, so chunking would fire that heavy rebuild many times. The parse is
      // already off the UI thread (isolate), so a single batch write is cheap here.
      await Db.I.upsertDeviceContacts(companions);
      await Db.I.pruneDeviceContacts(normSet);
      final dbWriteMs = DateTime.now().millisecondsSinceEpoch - writeT0;

      // 4) Presence probe intentionally NOT done (privacy 2026-06-27).
      final phones = normSet.toList();
      // PRIVACY (owner request 2026-06-27): the device address book is kept ONLY
      // for WhatsApp-style invites — we NO LONGER probe the backend for which
      // numbers are already on AvaTOK. Revealing that presence let anyone confirm
      // a private number belongs to an AvaTOK user and, combined with number
      // search, correlate a private phone → AvaTOK number → identity. We also
      // clear any previously-cached matches so the old "On AvaTOK" badge/trace
      // disappears everywhere it used to surface. (`kContactsSyncUrl` / the match
      // round-trip is intentionally no longer called from this path.)
      await Db.I.clearDeviceMatches();
      matchedCount = 0;
      Analytics.capture('contacts_presence_probe_skipped', {
        'source': source,
        'sent_count': phones.length,
        'reason': 'privacy_no_presence',
        'match_ms': matchMs,
        'match_status': matchStatus,
        if (matchError.isNotEmpty) 'error_type': matchError,
      });

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

  /// Back-compat no-op-ish: the address book is now read ON DEMAND only (when the
  /// user actually opens a screen that shows contacts — Invite / Search). It is
  /// NEVER read on cold start, resume, or an FCM push, so nothing contact-related
  /// can ever block the app in the background. Delegates to [ensureFresh] but
  /// callers on the cold-start/resume path have been removed.
  static Future<void> syncAndMatch([String? _ownerNpub]) => ensureFresh(source: 'cold_start');

  /// Read the address book ONLY when a contacts screen needs it and the mirror is
  /// empty or a day stale. Otherwise a no-op (repaints instantly from the mirror).
  /// The heavy parse runs in a background isolate, so even when it does read, it
  /// never blocks the UI thread.
  static Future<void> ensureFresh({String source = 'ensure'}) async {
    if (_syncing) return;
    final now = DateTime.now().millisecondsSinceEpoch;
    final empty = (await Db.I.deviceContactsOnce()).isEmpty;
    if (empty || now - _lastSyncMs > _minIntervalMs) {
      await refresh(force: true, source: source);
    }
  }

  /// Share the "join me on AvaTok" invite for [c] via the native share sheet.
  static Future<void> invite(DeviceContact c, {String? myHandle}) async {
    final who = c.displayName.isNotEmpty ? c.displayName.split(' ').first : 'there';
    await Share.share(_inviteMessage(who, handle: myHandle), subject: 'Join me on AvaTok');
  }

  /// Generic invite (no specific contact) — used by the drawer "Invite" entry.
  static Future<void> shareGenericInvite({String? myHandle}) async {
    await Share.share(_inviteMessage('there', handle: myHandle), subject: 'Join me on AvaTok');
  }

  static String _inviteMessage(String who, {String? handle, String? myName}) {
    final link = (handle != null && handle.isNotEmpty)
        ? ReferralService.inviteLink(handle)
        : kDownloadUrl;
    final from = (myName != null && myName.trim().isNotEmpty)
        ? ' It\'s ${myName.trim()}.'
        : '';
    return 'Hey $who,$from I\'m on AvaTok — come join me. It\'s an AI-powered messenger: '
        'Ava, your in-chat assistant, can watch for scams, reply for you when '
        'you\'re away, and pull up files mid-chat — and you can share with up to '
        '25 people. Join with my link: $link';
  }

  // ── AvaInvite: per-channel invite for ONE contact (Invite screen) ──

  /// First name to greet [c] with in an invite ("Hey Sam, …").
  static String _who(DeviceContact c) =>
      c.displayName.trim().isNotEmpty ? c.displayName.trim().split(' ').first : 'there';

  /// The pre-filled invite text shared via WhatsApp / SMS (carries the inviter's
  /// name + their referral link).
  static String inviteText(DeviceContact c, {required String myName, String? myHandle}) =>
      _inviteMessage(_who(c), handle: myHandle, myName: myName);

  /// Deep link that opens WhatsApp with the invite pre-filled for this number.
  /// The user taps Send inside WhatsApp (apps can't send on their behalf).
  static Uri whatsappUri(DeviceContact c, String message) {
    final digits = c.phoneNorm.replaceAll(RegExp(r'[^\d]'), '');
    return Uri.parse('https://wa.me/$digits?text=${Uri.encodeComponent(message)}');
  }

  /// Deep link that opens the SMS composer with the invite pre-filled. iOS uses
  /// `&body=`, Android `?body=` — both handled here.
  static Uri smsUri(DeviceContact c, String message) {
    final sep = Platform.isIOS ? '&' : '?';
    return Uri.parse('sms:${c.rawPhone}${sep}body=${Uri.encodeComponent(message)}');
  }

  /// Send an invite EMAIL to [c] from the server, on the user's behalf. This is
  /// the only channel that is truly auto-sent (WhatsApp/SMS need a Send tap).
  /// Returns true on a 200 `{ok:true}` from the Worker. Best-effort; never throws.
  static Future<bool> sendInviteEmail(DeviceContact c, {required String myName}) async {
    if (c.email.isEmpty) return false;
    try {
      final res = await ApiAuth.postJson(
        '$kApiBase/invite/email',
        {'to_email': c.email, 'to_name': c.displayName, 'from_name': myName},
        timeout: const Duration(seconds: 15),
      );
      if (res.statusCode == 200) {
        final j = jsonDecode(res.body) as Map<String, dynamic>;
        return j['ok'] == true;
      }
      Analytics.error(
          domain: 'invite', code: 'email_http_${res.statusCode}', action: 'send_email',
          message: 'invite email returned ${res.statusCode}');
      return false;
    } catch (e) {
      Analytics.error(
          domain: 'invite', code: 'email_failed', action: 'send_email', message: e.toString());
      return false;
    }
  }
}
