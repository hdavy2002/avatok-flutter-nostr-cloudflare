import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

import 'account_storage.dart';
import 'analytics.dart';
import 'api_auth.dart';
import 'config.dart';

/// The user's public profile (display name + @handle). Stored locally; published
/// to the directory only when the user opts in by saving a handle.
class Profile {
  final String displayName;
  final String handle; // without '@'
  final String phone; // collected at sign-up (E.164-ish), used for contact matching
  final String email; // the account's personal email — populates the QR contact card
  final String avatarUrl; // canonical blossom URL of the profile photo ('' = none)
  final String bio; // free-text "about you" — AvaBrain learns from it (opt-in via the Brain switch)
  final bool sharePresence; // last-seen / online visible to others
  final int? birthYear; // year of birth — used to compute age (under-18 gate); never shown publicly
  // OPTIONAL private phone number the user may choose to expose (owner request
  // 2026-06-29). NOT verified yet — VERIFICATION STUB: a future release will move
  // this under identity verification (see [privatePhoneVerified] placeholder).
  final String privatePhone;
  // When true, the user's QR card / contact areas show [privatePhone] INSTEAD of
  // their AvaTOK number, and the AvaTOK dialpad routes calls to that number to
  // their AvaTOK app. Off by default — privacy-first.
  final bool showPrivateNumber;
  // 'male' | 'female' | 'other' | '' (unset). Drives Ava's pronouns when she
  // answers calls ("can I take a message for him/her/them?") and is a MANDATORY
  // profile field (see [isComplete]).
  final String gender;
  const Profile({this.displayName = '', this.handle = '', this.phone = '', this.email = '', this.avatarUrl = '', this.bio = '', this.sharePresence = true, this.birthYear, this.privatePhone = '', this.showPrivateNumber = false, this.gender = ''});

  // VERIFICATION STUB (future): until phone verification ships, an exposed
  // private number is always treated as unverified. Wire this to the verification
  // service when it lands; UI can then show a "verified" check.
  bool get privatePhoneVerified => false;

  bool get isEmpty => displayName.isEmpty && handle.isEmpty;
  String get atHandle => handle.isEmpty ? '' : '@$handle';

  /// First + last name parts (split on whitespace, empties removed).
  List<String> get nameParts =>
      displayName.trim().split(RegExp(r'\s+')).where((s) => s.isNotEmpty).toList();

  /// All MANDATORY fields present & valid: a profile photo, a first AND last
  /// name, a valid email, an "about you" bio, and a birth year. PHONE IS
  /// OPTIONAL (owner decision 2026-06-27): sign-in and recovery run on email +
  /// email-OTP, so a phone is never required to finish onboarding — it's only
  /// collected later (e.g. for future dating features). Drives the mandatory
  /// profile gate — see ProfileSetupScreen / AvaShell.
  bool get isComplete =>
      avatarUrl.trim().isNotEmpty &&
      nameParts.length >= 2 &&
      isValidEmail(email) &&
      bio.trim().isNotEmpty &&
      birthYear != null &&
      gender.trim().isNotEmpty;

  /// Age in whole years derived from [birthYear] (year-precision — the profile
  /// collects a birth year, not a full date). Null when no birth year is set.
  int? get age => birthYear == null ? null : (DateTime.now().year - birthYear!);

  /// True when the user is under 18 — drives the minor-terms acceptance gate.
  bool get isMinor => (age ?? 99) < 18;

  static bool isValidEmail(String e) =>
      RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$').hasMatch(e.trim());

  /// E.164-ish: optional leading '+', then 8–15 digits (spaces/dashes/parens ok).
  static bool isValidPhone(String p) =>
      RegExp(r'^\+?\d{8,15}$').hasMatch(p.trim().replaceAll(RegExp(r'[\s\-()]'), ''));

  Profile copyWith({String? displayName, String? handle, String? phone, String? email, String? avatarUrl, String? bio, bool? sharePresence, int? birthYear, String? privatePhone, bool? showPrivateNumber, String? gender}) => Profile(
        displayName: displayName ?? this.displayName,
        handle: handle ?? this.handle,
        phone: phone ?? this.phone,
        email: email ?? this.email,
        avatarUrl: avatarUrl ?? this.avatarUrl,
        bio: bio ?? this.bio,
        sharePresence: sharePresence ?? this.sharePresence,
        birthYear: birthYear ?? this.birthYear,
        privatePhone: privatePhone ?? this.privatePhone,
        showPrivateNumber: showPrivateNumber ?? this.showPrivateNumber,
        gender: gender ?? this.gender,
      );
}

