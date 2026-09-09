import 'dart:async';

import 'package:app_links/app_links.dart';
import 'package:flutter/material.dart';

import '../features/avatok/add_by_link_sheet.dart';
import '../features/avatok/ava_number.dart';
import '../features/avatok/contacts.dart';
import '../features/booking/commercial_customer_screens.dart';
import '../features/avalive/avalive_discovery.dart';
import '../features/commercial_getstream/commercial_getstream_screens.dart';
import '../features/commercial_getstream/commercial_live_gateway.dart';
import '../features/commercial_getstream/commercial_live_screens.dart';
import '../features/explore/listing_detail.dart';
import 'analytics.dart';
import 'affiliate_bind_service.dart';

/// Routes incoming deep links into the app.
///
/// Handles the AvaTOK "add contact" share link in both forms:
///   • custom scheme:   avatok://add?t=<token>
///   • universal/App Link: https://avatok.ai/add?t=<token>
/// Commercial links use the same account-safe parser:
///   • live event:   https://avatok.ai/live/<listingId>
///   • consultation: https://avatok.ai/session/<bookingId>
/// Existing `/j/<token>`, `/session?...`, `/live`, and custom-scheme links
/// remain accepted for already-delivered messages and calendar invites.
/// Tapping one opens the app straight to the add-contact confirmation card
/// (Specs/AVATOK-NUMBER-FEATURE-SPEC.md §10A). Uses the global navigatorKey for
/// context so it works from a cold start or while the app is already running.
enum DeepLinkDestinationKind {
  liveDiscovery,
  liveEvent,
  commercialSession,
  bookingJoin,
  listing,
  group,
  addContact,
}

/// A parsed, account-neutral app link. IDs are retained exactly as supplied;
/// admission and role selection remain server-authorized after sign-in.
class DeepLinkDestination {
  const DeepLinkDestination(
    this.kind, {
    this.listingId,
    this.bookingId,
    this.joinToken,
    this.number,
    this.addToken,
    this.scheme = '',
  });

