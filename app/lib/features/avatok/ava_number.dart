import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

import '../../core/account_storage.dart';
import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/config.dart';

/// AvaTOK Number client (Specs/AVATOK-NUMBER-FEATURE-SPEC.md).
///
/// A purchasable, pure-virtual, country-standard, NON-PSTN number that represents
/// the user in-network and hides their real phone. Bundled free on paid plans;
/// assigning one replaces the real phone as the user's network identity. Numbers
/// are unique — the picker only ever offers available combinations.
@immutable
class NumberCountry {
  final String iso2;
  final String name;
  final String dial;
  final String flag;
  final String example;
  const NumberCountry({required this.iso2, required this.name, required this.dial, required this.flag, required this.example});
  factory NumberCountry.fromJson(Map<String, dynamic> j) => NumberCountry(
        iso2: (j['iso2'] ?? '').toString(),
        name: (j['name'] ?? '').toString(),
        dial: (j['dial'] ?? '').toString(),
        flag: (j['flag'] ?? '').toString(),
        example: (j['example'] ?? '').toString(),
      );
}

@immutable
class AvailableNumber {
  final String nsn;        // national significant number (digits)
  final String canonical;  // E.164 digits, no '+'
  final String display;    // pretty, e.g. '+233 24 555 0148'
  const AvailableNumber({required this.nsn, required this.canonical, required this.display});
  factory AvailableNumber.fromJson(Map<String, dynamic> j) => AvailableNumber(
        nsn: (j['nsn'] ?? '').toString(),
        canonical: (j['canonical'] ?? '').toString(),
        display: (j['display'] ?? '').toString(),
      );
}

@immutable
class MyNumber {
  final bool entitled;     // is the account on a paid plan (can hold a number)
  final int tier;
  final bool featureOn;
  final String? number;    // canonical digits, or null if unassigned
  final String? display;   // pretty form
  // Whether the account may (re)generate a number now. Paid: always. Free: only
  // their ONE free generation, until it's used. Server-computed (can_generate).
  final bool canGenerate;
  const MyNumber({required this.entitled, required this.tier, required this.featureOn, this.number, this.display, this.canGenerate = false});
  bool get hasNumber => (number ?? '').isNotEmpty;
  factory MyNumber.fromJson(Map<String, dynamic> j) => MyNumber(
        entitled: j['entitled'] == true,
        tier: (j['tier'] is int) ? j['tier'] as int : int.tryParse('${j['tier']}') ?? 0,
        featureOn: j['feature'] != false,
        number: (j['number'] ?? '').toString().isEmpty ? null : j['number'].toString(),
        display: (j['display'] ?? '').toString().isEmpty ? null : j['display'].toString(),
        // Back-compat: an older server without can_generate → old rule (paid only).
        canGenerate: j.containsKey('can_generate') ? j['can_generate'] == true : (j['entitled'] == true),
      );
}

@immutable
class Discoverability {
  final bool phoneDiscoverable;
  final bool emailDiscoverable;
  final String whoCanAdd; // everyone | number_only | nobody
  // [LASTSEEN-PRIVACY-1] WhatsApp-style last-seen visibility.
  final String lastSeenWho; // everyone | contacts | list | nobody
  final List<String> lastSeenAllow; // uids for 'contacts' (synced) / 'list' (picked)
  const Discoverability({required this.phoneDiscoverable, required this.emailDiscoverable,
      required this.whoCanAdd, this.lastSeenWho = 'everyone', this.lastSeenAllow = const []});
  factory Discoverability.fromJson(Map<String, dynamic> j) => Discoverability(
        phoneDiscoverable: j['phone_discoverable'] == true,
        emailDiscoverable: j['email_discoverable'] != false,
        whoCanAdd: (j['who_can_add'] ?? 'everyone').toString(),
        lastSeenWho: (j['last_seen_visibility'] ?? 'everyone').toString(),
        lastSeenAllow: [for (final u in (j['last_seen_allow'] as List? ?? const [])) u.toString()],
      );
}

