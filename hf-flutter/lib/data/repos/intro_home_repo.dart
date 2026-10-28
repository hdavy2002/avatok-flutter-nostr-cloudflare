import 'package:flutter/foundation.dart';

import '../api_client.dart';
import '../api_exception.dart';
import '../intro_flags.dart';
import '../services.dart';

/// [HF-INTRO-A3] What `GET /api/hf/me` adds for an influencer while `hfIntroOnboardingEnabled` is on (Specs/HF-INTRO-VIDEO-1-API.md section 4):
/// `needsIntroVideo`, `introStatus` (`none|submitted|approved|rejected`), `callOption` (`A|B|null`), and for a rejected intro
/// `introRejectReasons` (a list of `{code, text}`) and `introRejectNote`.
class IntroHomeState {
  const IntroHomeState({
    this.needsIntroVideo = false,
    this.introStatus = 'none',
    this.callOption,
    this.rejectReasons = const <String>[],
    this.rejectNote,
  });

  factory IntroHomeState.fromJson(Map<String, dynamic> j) {
    final hostRaw = j['host'];
    final host = hostRaw is Map ? hostRaw : const <String, Object?>{};
    final status = (j['introStatus'] ?? 'none').toString();
    final reasons = <String>[];
    final raw = j['introRejectReasons'];
    if (raw is List) {
      for (final r in raw) {
        final text = r is Map ? (r['text'] ?? '').toString().trim() : r.toString().trim();
        if (text.isNotEmpty) reasons.add(text);
      }
    }
    final note = (j['introRejectNote'] ?? '').toString().trim();
    return IntroHomeState(
      needsIntroVideo: j['needsIntroVideo'] == true,
      introStatus: const {'none', 'submitted', 'approved', 'rejected'}.contains(status) ? status : 'none',
      callOption: parseCallOption(j['callOption']) ?? parseCallOption(host['callOption']),
      rejectReasons: reasons,
      rejectNote: note.isEmpty ? null : note,
    );
  }

  final bool needsIntroVideo;
  final String introStatus;

  /// `A` (Bookings only), `B` (Bookings + live) or null (a legacy influencer: today's rules, which are Bookings + live).
  final String? callOption;
  final List<String> rejectReasons;
  final String? rejectNote;

  /// The dark ACTION NEEDED card shows for a missing intro, one waiting for approval, and a rejected one.
  bool get showsBanner => needsIntroVideo || introStatus == 'submitted' || introStatus == 'rejected';
}

String? parseCallOption(Object? v) => v == 'A' || v == 'B' ? v as String : null;

/// [HF-INTRO-A3] `GET /api/hf/me` (intro fields) and `GET|PUT /api/hosts/me/call-option` (W2). The PUT body is `{option:'A'|'B', surface:'app'}`.
class IntroHomeRepo {
  const IntroHomeRepo(this._api);

  final ApiClient _api;

  Future<IntroHomeState> state() async => IntroHomeState.fromJson(await _api.getJson('/api/hf/me'));

  Future<String?> callOption() async => parseCallOption((await _api.getJson('/api/hosts/me/call-option'))['callOption']);

  /// Returns the option the server ended up with.
  Future<String> setCallOption(String option) async {
    final j = await _api.putJson('/api/hosts/me/call-option', body: {'option': option, 'surface': 'app'});
    return parseCallOption(j['callOption']) ?? option;
  }
}

/// [HF-INTRO-A3] Her call option, shared by the Home card and the centre footer button so they never disagree (HF-REEL-15).
/// Quiet until `hfCallOptionEnabled` is on and the server has answered: [active] is then null and nothing reads it.
class CallOptionStore extends ChangeNotifier {
  CallOptionStore(this._repo);

  static CallOptionStore? _instance;
  static CallOptionStore get instance => _instance ??= CallOptionStore(IntroHomeRepo(Services.instance.api));
  @visibleForTesting
  static set instance(CallOptionStore? s) => _instance = s;

  final IntroHomeRepo _repo;

  /// `A`, `B` or null (not read yet, the flag is off, or the server has no option for a legacy influencer).
  String? option;
  bool loaded = false;
  bool saving = false;
  bool _loading = false;

  /// `A` or `B` once known and the flag is on; a legacy influencer (no option) counts as `B` because today's rules are Bookings + live.
  String? get active => IntroFlags.callOption && loaded ? (option ?? 'B') : null;

  /// Seeds from `GET /api/hf/me` (already read by the Home) so the Home needs no second request.
  void seed(String? value) {
    if (loaded && option == value) return;
    option = value;
    loaded = true;
    notifyListeners();
  }

  /// First read only; later calls are no-ops. Safe to call from build.
  void ensureLoaded() {
    if (loaded || _loading || !IntroFlags.callOption) return;
    _loading = true;
    () async {
      try {
        option = await _repo.callOption();
        loaded = true;
        notifyListeners();
      } catch (_) {
        // keep quiet; the footer and Home fall back to the three-way mode they had
      } finally {
        _loading = false;
      }
    }();
  }

  /// Null on success, else the plain-English reason (state rolled back).
  Future<String?> set(String value) async {
    if (saving || (loaded && value == option)) return null;
    final before = option;
    final wasLoaded = loaded;
    option = value;
    loaded = true;
    saving = true;
    notifyListeners();
    try {
      option = await _repo.setCallOption(value);
      return null;
    } on ApiException catch (e) {
      option = before;
      loaded = wasLoaded;
      return e.userMessage;
    } catch (_) {
      option = before;
      loaded = wasLoaded;
      return ApiException.genericText;
    } finally {
      saving = false;
      notifyListeners();
    }
  }
}
