import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/api_client.dart';
import '../../../../core/api/api_error.dart';
import '../../../../core/auth/session.dart';
import '../../../explore/data/host_options.dart' show noAutoRetry;
import 'part_b_rules.dart';

/// One AI avatar of the catalogue (`GET /api/hosts/avatars`).
class AvatarChoice {
  const AvatarChoice({
    required this.id,
    required this.url,
    required this.gender,
    required this.age,
    required this.look,
    required this.taken,
  });

  final String id;
  final String url;

  /// `woman | man`.
  final String gender;

  /// `20s | 30s | 40s | 50s+`.
  final String age;

  /// `traditional | casual | office`.
  final String look;

  /// Someone else already took it (the worker never marks your own as taken).
  final bool taken;

  String get genderLabel => gender == 'man' ? 'Man' : 'Woman';

  String get lookLabel => look.isEmpty ? '' : '${look[0].toUpperCase()}${look.substring(1)}';

  /// What a screen reader says for this tile.
  String get spoken => '$genderLabel, $age, $lookLabel look${taken ? ', taken' : ''}';

  static AvatarChoice? fromJson(Object? raw) {
    if (raw is! Map) return null;
    String s(Object? v) => (v ?? '').toString();
    final id = s(raw['id']);
    if (id.isEmpty) return null;
    final g = s(raw['gender']).toLowerCase();
    return AvatarChoice(
      id: id,
      url: s(raw['url']),
      gender: (g.startsWith('m')) ? 'man' : 'woman',
      age: s(raw['age']),
      look: s(raw['look']),
      taken: raw['taken'] == true,
    );
  }
}

/// `GET /api/hosts/generate/status`: `{status, stages:{text,images,safety}, error?}`.
class GenerationStatus {
  const GenerationStatus({required this.status, required this.stages, this.error});

  /// `none | queued | running | done | failed | ...`.
  final String status;

  /// Stage key to `waiting | working | done | skipped | failed`.
  final Map<String, String> stages;
  final String? error;

  String stage(String key) => stages[key] ?? 'waiting';

  bool get anyFailed => status == 'failed' || status == 'error' || kGenerationStages.any((k) => stage(k) == 'failed');

  /// Every stage is done (or skipped for now).
  bool get finished => kGenerationStages.every((k) => stage(k) == 'done' || stage(k) == 'skipped');

  factory GenerationStatus.fromJson(Map<String, dynamic> j) {
    final raw = j['stages'];
    final stages = <String, String>{};
    if (raw is Map) {
      raw.forEach((k, v) => stages['$k'] = '$v');
    }
    final e = (j['error'] ?? '').toString().trim();
    return GenerationStatus(
      status: (j['status'] ?? 'none').toString(),
      stages: stages,
      error: e.isEmpty ? null : e,
    );
  }
}

/// What `PUT /api/hosts/me/voice` answers: the length it kept and the review state (`pending`).
class VoiceSaved {
  const VoiceSaved({required this.seconds, required this.status});
  final int seconds;
  final String status;
}

/// The typed calls of onboarding part B that are not plain field saves (those go through `ProfileSaver`).
/// Every method throws [ApiError].
class HostSetupApi {
  const HostSetupApi(this._api);

  final ApiClient _api;

  /// `GET /api/hosts/avatars`: the whole catalogue (the worker sends up to 120). Filtering happens on the phone.
  Future<List<AvatarChoice>> avatars() async {
    final list = await _api.getList('/api/hosts/avatars');
    final out = <AvatarChoice>[];
    for (final e in list) {
      final a = AvatarChoice.fromJson(e);
      if (a != null) out.add(a);
    }
    return out;
  }

  /// `POST /api/hosts/avatars/:id/claim`. `409 avatar_taken` means someone was faster; `409 locked`, not now.
  Future<void> claimAvatar(String id) async {
    await _api.postJson('/api/hosts/avatars/${Uri.encodeComponent(id)}/claim');
  }

  /// `PUT /api/hosts/me/voice`: the raw recording. Headers are ASCII only (`x-duration-seconds`, `x-voice-consent`).
  /// Errors: `400 consent_required`, `422 too_short | too_long | too_small`, `413 too_large`, `415 unsupported_type`,
  /// `409 locked`, `429`.
  Future<VoiceSaved> uploadVoice({
    required Uint8List bytes,
    required String mime,
    required int seconds,
    void Function(int sent, int total)? onProgress,
  }) async {
    final j = await _api.uploadBytes(
      'PUT',
      '/api/hosts/me/voice',
      bytes: bytes,
      contentType: mime,
      headers: <String, String>{'x-duration-seconds': '$seconds', 'x-voice-consent': '1'},
      onProgress: onProgress,
    );
    final v = j['voice'];
    var status = 'pending';
    var secs = seconds;
    if (v is Map) {
      final st = (v['status'] ?? '').toString();
      if (st.isNotEmpty) status = st;
      final n = v['seconds'];
      if (n is num) secs = n.toInt();
    }
    return VoiceSaved(seconds: secs, status: status);
  }

  /// `PUT /api/hosts/me {agreements: true}`.
  Future<void> acceptAgreements() async {
    await _api.putJson('/api/hosts/me', body: <String, Object?>{'agreements': true});
  }

  /// `POST /api/hosts/generate` -> the job id. Errors: `409 profile_incomplete {missing[]}`, `409 already_generating`,
  /// `429 attempts_exhausted`, `503 generation_unavailable`.
  Future<String> startGeneration() async {
    final j = await _api.postJson('/api/hosts/generate');
    return (j['jobId'] ?? '').toString();
  }

  /// `GET /api/hosts/generate/status`.
  Future<GenerationStatus> generationStatus() async =>
      GenerationStatus.fromJson(await _api.getJson('/api/hosts/generate/status'));

  /// `PUT /api/hosts/me/generated {tagline?, quote?, aboutPolished?}`.
  Future<void> saveGenerated(Map<String, String> patch) async {
    await _api.putJson('/api/hosts/me/generated', body: patch);
  }

  /// `POST /api/hosts/submit`. Errors: `422 incomplete {missing[]}`, `409 bad_status`.
  Future<void> submit() async {
    await _api.postJson('/api/hosts/submit');
  }
}

final hostSetupApiProvider = Provider<HostSetupApi>((ref) => HostSetupApi(ref.watch(apiClientProvider)));

/// The avatar catalogue. A failure shows "Try again"; it is not retried behind the person's back.
final avatarCatalogProvider = FutureProvider.autoDispose<List<AvatarChoice>>(retry: noAutoRetry, (ref) {
  return ref.watch(hostSetupApiProvider).avatars();
});

/// The `missing` list of a `profile_incomplete` / `incomplete` error, as step keys the person can open.
List<String> missingSteps(ApiError e) {
  final raw = e.extra['missing'];
  if (raw is! List) return const <String>[];
  final steps = <String>[];
  for (final m in raw) {
    final s = stepForMissing('$m');
    if (s != null && !steps.contains(s)) steps.add(s);
  }
  return steps;
}
