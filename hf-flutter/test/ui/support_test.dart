import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:hf_app/core/brand.dart';
import 'package:hf_app/core/deep_links.dart';
import 'package:hf_app/data/api_client.dart';
import 'package:hf_app/data/api_exception.dart';
import 'package:hf_app/data/merch_art_picker.dart';
import 'package:hf_app/data/models/support.dart';
import 'package:hf_app/data/repos/pages_repo.dart';
import 'package:hf_app/data/repos/policy_repo.dart';
import 'package:hf_app/data/repos/settings_repo.dart';
import 'package:hf_app/data/repos/support_repo.dart';
import 'package:hf_app/demo/screens/policy_page.dart';
import 'package:hf_app/demo/screens/policy_update.dart';
import 'package:hf_app/demo/screens/support_real.dart';
import 'package:hf_app/demo/screens/support_ticket.dart';
import 'package:hf_app/demo/support_kit.dart';
import 'package:hf_app/demo/theme.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

typedef Handler = Object? Function(String method, String path, Object? body);

class FakeApi extends ApiClient {
  FakeApi(this.handler) : super(origin: 'https://api.test');

  Handler handler;
  final List<String> calls = [];
  final List<Object?> bodies = [];
  final List<bool> auths = [];

  @override
  Future<Object?> request(String method, String path,
      {Map<String, Object?>? query, Object? body, bool auth = true, Map<String, String>? headers}) async {
    calls.add('$method $path');
    bodies.add(body);
    auths.add(auth);
    final out = handler(method, path, body);
    if (out is ApiException) throw out;
    return out;
  }
}

// ---------------------------------------------------------------------------------------------- fixtures

Map<String, Object?> _page({int version = 3, String title = 'Terms of use'}) => {
      'ok': true,
      'slug': 'terms',
      'title': title,
      'summary': 'This service connects you with your favourite influencer on a private phone call.',
      'related': [
        {'href': '/wallet-terms', 'label': 'Wallet terms'},
        {'href': '/privacy', 'label': 'Privacy policy'},
        {'href': '/terms', 'label': 'This very page'},
        {'href': 'https://example.org/x', 'label': 'Elsewhere'},
      ],
      'version': version,
      'updatedAt': '2026-10-28',
      'blocks': [
        {'t': 'h2', 'text': 'Business and contact details'},
        {
          't': 'p',
          'spans': [
            {'text': 'The public business name is Acme.'},
          ],
        },
        {
          't': 'p',
          'lang': 'en',
          'spans': [
            {'text': 'Email '},
            {'text': Brand.supportEmail, 'href': 'mailto:${Brand.supportEmail}', 'strong': true},
            {'text': '\n'},
            {'text': 'or read the '},
            {'text': 'refund policy', 'href': '/refunds', 'em': true},
            {'text': '.'},
          ],
        },
        {'t': 'h2', 'text': 'Billing and conduct'},
        {
          't': 'ul',
          'items': [
            [
              {'text': 'No abusive talk'},
            ],
            [
              {'text': 'No payment outside'},
            ],
          ],
        },
        {
          't': 'ol',
          'items': [
            [
              {'text': 'First step'},
            ],
          ],
        },
        {
          't': 'note',
          'spans': [
            {'text': 'Read the '},
            {'text': 'wallet terms', 'href': '/wallet-terms'},
            {'text': '.'},
          ],
        },
        {'t': 'mystery', 'text': 'a block type this app does not know'},
        {
          't': 'links',
          'items': [
            {'href': '/grievance', 'title': 'Grievance', 'text': 'How to complain'},
          ],
        },
      ],
    };

Map<String, Object?> _ticketRow(String no, String status, String label, {String subject = 'Withdraw not received', bool unread = false}) => {
      'number': no,
      'subject': subject,
      'category': 'withdraw',
      'status': status,
      'statusLabel': label,
      'preview': 'We looked into it',
      'updatedAt': DateTime.now().subtract(const Duration(hours: 2)).millisecondsSinceEpoch,
      'unread': unread,
    };

Map<String, Object?> _thread({String status = 'waiting', String label = 'We replied', bool canReopen = false, bool signature = true}) => {
      'ok': true,
      'ticket': {
        'number': 'HF-10234',
        'subject': 'Withdraw not received',
        'category': 'withdraw',
        'status': status,
        'statusLabel': label,
        'createdAt': DateTime.utc(2026, 10, 27, 13, 12).millisecondsSinceEpoch,
        'updatedAt': DateTime.utc(2026, 10, 28, 5, 35).millisecondsSinceEpoch,
        'canReopen': canReopen,
      },
      'messages': [
        {
          'id': 'm1',
          'author': 'customer',
          'authorName': 'Ravi',
          'text': 'I withdrew 450 rupees on Monday and have not received it.',
          'createdAt': DateTime.utc(2026, 10, 27, 13, 12).millisecondsSinceEpoch,
          'attachments': [
            {'id': 'att1', 'name': 'withdraw-screen.png', 'size': 1200, 'contentType': 'image/png'},
          ],
        },
        {'id': 'm2', 'author': 'system', 'authorName': '', 'text': 'Auto-reply sent', 'createdAt': DateTime.utc(2026, 10, 27, 13, 12).millisecondsSinceEpoch, 'attachments': []},
        {
          'id': 'm3',
          'author': 'support',
          'authorName': 'Hello Fraands Support',
          'text': 'The bank shows your money as sent. Banks can take up to 48 hours.',
          if (signature) 'signature': 'Davy · Support\n${Brand.supportEmail}',
          'createdAt': DateTime.utc(2026, 10, 28, 5, 35).millisecondsSinceEpoch,
          'attachments': [
            {'id': 'att2', 'name': 'receipt.pdf', 'size': 9000, 'contentType': 'application/pdf'},
          ],
        },
      ],
    };

