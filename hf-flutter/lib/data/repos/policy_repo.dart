import 'package:flutter/foundation.dart';

import '../api_client.dart';
import '../api_exception.dart';

/// One policy page the person has not accepted in its current version.
class PolicyItem {
  const PolicyItem({required this.policy, required this.path, required this.version});

  /// `terms | privacy | disclaimer | community | engagement`
  final String policy;

  /// The website page, e.g. `/terms` (open it with `Brand.url(path)`).
  final String path;

  /// The version pin the server wants echoed back on accept.
  final String version;

  /// Plain name for the list.
  String get title => switch (policy) {
        'terms' => 'Terms of use',
        'privacy' => 'Privacy policy',
        'disclaimer' => 'Disclaimer',
        'community' => 'Community guidelines',
        'engagement' => 'Rules of engagement',
        _ => 'Our rules',
      };
}

/// `GET /api/hf/me/policy-update` (worker/src/routes/hf_registration.ts):
/// `{required, note, pending: [{policy, path, version}]}`.
class PolicyUpdate {
  const PolicyUpdate({this.required = false, this.note, this.pending = const []});

  final bool required;

  /// One plain line saying what changed, or null.
  final String? note;
  final List<PolicyItem> pending;

  /// The prompt only shows when the server says so AND there is something to accept.
  bool get blocks => required && pending.isNotEmpty;

  factory PolicyUpdate.fromJson(Map<String, dynamic> j) {
    final raw = j['pending'];
    final items = <PolicyItem>[];
    if (raw is List) {
      for (final e in raw) {
        if (e is! Map) continue;
        final policy = (e['policy'] ?? '').toString();
        final version = (e['version'] ?? '').toString();
        if (policy.isEmpty || version.isEmpty) continue;
        items.add(PolicyItem(policy: policy, path: (e['path'] ?? '').toString(), version: version));
      }
    }
    final note = (j['note'] ?? '').toString().trim();
    return PolicyUpdate(required: j['required'] == true, note: note.isEmpty ? null : note, pending: items);
  }
}

/// Policy re-accept: `GET` and `POST /api/hf/me/policy-update`.
class PolicyRepo {
  const PolicyRepo(this._api);

  final ApiClient _api;

  Future<PolicyUpdate> fetch() async => PolicyUpdate.fromJson(await _api.getJson('/api/hf/me/policy-update'));

  /// Accepts exactly the versions shown: `{acceptedPolicyVersions: {policy: version}}`.
  /// Throws `ApiException` (409 `policy_versions_required` when the pins moved since they were read).
  Future<void> accept(PolicyUpdate update) async {
    await _api.postJson('/api/hf/me/policy-update', body: {
      'acceptedPolicyVersions': {for (final p in update.pending) p.policy: p.version},
    });
  }
}

/// The gating logic behind the blocking "rules changed" prompt, kept free of widgets so it can be tested.
///
/// - Signed out (`account == null`): never blocks, forgets everything.
/// - Signed in: asks the server once per account per app run. A failed check never blocks (the next app start asks again).
/// - [accept] posts once at a time; on error [error] is set and [pending] stays, so the person can retry.
class PolicyGateController extends ChangeNotifier {
  PolicyGateController(this._repo);

  final PolicyRepo _repo;

  PolicyUpdate? _pending;
  bool _accepting = false;
  String? _error;
  String? _checkedFor;

  /// The update to show, or null when nothing blocks.
  PolicyUpdate? get pending => _pending;
  bool get blocked => _pending != null;
  bool get accepting => _accepting;
  String? get error => _error;

  /// Call whenever the signed-in account changes (or at start). Safe to call many times.
  Future<void> check(String? account) async {
    if (account == null || account.isEmpty) {
      _checkedFor = null;
      if (_pending != null || _error != null || _accepting) {
        _pending = null;
        _error = null;
        _accepting = false;
        notifyListeners();
      }
      return;
    }
    if (_checkedFor == account) return;
    _checkedFor = account;
    PolicyUpdate? update;
    try {
      update = await _repo.fetch();
    } catch (_) {
      return; // fail open: never lock somebody out because the check could not run
    }
    if (_checkedFor != account) return; // signed out or switched while waiting
    _pending = update.blocks ? update : null;
    _error = null;
    notifyListeners();
  }

  /// The "I agree" button.
  Future<void> accept() async {
    final p = _pending;
    final account = _checkedFor;
    if (p == null || _accepting) return;
    _accepting = true;
    _error = null;
    notifyListeners();
    try {
      await _repo.accept(p);
      if (_checkedFor != account) return;
      _pending = null;
    } on ApiException catch (e) {
      if (_checkedFor != account) return;
      _error = e.userMessage;
      if (e.code == 'policy_versions_required') {
        // The pages changed again while the prompt was open: read the new versions so the next tap accepts those.
        try {
          final fresh = await _repo.fetch();
          if (_checkedFor == account) _pending = fresh.blocks ? fresh : null;
        } catch (_) {}
      }
    } catch (_) {
      if (_checkedFor == account) _error = 'We could not save that. Please try again.';
    } finally {
      _accepting = false;
      notifyListeners();
    }
  }
}
