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

      // 2) Read the device address book.
      final readT0 = DateTime.now().millisecondsSinceEpoch;
      final raw = await FlutterContacts.getContacts(
        withProperties: true,
        withPhoto: false,
        // Accounts let us flag WhatsApp contacts on Android (account type
        // `com.whatsapp`) so the Invite screen can show a WhatsApp icon only for
        // people who actually use it. iOS has no equivalent — we show it anyway.
        withAccounts: true,
        deduplicateProperties: true,
      );
      rawContactCount = raw.length;
      // phoneNorm -> (rawPhone, name, email, wa). First non-empty value wins per
      // number; WhatsApp flag is OR-ed across the contacts that share the number.
      final byNorm = <String, ({String raw, String name, String email, bool wa})>{};
      var _processed = 0;
      for (final c in raw) {
        // A large address book (thousands of contacts) processed in one synchronous
        // pass blocks the UI thread long enough to ANR ("AvaTOK isn't responding"),
        // especially when an FCM-triggered resume re-runs this. Yield to the event
        // loop every 250 contacts so the UI stays responsive during the parse.
        if (++_processed % 250 == 0) await Future<void>.delayed(Duration.zero);
        final name = c.displayName.trim();
        final email = c.emails.isNotEmpty ? c.emails.first.address.trim() : '';
        // Android: detect WhatsApp via the contact's linked accounts. iOS can't
        // tell, so default to true (show the icon; wa.me handles non-users).
        final wa = !Platform.isAndroid ||
            c.accounts.any((a) => a.type.toLowerCase().contains('whatsapp'));
        for (final p in c.phones) {
          final rawNum = p.number.trim();
          if (rawNum.isEmpty) continue;
          phoneCountRaw++;
          final norm = normPhone(rawNum);
          if (norm.length < 4) continue; // junk
          final existing = byNorm[norm];
          if (existing == null) {
            byNorm[norm] = (raw: rawNum, name: name, email: email, wa: wa);
          } else {
            byNorm[norm] = (
              raw: existing.raw,
              name: existing.name.isEmpty && name.isNotEmpty ? name : existing.name,
              email: existing.email.isEmpty && email.isNotEmpty ? email : existing.email,
              wa: existing.wa || wa,
            );
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
          // Fresh from the device read each sync (carry forward if this read
          // somehow lost it, so an existing email/flag isn't wiped).
          email: Value(v.email.isNotEmpty ? v.email : (prev?.email ?? '')),
          hasWhatsapp: Value(v.wa ? 1 : (prev?.hasWhatsapp ?? 0)),
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
