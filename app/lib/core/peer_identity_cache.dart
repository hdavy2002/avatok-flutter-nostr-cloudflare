// peer_identity_cache.dart — [STREAM-AVA-COPY-1 2026-08-24]
//
// A peer's FIRST NAME and PRONOUN, cached on-device per account.
//
// Why this exists: the Ava receptionist screen has to tell the caller something
// true and specific — "Sonal didn't pick up, so you're talking to her
// assistant". That needs the callee's own name and their stated gender. Both
// live in D1 `users` (the `gender` column has existed since
// migrations/add_user_gender.sql, "Owner gender for receptionist pronouns") and
// are served by `publicIdentityFor`, surfaced to the caller on
// `GET /api/receptionist/config`.
//
// The cloud already caches it (that KV snapshot has a 300s TTL) and
// `ReceptionistApi.configFor` caches it in memory for 3 minutes. This adds the
// third tier the owner asked for: a DURABLE on-device copy, so the very first
// frame of the Ava screen says "her assistant" instead of flashing "their
// assistant" while a probe is in flight — and so it is still right on a cold
// start with no network.
//
// PER-ACCOUNT SCOPING IS MANDATORY (Specs/AVATALK-CLOUDFLARE-RULEBOOK.md §1):
// one phone is shared by a parent and each child account, so a cached peer
// identity must never leak across accounts. Every read and write goes through
// `scopedKey`/`readScoped`.
library;

import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../identity/identity.dart' show AccountScope;
import 'account_storage.dart';

/// A peer's display bits, as far as this device knows them.
class PeerIdentity {
  const PeerIdentity({
    this.firstName = '',
    this.displayName = '',
    this.gender = '',
  });

  /// "Sonal" — what the sentence should call them.
  final String firstName;

  /// "Sonal Singh" — for the header.
  final String displayName;

  /// `'male' | 'female' | 'other' | ''`. Empty means UNKNOWN, and unknown
  /// renders as they/their. Never inferred from the name: guessing a stranger's
  /// pronoun from their name is exactly the mistake this field exists to avoid.
  final String gender;

  bool get isEmpty => firstName.isEmpty && displayName.isEmpty && gender.isEmpty;

  /// Subject pronoun — "she" / "he" / "they".
  String get subjectPronoun => switch (gender) {
        'female' => 'she',
        'male' => 'he',
        _ => 'they',
      };

  /// Possessive pronoun — "her" / "his" / "their". Matches the server-side
  /// mapping in `worker/src/lib/pa_prompt.ts` so the words Ava speaks and the
  /// words on screen cannot disagree.
  String get possessivePronoun => switch (gender) {
        'female' => 'her',
        'male' => 'his',
        _ => 'their',
      };

  Map<String, Object?> toJson() => {
        'firstName': firstName,
        'displayName': displayName,
        'gender': gender,
      };

  static PeerIdentity fromJson(Map<String, dynamic> j) => PeerIdentity(
        firstName: (j['firstName'] ?? '').toString(),
        displayName: (j['displayName'] ?? '').toString(),
        gender: _normalizeGender((j['gender'] ?? '').toString()),
      );

  /// From the `GET /api/receptionist/config` body.
  static PeerIdentity fromConfig(Map<String, dynamic> j) => PeerIdentity(
        firstName: (j['owner_first_name'] ?? '').toString(),
        displayName: (j['owner_display_name'] ?? '').toString(),
        gender: _normalizeGender((j['owner_gender'] ?? '').toString()),
      );

  /// Anything that is not one of the three known values is UNKNOWN. An older
  /// Worker sends no `owner_gender` at all, which must read as unknown rather
  /// than as a literal "null" string.
  static String _normalizeGender(String raw) {
    final g = raw.trim().toLowerCase();
    return (g == 'male' || g == 'female' || g == 'other') ? g : '';
  }

  /// Fill blanks from [other] without overwriting anything already known — used
  /// to merge a fresh probe over a cached copy when the probe came back thin
  /// (an unavailable receptionist returns no owner fields at all).
  PeerIdentity mergedWith(PeerIdentity other) => PeerIdentity(
        firstName: firstName.isNotEmpty ? firstName : other.firstName,
        displayName: displayName.isNotEmpty ? displayName : other.displayName,
        gender: gender.isNotEmpty ? gender : other.gender,
      );
}

class PeerIdentityCache {
  PeerIdentityCache._();
  static final PeerIdentityCache instance = PeerIdentityCache._();

  static const _prefix = 'peer_identity_v1';

  final FlutterSecureStorage _s = const FlutterSecureStorage(
    mOptions: MacOsOptions(useDataProtectionKeyChain: false),
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  /// In-isolate memo in front of secure storage, mirroring `ProfileStore`'s
  /// reasoning: Android's EncryptedSharedPreferences is slow on some OEMs and
  /// this is read on the first frame of a call screen. Keyed by
  /// `"<accountScope>|<uid>"` so an account switch is a miss, never a hit on
  /// another account's data.
  final Map<String, PeerIdentity> _memo = <String, PeerIdentity>{};

  String _diskKey(String uid) => '${_prefix}_$uid';
  String _memoKey(String uid) => '${AccountScope.id ?? ''}|$uid';

  /// Best known identity for [uid], or an empty one. Never throws.
  Future<PeerIdentity> load(String uid) async {
    if (uid.isEmpty) return const PeerIdentity();
    final memoKey = _memoKey(uid);
    final hit = _memo[memoKey];
    if (hit != null) return hit;
    try {
      final raw = await readScoped(_s, _diskKey(uid));
      if (raw == null || raw.isEmpty) return const PeerIdentity();
      final decoded = jsonDecode(raw);
      if (decoded is! Map) return const PeerIdentity();
      final p = PeerIdentity.fromJson(decoded.cast<String, dynamic>());
      _memo[memoKey] = p;
      return p;
    } catch (_) {
      // A corrupt or undecryptable entry is not worth failing a call over, and
      // must NOT be memoised — the next read should try disk again.
      return const PeerIdentity();
    }
  }

  /// Persist [identity] for [uid]. A wholly empty identity is dropped rather
  /// than written: caching "I know nothing about this person" would pin the
  /// they/their fallback in place of a later real answer.
  Future<void> save(String uid, PeerIdentity identity) async {
    if (uid.isEmpty || identity.isEmpty) return;
    _memo[_memoKey(uid)] = identity;
    try {
      await _s.write(
        key: scopedKey(_diskKey(uid)),
        value: jsonEncode(identity.toJson()),
      );
    } catch (_) {/* best-effort: the memo still serves this session */}
  }

  /// Drop the in-memory tier (used after a wipe, where the scope does not
  /// change so the scope check alone would keep serving deleted data).
  void invalidateMemo() => _memo.clear();
}
