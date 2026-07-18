import 'dart:async';

import 'package:app_links/app_links.dart';
import 'package:flutter/material.dart';

import '../features/avatok/add_by_link_sheet.dart';
import '../features/avatok/ava_number.dart';
import '../features/avatok/contacts.dart';
import '../features/explore/listing_detail.dart';
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
    // [MKT7] Marketplace listing link — https://avatok.ai/l/<id> or avatok://l/<id>
    // (the QR on a listing detail page). Open the listing directly.
    final listingId = _listingId(uri);
    if (listingId.isNotEmpty) {
      Analytics.capture('listing_link_opened', {'scheme': uri.scheme});
      WidgetsBinding.instance.addPostFrameCallback((_) {
        final st = _navKey?.currentState;
        if (st == null) return;
        st.push(MaterialPageRoute(builder: (_) => ListingDetailScreen(listingId: listingId)));
      });
      return;
    }
    // Group-invite deep link (avatok://group?conv= / https://avatok.ai/group?conv=)
    // → open the app; the Groups tab + notification bell surface the pending invite.
    if (_isGroupLink(uri)) {
      Analytics.capture('group_link_opened', {'scheme': uri.scheme});
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _navKey?.currentState?.popUntil((r) => r.isFirst);
      });
      return;
    }
    // Add-by-number link (?n=<digits>) — a contact's QR encodes their AvaTOK
    // number. Resolve it to a card and add the contact directly.
    final number = _addNumber(uri);
    if (number.isNotEmpty) {
      Analytics.capture('qr_link_opened', {'scheme': uri.scheme, 'by': 'number'});
      WidgetsBinding.instance.addPostFrameCallback((_) async {
        final ctx = _navKey?.currentContext;
        final card = await AvaNumber.addResolveByNumber(number);
        if (card == null || card.uid.isEmpty || ctx == null) return;
        final name = card.name.isNotEmpty
            ? card.name
            : [card.firstName, card.lastName].where((s) => s.isNotEmpty).join(' ').trim();
        final contact = Contact(
          uid: card.uid,
          name: name.isNotEmpty ? name : (card.email.isNotEmpty ? card.email : card.number),
          email: card.email,
          avatarUrl: card.avatarUrl,
          number: card.sharesRealNumber ? '' : card.number,
          phone: card.sharesRealNumber ? card.number : '',
        );
        await ContactsStore().add(contact);
        ScaffoldMessenger.maybeOf(ctx)?.showSnackBar(SnackBar(content: Text('Added ${contact.name}')));
      });
      return;
    }
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

  /// Listing id from a `/l/<id>` link (https://avatok.ai/l/<id> or avatok://l/<id>),
  /// or '' if this isn't a listing link. Custom-scheme puts "l" in the host and the
  /// id in the first path segment; universal-link puts both in the path.
  static String _listingId(Uri uri) {
    final segs = uri.pathSegments.where((s) => s.isNotEmpty).toList();
    if (uri.scheme == 'avatok' && uri.host == 'l' && segs.isNotEmpty) return segs.first;
    if (uri.host.endsWith('avatok.ai') && segs.length >= 2 && segs.first == 'l') return segs[1];
    return '';
  }

  /// Digits of the `?n=` number on an AvaTOK add link, or '' if none.
  static String _addNumber(Uri uri) {
    final isAdd = (uri.scheme == 'avatok' &&
            (uri.host == 'add' || uri.path == 'add' || uri.path == '/add')) ||
        ((uri.scheme == 'https' || uri.scheme == 'http') &&
            uri.host.endsWith('avatok.ai') && uri.path.startsWith('/add'));
    if (!isAdd) return '';
    return (uri.queryParameters['n'] ?? '').replaceAll(RegExp(r'[^0-9]'), '');
  }

  static bool _isGroupLink(Uri uri) {
    final isCustom = uri.scheme == 'avatok' &&
        (uri.host == 'group' || uri.path == 'group' || uri.path == '/group');
    final isHttp = (uri.scheme == 'https' || uri.scheme == 'http') &&
        uri.host.endsWith('avatok.ai') && uri.path.startsWith('/group');
    return isCustom || isHttp;
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
