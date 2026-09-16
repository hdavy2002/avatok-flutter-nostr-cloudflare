import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../identity/identity.dart';
import '../account_storage.dart';
import '../analytics.dart';
import 'ui_catalog_repository.dart';
import 'ui_locales.dart';
import 'ui_messages.dart';

class UiLocaleController extends ChangeNotifier {
  UiLocaleController._() {
    AccountScope.changes.addListener(_accountChanged);
  }
  static final instance = UiLocaleController._();
  final _repository = UiCatalogRepository();
  final _storage = const FlutterSecureStorage();
  UiLocale selected = uiLocales.first;
  UiCatalog? _catalog;
  bool loading = false;
  bool fallback = false;
  int _request = 0;
  Future<void> _preferenceWrites = Future<void>.value();
  final Set<String> _missing = {};
  String get _scope => AccountScope.id ?? kGuestScope;
  String get release => _catalog?.release ?? 'bundled';
  TextDirection get direction => selected.rtl ? TextDirection.rtl : TextDirection.ltr;
  // Flutter does not supply every scheduled-language framework delegate. Do not
  // pretend English system dialogs are a reviewed translation for those locales.
  bool get frameworkSupported => GlobalMaterialLocalizations.delegate.isSupported(selected.locale) &&
      GlobalCupertinoLocalizations.delegate.isSupported(selected.locale);
  Locale get frameworkLocale => frameworkSupported ? selected.locale : const Locale('en');
  bool available(String code) => _repository.published(code);

  Future<void> initialize() => _restore();
  void _accountChanged() {
    ++_request;
    _repository.reset();
    _catalog = null;
    selected = uiLocales.first;
    fallback = false;
    loading = false;
    _missing.clear();
    notifyListeners();
    unawaited(_restore());
  }

  Future<void> _restore() async {
    final scope = _scope;
    final ticket = ++_request;
    final preferenceKey = scopedKey('ui_locale_v1');
    String? preference;
    try { preference = await _storage.read(key: preferenceKey); } catch (_) {}
    if (scope != _scope || ticket != _request) return;
    // Apply bundled English immediately; published catalogs are never required
    // to open the app, and preference reads never migrate another user's value.
    final code = uiLocale(preference ?? 'en').code;
    await _repository.restoreManifest(scope);
    if (scope != _scope || ticket != _request) return;
    // setLocale increments its ticket synchronously before its first await.
    // Keep that exact ticket; never adopt a newer user selection after awaiting.
    final restoreSelectionTicket = _request + 1;
    await setLocale(code, persist: false, allowNetwork: false);
    if (scope != _scope || restoreSelectionTicket != _request || selected.code != code) return;
    final refreshTicket = restoreSelectionTicket;
    unawaited(() async {
      await _repository.refreshManifest(scope);
      if (scope != _scope) return;
      // Publish the newly known availability without overriding a newer choice.
      notifyListeners();
      if (refreshTicket != _request || selected.code != code) return;
      await setLocale(code, persist: false);
    }());
  }

  Future<bool> setLocale(String code, {bool persist = true, bool allowNetwork = true}) async {
    if (!uiLocales.any((l) => l.code == code)) return false;
    final scope = _scope;
    final preferenceKey = scopedKey('ui_locale_v1');
    final ticket = ++_request;
    final timer = Stopwatch()..start();
    loading = true;
    notifyListeners();
    UiCatalog? catalog;
    try { catalog = await _repository.load(scope, code, allowNetwork: allowNetwork); } catch (_) {}
    if (ticket != _request || scope != _scope) return false;
    // Explicit source fallback, never label an absent translation as complete.
    selected = uiLocale(code);
    _catalog = catalog;
    fallback = code != 'en' && catalog == null;
    loading = false;
    _missing.clear();
    notifyListeners();
    if (persist) {
      _preferenceWrites = _preferenceWrites.then((_) async {
        if (ticket != _request || scope != _scope) return;
        try { await _storage.write(key: preferenceKey, value: code); } catch (_) {}
      });
      await _preferenceWrites;
    }
    if (ticket == _request && scope == _scope) {
      unawaited(Analytics.capture('ui_locale_changed', {
        'locale': code, 'release': release, 'catalog_layer': catalog?.layer ?? 'source-fallback',
        'duration_ms': timer.elapsedMilliseconds, 'fallback': fallback,
        'framework_fallback': !frameworkSupported,
      }));
    }
    return !fallback;
  }

  String text(UiMessage message, [Map<String, Object> params = const {}]) {
    final key = message.name;
    final translated = _catalog?.messages[key];
    if (selected.code != 'en' && translated == null && _missing.length < 50 && _missing.add(key)) {
      // Only catalog IDs, never rendered values or private text.
      unawaited(Analytics.capture('ui_catalog_missing_key', {
        'locale': selected.code, 'release': release, 'message_key': key,
      }));
    }
    final value = translated ?? uiSourceMessages[key]!;
    // Replace original placeholders once; inserted private values are never parsed.
    return value.replaceAllMapped(RegExp(r'\{([^{}]+)\}'), (match) {
      final name = match.group(1)!;
      return params.containsKey(name) ? params[name].toString() : match.group(0)!;
    });
  }
}