  final DeepLinkDestinationKind kind;
  final String? listingId;
  final String? bookingId;
  final String? joinToken;
  final String? number;
  final String? addToken;
  final String scheme;
}

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
    final affiliateToken = _affiliateToken(uri);
    if (affiliateToken.isNotEmpty) {
      unawaited(AffiliateBindService.savePendingToken(affiliateToken));
      Analytics.capture('affiliate_referral_link_opened', {'scheme': uri.scheme});
      return;
    }
    // [APP-JOIN-ROUTE-1] Booking join link — https://avatok.ai/j/<token> or
    // avatok://j/<token>. Every confirmation email, reminder email and .ics
    // `URL:` field points here; before this handler existed the tap opened
    // the app to whatever screen was already showing and silently dropped
    // the token. Resolution (public join-info, then role/kind via the
    // authenticated booking list, then the sign-in gate if needed) happens
    // in JoinLinkResolverScreen — pushed here so the async work has a widget
    // lifecycle instead of a bare postFrameCallback.
    final destination = parse(uri);
    final joinToken = destination?.joinToken ?? '';
    if (destination?.kind == DeepLinkDestinationKind.bookingJoin &&
        joinToken.isNotEmpty) {
      Analytics.capture('deep_link_opened', {
        'path_shape': '/j/<token>',
        'scheme': uri.scheme,
      });
      WidgetsBinding.instance.addPostFrameCallback((_) {
        final st = _navKey?.currentState;
        if (st == null) return;
        st.push(MaterialPageRoute(
          builder: (_) =>
              JoinLinkResolverScreen(token: joinToken, scheme: uri.scheme),
        ));
      });
      return;
    }
    if (destination?.kind == DeepLinkDestinationKind.liveDiscovery) {
      Analytics.capture('live_link_opened', {
        'path_shape': '/live',
        'scheme': uri.scheme,
      });
      WidgetsBinding.instance.addPostFrameCallback((_) {
        final st = _navKey?.currentState;
        if (st == null) return;
        st.push(MaterialPageRoute(
          builder: (_) => const AvaLiveDiscovery(),
        ));
      });
      return;
    }
    if (destination?.kind == DeepLinkDestinationKind.liveEvent) {
      final listingId = destination!.listingId!;
      Analytics.capture('live_link_opened', {
        'path_shape': '/live/:listingId',
        'scheme': uri.scheme,
      });
      WidgetsBinding.instance.addPostFrameCallback((_) {
        final st = _navKey?.currentState;
        if (st == null) return;
        st.push(MaterialPageRoute(
          builder: (_) => _CommercialLiveLinkScreen(listingId: listingId),
        ));
      });
      return;
    }
    final session = destination?.kind == DeepLinkDestinationKind.commercialSession
        ? (destination!.listingId, destination.bookingId)
        : null;
    if (session != null) {
      Analytics.capture('commercial_session_link_opened', {
        'path_shape': '/session',
        'scheme': uri.scheme,
        'has_listing_id': session.$1 != null,
        'has_booking_id': session.$2 != null,
      });
      WidgetsBinding.instance.addPostFrameCallback((_) {
        final st = _navKey?.currentState;
        if (st == null) return;
        st.push(MaterialPageRoute(
          builder: (_) => MySessionsScreen(
            focusListingId: session.$1,
            focusBookingId: session.$2,
          ),
        ));
      });
      return;
    }
    // [MKT7] Marketplace listing link — https://avatok.ai/l/<id> or avatok://l/<id>
    // (the QR on a listing detail page). Open the listing directly.
    final listingId = destination?.kind == DeepLinkDestinationKind.listing
        ? destination!.listingId!
        : '';
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
    if (destination?.kind == DeepLinkDestinationKind.group) {
      Analytics.capture('group_link_opened', {'scheme': uri.scheme});
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _navKey?.currentState?.popUntil((r) => r.isFirst);
      });
      return;
    }
    // Add-by-number link (?n=<digits>) — a contact's QR encodes their AvaTOK
    // number. Resolve it to a card and add the contact directly.
    final number = destination?.kind == DeepLinkDestinationKind.addContact
        ? (destination!.number ?? '')
        : '';
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
          // [PIVOT-NUMBER-MASK-1] The server now ALWAYS puts the AvaTOK number
          // (never the real phone) in `card.number`, for free and paid alike —
          // see worker/src/routes/number.ts shareCardPut. `card.number` is
          // therefore never the real phone number here; nothing belongs in
          // `phone`.
          number: card.number,
          phone: '',
        );
        await ContactsStore().add(contact);
        ScaffoldMessenger.maybeOf(ctx)?.showSnackBar(SnackBar(content: Text('Added ${contact.name}')));
      });
      return;
    }
    final token = destination?.kind == DeepLinkDestinationKind.addContact
        ? (destination!.addToken ?? '')
        : '';
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

  static bool _isWeb(Uri uri) =>
      (uri.scheme == 'https' || uri.scheme == 'http') &&
      const {'avatok.ai', 'www.avatok.ai'}.contains(uri.host.toLowerCase());

  static bool _isCustom(Uri uri, String name) =>
      uri.scheme == 'avatok' &&
      (uri.host == name || uri.path == name || uri.path == '/$name');

  static String? _cleanId(String? value) {
    final text = (value ?? '').trim();
    return text.isNotEmpty &&
            text.length <= 160 &&
            RegExp(r'^[A-Za-z0-9][A-Za-z0-9_:-]*$').hasMatch(text)
        ? text
        : null;
  }

  /// Parse all supported link shapes without performing account or entitlement
  /// checks. Kept public so focused tests can cover cold/warm URI handling.
  static DeepLinkDestination? parse(Uri uri) {
    final web = _isWeb(uri);
    final segs = uri.pathSegments.where((s) => s.isNotEmpty).toList();
    final scheme = uri.scheme;

    if (_isCustom(uri, 'j') && segs.isNotEmpty) {
      return DeepLinkDestination(DeepLinkDestinationKind.bookingJoin,
          joinToken: segs.first, scheme: scheme);
    }
    if (web && segs.length >= 2 && segs.first == 'j') {
      return DeepLinkDestination(DeepLinkDestinationKind.bookingJoin,
          joinToken: segs[1], scheme: scheme);
    }

    final liveBase = _isCustom(uri, 'live') || (web && segs.isNotEmpty && segs.first == 'live');
    if (liveBase) {
      final liveId = _cleanId(
        uri.queryParameters['listing_id'] ??
            uri.queryParameters['listing'] ??
            (uri.scheme == 'avatok' && uri.host == 'live'
                ? (segs.isEmpty ? null : segs.first)
                : segs.length >= 2 ? segs[1] : null),
      );
      return liveId == null
          ? DeepLinkDestination(DeepLinkDestinationKind.liveDiscovery,
              scheme: scheme)
          : DeepLinkDestination(DeepLinkDestinationKind.liveEvent,
              listingId: liveId, scheme: scheme);
    }

    final sessionBase = _isCustom(uri, 'session') ||
        _isCustom(uri, 'booking') ||
        (web && segs.isNotEmpty && segs.first == 'session');
    if (sessionBase) {
      final canonicalBooking = web && segs.length >= 2 && segs.first == 'session'
          ? segs[1]
          : uri.scheme == 'avatok' && (uri.host == 'session' || uri.host == 'booking') && segs.isNotEmpty
              ? segs.first
              : null;
      final booking = _cleanId(canonicalBooking ??
          uri.queryParameters['booking_id'] ?? uri.queryParameters['booking']);
      final listing = _cleanId(uri.queryParameters['listing_id'] ?? uri.queryParameters['listing']);
      return booking == null && listing == null
          ? null
          : DeepLinkDestination(DeepLinkDestinationKind.commercialSession,
              listingId: listing, bookingId: booking, scheme: scheme);
    }

    if ((web && segs.length >= 2 && segs.first == 'l') ||
        (uri.scheme == 'avatok' && uri.host == 'l' && segs.isNotEmpty)) {
      final id = _cleanId(segs.last);
      return id == null ? null : DeepLinkDestination(DeepLinkDestinationKind.listing, listingId: id, scheme: scheme);
    }
    if (_isCustom(uri, 'group') || (web && segs.isNotEmpty && segs.first == 'group')) {
      return DeepLinkDestination(DeepLinkDestinationKind.group, scheme: scheme);
    }
    final addBase = _isCustom(uri, 'add') || (web && segs.isNotEmpty && segs.first == 'add');
    if (addBase) {
      final number = (uri.queryParameters['n'] ?? '').replaceAll(RegExp(r'[^0-9]'), '');
      final token = uri.queryParameters['t']?.isNotEmpty == true
          ? AvaNumber.tokenFromLink('t=${uri.queryParameters['t']}')
          : AvaNumber.tokenFromLink(uri.toString());
      return DeepLinkDestination(DeepLinkDestinationKind.addContact,
          number: number, addToken: token, scheme: scheme);
    }
    return null;
  }

  static String _affiliateToken(Uri uri) {
    final custom = uri.scheme == 'avatok' && (uri.host == 'join' || uri.path == 'join');
    final web = _isWeb(uri) && uri.path.startsWith('/a/');
    if (!custom && !web) return '';
    return (uri.queryParameters['aff'] ?? '').trim();
  }

}

