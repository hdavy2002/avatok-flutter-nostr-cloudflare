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
  // Full date of birth (owner request 2026-07-08): 'yyyy-MM-dd', '' = unset. Now the
  // MANDATORY field the profile screen collects; [birthYear] is kept derived from it
  // for back-compat with the server payload and existing age logic.
  final String birthDate;
  // OPTIONAL time of birth, 'HH:mm' (24h), '' = unset.
  final String birthTime;
  // OPTIONAL private phone number the user may choose to expose (owner request
  // 2026-06-29). NOT verified yet — VERIFICATION STUB: a future release will move
  // this under identity verification (see [privatePhoneVerified] placeholder).
  final String privatePhone;
  // When true, the user's QR card / contact areas show [privatePhone] INSTEAD of
  // their AvaTOK number, and the AvaTOK dialpad routes calls to that number to
  // their AvaTOK app. Off by default — privacy-first.
  final bool showPrivateNumber;
  // True once [privatePhone] has been confirmed via SMS OTP (owner request
  // 2026-07-08). Once verified the profile screen LOCKS the field.
  final bool privatePhoneVerified;
  // 'male' | 'female' | 'other' | '' (unset). Drives Ava's pronouns when she
  // answers calls ("can I take a message for him/her/them?") and is a MANDATORY
  // profile field (see [isComplete]).
  final String gender;
  const Profile({this.displayName = '', this.handle = '', this.phone = '', this.email = '', this.avatarUrl = '', this.bio = '', this.sharePresence = true, this.birthYear, this.birthDate = '', this.birthTime = '', this.privatePhone = '', this.showPrivateNumber = false, this.privatePhoneVerified = false, this.gender = ''});

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

  /// Age in whole years. Prefers the full [birthDate] (day-precise, so the
  /// under-18 gate is exact on birthdays); falls back to year-precision
  /// [birthYear] for older profiles. Null when neither is set.
  int? get age {
    if (birthDate.isNotEmpty) {
      final d = DateTime.tryParse(birthDate);
      if (d != null) {
        final now = DateTime.now();
        var a = now.year - d.year;
        if (now.month < d.month || (now.month == d.month && now.day < d.day)) a--;
        return a;
      }
    }
    return birthYear == null ? null : (DateTime.now().year - birthYear!);
  }

  /// True when the user is under 18 — drives the minor-terms acceptance gate.
  bool get isMinor => (age ?? 99) < 18;

  static bool isValidEmail(String e) =>
      RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$').hasMatch(e.trim());

  /// E.164-ish: optional leading '+', then 8–15 digits (spaces/dashes/parens ok).
  static bool isValidPhone(String p) =>
      RegExp(r'^\+?\d{8,15}$').hasMatch(p.trim().replaceAll(RegExp(r'[\s\-()]'), ''));

  Profile copyWith({String? displayName, String? handle, String? phone, String? email, String? avatarUrl, String? bio, bool? sharePresence, int? birthYear, String? birthDate, String? birthTime, String? privatePhone, bool? showPrivateNumber, bool? privatePhoneVerified, String? gender}) => Profile(
        displayName: displayName ?? this.displayName,
        handle: handle ?? this.handle,
        phone: phone ?? this.phone,
        email: email ?? this.email,
        avatarUrl: avatarUrl ?? this.avatarUrl,
        bio: bio ?? this.bio,
        sharePresence: sharePresence ?? this.sharePresence,
        birthYear: birthYear ?? this.birthYear,
        birthDate: birthDate ?? this.birthDate,
        birthTime: birthTime ?? this.birthTime,
        privatePhone: privatePhone ?? this.privatePhone,
        showPrivateNumber: showPrivateNumber ?? this.showPrivateNumber,
        privatePhoneVerified: privatePhoneVerified ?? this.privatePhoneVerified,
        gender: gender ?? this.gender,
      );
}