/// Card resolved from a scanned/clicked QR share token (`/api/add?t=`).
@immutable
class AddCard {
  final String uid;
  final String name;
  final String avatarUrl;
  final String firstName;
  final String lastName;
  final String email;
  final String number;  // AvaTOK number (paid) or real phone (free)
  final String plan;    // 'paid' | 'free'
  const AddCard({required this.uid, required this.name, this.avatarUrl = '', this.firstName = '', this.lastName = '', this.email = '', this.number = '', this.plan = 'free'});
  bool get sharesRealNumber => plan == 'free';
}

class AvaNumber {
  // ---- per-account stale-while-revalidate cache -----------------------------
  // Settings sub-pages (Your number, Privacy, Contact info) used to hit the
  // network on EVERY visit and show a spinner. These small JSON blobs are cached
  // per account so a revisit renders INSTANTLY from disk, then a background fetch
  // refreshes the cache for next time. Account-scoped (scopedKey) because one
  // phone is shared by a parent + child accounts (rulebook §per-account scoping).
  static const _ss = FlutterSecureStorage();
  static const _meCacheKey = 'avanum_me_v1';
  static const _privCacheKey = 'avanum_privacy_v1';

  static Future<Map<String, dynamic>?> _readCache(String base) async {
    try {
      final s = await readScoped(_ss, base);
      if (s == null || s.isEmpty) return null;
      return jsonDecode(s) as Map<String, dynamic>;
    } catch (_) { return null; }
  }

  static Future<void> _writeCache(String base, Map<String, dynamic> j) async {
    try { await _ss.write(key: scopedKey(base), value: jsonEncode(j)); } catch (_) { /* best-effort */ }
  }

  static Future<Map<String, dynamic>?> _fetchJson(String url) async {
    try {
      final r = await ApiAuth.getSigned(url);
      if (r.statusCode != 200) return null;
      return jsonDecode(r.body) as Map<String, dynamic>;
    } catch (_) { return null; }
  }

  /// Supported countries for the picker (public).
  static Future<List<NumberCountry>> countries() async {
    try {
      final r = await http.get(Uri.parse('$kNumberBase/countries')).timeout(const Duration(seconds: 8));
      if (r.statusCode != 200) return [];
      final list = (jsonDecode(r.body)['countries'] as List?)?.cast<Map<String, dynamic>>() ?? [];
      return list.map(NumberCountry.fromJson).toList();
    } catch (_) { return []; }
  }

  /// Available vanity numbers for a country (authed). `pattern` filters by digits.
  static Future<({bool entitled, int tier, List<AvailableNumber> numbers})> available(String country, {String pattern = ''}) async {
    try {
      final q = 'country=${Uri.encodeQueryComponent(country)}${pattern.isNotEmpty ? '&pattern=${Uri.encodeQueryComponent(pattern)}' : ''}';
      final r = await ApiAuth.getSigned('$kNumberBase/available?$q');
      if (r.statusCode != 200) {
        Analytics.capture('number_store_opened_client', {'country': country, 'ok': false, 'status': r.statusCode});
        return (entitled: false, tier: 0, numbers: <AvailableNumber>[]);
      }
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      final list = (j['numbers'] as List?)?.cast<Map<String, dynamic>>() ?? [];
      Analytics.capture('number_store_opened_client', {
        'country': country, 'ok': true,
        'has_pattern': pattern.isNotEmpty,
        'result_count': list.length,
        'entitled': j['entitled'] == true,
        'tier': (j['tier'] as int?) ?? 0,
      });
      return (entitled: j['entitled'] == true, tier: (j['tier'] as int?) ?? 0, numbers: list.map(AvailableNumber.fromJson).toList());
    } catch (e) {
      Analytics.capture('number_store_opened_client', {'country': country, 'ok': false, 'error': e.runtimeType.toString()});
      return (entitled: false, tier: 0, numbers: <AvailableNumber>[]);
    }
  }