/// Canonical `/live/:listingId` links do not trust the role encoded in a URL.
/// The host admission endpoint is attempted first; only a server refusal for
/// host access falls through to the receive-only viewer entry screen.
class _CommercialLiveLinkScreen extends StatefulWidget {
  const _CommercialLiveLinkScreen({required this.listingId});
  final String listingId;

  @override
  State<_CommercialLiveLinkScreen> createState() =>
      _CommercialLiveLinkScreenState();
}

class _CommercialLiveLinkScreenState
    extends State<_CommercialLiveLinkScreen> {
  String? _error;

  @override
  void initState() {
    super.initState();
    _resolve();
  }

  Future<void> _resolve() async {
    const gateway = AuthenticatedCommercialLiveGateway();
    try {
      final grant = await gateway.prepareHost(widget.listingId);
      if (!mounted) return;
      Navigator.of(context).pushReplacement(MaterialPageRoute<void>(
        builder: (_) => LiveReadinessScreen(
          listingId: widget.listingId,
          title: grant.title,
          gateway: gateway,
        ),
      ));
    } on CommercialLiveGatewayError catch (e) {
      // 401/403 means this account is not the host. The viewer screen still
      // performs its own paid-entitlement admission and stays receive-only.
      if (e.status == 401 || e.status == 403) {
        if (!mounted) return;
        Navigator.of(context).pushReplacement(MaterialPageRoute<void>(
          builder: (_) => CommercialLiveViewerScreen(
            listingId: widget.listingId,
            entitlementId: '',
            title: 'Live event',
            gateway: gateway,
          ),
        ));
        return;
      }
      if (mounted) setState(() => _error = e.message);
    } catch (e) {
      if (mounted) setState(() => _error = 'This live event could not be opened.');
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        body: Center(
          child: _error == null
              ? const CircularProgressIndicator()
              : Padding(
                  padding: const EdgeInsets.all(24),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(_error!, textAlign: TextAlign.center),
                      const SizedBox(height: 16),
                      FilledButton(onPressed: _resolve, child: const Text('Try again')),
                    ],
                  ),
                ),
        ),
      );
}
