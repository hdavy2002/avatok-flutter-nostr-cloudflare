import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:hf_app/core/brand.dart';
import 'package:hf_app/data/api_client.dart';
import 'package:hf_app/data/api_exception.dart';
import 'package:hf_app/data/models/me.dart';
import 'package:hf_app/data/repos/settings_repo.dart';
import 'package:hf_app/demo/screens/me.dart';
import 'package:hf_app/demo/screens/settings_real.dart';
import 'package:hf_app/ui/strings/help_strings.dart';

typedef Handler = Object? Function(String method, String path, Object? body);

class FakeApiClient extends ApiClient {
  FakeApiClient(this.handler) : super(origin: 'https://api.test');

  Handler handler;
  final List<String> calls = [];
  final List<Object?> bodies = [];
  final List<Map<String, String>?> sentHeaders = [];

  @override
  Future<Object?> request(String method, String path,
      {Map<String, Object?>? query, Object? body, bool auth = true, Map<String, String>? headers}) async {
    calls.add('$method $path');
    bodies.add(body);
    sentHeaders.add(headers);
    final out = handler(method, path, body);
    if (out is ApiException) throw out;
    return out;
  }
}

Map<String, Object?> _prefs({bool call = true, bool appt = true, bool reels = true}) =>
    {'ok': true, 'notifyWhatsapp': call, 'apptReminders': appt, 'reelAlerts': reels};

Map<String, Object?> _close({
  String decision = 'delete',
  double withdrawable = 0,
  double refundable = 0,
  double forfeit = 0,
  Map<String, Object?>? exit,
  Map<String, Object?>? payout,
  Map<String, Object?>? deletion,
}) =>
    {
      'gateEnabled': true,
      'decision': decision,
      'paidBalance': refundable,
      'withdrawable': withdrawable,
      'held': 0,
      'refundable': refundable,
      'manualRefund': 0,
      'forfeitRupees': forfeit,
      'bankOk': false,
      'exit': exit,
      'payout': payout,
      'refund': null,
      'deletion': deletion,
    };

const _me = Me(uid: 'u1', name: 'Asha', email: 'asha@example.com', phoneMasked: '******3210');

Future<void> _pump(WidgetTester tester, Widget home) async {
  tester.view.physicalSize = const Size(900, 2800);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final router = GoRouter(
    initialLocation: '/start',
    routes: [
      GoRoute(path: '/start', builder: (_, __) => home),
      GoRoute(path: '/reels', builder: (_, __) => const Scaffold(body: Text('REELS PAGE'))),
      GoRoute(path: '/help', builder: (_, __) => const Scaffold(body: Text('HELP PAGE'))),
    ],
  );
  await tester.pumpWidget(MaterialApp.router(routerConfig: router));
  await tester.pump();
  await tester.pump();
}