class ProfileStore {
  static const _key = 'avatok_profile';
  // Set once a fresh device has recovered an existing account from the server,
  // so we don't re-hit /api/me on every cold start (account-scoped).
  static const _recoveredKey = 'account_recovered_v1';
  final FlutterSecureStorage _s;
  ProfileStore([FlutterSecureStorage? s])
      : _s = s ??
            const FlutterSecureStorage(mOptions: MacOsOptions(useDataProtectionKeyChain: false), 
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
            );

  Future<Profile> load() async {
    final raw = await readScoped(_s, _key);
    if (raw == null || raw.isEmpty) return const Profile();
    try {
      final j = jsonDecode(raw) as Map<String, dynamic>;
      return Profile(
        displayName: (j['name'] ?? '').toString(),
        handle: (j['handle'] ?? '').toString(),
        phone: (j['phone'] ?? '').toString(),
        email: (j['email'] ?? '').toString(),
        avatarUrl: (j['avatarUrl'] ?? '').toString(),
        bio: (j['bio'] ?? '').toString(),
        sharePresence: j['sharePresence'] != false,
        birthYear: (j['birthYear'] is num)
            ? (j['birthYear'] as num).toInt()
            : int.tryParse((j['birthYear'] ?? '').toString()),
        privatePhone: (j['privatePhone'] ?? '').toString(),
        showPrivateNumber: j['showPrivateNumber'] == true,
        gender: (j['gender'] ?? '').toString(),
      );
    } catch (_) {
      return const Profile();
    }
  }

  Future<void> save(Profile p) => _s.write(
      key: scopedKey(_key),
      value: jsonEncode({'name': p.displayName, 'handle': p.handle, 'phone': p.phone, 'email': p.email, 'avatarUrl': p.avatarUrl, 'bio': p.bio, 'sharePresence': p.sharePresence, 'birthYear': p.birthYear, 'privatePhone': p.privatePhone, 'showPrivateNumber': p.showPrivateNumber, 'gender': p.gender}));

  /// Persist just the phone (merging with any existing profile fields).
  Future<void> setPhone(String phone) async {
    final p = await load();
    await save(p.copyWith(phone: phone.trim()));
  }

  /// Persist the account email (merging) so the QR contact card is always complete.
  Future<void> setEmail(String email) async {
    final e = email.trim();
    if (e.isEmpty) return;
    final p = await load();
    if (p.email == e) return;
    await save(p.copyWith(email: e));
  }

  /// Recover an existing account on a NEW phone (email-OTP recovery, owner
  /// request 2026-06-27). When the local profile is incomplete, ask the server
  /// (`GET /api/me`, Clerk-authed) for this account's saved profile and hydrate
  /// it locally so a returning user skips onboarding. The real phone is stored
  /// only as a hash server-side and can't be recovered — it's re-added later via
  /// the soft phone nudge — so a recovered account is treated as set up WITHOUT a
  /// local phone. Returns true when an existing account was recovered (the caller
  /// should let the user straight into the app).
  Future<bool> restoreFromServer() async {
    // Already recovered on this device → trust it, skip the network round-trip.
    try { if (await readScoped(_s, _recoveredKey) == '1') return true; } catch (_) {}
    http.Response res;
    try {
      res = await ApiAuth.getSigned(kMeUrl);
    } catch (_) {
      return false; // offline / transient → fall back to the setup screen
    }
    if (res.statusCode != 200) return false;
    Map<String, dynamic> j;
    try { j = jsonDecode(res.body) as Map<String, dynamic>; } catch (_) { return false; }
    if (j['found'] != true) return false;
    final first = (j['first_name'] ?? '').toString().trim();
    final last = (j['last_name'] ?? '').toString().trim();
    final display = (j['display_name'] ?? '').toString().trim();
    final name = display.isNotEmpty ? display : [first, last].where((s) => s.isNotEmpty).join(' ').trim();
    final avatar = (j['avatar_url'] ?? '').toString().trim();
    // A genuinely set-up account has at least a name and a photo. (A brand-new
    // signup with no profile row yet returns found:false / empty → setup screen.)
    if (name.isEmpty || avatar.isEmpty) return false;
    final by = (j['birth_year'] is num) ? (j['birth_year'] as num).toInt() : null;
    final bio = (j['bio'] ?? '').toString();
    final gender = (j['gender'] ?? '').toString();
    // Email isn't returned (stored hashed) — take it from the signed-in account.
    final email = (Analytics.currentEmail ?? '').trim();
    final existing = await load();
    await save(existing.copyWith(
      displayName: name,
      avatarUrl: avatar,
      bio: bio,
      birthYear: by,
      email: email.isNotEmpty ? email : null,
      gender: gender.isNotEmpty ? gender : null,
    ));
    try { await _s.write(key: scopedKey(_recoveredKey), value: '1'); } catch (_) {/* best-effort */}
    return true;
  }
}
