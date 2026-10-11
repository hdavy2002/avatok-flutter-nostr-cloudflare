import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../core/storage/account_storage.dart';
import '../../../core/router/routes.dart';
import 'kyc_models.dart';

/// "A DigiLocker sign-in is in progress" (spec 2.13 and section 3.3).
///
/// The person leaves the app for a Custom Tab and comes back by app resume or by the custom-scheme return link.
/// Either way the screen has to know a check is pending, and for WHOM (host onboarding or a lane join), so the
/// completion call runs once, in the right place. Saved per account, valid 30 minutes (the worker keeps the
/// DigiLocker session 30 minutes too).
class DigiLockerPending {
  const DigiLockerPending({required this.role, required this.at, this.lane, this.next});

  final KycRole role;
  final DateTime at;

  /// `women` or `lgbtq` when a lane join started it; null for host onboarding.
  final String? lane;
  final String? next;

  static const Duration ttl = Duration(minutes: 30);

  bool isFreshAt(DateTime now) => !now.isBefore(at) && now.difference(at) < ttl;
}

class DigiLockerPendingStore {
  const DigiLockerPendingStore();

  static String get _key => scopedKey('hf.kyc.digilocker_pending.v1');

  /// The pending attempt, or null when there is none or it is older than 30 minutes (then it is removed).
  Future<DigiLockerPending?> read() async {
    final key = _key;
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(key);
      if (raw == null) return null;
      final j = jsonDecode(raw);
      if (j is! Map) return null;
      final role = KycRole.fromWire(j['role']?.toString());
      final at = j['at'];
      if (role == null || at is! num) {
        await prefs.remove(key);
        return null;
      }
      final p = DigiLockerPending(
        role: role,
        at: DateTime.fromMillisecondsSinceEpoch(at.toInt()),
        lane: j['lane']?.toString(),
        next: Routes.safeNext(j['next']?.toString()),
      );
      if (!p.isFreshAt(DateTime.now())) {
        await prefs.remove(key);
        return null;
      }
      return key == _key ? p : null;
    } catch (e) {
      debugPrint('digilocker pending read failed: $e');
      return null;
    }
  }

  Future<void> save(DigiLockerPending p) async {
    final key = _key;
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(
        key,
        jsonEncode({'role': p.role.wire, 'at': p.at.millisecondsSinceEpoch, if (p.lane != null) 'lane': p.lane, if (Routes.safeNext(p.next) != null) 'next': Routes.safeNext(p.next)}),
      );
    } catch (e) {
      debugPrint('digilocker pending save failed: $e');
    }
  }

  Future<void> clear() async {
    final key = _key;
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.remove(key);
    } catch (e) {
      debugPrint('digilocker pending clear failed: $e');
    }
  }
}

final digiLockerPendingStoreProvider = Provider<DigiLockerPendingStore>((ref) => const DigiLockerPendingStore());