  /// Hold a number briefly while the user confirms (authed + paid).
  static Future<bool> reserve(String country, String nsn) async {
    try {
      final r = await ApiAuth.postJson('$kNumberBase/reserve', {'country': country, 'nsn': nsn});
      return r.statusCode == 200;
    } catch (_) { return false; }
  }

  /// Assign the number — it becomes the user's network identity and replaces the
  /// real phone. Returns the error code on failure (e.g. 'upgrade_required').
  static Future<({bool ok, String? number, String? display, String? error})> assign(String country, String nsn) async {
    try {
      final r = await ApiAuth.postJson('$kNumberBase/assign', {'country': country, 'nsn': nsn});
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      if (r.statusCode == 200 && j['ok'] == true) {
        // Conversion event — country chosen + the number now bound to this account
        // (the signed-in person's email/phone are attached as person properties via
        // Analytics.setUserKeys, so PostHog ties email ↔ this AvaTOK number).
        Analytics.capture('number_assigned', {
          'country': country, 'nsn': nsn,
          'number': (j['number'] ?? '').toString(),
          'display': (j['display'] ?? '').toString(),
        });
        // Write-through the `me` cache so the very next screen (the profile, which
        // reads AvaNumber.me() cache-first) shows the number we just assigned
        // instead of the stale pre-assignment value.
        final cur = (await _readCache(_meCacheKey)) ?? <String, dynamic>{};
        cur['number'] = (j['number'] ?? '').toString();
        cur['display'] = (j['display'] ?? '').toString();
        cur['feature'] = true;
        await _writeCache(_meCacheKey, cur);
        return (ok: true, number: (j['number'] ?? '').toString(), display: (j['display'] ?? '').toString(), error: null);
      }
      final err = (j['error'] ?? 'http_${r.statusCode}').toString();
      Analytics.capture('number_assign_failed', {'country': country, 'nsn': nsn, 'error': err, 'status': r.statusCode});
      return (ok: false, number: null, display: null, error: err);
    } catch (e) {
      Analytics.error(domain: 'number', code: 'assign_failed', action: 'assign',
          message: e.toString(), extra: {'country': country});
      return (ok: false, number: null, display: null, error: 'network');
    }
  }

  /// "Use my own number" — bind a real number the user types (e.g. a business
  /// that doesn't need privacy) as their AvaTOK identity. Format-validated on the
  /// server; not ownership-verified (owner decision 2026-06-27). AvaTOK numbers
  /// are in-app only and never touch the PSTN. Pass the full number or NSN.
  static Future<({bool ok, String? number, String? display, String? error})> assignOwn(String country, String number) async {
    try {
      final r = await ApiAuth.postJson('$kNumberBase/assign-own', {'country': country, 'number': number});
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      if (r.statusCode == 200 && j['ok'] == true) {
        Analytics.capture('number_assigned_own', {'country': country, 'number': (j['number'] ?? '').toString()});
        return (ok: true, number: (j['number'] ?? '').toString(), display: (j['display'] ?? '').toString(), error: null);
      }
      final err = (j['error'] ?? 'http_${r.statusCode}').toString();
      Analytics.capture('number_assign_own_failed', {'country': country, 'error': err, 'status': r.statusCode});
      return (ok: false, number: null, display: null, error: err);
    } catch (e) {
      Analytics.error(domain: 'number', code: 'assign_own_failed', action: 'assign_own',
          message: e.toString(), extra: {'country': country});
      return (ok: false, number: null, display: null, error: 'network');
    }
  }

