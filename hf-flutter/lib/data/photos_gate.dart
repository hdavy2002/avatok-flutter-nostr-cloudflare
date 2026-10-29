import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';

import 'api_exception.dart';
import 'intro_flags.dart';
import 'repos/my_photos_repo.dart';
import 'services.dart';
import 'telemetry.dart';

/// [HF-PHOTO-CROP-APP] The photos-required gate.
///
/// With `hfPhotosRequiredEnabled` on, every signed-in member (fan or influencer) needs an approved profile photo AND cover
/// before using the app. This object holds the last known answer of `GET /api/hf/me/photos` (`photos_complete`) so the router's
/// `redirect` can read it without a network call, and tells the router (it is the router's `refreshListenable`) when it changes.
///
/// - Signed-out people (guests) are never blocked.
/// - A failed status call fails OPEN: the person is let through (the server still answers 403 `photos_required` on call, booking and
///   queue routes, which sends her here through [markRequired]).
/// - Refreshed after sign-in (`authAccount` changes), when the app comes back to the front, and after every photo upload.
class PhotosGate extends ChangeNotifier {
  PhotosGate({MyPhotosRepo Function()? repo, bool Function()? signedIn, bool Function()? flagOn, Future<void> Function()? loadFlags})
      : _repo = repo ?? (() => MyPhotosRepo.instance),
        _signedIn = signedIn ?? (() => Services.instance.isSignedIn),
        _flagOn = flagOn ?? (() => IntroFlags.photosRequired && IntroFlags.photoModeration),
        _loadFlags = loadFlags ?? IntroFlags.ensureLoaded;

  /// The app's one gate (the router listens to it).
  static final PhotosGate instance = PhotosGate();

  final MyPhotosRepo Function() _repo;
  final bool Function() _signedIn;
  final bool Function() _flagOn;
  final Future<void> Function() _loadFlags;

  bool _incomplete = false;
  bool _forced = false;
  List<String> _missing = const <String>[];
  String? _message;
  int _gen = 0;
  bool _started = false;

  /// True when the router must keep the person on the photo setup screen.
  bool get blocking => _incomplete && _signedIn() && (_forced || _flagOn());

  /// Which of `profile` / `cover` is still missing, as far as the server said.
  List<String> get missing => _missing;

  /// The server's sentence from the last 403 `photos_required`, handed to the setup screen once.
  String? takeMessage() {
    final m = _message;
    _message = null;
    return m;
  }

  /// Hooks the gate to sign-in changes and app resume. Call once, after `runApp`.
  void start() {
    if (_started) return;
    _started = true;
    Services.instance.authAccount.addListener(_authChanged);
    WidgetsBinding.instance.addObserver(_Resume(this));
    unawaited(refresh());
  }

  void _authChanged() {
    if (!_signedIn()) _forced = false;
    unawaited(refresh());
  }

  /// Asks the server once and updates the cached answer. Never throws.
  Future<void> refresh() async {
    final gen = ++_gen;
    if (!_signedIn()) {
      _forced = false;
      _set(false, const <String>[]);
      return;
    }
    try {
      await _loadFlags();
    } catch (_) {}
    if (gen != _gen) return;
    if (!_flagOn() && !_forced) {
      _set(false, const <String>[]);
      return;
    }
    try {
      final p = await _repo().load();
      if (gen != _gen) return;
      if (p.isComplete) _forced = false;
      _set(!p.isComplete, p.photosMissing);
    } catch (_) {
      if (gen != _gen) return;
      _forced = false; // fail open
      _set(false, const <String>[]);
    }
  }

  /// The server said 403 `photos_required`: block now, even if the cached config is older than the flag.
  void markRequired(ApiException e) {
    _forced = true;
    final m = e.extra['missing'];
    _message = e.userMessage;
    _gen++; // an older status call must not undo this
    _set(true, m is List ? m.whereType<String>().toList() : const <String>[]);
  }

  /// Awaits [f]; a 403 `photos_required` blocks the gate (the router then opens the photo setup screen) and is rethrown for the caller.
  static Future<T> watch<T>(Future<T> f) async {
    try {
      return await f;
    } on ApiException catch (e) {
      if (e.status == 403 && e.code == 'photos_required') instance.markRequired(e);
      rethrow;
    }
  }

  void _set(bool incomplete, List<String> missing) {
    final changed = incomplete != _incomplete || !listEquals(missing, _missing);
    _incomplete = incomplete;
    _missing = missing;
    if (changed) notifyListeners();
  }

  /// Tests: back to "nothing known".
  @visibleForTesting
  void reset() {
    _gen++;
    _forced = false;
    _message = null;
    _set(false, const <String>[]);
  }
}

class _Resume with WidgetsBindingObserver {
  _Resume(this._gate);

  final PhotosGate _gate;

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) unawaited(_gate.refresh());
  }
}

/// Routes that stay open while the photos are missing: the setup screen itself, the splash and intro that lead into the app,
/// settings (sign out), help, the policy pages and the support-ticket screens.
bool photosGateExempt(String path) {
  if (path == '/onboarding/photos' || path == '/splash' || path == '/intro' || path == '/help') return true;
  return path == '/settings' ||
      path.startsWith('/settings/') ||
      path == '/support' ||
      path.startsWith('/support/') ||
      path.startsWith('/page/');
}

String? _lastRedirectFrom;

/// The router's top-level `redirect`: to the photo setup screen when [gate] is blocking and [path] is not exempt, else null.
String? photosGateRedirect(PhotosGate gate, String path) {
  if (!gate.blocking || photosGateExempt(path)) return null;
  if (_lastRedirectFrom != path) {
    _lastRedirectFrom = path;
    Telemetry.event('hf_photo_gate_redirect', {'from': path, 'missing': gate.missing.join(',')});
  }
  return '/onboarding/photos';
}