Future<GoRouter> _pumpRouter(WidgetTester tester, Widget home, {String start = '/start'}) async {
  tester.view.physicalSize = const Size(900, 3200);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final router = GoRouter(
    initialLocation: start,
    routes: [
      GoRoute(path: '/start', builder: (_, __) => home),
      GoRoute(path: '/page/:slug', builder: (_, s) => Scaffold(body: Text('POLICY ${s.pathParameters['slug']}'))),
      GoRoute(path: '/support', builder: (_, __) => const Scaffold(body: Text('SUPPORT PAGE'))),
      GoRoute(path: '/support/:number', builder: (_, s) => Scaffold(body: Text('TICKET ${s.pathParameters['number']}'))),
      GoRoute(path: '/reels', builder: (_, __) => const Scaffold(body: Text('REELS PAGE'))),
    ],
  );
  await tester.pumpWidget(MaterialApp.router(routerConfig: router));
  await tester.pumpAndSettle();
  return router;
}

/// Taps a link inside rich text by calling its recogniser (a tap on the paragraph's middle would not hit the right span).
void _tapSpan(WidgetTester tester, String text) {
  for (final w in tester.widgetList<RichText>(find.byType(RichText))) {
    TapGestureRecognizer? hit;
    w.text.visitChildren((s) {
      if (s is TextSpan && s.text == text && s.recognizer is TapGestureRecognizer) {
        hit = s.recognizer! as TapGestureRecognizer;
        return false;
      }
      return true;
    });
    if (hit != null) {
      hit!.onTap!();
      return;
    }
  }
  fail('no link span "$text"');
}

bool _hasLinkSpan(WidgetTester tester, String text) {
  for (final w in tester.widgetList<RichText>(find.byType(RichText))) {
    var found = false;
    w.text.visitChildren((s) {
      if (s is TextSpan && s.text == text && s.recognizer != null) found = true;
      return true;
    });
    if (found) return true;
  }
  return false;
}