class ProfileStore {
  static const _key = 'avatok_profile';
  // Set once a fresh device has recovered an existing account from the server,
  // so we don't re-hit /api/me on every cold start (account-scoped).
  static const _recoveredKey = 'account_recovered_v1';
  // [PROFILE-400-LOOP-2] (AVA-UI-CACHE) Fingerprint of the last name|email|phone
  // payload the cold-start launch-publish sent to /api/profile, per account. The
  // launch publish only carries those three fields, so re-POSTing an IDENTICAL
  // payload can never change the server's completeness verdict — yet the
  // in-memory ApiBackoffState resets every cold start, so an incomplete profile
  // re-fired `400 profile_incomplete` on EVERY launch (84×/3d for one tester).
  // We persist the payload fingerprint here and skip an unchanged re-publish.
  static const _launchPubFpKey = 'profile_launch_pub_fp_v1';
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
        birthDate: (j['birthDate'] ?? '').toString(),
        birthTime: (j['birthTime'] ?? '').toString(),
        privatePhone: (j['privatePhone'] ?? '').toString(),
        showPrivateNumber: j['showPrivateNumber'] == true,
        privatePhoneVerified: j['privatePhoneVerified'] == true,
        gender: (j['gender'] ?? '').toString(),
      );
    } catch (_) {
      return const Profile();
    }
  }

  Future<void> save(Profile p) => _s.write(
      key: scopedKey(_key),
      value: jsonEncode({'name': p.displayName, 'handle': p.handle, 'phone': p.phone, 'email': p.email, 'avatarUrl': p.avatarUrl, 'bio': p.bio, 'sharePresence': p.sharePresence, 'birthYear': p.birthYear, 'birthDate': p.birthDate, 'birthTime': p.birthTime, 'privatePhone': p.privatePhone, 'showPrivateNumber': p.showPrivateNumber, 'privatePhoneVerified': p.privatePhoneVerified, 'gender': p.gender}));

  /// [PROFILE-400-LOOP-2] Fingerprint of the last launch-publish payload sent for
  /// THIS account (scoped). Null when we've never published on this device/account.
  Future<String?> lastLaunchPublishFingerprint() => readScoped(_s, _launchPubFpKey);

  /// Record the fingerprint of the launch-publish payload we just sent, so an
  /// identical (and therefore identically-rejected) payload isn't re-POSTed on the
  /// next cold start. Best-effort — a write failure just means we retry next launch.
  Future<void> setLaunchPublishFingerprint(String fp) async {
    try { await _s.write(key: scopedKey(_launchPubFpKey), value: fp); } catch (_) {/* best-effort */}
  }

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
    // [ISSUE-RESTORE-FLAG-1] (2026-07-09) …but ONLY if the local profile actually
    // has content. FlutterSecureStorage (EncryptedSharedPreferences) can SURVIVE
    // an uninstall via Android Auto Backup, so after a reinstall this flag said
    // "already recovered" while the profile itself was empty — the server pull
    // was skipped and the user's name/photo never came back (hdavy2002, build
    // 12376). An empty profile means the flag is stale: fall through and re-pull.
    try {
      if (await readScoped(_s, _recoveredKey) == '1') {
        final p = await load();
        if (p.displayName.trim().isNotEmpty && p.avatarUrl.trim().isNotEmpty) return true;
        Analytics.capture('profile_restore_flag_stale', const {'reason': 'flag_set_but_profile_empty'});
      }
    } catch (_) {}
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
    // Full DOB (best-effort — present once the server stores it; harmless when absent).
    final bdate = (j['birth_date'] ?? '').toString();
    final btime = (j['birth_time'] ?? '').toString();
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
      birthDate: bdate.isNotEmpty ? bdate : null,
      birthTime: btime.isNotEmpty ? btime : null,
      email: email.isNotEmpty ? email : null,
      gender: gender.isNotEmpty ? gender : null,
    ));
    try { await _s.write(key: scopedKey(_recoveredKey), value: '1'); } catch (_) {/* best-effort */}
    // [ISSUE-VAULT-RESTORE-1] restore counter — the 2026-07-09 missing-data
    // report had no event proving whether the profile came back from /api/me.
    Analytics.capture('profile_restored', {
      'has_photo': avatar.isNotEmpty,
      'has_birth_year': by != null,
      'has_gender': gender.isNotEmpty,
    });
    return true;
  }

  /// R2-F2 login gate: ask the server whether this account's profile is complete
  /// (`GET /api/me` → `profile_complete`). Returns null on any network/parse error
  /// so the caller can FAIL OPEN (a fetch failure must never trap a user out of
  /// the app). Only consulted by AvaShell when RemoteConfig.profileCompletionGate
  /// is on. This is the AUTHORITATIVE completeness signal — the server's vetting
  /// (photo moderation, real-name) can mark a locally-"complete" profile as not
  /// yet passed, so it must route the user back to the Profile screen.
  Future<bool?> serverProfileComplete() async {
    http.Response res;
    try {
      res = await ApiAuth.getSigned(kMeUrl);
    } catch (_) {
      return null; // offline / transient → caller fails open
    }
    if (res.statusCode != 200) return null;
    try {
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      if (j['found'] != true) return false; // no profile row yet → not complete
      return j['profile_complete'] == true;
    } catch (_) {
      return null;
    }
  }
}
