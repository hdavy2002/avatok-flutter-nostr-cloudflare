import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'account_storage.dart';

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
  const Profile({this.displayName = '', this.handle = '', this.phone = '', this.email = '', this.avatarUrl = '', this.bio = '', this.sharePresence = true});

  bool get isEmpty => displayName.isEmpty && handle.isEmpty;
  String get atHandle => handle.isEmpty ? '' : '@$handle';

  Profile copyWith({String? displayName, String? handle, String? phone, String? email, String? avatarUrl, String? bio, bool? sharePresence}) => Profile(
        displayName: displayName ?? this.displayName,
        handle: handle ?? this.handle,
        phone: phone ?? this.phone,
        email: email ?? this.email,
        avatarUrl: avatarUrl ?? this.avatarUrl,
        bio: bio ?? this.bio,
        sharePresence: sharePresence ?? this.sharePresence,
      );
}

class ProfileStore {
  static const _key = 'avatok_profile';
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
      );
    } catch (_) {
      return const Profile();
    }
  }

  Future<void> save(Profile p) => _s.write(
      key: scopedKey(_key),
      value: jsonEncode({'name': p.displayName, 'handle': p.handle, 'phone': p.phone, 'email': p.email, 'avatarUrl': p.avatarUrl, 'bio': p.bio, 'sharePresence': p.sharePresence}));

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
}