  static Future<MyNumber> me() async {
    // Cache-first ONLY when the cache already has a number (the steady state):
    // return instantly + refresh in the background. If the cache has NO number
    // (the bug-prone state that drove the gate loop + a blank profile QR), treat
    // it as a miss and await the network — which now reads the PRIMARY D1, so a
    // just-assigned number is always seen.
    final cached = await _readCache(_meCacheKey);
    if (cached != null && (cached['number'] ?? '').toString().isNotEmpty) {
      unawaited(_fetchJson('$kNumberBase/me').then((fresh) {
        // Replica-lag guard (owner report 2026-07-01, the "asked to pick a SECOND
        // number" bug): a just-assigned number is written to the PRIMARY D1, but a
        // background /me can still hit a lagged replica and return NO number.
        // Writing that empty response through wiped the cached number, so the next
        // me() missed → the compulsory number gate re-appeared AFTER the profile
        // step. Never let an empty response DOWNGRADE a known number — only refresh
        // when the fresh copy also has one. A real release() clears the cache itself.
        if (fresh != null && (fresh['number'] ?? '').toString().isNotEmpty) {
          _writeCache(_meCacheKey, fresh);
        }
      }));
      return MyNumber.fromJson(cached);
    }
    final fresh = await _fetchJson('$kNumberBase/me');
    if (fresh != null) { await _writeCache(_meCacheKey, fresh); return MyNumber.fromJson(fresh); }
    // Network unavailable → fall back to whatever cache we had, else a safe default.
    if (cached != null) return MyNumber.fromJson(cached);
    return const MyNumber(entitled: false, tier: 0, featureOn: true);
  }

  static Future<bool> release() async {
    try {
      final ok = (await ApiAuth.postJson('$kNumberBase/release', {})).statusCode == 200;
      // Clear the me-cache on a real release so the empty-response guard in me()
      // doesn't keep preserving a number the account no longer holds.
      if (ok) { try { await _ss.delete(key: scopedKey(_meCacheKey)); } catch (_) {} }
      return ok;
    } catch (_) { return false; }
  }

  /// Persist the card the user chose to share + get the stable QR link.
  static Future<({String token, String link})?> shareCard({required String firstName, required String lastName, required String email, required String number}) async {
    try {
      final r = await ApiAuth.postJson('$kNumberBase/share-card', {'firstName': firstName, 'lastName': lastName, 'email': email, 'number': number});
      if (r.statusCode != 200) return null;
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      return (token: (j['token'] ?? '').toString(), link: (j['link'] ?? '').toString());
    } catch (_) { return null; }
  }

  /// Register/clear the user's optional private number + whether to expose it.
  /// When [show] is true, the server lets the AvaTOK dialpad resolve that number
  /// to this account so calls ring their app (owner request 2026-06-29).
  static Future<bool> setPrivateNumber({required String number, required bool show}) async {
    try {
      final r = await ApiAuth.postJson('$kNumberBase/private', {'number': number, 'show': show});
      return r.statusCode == 200;
    } catch (_) { return false; }
  }

  static Future<Discoverability> getPrivacy() async {
    final cached = await _readCache(_privCacheKey);
    if (cached != null) {
      unawaited(_fetchJson('$kNumberBase/privacy').then((fresh) {
        if (fresh != null) _writeCache(_privCacheKey, fresh);
      }));
      return Discoverability.fromJson(cached);
    }
    final fresh = await _fetchJson('$kNumberBase/privacy');
    if (fresh == null) return const Discoverability(phoneDiscoverable: false, emailDiscoverable: true, whoCanAdd: 'everyone');
    await _writeCache(_privCacheKey, fresh);
    return Discoverability.fromJson(fresh);
  }

