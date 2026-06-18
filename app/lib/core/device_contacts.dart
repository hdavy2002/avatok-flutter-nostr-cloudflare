import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_contacts/flutter_contacts.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:share_plus/share_plus.dart';

import 'account_storage.dart';
import 'api_auth.dart';
import 'config.dart';
import 'referral_service.dart';

/// One entry from the user's phone address book, optionally matched to an
/// AvaTok account (npub) when the person already uses the app.
@immutable
class DeviceContact {
  final String name;
  final List<String> emails;
  final List<String> phones;
  final String? npub; // non-null ⇒ already on AvaTok
  final String? avatar; // base64 thumbnail, optional

  const DeviceContact({
    required this.name,
    this.emails = const [],
    this.phones = const [],
    this.npub,
    this.avatar,
  });

  bool get onAvatok => npub != null && npub!.isNotEmpty;
  String get primaryEmail => emails.isNotEmpty ? emails.first : '';
  String get primaryPhone => phones.isNotEmpty ? phones.first : '';
  String get subtitle =>
      primaryPhone.isNotEmpty ? primaryPhone : (primaryEmail.isNotEmpty ? primaryEmail : '');

  DeviceContact copyWith({String? npub}) => DeviceContact(
        name: name, emails: emails, phones: phones, npub: npub ?? this.npub, avatar: avatar);

  Map<String, dynamic> toJson() =>
      {'name': name, 'emails': emails, 'phones': phones, if (npub != null) 'npub': npub};
  // The wire shape the Worker expects for sync/match (no npub — server resolves).
  Map<String, dynamic> toWire() => {'name': name, 'emails': emails, 'phones': phones};

  factory DeviceContact.fromJson(Map<String, dynamic> j) => DeviceContact(
        name: (j['name'] ?? '').toString(),
        emails: ((j['emails'] as List?) ?? []).map((e) => e.toString()).toList(),
        phones: ((j['phones'] as List?) ?? []).map((e) => e.toString()).toList(),
        npub: j['npub']?.toString(),
      );
}

/// Reads the device address book, syncs it to our backend (per-user storage,
/// reused later by AvaContacts), resolves who's already on AvaTok, and lets the
/// user invite anyone who isn't.
class DeviceContactsService {
  static const _cacheKey = 'avatok_device_contacts_v1';
  static final _store = const FlutterSecureStorage(mOptions: MacOsOptions(useDataProtectionKeyChain: false), 
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  /// True if contacts permission is already granted (no prompt).
  static Future<bool> hasPermission() async {
    // flutter_contacts is mobile-only — no device address book on desktop.
    if (!Platform.isAndroid && !Platform.isIOS) return false;
    try {
      return await FlutterContacts.requestPermission(readonly: true);
    } catch (_) {
      return false;
    }
  }

  /// Prompt for READ_CONTACTS. Returns whether granted.
  static Future<bool> requestPermission() => hasPermission();

  /// Read raw contacts from the phone (name + emails + phones). Empty on denial.
  static Future<List<DeviceContact>> readDevice() async {
    if (!Platform.isAndroid && !Platform.isIOS) return [];
    try {
      if (!await FlutterContacts.requestPermission(readonly: true)) return [];
      final raw = await FlutterContacts.getContacts(
        withProperties: true,
        withPhoto: false,
        deduplicateProperties: true,
      );
      final out = <DeviceContact>[];
      for (final c in raw) {
        final name = c.displayName.trim();
        final emails = c.emails
            .map((e) => e.address.trim().toLowerCase())
            .where((e) => e.isNotEmpty)
            .toSet()
            .toList();
        final phones = c.phones
            .map((p) => p.number.trim())
            .where((p) => p.isNotEmpty)
            .toSet()
            .toList();
        if (name.isEmpty && emails.isEmpty && phones.isEmpty) continue;
        out.add(DeviceContact(name: name, emails: emails, phones: phones));
      }
      out.sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
      return out;
    } catch (_) {
      return [];
    }
  }

  /// Load the last-synced address book from local cache (instant, offline).
  static Future<List<DeviceContact>> cached() async {
    final raw = await _store.read(key: scopedKey(_cacheKey));
    if (raw == null || raw.isEmpty) return [];
    try {
      return (jsonDecode(raw) as List)
          .cast<Map<String, dynamic>>()
          .map(DeviceContact.fromJson)
          .toList();
    } catch (_) {
      return [];
    }
  }

  static Future<void> _saveCache(List<DeviceContact> cs) =>
      _store.write(key: scopedKey(_cacheKey), value: jsonEncode(cs.map((c) => c.toJson()).toList()));

  /// Read the phone, upload to the backend for [ownerNpub], annotate each
  /// contact with its resolved npub (if on AvaTok), cache, and return.
  static Future<List<DeviceContact>> syncAndMatch(String ownerNpub) async {
    final device = await readDevice();
    if (device.isEmpty) {
      final c = await cached();
      return c;
    }
    final matchedByKey = <String, String>{}; // email/phone(lower) -> npub
    try {
      // owner derived server-side from the NIP-98 signature; no longer in body.
      final res = await ApiAuth.postJson(kContactsSyncUrl,
          {'contacts': device.map((c) => c.toWire()).toList()},
          timeout: const Duration(seconds: 12));
      if (res.statusCode == 200) {
        final j = jsonDecode(res.body) as Map<String, dynamic>;
        for (final m in ((j['matched'] as List?) ?? [])) {
          final mm = (m as Map).cast<String, dynamic>();
          final via = (mm['via'] ?? '').toString().toLowerCase();
          final np = (mm['npub'] ?? '').toString();
          if (via.isNotEmpty && np.isNotEmpty) matchedByKey[via] = np;
        }
      }
    } catch (_) {/* offline — fall back to local cache below */}

    final annotated = device.map((c) {
      String? np;
      for (final e in c.emails) {
        if (matchedByKey.containsKey(e.toLowerCase())) { np = matchedByKey[e.toLowerCase()]; break; }
      }
      if (np == null) {
        for (final p in c.phones) {
          if (matchedByKey.containsKey(p.toLowerCase())) { np = matchedByKey[p.toLowerCase()]; break; }
        }
      }
      return np == null ? c : c.copyWith(npub: np);
    }).toList();

    await _saveCache(annotated);
    return annotated;
  }

  /// Share the "join me on AvaTok" invite for [c] via the native share sheet.
  /// Pass [myHandle] so the link carries your referral code (you earn coins when
  /// they join). Falls back to the plain download link if omitted.
  static Future<void> invite(DeviceContact c, {String? myHandle}) async {
    final who = c.name.isNotEmpty ? c.name.split(' ').first : 'there';
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
