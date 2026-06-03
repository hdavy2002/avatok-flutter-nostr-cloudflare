import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// The user's public profile (display name + @handle). Stored locally; published
/// to the directory only when the user opts in by saving a handle.
class Profile {
  final String displayName;
  final String handle; // without '@'
  final bool sharePresence; // last-seen / online visible to others
  const Profile({this.displayName = '', this.handle = '', this.sharePresence = true});

  bool get isEmpty => displayName.isEmpty && handle.isEmpty;
  String get atHandle => handle.isEmpty ? '' : '@$handle';
}

class ProfileStore {
  static const _key = 'avatok_profile';
  final FlutterSecureStorage _s;
  ProfileStore([FlutterSecureStorage? s])
      : _s = s ??
            const FlutterSecureStorage(
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
            );

  Future<Profile> load() async {
    final raw = await _s.read(key: _key);
    if (raw == null || raw.isEmpty) return const Profile();
    try {
      final j = jsonDecode(raw) as Map<String, dynamic>;
      return Profile(
        displayName: (j['name'] ?? '').toString(),
        handle: (j['handle'] ?? '').toString(),
        sharePresence: j['sharePresence'] != false,
      );
    } catch (_) {
      return const Profile();
    }
  }

  Future<void> save(Profile p) => _s.write(
      key: _key,
      value: jsonEncode({'name': p.displayName, 'handle': p.handle, 'sharePresence': p.sharePresence}));
}