void main() {
  tearDown(() {
    ExternalLinks.launcher = (u) async => false;
    AppVersionInfo.loader = () async => const AppVersion('', '');
  });

  group('help strings', () {
    test('seven answers, no gateway name, rulebook facts present', () {
      expect(HelpStrings.faq.length, 7);
      final all = HelpStrings.faq.map((f) => '${f.$1} ${f.$2}').join(' ').toLowerCase();
      expect(all, contains('1 hour'));
      expect(all, contains('back to your wallet'));
      expect(all, contains('₹20'));
      expect(all, isNot(contains('180 days')));
      expect(all, isNot(contains('original payment')));
      expect(all, contains('notify me'));
      expect(all, isNot(contains('cashfree')));
      expect(all, isNot(contains('razorpay')));
    });
  });

  group('Settings', () {
    testWidgets('loads the real switches and shows real version', (tester) async {
      AppVersionInfo.loader = () async => const AppVersion('2.0.0', '2123');
      final api = FakeApiClient((m, p, b) => p == '/api/hf/me/prefs' ? _prefs(reels: false) : {});
      await _pump(tester, RealSettingsScreen(repo: SettingsRepo(api), me: _me));
      expect(find.text('Asha'), findsOneWidget);
      expect(find.text('asha@example.com'), findsOneWidget);
      expect(find.text('******3210'), findsOneWidget);
      expect(find.text('2.0.0 (build 2123)'), findsOneWidget);
      expect(tester.widget<SwitchListTile>(find.byKey(const Key('pref-reelAlerts'))).value, isFalse);
      expect(tester.widget<SwitchListTile>(find.byKey(const Key('pref-notifyWhatsapp'))).value, isTrue);
      expect(find.textContaining(Brand.supportEmail), findsWidgets); // email / WhatsApp change notes
    });

    testWidgets('a switch flips at once and is saved with PATCH', (tester) async {
      final api = FakeApiClient((m, p, b) => m == 'PATCH' ? _prefs(appt: false) : _prefs());
      await _pump(tester, RealSettingsScreen(repo: SettingsRepo(api), me: _me));
      await tester.tap(find.byKey(const Key('pref-apptReminders')));
      await tester.pump();
      expect(tester.widget<SwitchListTile>(find.byKey(const Key('pref-apptReminders'))).value, isFalse);
      await tester.pump();
      expect(api.calls, contains('PATCH /api/hf/me/prefs'));
      expect(api.bodies.last, {'apptReminders': false});
      expect(tester.widget<SwitchListTile>(find.byKey(const Key('pref-apptReminders'))).value, isFalse);
    });

    testWidgets('a failed save puts the switch back and says why', (tester) async {
      final api = FakeApiClient((m, p, b) => m == 'PATCH'
          ? const ApiException(kind: ApiFailure.http, status: 500, code: 'http_500', message: 'Could not save.')
          : _prefs());
      await _pump(tester, RealSettingsScreen(repo: SettingsRepo(api), me: _me));
      await tester.tap(find.byKey(const Key('pref-notifyWhatsapp')));
      await tester.pump();
      await tester.pump();
      expect(tester.widget<SwitchListTile>(find.byKey(const Key('pref-notifyWhatsapp'))).value, isTrue);
      expect(find.text('Could not save.'), findsOneWidget);
    });

    testWidgets('edit name sends PATCH /api/hf/me and shows the stored name', (tester) async {
      final api = FakeApiClient((m, p, b) => m == 'PATCH' && p == '/api/hf/me' ? {'ok': true, 'displayName': 'Asha Rao'} : _prefs());
      await _pump(tester, RealSettingsScreen(repo: SettingsRepo(api), me: _me));
      await tester.tap(find.byKey(const Key('settings-name')));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'Asha Rao');
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      expect(api.calls, contains('PATCH /api/hf/me'));
      expect(api.bodies.last, {'displayName': 'Asha Rao'});
      expect(find.text('Asha Rao'), findsOneWidget);
    });

    testWidgets('name refused by the server keeps the old name and shows the message', (tester) async {
      final api = FakeApiClient((m, p, b) => m == 'PATCH' && p == '/api/hf/me'
          ? const ApiException(kind: ApiFailure.http, status: 400, code: 'invalid_name', message: 'Names cannot have numbers.')
          : _prefs());
      await _pump(tester, RealSettingsScreen(repo: SettingsRepo(api), me: _me));
      await tester.tap(find.byKey(const Key('settings-name')));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'Asha 2');
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      expect(find.text('Names cannot have numbers.'), findsOneWidget);
      expect(find.text('Asha'), findsOneWidget);
    });

    testWidgets('Terms and Privacy open the website pages of the brand domain', (tester) async {
      final opened = <Uri>[];
      ExternalLinks.launcher = (u) async {
        opened.add(u);
        return true;
      };
      final api = FakeApiClient((m, p, b) => _prefs());
      await _pump(tester, RealSettingsScreen(repo: SettingsRepo(api), me: _me));
      await tester.scrollUntilVisible(find.text('Terms of use'), 200, scrollable: find.byType(Scrollable).first);
      await tester.tap(find.text('Terms of use'));
      await tester.tap(find.text('Privacy policy'));
      await tester.pump();
      expect(opened.map((u) => u.toString()), [Brand.url('/terms'), Brand.url('/privacy')]);
    });

    testWidgets('SIGN OUT runs the sign-out and goes to the reels', (tester) async {
      var out = 0;
      final api = FakeApiClient((m, p, b) => _prefs());
      await _pump(tester, RealSettingsScreen(repo: SettingsRepo(api), me: _me, signOut: () async => out++));
      await tester.scrollUntilVisible(find.text('SIGN OUT'), 200, scrollable: find.byType(Scrollable).first);
      await tester.tap(find.text('SIGN OUT'));
      await tester.pumpAndSettle();
      expect(out, 1);
      expect(find.text('REELS PAGE'), findsOneWidget);
    });
  });

  group('Delete account', () {
    testWidgets('no money: final confirm, then POST /api/account/delete, sign out', (tester) async {
      var out = 0;
      final api = FakeApiClient((m, p, b) {
        if (p == '/api/hf/account/exit') return _close();
        if (p == '/api/account/delete') return {'scheduled': true, 'grace_ends_at': 1800000000000};
        return {};
      });
      await _pump(tester, DeleteAccountScreen(repo: SettingsRepo(api), signOut: () async => out++));
      await tester.tap(find.text('DELETE MY ACCOUNT'));
      await tester.pumpAndSettle();
      expect(find.text('Delete your account?'), findsOneWidget);
      // Backing out deletes nothing.
      await tester.tap(find.text('Keep my account'));
      await tester.pumpAndSettle();
      expect(api.calls, isNot(contains('POST /api/account/delete')));
      await tester.tap(find.text('DELETE MY ACCOUNT'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Yes, delete'));
      await tester.pumpAndSettle();
      expect(api.calls, contains('POST /api/account/delete'));
      expect(out, 1);
      expect(find.text('REELS PAGE'), findsOneWidget);
    });

    testWidgets('money first: explains payout and refund, needs the give-up tick, sends forfeit + Idempotency-Key', (tester) async {
      final api = FakeApiClient((m, p, b) {
        if (m == 'GET' && p == '/api/hf/account/exit') return _close(decision: 'exit', withdrawable: 800, refundable: 250, forfeit: 800);
        if (m == 'POST' && p == '/api/hf/account/exit') return {'ok': true, 'status': 'waiting_payouts'};
        return {};
      });
      await _pump(tester, DeleteAccountScreen(repo: SettingsRepo(api)));
      expect(find.textContaining('₹800'), findsWidgets);
      expect(find.textContaining('never refunded to your card'), findsOneWidget);
      // Disabled until the tick.
      await tester.tap(find.text('START CLOSING MY ACCOUNT'));
      await tester.pumpAndSettle();
      expect(find.text('Close your account?'), findsNothing);
      await tester.tap(find.byKey(const Key('give-up-money')));
      await tester.pump();
      await tester.tap(find.text('START CLOSING MY ACCOUNT'));
      await tester.pumpAndSettle();
      expect(find.text('Close your account?'), findsOneWidget);
      await tester.tap(find.text('Yes, start'));
      await tester.pumpAndSettle();
      final i = api.calls.indexOf('POST /api/hf/account/exit');
      expect(i, greaterThanOrEqualTo(0));
      expect(api.bodies[i], {'forfeit': true});
      expect(api.sentHeaders[i]!['Idempotency-Key'], isNotEmpty);
      expect(api.calls, isNot(contains('POST /api/account/delete')));
    });

    testWidgets('a closure in progress shows server state and can be stopped', (tester) async {
      var cancelled = false;
      final api = FakeApiClient((m, p, b) {
        if (m == 'DELETE' && p == '/api/hf/account/exit') {
          cancelled = true;
          return {'ok': true};
        }
        if (cancelled) return _close();
        return _close(
          decision: 'exit',
          exit: {'status': 'waiting_payouts'},
          payout: {'amount': 800, 'status': 'requested'},
        );
      });
      await _pump(tester, DeleteAccountScreen(repo: SettingsRepo(api)));
      expect(find.text('Closing your account'), findsOneWidget);
      expect(find.textContaining('Waiting for approval'), findsOneWidget);
      await tester.tap(find.text('STOP CLOSING MY ACCOUNT'));
      await tester.pumpAndSettle();
      expect(api.calls, contains('DELETE /api/hf/account/exit'));
      expect(find.text('DELETE MY ACCOUNT'), findsOneWidget);
    });

    testWidgets('a scheduled deletion shows the date and can be cancelled', (tester) async {
      var cancelled = false;
      final api = FakeApiClient((m, p, b) {
        if (p == '/api/account/delete/cancel') {
          cancelled = true;
          return {'cancelled': true};
        }
        if (cancelled) return _close();
        return _close(deletion: {'status': 'pending', 'scheduledAt': DateTime(2026, 11, 20).millisecondsSinceEpoch});
      });
      await _pump(tester, DeleteAccountScreen(repo: SettingsRepo(api)));
      expect(find.textContaining('20 Nov 2026'), findsOneWidget);
      await tester.tap(find.text('KEEP MY ACCOUNT'));
      await tester.pumpAndSettle();
      expect(api.calls, contains('POST /api/account/delete/cancel'));
      expect(find.text('DELETE MY ACCOUNT'), findsOneWidget);
    });
  });

  group('Help', () {
    testWidgets('shows the five questions and the email opens the mail app', (tester) async {
      final opened = <Uri>[];
      ExternalLinks.launcher = (u) async {
        opened.add(u);
        return true;
      };
      await _pump(tester, const HelpScreen());
      for (final f in HelpStrings.faq) {
        expect(find.text(f.$1), findsOneWidget);
      }
      await tester.tap(find.byKey(const Key('help-email')));
      await tester.pump();
      expect(opened.single.scheme, 'mailto');
      expect(opened.single.path, Brand.supportEmail);
    });
  });
}
