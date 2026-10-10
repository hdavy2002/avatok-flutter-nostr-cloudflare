import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/api_client.dart';
import '../../../../core/api/api_error.dart';
import '../../../../core/auth/session.dart';

/// Saves profile fields with `PUT /api/hosts/me`, one field per request, 800 ms after the last change
/// (the same rhythm as the website). One bad field never blocks the others: its message is kept under that
/// field's name and the screen shows it under the field.
///
/// - [set] remembers the wanted value and starts (or restarts) the timer.
/// - [flush] sends everything now and answers whether the given fields are saved.
/// - [valueOf] gives the screen the value the person typed last, else the server's value, so going Back and
///   forward never shows an old value while a save is still on its way.
/// - A field that cannot be edited now (`409 locked`) is dropped quietly: the screens are read-only then.
/// - No network keeps the field waiting; [saveProblem] says so, and the next change or [flush] tries again.
class ProfileSaver extends ChangeNotifier {
  ProfileSaver(this._api, {this.debounce = const Duration(milliseconds: 800)});

  final ApiClient _api;
  final Duration debounce;

  final Map<String, Object?> _local = <String, Object?>{};
  final Map<String, String> _sent = <String, String>{};
  final Map<String, String> _errors = <String, String>{};
  final List<String> _dirty = <String>[];
  Timer? _timer;
  Future<void>? _draining;
  String? _saveProblem;
  bool _disposed = false;

  /// What the person set last for [field], else [fallback] (the server's value).
  Object? valueOf(String field, Object? fallback) => _local.containsKey(field) ? _local[field] : fallback;

  /// The server's message for [field], or null.
  String? errorOf(String field) => _errors[field];

  /// A message about the last failed save (offline or sign-in), or null.
  String? get saveProblem => _saveProblem;

  bool get hasPending => _dirty.isNotEmpty || _draining != null;

  /// Tells the saver what the server already holds, so an untouched field is never sent again.
  /// Ignored for a field the person has already changed or that was already sent in this session.
  void seed(String field, Object? serverValue) {
    if (serverValue == null || _local.containsKey(field) || _sent.containsKey(field)) return;
    _sent[field] = jsonEncode(serverValue);
  }

  /// Wants [field] to become [value]. Clears the old message for that field.
  void set(String field, Object? value) {
    _local[field] = value;
    _errors.remove(field);
    if (!_dirty.contains(field)) _dirty.add(field);
    _timer?.cancel();
    _timer = Timer(debounce, () {
      _timer = null;
      unawaited(_drain());
    });
    _notify();
  }

  /// Sends everything now. True when none of [fields] (default: all that were pending) has a message and
  /// nothing is still waiting for the network.
  Future<bool> flush({List<String>? fields}) async {
    _timer?.cancel();
    _timer = null;
    final watch = fields ?? List<String>.of(_dirty);
    await _drain();
    // A change that arrived while the last request ran is sent too.
    if (_dirty.isNotEmpty) await _drain();
    if (_saveProblem != null && _dirty.any(watch.contains)) return false;
    return watch.every((f) => !_errors.containsKey(f));
  }

  Future<void> _drain() {
    final running = _draining;
    if (running != null) return running;
    final run = _run();
    _draining = run;
    return run.whenComplete(() {
      _draining = null;
    });
  }

  Future<void> _run() async {
    _saveProblem = null;
    while (_dirty.isNotEmpty) {
      final field = _dirty.removeAt(0);
      final value = _local[field];
      final sig = jsonEncode(value);
      if (_sent[field] == sig) continue;
      try {
        await _api.putJson('/api/hosts/me', body: <String, Object?>{field: value});
        _sent[field] = sig;
        _errors.remove(field);
        // Turning the LGBTQ+ lane off resets "show on my profile" on the server.
        if (field == 'lgbtqLane') _sent.remove('lgbtqPublic');
      } on ApiError catch (e) {
        if (e.code == 'locked') {
          _sent[field] = sig;
        } else if (e.isOffline || e.isUnauthorized) {
          _dirty.insert(0, field);
          _saveProblem = e.isOffline ? e.userMessage : 'Please sign in again to save.';
          _notify();
          return;
        } else {
          _errors[e.field ?? field] = e.userMessage;
        }
      } catch (_) {
        // Anything unexpected: keep the field waiting and say so, never crash a screen from a background save.
        _dirty.insert(0, field);
        _saveProblem = 'We could not save that. Please try again.';
        _notify();
        return;
      }
      _notify();
    }
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    super.dispose();
  }
}

/// One saver for the whole part B flow, so a value typed on one step is still shown after Back and forward.
/// A new person signing in on the same phone starts with a clean one.
final profileSaverProvider = Provider<ProfileSaver>((ref) {
  ref.watch(sessionProvider.select((s) => s.user?.id));
  final saver = ProfileSaver(ref.watch(apiClientProvider));
  ref.onDispose(saver.dispose);
  return saver;
});