  static Future<bool> setPrivacy({bool? phoneDiscoverable, bool? emailDiscoverable, String? whoCanAdd,
      String? lastSeenWho, List<String>? lastSeenAllow}) async {
    try {
      final body = <String, dynamic>{
        if (phoneDiscoverable != null) 'phone_discoverable': phoneDiscoverable,
        if (emailDiscoverable != null) 'email_discoverable': emailDiscoverable,
        if (whoCanAdd != null) 'who_can_add': whoCanAdd,
        // [LASTSEEN-PRIVACY-1] visibility + the uid allow set (uids only — never
        // phone numbers or emails, per the on-device contacts privacy rule).
        if (lastSeenWho != null) 'last_seen_visibility': lastSeenWho,
        if (lastSeenAllow != null) 'last_seen_allow': lastSeenAllow,
      };
      final r = await ApiAuth.postJson('$kNumberBase/privacy', body);
      if (r.statusCode == 200) {
        Analytics.capture('discoverability_changed', {
          'who_can_add': whoCanAdd ?? '',
          if (lastSeenWho != null) 'last_seen_visibility': lastSeenWho,
        });
        // Write-through so the cached settings page reflects the change instantly
        // on the next open (no stale toggle until the background refresh lands).
        final cur = (await _readCache(_privCacheKey)) ?? <String, dynamic>{};
        if (phoneDiscoverable != null) cur['phone_discoverable'] = phoneDiscoverable;
        if (emailDiscoverable != null) cur['email_discoverable'] = emailDiscoverable;
        if (whoCanAdd != null) cur['who_can_add'] = whoCanAdd;
        if (lastSeenWho != null) cur['last_seen_visibility'] = lastSeenWho;
        if (lastSeenAllow != null) cur['last_seen_allow'] = lastSeenAllow;
        await _writeCache(_privCacheKey, cur);
      }
      return r.statusCode == 200;
    } catch (_) { return false; }
  }

  /// Resolve a scanned QR share token to a contact card (public).
  static Future<AddCard?> addResolve(String token) async {
    final t = token.trim();
    if (t.isEmpty) return null;
    try {
      final r = await http.get(Uri.parse('$kAddResolveUrl?t=${Uri.encodeQueryComponent(t)}')).timeout(const Duration(seconds: 8));
      if (r.statusCode != 200) return null;
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      final card = (j['card'] as Map<String, dynamic>?) ?? {};
      Analytics.capture('qr_scanned', {'plan': (card['plan'] ?? '').toString()});
      return AddCard(
        uid: (j['uid'] ?? '').toString(),
        name: (j['name'] ?? '').toString(),
        avatarUrl: (j['avatar_url'] ?? '').toString(),
        firstName: (card['firstName'] ?? '').toString(),
        lastName: (card['lastName'] ?? '').toString(),
        email: (card['email'] ?? '').toString(),
        number: (card['number'] ?? '').toString(),
        plan: (card['plan'] ?? 'free').toString(),
      );
    } catch (_) { return null; }
  }

  /// Resolve a contact by their PUBLIC AvaTOK number (a scanned/clicked `?n=`
  /// link, e.g. from a contact's shared QR). Returns their add card, or null.
  static Future<AddCard?> addResolveByNumber(String number) async {
    final digits = number.replaceAll(RegExp(r'[^0-9]'), '');
    if (digits.isEmpty) return null;
    try {
      final r = await http.get(Uri.parse('$kAddResolveUrl?n=${Uri.encodeQueryComponent(digits)}')).timeout(const Duration(seconds: 8));
      if (r.statusCode != 200) return null;
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      final card = (j['card'] as Map<String, dynamic>?) ?? {};
      Analytics.capture('qr_scanned', {'by': 'number'});
      return AddCard(
        uid: (j['uid'] ?? '').toString(),
        name: (j['name'] ?? '').toString(),
        avatarUrl: (j['avatar_url'] ?? '').toString(),
        firstName: (card['firstName'] ?? '').toString(),
        lastName: (card['lastName'] ?? '').toString(),
        email: (card['email'] ?? '').toString(),
        number: (card['number'] ?? '').toString(),
        plan: (card['plan'] ?? 'free').toString(),
      );
    } catch (_) { return null; }
  }

  /// Extract a share token from an avatok add link/deep-link, or '' if none.
  static String tokenFromLink(String input) {
    final s = input.trim();
    final m = RegExp(r'[?&]t=([A-Za-z0-9]+)').firstMatch(s);
    if (m != null) return m.group(1) ?? '';
    // Bare token pasted directly.
    if (RegExp(r'^[A-Fa-f0-9]{16,64}$').hasMatch(s)) return s;
    return '';
  }
}
