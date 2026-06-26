import 'dart:async';

import 'package:app_links/app_links.dart';
import 'package:flutter/material.dart';

import '../features/avatok/add_by_link_sheet.dart';
import '../features/avatok/ava_number.dart';
import '../features/avatok/contacts.dart';
import 'analytics.dart';

/// Routes incoming deep links into the app.
///
/// Handles the AvaTOK "add contact" share link in both forms:
///   • custom scheme:   avatok://add?t=<token>
///   • universal/App Link: https://avatok.ai/add?t=<token>
/// Tapping one opens the app straight to the add-contact confirmation card
/// (Specs/AVATOK-NUMBER-FEATURE-SPEC.md §10A). Uses the global navigatorKey for
/// context so it works from a cold start or while the app is already running.
class DeepLinks {
  static final AppLinks _appLinks = AppLinks();
  static StreamSubscription<Uri>? _sub;
  static GlobalKey<NavigatorState>? _navKey;
  static bool _started = false;

  static Future<void> init(GlobalKey<NavigatorState> navKey) async {
    if (_started) return;
    _started = true;
    _navKey = navKey;
    // Cold start: the link that launched the app (if any).
    try {
      final initial = await _appLinks.getInitialLink();
      if (initial != null) _handle(initial);
    } catch (_) {/* no initial link */}
    // Warm: links delivered while the app is already running.
    _sub = _appLinks.uriLinkStream.listen(_handle, onError: (_) {});
  }

  static void dispose() {
    _sub?.cancel();
    _sub = null;
    _started = false;
  }

  static void _handle(Uri uri) {
    final token = _addToken(uri);
    if (token.isEmpty) return;
    Analytics.capture('qr_link_opened', {'scheme': uri.scheme});
    // Defer until the navigator is mounted (matters on cold start).
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final ctx = _navKey?.currentContext;
      if (ctx == null) return;
      final contact = await addContactFromShareToken(ctx, token);
      if (contact != null) {
        await ContactsStore().add(contact);
        final messenger = ScaffoldMessenger.maybeOf(ctx);
        messenger?.showSnackBar(SnackBar(content: Text('Added ${contact.name}')));
      }
    });
  }

  /// Extract the share token if [uri] is an AvaTOK add link, else ''.
  static String _addToken(Uri uri) {
    final isCustom = uri.scheme == 'avatok' &&
        (uri.host == 'add' || uri.path == 'add' || uri.path == '/add');
    final isHttp = (uri.scheme == 'https' || uri.scheme == 'http') &&
        uri.host.endsWith('avatok.ai') && uri.path.startsWith('/add');
    if (!isCustom && !isHttp) return '';
    final t = uri.queryParameters['t'] ?? '';
    if (t.isNotEmpty) return AvaNumber.tokenFromLink('t=$t');
    return AvaNumber.tokenFromLink(uri.toString());
  }
}
