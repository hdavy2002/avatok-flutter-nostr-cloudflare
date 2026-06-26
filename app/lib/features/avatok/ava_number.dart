import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

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
  const MyNumber({required this.entitled, required this.tier, required this.featureOn, this.number, this.display});
  bool get hasNumber => (number ?? '').isNotEmpty;
  factory MyNumber.fromJson(Map<String, dynamic> j) => MyNumber(
        entitled: j['entitled'] == true,
        tier: (j['tier'] is int) ? j['tier'] as int : int.tryParse('${j['tier']}') ?? 0,
        featureOn: j['feature'] != false,
        number: (j['number'] ?? '').toString().isEmpty ? null : j['number'].toString(),
        display: (j['display'] ?? '').toString().isEmpty ? null : j['display'].toString(),
      );
}

@immutable
class Discoverability {
  final bool phoneDiscoverable;
  final bool emailDiscoverable;
  final String whoCanAdd; // everyone | number_only | nobody
  const Discoverability({required this.phoneDiscoverable, required this.emailDiscoverable, required this.whoCanAdd});
  factory Discoverability.fromJson(Map<String, dynamic> j) => Discoverability(
        phoneDiscoverable: j['phone_discoverable'] == true,
        emailDiscoverable: j['email_discoverable'] != false,
        whoCanAdd: (j['who_can_add'] ?? 'everyone').toString(),
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
      if (r.statusCode != 200) return (entitled: false, tier: 0, numbers: <AvailableNumber>[]);
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      final list = (j['numbers'] as List?)?.cast<Map<String, dynamic>>() ?? [];
      return (entitled: j['entitled'] == true, tier: (j['tier'] as int?) ?? 0, numbers: list.map(AvailableNumber.fromJson).toList());
    } catch (_) { return (entitled: false, tier: 0, numbers: <AvailableNumber>[]); }
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
        Analytics.capture('number_assigned', {'country': country});
        return (ok: true, number: (j['number'] ?? '').toString(), display: (j['display'] ?? '').toString(), error: null);
      }
      return (ok: false, number: null, display: null, error: (j['error'] ?? 'http_${r.statusCode}').toString());
    } catch (_) { return (ok: false, number: null, display: null, error: 'network'); }
  }

  static Future<MyNumber> me() async {
    try {
      final r = await ApiAuth.getSigned('$kNumberBase/me');
      if (r.statusCode != 200) return const MyNumber(entitled: false, tier: 0, featureOn: true);
      return MyNumber.fromJson(jsonDecode(r.body) as Map<String, dynamic>);
    } catch (_) { return const MyNumber(entitled: false, tier: 0, featureOn: true); }
  }

  static Future<bool> release() async {
    try { return (await ApiAuth.postJson('$kNumberBase/release', {})).statusCode == 200; } catch (_) { return false; }
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

  static Future<Discoverability> getPrivacy() async {
    try {
      final r = await ApiAuth.getSigned('$kNumberBase/privacy');
      if (r.statusCode != 200) return const Discoverability(phoneDiscoverable: false, emailDiscoverable: true, whoCanAdd: 'everyone');
      return Discoverability.fromJson(jsonDecode(r.body) as Map<String, dynamic>);
    } catch (_) { return const Discoverability(phoneDiscoverable: false, emailDiscoverable: true, whoCanAdd: 'everyone'); }
  }

  static Future<bool> setPrivacy({bool? phoneDiscoverable, bool? emailDiscoverable, String? whoCanAdd}) async {
    try {
      final body = <String, dynamic>{
        if (phoneDiscoverable != null) 'phone_discoverable': phoneDiscoverable,
        if (emailDiscoverable != null) 'email_discoverable': emailDiscoverable,
        if (whoCanAdd != null) 'who_can_add': whoCanAdd,
      };
      final r = await ApiAuth.postJson('$kNumberBase/privacy', body);
      if (r.statusCode == 200) Analytics.capture('discoverability_changed', {'who_can_add': whoCanAdd ?? ''});
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
