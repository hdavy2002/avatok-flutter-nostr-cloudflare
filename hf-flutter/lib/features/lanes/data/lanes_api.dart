import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_client.dart';
import '../../../core/auth/session.dart';

/// The two protected spaces (worker lib/hf_lanes.ts).
enum Lane {
  women('women'),
  lgbtq('lgbtq');

  const Lane(this.wire);

  /// The value in the URL and the telemetry (`women`, `lgbtq`). Never anything else about the person.
  final String wire;

  static Lane? parse(String? s) {
    for (final l in Lane.values) {
      if (l.wire == s) return l;
    }
    return null;
  }
}

/// `GET /api/hf/lanes/me`:
/// `{whatsappVerified, aadhaarVerified, gender:'F'|'M'|'T'|null, lanes:{women:{eligible,granted}, lgbtq:{declared,granted}}}`.
class LaneStatus {
  const LaneStatus({
    this.whatsappVerified = false,
    this.aadhaarVerified = false,
    this.gender,
    this.womenEligible = false,
    this.womenGranted = false,
    this.lgbtqDeclared = false,
    this.lgbtqGranted = false,
  });

  final bool whatsappVerified;
  final bool aadhaarVerified;

  /// `F`, `M`, `T` or null. Used only to explain eligibility on this screen; never sent to telemetry.
  final String? gender;
  final bool womenEligible;
  final bool womenGranted;
  final bool lgbtqDeclared;
  final bool lgbtqGranted;

  bool granted(Lane l) => l == Lane.women ? womenGranted : lgbtqGranted;

  factory LaneStatus.fromJson(Map<String, dynamic> j) {
    Map<String, dynamic> m(Object? v) => v is Map ? Map<String, dynamic>.from(v) : <String, dynamic>{};
    final lanes = m(j['lanes']);
    final women = m(lanes['women']);
    final lgbtq = m(lanes['lgbtq']);
    final g = (j['gender'] ?? '').toString();
    return LaneStatus(
      whatsappVerified: j['whatsappVerified'] == true,
      aadhaarVerified: j['aadhaarVerified'] == true,
      gender: g.isEmpty ? null : g,
      womenEligible: women['eligible'] == true,
      womenGranted: women['granted'] == true,
      lgbtqDeclared: lgbtq['declared'] == true,
      lgbtqGranted: lgbtq['granted'] == true,
    );
  }
}

/// Lane calls. Errors are `ApiError`: `404 not_enabled`, `409 aadhaar_required`, `403 not_eligible`,
/// `400 declare_required | ack18_required`.
class LanesApi {
  const LanesApi(this._api);

  final ApiClient _api;

  Future<LaneStatus> me() async => LaneStatus.fromJson(await _api.getJson('/api/hf/lanes/me'));

  /// `POST /api/hf/lanes/women/join`.
  Future<void> joinWomen() async {
    await _api.postJson('/api/hf/lanes/women/join');
  }

  /// `POST /api/hf/lanes/lgbtq/join {declare:true, ack18:true}`: a private self-declaration.
  Future<void> joinLgbtq({required bool declare, required bool ack18}) async {
    await _api.postJson('/api/hf/lanes/lgbtq/join', body: {'declare': declare, 'ack18': ack18});
  }

  /// `DELETE /api/hf/lanes/:lane`.
  Future<void> leave(Lane lane) async {
    await _api.deleteJson('/api/hf/lanes/${lane.wire}');
  }
}

final lanesApiProvider = Provider<LanesApi>((ref) => LanesApi(ref.watch(apiClientProvider)));

/// The person's lane state. `ref.invalidate(laneStatusProvider)` after a join or a leave.
/// The Me screen (HF-NATIVE-12) can read it for "My spaces" and call `ref.read(lanesApiProvider).leave(lane)`.
final laneStatusProvider = FutureProvider.autoDispose<LaneStatus>((ref) => ref.watch(lanesApiProvider).me());