void main() {
  late List<Uri> launched;

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    launched = <Uri>[];
    ExternalLinks.launcher = (u) async {
      launched.add(u);
      return true;
    };
    AppVersionInfo.loader = () async => const AppVersion('2.0.0', '2123');
  });

  tearDown(() {
    ExternalLinks.launcher = (u) async => false;
    AppVersionInfo.loader = () async => const AppVersion('', '');
  });

  // -------------------------------------------------------------------------------------------- links and routes

  group('inAppRouteForHref', () {
    test('policy pages, support and help stay inside the app', () {
      expect(inAppRouteForHref('/terms'), '/page/terms');
      expect(inAppRouteForHref('/community-guidelines'), '/page/community-guidelines');
      expect(inAppRouteForHref('/refunds?x=1#top'), '/page/refunds');
      expect(inAppRouteForHref('/terms/'), '/page/terms');
      expect(inAppRouteForHref(Brand.url('/privacy')), '/page/privacy');
      expect(inAppRouteForHref('mailto:${Brand.supportEmail}'), '/support');
      expect(inAppRouteForHref('mailto:${Brand.grievanceEmail}'), '/support');
      expect(inAppRouteForHref('/contact'), '/support');
      expect(inAppRouteForHref('/report'), '/support?topic=report');
      expect(inAppRouteForHref('/help/wallet-and-payments/no-refunds'), '/help');
      expect(inAppRouteForHref('/faq'), '/help');
      expect(inAppRouteForHref('/wallet'), '/wallet');
      expect(inAppRouteForHref('/account/close'), '/settings');
      expect(inAppRouteForHref('/support/HF-10234'), '/support/HF-10234');
    });

    test('anything without an app screen is ignored, never sent to a browser', () {
      expect(inAppRouteForHref('https://example.org/x'), isNull);
      expect(inAppRouteForHref('tel:112'), isNull);
      expect(inAppRouteForHref('mailto:someone@example.org'), isNull);
      expect(inAppRouteForHref('//evil.example/terms'), isNull);
      expect(inAppRouteForHref('/hosts/rules'), isNull);
      expect(inAppRouteForHref('/emergency'), isNull);
      expect(inAppRouteForHref(''), isNull);
    });

    test('the policy re-accept item reads its page by slug', () {
      expect(const PolicyItem(policy: 'community', path: '/community-guidelines', version: 'v').slug, 'community-guidelines');
      expect(const PolicyItem(policy: 'terms', path: '/terms', version: 'v').slug, 'terms');
    });

    test('deep links: /support and /support/HF-n open Contact Support and the ticket; policy paths open the in-app page', () {
      expect(linkTargetFor(Uri.parse('https://${Brand.domain}/support'))?.location, '/support');
      expect(linkTargetFor(Uri.parse('${Brand.scheme}://support/HF-10234'))?.location, '/support/HF-10234');
      expect(linkTargetFor(Uri.parse('https://${Brand.domain}/support/hf-10234'))?.location, '/support/HF-10234');
      expect(linkTargetFor(Uri.parse('https://${Brand.domain}/support/10234')), isNull);
      expect(linkTargetFor(Uri.parse('https://${Brand.domain}/support/HF-1/../../admin')), isNull);
      expect(linkTargetFor(Uri.parse('https://${Brand.domain}/terms'))?.location, '/page/terms');
      expect(linkTargetForPath('/support/HF-10234')?.location, '/support/HF-10234');
      expect(linkTargetFor(Uri.parse('https://${Brand.domain}/support/HF-10234'))?.telemetryPath, '/support/:id');
    });
  });

  // -------------------------------------------------------------------------------------------- policy page

  group('PolicyPageScreen', () {
    testWidgets('renders every block of the fixture in the approved layout', (tester) async {
      final api = FakeApi((m, p, b) => _page());
      await _pumpRouter(tester, PolicyPageScreen(slug: 'terms', repo: PagesRepo(api)));
      expect(api.calls, ['GET /api/hf/pages/terms']);
      expect(api.auths.single, isFalse); // public: a signed-out person can read it
      expect(find.text('Terms of use'), findsOneWidget);
      expect(find.text('Last updated 28 Oct 2026'), findsOneWidget);
      expect(find.text('Version 3'), findsOneWidget);
      expect(find.byKey(const Key('page-summary')), findsOneWidget);
      expect(find.text('Business and contact details'), findsOneWidget);
      expect(find.text('Billing and conduct'), findsOneWidget);
      expect(find.textContaining('The public business name is Acme.'), findsOneWidget);
      expect(find.text('No abusive talk'), findsOneWidget);
      expect(find.text('No payment outside'), findsOneWidget);
      expect(find.text('First step'), findsOneWidget);
      expect(find.text('1.'), findsOneWidget);
      expect(find.text('Grievance'), findsOneWidget);
      expect(find.text('RELATED PAGES'), findsOneWidget);
      expect(find.text('Wallet terms'), findsOneWidget);
      expect(find.text('Privacy policy'), findsOneWidget);
      expect(find.text('This very page'), findsNothing); // a link to the page itself is not offered
      expect(find.text('Elsewhere'), findsNothing); // an outside site has no in-app screen
      expect(find.byKey(const Key('page-offline-note')), findsOneWidget);
      expect(find.text('Saved on your phone · reads offline'), findsOneWidget);
      expect(find.byKey(const Key('page-error')), findsNothing);
    });

    testWidgets('the line-break span is a new line and em/strong keep their text', (tester) async {
      final api = FakeApi((m, p, b) => _page());
      await _pumpRouter(tester, PolicyPageScreen(slug: 'terms', repo: PagesRepo(api)));
      final plain = tester.widgetList<RichText>(find.byType(RichText)).map((w) => w.text.toPlainText()).join('|');
      expect(plain, contains('Email ${Brand.supportEmail}\nor read the refund policy.'));
    });

    testWidgets('links go to in-app routes and never to the browser', (tester) async {
      final api = FakeApi((m, p, b) => _page());
      final router = await _pumpRouter(tester, PolicyPageScreen(slug: 'terms', repo: PagesRepo(api)));
      _tapSpan(tester, 'refund policy');
      await tester.pumpAndSettle();
      expect(find.text('POLICY refunds'), findsOneWidget);
      router.pop();
      await tester.pumpAndSettle();
      _tapSpan(tester, Brand.supportEmail);
      await tester.pumpAndSettle();
      expect(find.text('SUPPORT PAGE'), findsOneWidget);
      router.pop();
      await tester.pumpAndSettle();
      await tester.tap(find.text('Wallet terms'));
      await tester.pumpAndSettle();
      expect(find.text('POLICY wallet-terms'), findsOneWidget);
      expect(launched, isEmpty);
    });

    testWidgets('a link with no app screen is plain text, not a link', (tester) async {
      final api = FakeApi((m, p, b) {
        final j = _page();
        (j['blocks']! as List).add({
          't': 'p',
          'spans': [
            {'text': 'Call ', 'em': true},
            {'text': 'tel:112', 'href': 'tel:112'},
          ],
        });
        return j;
      });
      await _pumpRouter(tester, PolicyPageScreen(slug: 'terms', repo: PagesRepo(api)));
      expect(_hasLinkSpan(tester, 'tel:112'), isFalse);
      expect(_hasLinkSpan(tester, 'refund policy'), isTrue);
    });

    testWidgets('offline with a saved copy: shows the saved page at once, quietly, with no error card', (tester) async {
      SharedPreferences.setMockInitialValues({'hfpage1|terms': jsonEncode(_page(version: 2))});
      final api = FakeApi((m, p, b) => ApiException.offline());
      await _pumpRouter(tester, PolicyPageScreen(slug: 'terms', repo: PagesRepo(api)));
      expect(api.calls, ['GET /api/hf/pages/terms']);
      expect(find.text('Version 2'), findsOneWidget);
      expect(find.text('Business and contact details'), findsOneWidget);
      expect(find.byKey(const Key('page-error')), findsNothing);
      expect(find.byKey(const Key('page-stale')), findsOneWidget);
    });

    testWidgets('a newer version replaces the saved copy and is stored for next time', (tester) async {
      SharedPreferences.setMockInitialValues({'hfpage1|terms': jsonEncode(_page(version: 2))});
      final api = FakeApi((m, p, b) => _page(version: 3));
      await _pumpRouter(tester, PolicyPageScreen(slug: 'terms', repo: PagesRepo(api)));
      expect(find.text('Version 3'), findsOneWidget);
      expect(find.text('Version 2'), findsNothing);
      final stored = await PagesRepo(api).cached('terms');
      expect(stored?.version, 3);
      expect(stored?.blocks.length, greaterThan(3));
    });

    testWidgets('never loaded and offline: an error card with Try again, and it recovers', (tester) async {
      var online = false;
      final api = FakeApi((m, p, b) => online ? _page() : ApiException.offline());
      await _pumpRouter(tester, PolicyPageScreen(slug: 'terms', repo: PagesRepo(api)));
      expect(find.byKey(const Key('page-error')), findsOneWidget);
      expect(find.text('No internet. Check your connection.'), findsOneWidget);
      expect(find.text('Terms of use'), findsOneWidget); // the header still names the page
      online = true;
      await tester.tap(find.text('Try again'));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('page-error')), findsNothing);
      expect(find.text('Business and contact details'), findsOneWidget);
    });

    testWidgets('a page the server does not have shows the error card (not found)', (tester) async {
      final api = FakeApi((m, p, b) => const ApiException(kind: ApiFailure.http, status: 404, code: 'not_found'));
      await _pumpRouter(tester, PolicyPageScreen(slug: 'nope', repo: PagesRepo(api)));
      expect(find.byKey(const Key('page-error')), findsOneWidget);
      expect(find.text('Try again'), findsOneWidget);
    });
  });

  group('re-accept prompt', () {
    testWidgets('a policy opens inside the prompt (no browser) and Back returns to the prompt', (tester) async {
      tester.view.physicalSize = const Size(900, 3200);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final api = FakeApi((m, p, b) => _page());
      var agreed = 0;
      await tester.pumpWidget(MaterialApp(
        home: PolicyUpdateScreen(
          update: const PolicyUpdate(required: true, note: 'Rules changed', pending: [PolicyItem(policy: 'terms', path: '/terms', version: 'v1')]),
          onAgree: () => agreed++,
          pagesRepo: PagesRepo(api),
        ),
      ));
      await tester.pump();
      expect(find.byKey(const Key('policy-note')), findsOneWidget);
      await tester.tap(find.byKey(const Key('policy-link-terms')));
      await tester.pumpAndSettle();
      expect(find.text('Business and contact details'), findsOneWidget);
      expect(find.byKey(const Key('policy-agree')), findsNothing);
      expect(launched, isEmpty);
      await tester.tap(find.byIcon(Icons.arrow_back_rounded));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('policy-agree')), findsOneWidget);
      await tester.tap(find.byKey(const Key('policy-agree')));
      expect(agreed, 1);
    });
  });

  // -------------------------------------------------------------------------------------------- repo + models

  group('SupportRepo', () {
    test('parses the contract JSON: ticket list', () async {
      final api = FakeApi((m, p, b) => {
            'ok': true,
            'tickets': [
              _ticketRow('HF-10234', 'waiting', 'We replied', unread: true),
              _ticketRow('HF-10198', 'open', 'Open'),
              _ticketRow('HF-10102', 'solved', 'Solved'),
              _ticketRow('HF-10001', 'closed', 'Closed'),
              {'subject': 'no number, skipped'},
            ],
          });
      final list = await SupportRepo(api).tickets(status: 'all');
      expect(api.calls, ['GET /api/hf/support/tickets']);
      expect(list.map((t) => t.number), ['HF-10234', 'HF-10198', 'HF-10102', 'HF-10001']);
      expect(list.first.unread, isTrue);
      expect(list.first.label, 'We replied');
      expect(list.map((t) => t.tone), [SupportTone.replied, SupportTone.open, SupportTone.solved, SupportTone.closed]);
      expect(list.first.updatedAt, isNotNull);
      expect(list.first.category, 'withdraw');
    });

    test('parses the contract JSON: one ticket with its thread and attachments', () async {
      final api = FakeApi((m, p, b) => _thread(status: 'solved', label: 'Solved', canReopen: true));
      final th = await SupportRepo(api).ticket('HF-10234');
      expect(api.calls, ['GET /api/hf/support/tickets/HF-10234']);
      expect(th.ticket.number, 'HF-10234');
      expect(th.ticket.subject, 'Withdraw not received');
      expect(th.ticket.tone, SupportTone.solved);
      expect(th.canReopen, isTrue);
      expect(th.createdAt, DateTime.utc(2026, 10, 27, 13, 12).millisecondsSinceEpoch);
      expect(th.messages.map((m) => m.author), ['customer', 'system', 'support']);
      expect(th.messages.first.fromCustomer, isTrue);
      expect(th.messages[1].fromSystem, isTrue);
      expect(th.messages.first.attachments.single.isImage, isTrue);
      expect(th.messages.last.attachments.single.isPdf, isTrue);
      expect(th.messages.last.signature, contains(Brand.supportEmail));
      expect(th.hasSupportReply, isTrue);
    });

    test('create sends the contract body and returns the new number', () async {
      final api = FakeApi((m, p, b) => {
            'ok': true,
            'ticket': {'number': 'HF-10240', 'status': 'new', 'statusLabel': 'Open', 'subject': 'S'},
          });
      final t = await SupportRepo(api).create(
        category: 'withdraw',
        subject: '  Withdraw not received ',
        message: ' It did not arrive. ',
        attachmentIds: ['a1', 'a2'],
        meta: {'appVersion': '2.0.0', 'build': '2123', 'platform': 'android'},
      );
      expect(t.number, 'HF-10240');
      expect(api.calls, ['POST /api/hf/support/tickets']);
      expect(api.bodies.single, {
        'category': 'withdraw',
        'subject': 'Withdraw not received',
        'message': 'It did not arrive.',
        'attachmentIds': ['a1', 'a2'],
        'meta': {'appVersion': '2.0.0', 'build': '2123', 'platform': 'android'},
      });
    });

    test('create with no files and no meta leaves those keys out; a reply without a ticket in the answer is a parse error', () async {
      final api = FakeApi((m, p, b) => {'ok': true});
      await expectLater(SupportRepo(api).create(category: 'other', subject: 'Hi there', message: 'Hello'), throwsA(isA<ApiException>()));
      expect(api.bodies.single, {'category': 'other', 'subject': 'Hi there', 'message': 'Hello'});
    });

    test('reply, solve and reopen hit the contract paths', () async {
      final api = FakeApi((m, p, b) => {'ok': true});
      final repo = SupportRepo(api);
      await repo.reply('HF-10234', ' thanks ', attachmentIds: ['x']);
      await repo.solve('HF-10234');
      await repo.reopen('HF-10234');
      expect(api.calls, [
        'POST /api/hf/support/tickets/HF-10234/reply',
        'POST /api/hf/support/tickets/HF-10234/solve',
        'POST /api/hf/support/tickets/HF-10234/reopen',
      ]);
      expect(api.bodies.first, {'message': 'thanks', 'attachmentIds': ['x']});
    });

    test('upload sends the raw bytes with a percent-encoded x-file-name and reads {id,name,size}', () async {
      late http.Request seen;
      final mock = MockClient((req) async {
        seen = req;
        return http.Response(jsonEncode({'ok': true, 'id': 'att9', 'name': 'shot.png', 'size': 3}), 200, headers: {'content-type': 'application/json'});
      });
      final api = ApiClient(client: mock, origin: 'https://api.test', reporter: (m, e, err, ms) {});
      final up = await SupportRepo(api).upload(Uint8List.fromList([1, 2, 3]), contentType: 'image/png', fileName: 'स्क्रीन shot.png');
      expect(seen.url.toString(), 'https://api.test/api/hf/support/attachments');
      expect(seen.method, 'POST');
      expect(seen.headers['content-type'], 'image/png');
      expect(seen.headers['x-file-name'], Uri.encodeComponent('स्क्रीन shot.png'));
      expect(seen.headers['x-file-name']!.codeUnits.every((c) => c < 128), isTrue); // a header cannot carry non-ASCII
      expect(seen.bodyBytes, [1, 2, 3]);
      expect(up.id, 'att9');
      expect(up.size, 3);
    });

    test('times: seconds, milliseconds and D1 text (no zone = UTC) all read', () {
      expect(supportMs(1790000000), 1790000000000);
      expect(supportMs(1790000000000), 1790000000000);
      expect(supportMs('2026-10-28 11:05:00'), DateTime.utc(2026, 10, 28, 11, 5).millisecondsSinceEpoch);
      expect(supportMs('2026-10-28T11:05:00Z'), DateTime.utc(2026, 10, 28, 11, 5).millisecondsSinceEpoch);
      expect(supportMs('2026-10-28T16:35:00+05:30'), DateTime.utc(2026, 10, 28, 11, 5).millisecondsSinceEpoch);
      expect(supportMs(null), isNull);
      expect(supportMs('soon'), isNull);
    });

    test('status labels follow the contract: new/open/on_hold = Open, waiting = We replied', () {
      expect(supportStatusLabel('new'), 'Open');
      expect(supportStatusLabel('on_hold'), 'Open');
      expect(supportStatusLabel('waiting'), 'We replied');
      expect(supportStatusLabel('solved'), 'Solved');
      expect(supportStatusLabel('closed'), 'Closed');
      expect(supportToneOf('waiting'), SupportTone.replied);
      expect(supportToneOf('new'), SupportTone.open);
    });

    test('topics are the contract categories, in order', () {
      expect(kSupportTopics.map((t) => t.slug), ['calls', 'wallet', 'withdraw', 'bookings', 'influencer', 'app', 'report', 'other']);
      expect(supportTopicLabel('withdraw'), 'Withdraw to UPI');
      expect(supportTopicLabel('wallet'), 'Wallet & top-ups');
    });

    test('acknowledgement line adds the hours line only outside 10 am to 7 pm IST, Monday to Saturday', () {
      // Wed 28 Oct 2026, 11:00 IST = 05:30 UTC
      expect(supAckText('HF-10234', now: DateTime.utc(2026, 10, 28, 5, 30)), 'Your ticket HF-10234 is open. Someone from ${Brand.name} will respond back soon.');
      // Wed 28 Oct 2026, 21:00 IST = 15:30 UTC
      expect(supAckText('HF-10234', now: DateTime.utc(2026, 10, 28, 15, 30)), contains('Our team works 10 am–7 pm IST, Monday to Saturday.'));
      // Sun 1 Nov 2026, 12:00 IST
      expect(supOutsideHours(now: DateTime.utc(2026, 11, 1, 6, 30)), isTrue);
    });
  });

  // -------------------------------------------------------------------------------------------- Contact Support

  group('SupportScreen', () {
    Object? handler(String m, String p, Object? b, {List<Map<String, Object?>>? rows}) {
      if (m == 'GET' && p == '/api/hf/support/tickets') {
        return {
          'ok': true,
          'tickets': rows ??
              [
                _ticketRow('HF-10234', 'waiting', 'We replied', unread: true),
                _ticketRow('HF-10198', 'open', 'Open', subject: 'Booking time changed by influencer'),
                _ticketRow('HF-10102', 'solved', 'Solved', subject: 'Top-up not showing in wallet'),
              ],
        };
      }
      if (m == 'POST' && p == '/api/hf/support/tickets') {
        return {
          'ok': true,
          'ticket': {'number': 'HF-10240', 'status': 'new', 'statusLabel': 'Open', 'subject': 'x'},
        };
      }
      return {'ok': true};
    }

    testWidgets('shows the eight topic chips, the form and My tickets with the status colours', (tester) async {
      final api = FakeApi(handler);
      await _pumpRouter(tester, SupportScreen(repo: SupportRepo(api)));
      expect(find.text('Contact Support'), findsOneWidget);
      for (final topic in kSupportTopics) {
        expect(find.byKey(Key('topic-${topic.slug}')), findsOneWidget);
        expect(find.text(topic.label), findsOneWidget);
      }
      expect(find.text('SEND TO SUPPORT'), findsOneWidget);
      expect(find.text('Add a screenshot'), findsOneWidget);
      expect(find.text('My tickets'), findsOneWidget);
      expect(find.text('Booking time changed by influencer'), findsOneWidget);
      expect(find.byKey(const Key('unread-HF-10234')), findsOneWidget);
      Color chipColor(String label) {
        final box = tester.widget<Container>(find.ancestor(of: find.text(label), matching: find.byType(Container)).first);
        return (box.decoration! as BoxDecoration).color!;
      }

      expect(chipColor('We replied'), SupStatusChip.colors(SupportTone.replied).$1);
      expect(chipColor('Open'), SupStatusChip.colors(SupportTone.open).$1);
      expect(chipColor('Solved'), SupStatusChip.colors(SupportTone.solved).$1);
      expect(SupStatusChip.colors(SupportTone.closed).$1, isNot(SupStatusChip.colors(SupportTone.open).$1));
    });

    testWidgets('picking a topic chip selects it, and it is the category that gets sent', (tester) async {
      final api = FakeApi(handler);
      await _pumpRouter(tester, SupportScreen(repo: SupportRepo(api)));
      // a chosen chip is filled with the solid plum, the others are cream
      bool selected(String slug) =>
          tester.widget<Material>(find.descendant(of: find.byKey(Key('topic-$slug')), matching: find.byType(Material)).first).color == C.maroon;
      expect(selected('other'), isTrue); // the default
      await tester.tap(find.byKey(const Key('topic-withdraw')));
      await tester.pump();
      expect(selected('withdraw'), isTrue);
      expect(selected('other'), isFalse);
      await tester.tap(find.byKey(const Key('topic-calls')));
      await tester.pump();
      expect(selected('calls'), isTrue);
      expect(selected('withdraw'), isFalse);
      await tester.tap(find.byKey(const Key('topic-withdraw')));
      await tester.pump();
      await tester.enterText(find.byKey(const Key('support-subject')), 'Withdraw not received');
      await tester.enterText(find.byKey(const Key('support-message')), 'I withdrew 450 rupees on Monday and it has not arrived.');
      await tester.pump();
      await tester.tap(find.byKey(const Key('support-send')));
      await tester.pumpAndSettle();
      final i = api.calls.indexOf('POST /api/hf/support/tickets');
      expect(i, greaterThanOrEqualTo(0));
      final body = api.bodies[i]! as Map;
      expect(body['category'], 'withdraw');
      expect(body['subject'], 'Withdraw not received');
      expect(body['message'], 'I withdrew 450 rupees on Monday and it has not arrived.');
      final meta = body['meta']! as Map;
      expect(meta['appVersion'], '2.0.0');
      expect(meta['build'], '2123');
      expect(meta['platform'], isNotEmpty);
      expect(body.containsKey('attachmentIds'), isFalse);
    });

    testWidgets('?topic= preselects a topic', (tester) async {
      final api = FakeApi(handler);
      await _pumpRouter(tester, SupportScreen(repo: SupportRepo(api), initialTopic: 'report'));
      await tester.enterText(find.byKey(const Key('support-subject')), 'Someone was rude');
      await tester.enterText(find.byKey(const Key('support-message')), 'They said things on the call.');
      await tester.pump();
      await tester.tap(find.byKey(const Key('support-send')));
      await tester.pumpAndSettle();
      final i = api.calls.indexOf('POST /api/hf/support/tickets');
      expect((api.bodies[i]! as Map)['category'], 'report');
    });

    testWidgets('Send stays off until there is a subject and a message; then a success state shows the ticket number', (tester) async {
      final api = FakeApi(handler);
      await _pumpRouter(tester, SupportScreen(repo: SupportRepo(api)));
      await tester.tap(find.byKey(const Key('support-send')));
      await tester.pump();
      expect(api.calls.where((c) => c.startsWith('POST')), isEmpty);
      await tester.enterText(find.byKey(const Key('support-subject')), 'Top-up missing');
      await tester.enterText(find.byKey(const Key('support-message')), 'I paid and nothing came.');
      await tester.pump();
      await tester.tap(find.byKey(const Key('support-send')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('support-sent-number')), findsOneWidget);
      expect(find.text('HF-10240'), findsOneWidget);
      expect(find.textContaining('Your ticket HF-10240 is open. Someone from ${Brand.name} will respond back soon.'), findsOneWidget);
      expect(find.text('SEND TO SUPPORT'), findsNothing);
      // My tickets was refreshed after sending
      expect(api.calls.where((c) => c == 'GET /api/hf/support/tickets').length, 2);
    });

    testWidgets('a failed send keeps the text and says why', (tester) async {
      final api = FakeApi((m, p, b) => m == 'POST'
          ? const ApiException(kind: ApiFailure.http, status: 429, code: 'rate_limited', message: 'You have sent too many tickets today.')
          : handler(m, p, b));
      await _pumpRouter(tester, SupportScreen(repo: SupportRepo(api)));
      await tester.enterText(find.byKey(const Key('support-subject')), 'Another one');
      await tester.enterText(find.byKey(const Key('support-message')), 'Please help me with this.');
      await tester.pump();
      await tester.tap(find.byKey(const Key('support-send')));
      await tester.pumpAndSettle();
      expect(find.text('You have sent too many tickets today.'), findsOneWidget);
      expect(find.text('Another one'), findsOneWidget);
      expect(find.byKey(const Key('support-sent-number')), findsNothing);
    });

    testWidgets('Add a screenshot uses the app picker and shows the picture as a removable chip', (tester) async {
      final api = FakeApi(handler);
      await _pumpRouter(
        tester,
        SupportScreen(repo: SupportRepo(api), pick: () async => PickedArt(bytes: Uint8List.fromList([1, 2, 3]), name: 'shot.png', mime: 'image/png')),
      );
      await tester.tap(find.byKey(const Key('support-attach')));
      await tester.pumpAndSettle();
      expect(find.text('shot.png'), findsOneWidget);
      await tester.tap(find.byTooltip('Remove'));
      await tester.pump();
      expect(find.text('shot.png'), findsNothing);
    });

    testWidgets('a picture the picker refuses shows its reason', (tester) async {
      final api = FakeApi(handler);
      await _pumpRouter(
        tester,
        SupportScreen(repo: SupportRepo(api), pick: () async => PickedArt(bytes: Uint8List(0), name: 'big.png', mime: 'image/png', problem: 'big.png: The picture must be 15 MB or smaller.')),
      );
      await tester.tap(find.byKey(const Key('support-attach')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('support-error')), findsOneWidget);
      expect(find.text('big.png'), findsNothing);
    });

    testWidgets('My tickets: empty and error states, and a ticket opens its page', (tester) async {
      final empty = FakeApi((m, p, b) => {'ok': true, 'tickets': []});
      await _pumpRouter(tester, SupportScreen(repo: SupportRepo(empty)));
      expect(find.byKey(const Key('tickets-empty')), findsOneWidget);

      var online = false;
      final api = FakeApi((m, p, b) => online ? handler(m, p, b) : ApiException.offline());
      await _pumpRouter(tester, SupportScreen(repo: SupportRepo(api)));
      expect(find.byKey(const Key('tickets-error')), findsOneWidget);
      online = true;
      await tester.tap(find.text('Try again'));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('tickets-error')), findsNothing);
      await tester.tap(find.byKey(const Key('ticket-HF-10198')));
      await tester.pumpAndSettle();
      expect(find.text('TICKET HF-10198'), findsOneWidget);
    });

    testWidgets('pull to refresh reloads My tickets', (tester) async {
      final api = FakeApi(handler);
      await _pumpRouter(tester, SupportScreen(repo: SupportRepo(api)));
      expect(api.calls.where((c) => c == 'GET /api/hf/support/tickets').length, 1);
      // Drive the RefreshIndicator's own callback: a fling over the form fields is flaky in widget tests.
      final indicator = tester.widget<RefreshIndicator>(find.ancestor(of: find.byKey(const Key('support-list')), matching: find.byType(RefreshIndicator)));
      await tester.runAsync(() => indicator.onRefresh());
      await tester.pumpAndSettle();
      expect(api.calls.where((c) => c == 'GET /api/hf/support/tickets').length, 2);
    });
  });

  // -------------------------------------------------------------------------------------------- one ticket

  group('SupportTicketScreen', () {
    testWidgets('shows the thread: customer on the right, support with its signature, system line, attachments', (tester) async {
      final api = FakeApi((m, p, b) => _thread());
      await _pumpRouter(tester, SupportTicketScreen(number: 'HF-10234', repo: SupportRepo(api)));
      expect(api.calls, ['GET /api/hf/support/tickets/HF-10234']);
      expect(find.text('HF-10234'), findsOneWidget);
      expect(find.text('Withdraw not received'), findsOneWidget);
      expect(find.text('We replied'), findsOneWidget);
      expect(find.textContaining('Ticket opened · '), findsOneWidget);
      expect(find.textContaining('Auto-reply sent'), findsOneWidget);
      final mine = tester.getTopLeft(find.textContaining('I withdrew 450 rupees')).dx;
      final theirs = tester.getTopLeft(find.textContaining('The bank shows your money')).dx;
      expect(mine, greaterThan(theirs)); // yours on the right, support on the left
      expect(find.byKey(const Key('support-signature')), findsOneWidget);
      expect(find.text('Hello Fraands Support'), findsOneWidget);
      expect(find.text('withdraw-screen.png'), findsOneWidget);
      expect(find.text('receipt.pdf'), findsOneWidget);
      expect(find.byKey(const Key('ticket-solve')), findsOneWidget);
      expect(find.byKey(const Key('ticket-reply')), findsOneWidget);
    });

    testWidgets('an attachment opens through the attachment opener, in the app', (tester) async {
      final api = FakeApi((m, p, b) => _thread());
      final opened = <String>[];
      await _pumpRouter(
        tester,
        SupportTicketScreen(number: 'HF-10234', repo: SupportRepo(api), openAttachment: (ctx, a) async => opened.add(a.id)),
      );
      await tester.tap(find.byKey(const Key('attachment-att1')));
      await tester.tap(find.byKey(const Key('attachment-att2')));
      expect(opened, ['att1', 'att2']);
      expect(launched, isEmpty);
    });

    testWidgets('the picture viewer loads the file through the API client and shows it (pinch to zoom)', (tester) async {
      var loads = 0;
      await tester.pumpWidget(MaterialApp(
        home: SupportImageViewer(
          title: 'withdraw-screen.png',
          bytes: () async {
            loads++;
            return <int>[0, 1, 2, 3];
          },
        ),
      ));
      await tester.pump();
      await tester.pump();
      expect(loads, 1);
      expect(find.text('withdraw-screen.png'), findsOneWidget);
      expect(find.byType(InteractiveViewer), findsOneWidget);
    });

    testWidgets('the picture viewer shows a reason and Try again when the file cannot be fetched', (tester) async {
      var ok = false;
      await tester.pumpWidget(MaterialApp(
        home: SupportImageViewer(title: 'x.png', bytes: () async => ok ? <int>[1] : throw ApiException.offline()),
      ));
      await tester.pump();
      await tester.pump();
      expect(find.text('No internet. Check your connection.'), findsOneWidget);
      ok = true;
      await tester.tap(find.text('Try again'));
      await tester.pump();
      await tester.pump();
      expect(find.byType(InteractiveViewer), findsOneWidget);
    });

    testWidgets('"This solved my issue" posts /solve and reloads', (tester) async {
      final api = FakeApi((m, p, b) => m == 'POST' ? {'ok': true} : _thread());
      await _pumpRouter(tester, SupportTicketScreen(number: 'HF-10234', repo: SupportRepo(api)));
      await tester.tap(find.byKey(const Key('ticket-solve')));
      await tester.pumpAndSettle();
      expect(api.calls, contains('POST /api/hf/support/tickets/HF-10234/solve'));
      expect(api.calls.where((c) => c.startsWith('GET')).length, 2);
    });

    testWidgets('reply sends the text, clears the box and reloads', (tester) async {
      final api = FakeApi((m, p, b) => m == 'POST' ? {'ok': true} : _thread());
      await _pumpRouter(tester, SupportTicketScreen(number: 'HF-10234', repo: SupportRepo(api)));
      await tester.tap(find.byKey(const Key('ticket-send')));
      await tester.pump();
      expect(api.calls.where((c) => c.startsWith('POST')), isEmpty); // nothing to send yet
      await tester.enterText(find.byKey(const Key('ticket-reply')), 'It has not reached me yet.');
      await tester.pump();
      await tester.tap(find.byKey(const Key('ticket-send')));
      await tester.pumpAndSettle();
      final i = api.calls.indexOf('POST /api/hf/support/tickets/HF-10234/reply');
      expect(i, greaterThanOrEqualTo(0));
      expect(api.bodies[i], {'message': 'It has not reached me yet.'});
      expect(tester.widget<TextField>(find.byKey(const Key('ticket-reply'))).controller!.text, isEmpty);
    });

    testWidgets('a solved ticket within 7 days offers Reopen; Solve is gone', (tester) async {
      final api = FakeApi((m, p, b) => m == 'POST' ? {'ok': true} : _thread(status: 'solved', label: 'Solved', canReopen: true));
      await _pumpRouter(tester, SupportTicketScreen(number: 'HF-10234', repo: SupportRepo(api)));
      expect(find.byKey(const Key('ticket-solve')), findsNothing);
      expect(find.byKey(const Key('ticket-reopen')), findsOneWidget);
      await tester.tap(find.byKey(const Key('ticket-reopen')));
      await tester.pumpAndSettle();
      expect(api.calls, contains('POST /api/hf/support/tickets/HF-10234/reopen'));
    });

    testWidgets('a solved ticket past 7 days has no Reopen', (tester) async {
      final api = FakeApi((m, p, b) => _thread(status: 'solved', label: 'Solved'));
      await _pumpRouter(tester, SupportTicketScreen(number: 'HF-10234', repo: SupportRepo(api)));
      expect(find.byKey(const Key('ticket-reopen')), findsNothing);
    });

    testWidgets('a closed ticket has no reply box and points to a new ticket', (tester) async {
      final api = FakeApi((m, p, b) => _thread(status: 'closed', label: 'Closed'));
      await _pumpRouter(tester, SupportTicketScreen(number: 'HF-10234', repo: SupportRepo(api)));
      expect(find.byKey(const Key('ticket-reply')), findsNothing);
      expect(find.text('This ticket is closed.'), findsOneWidget);
      await tester.tap(find.byKey(const Key('ticket-new')));
      await tester.pumpAndSettle();
      expect(find.text('SUPPORT PAGE'), findsOneWidget);
    });

    testWidgets('a ticket that cannot be loaded shows the error card with Try again', (tester) async {
      var online = false;
      final api = FakeApi((m, p, b) => online ? _thread() : ApiException.offline());
      await _pumpRouter(tester, SupportTicketScreen(number: 'HF-10234', repo: SupportRepo(api)));
      expect(find.byKey(const Key('ticket-error')), findsOneWidget);
      online = true;
      await tester.tap(find.text('Try again'));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('ticket-error')), findsNothing);
      expect(find.byKey(const Key('ticket-thread')), findsOneWidget);
    });
  });
}
