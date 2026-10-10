import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/brand.dart';
import 'package:hf_app/core/router/deep_links.dart';

String site(String path) => 'https://${Brand.domain}$path';
String www(String path) => 'https://${Brand.wwwHost}$path';
String app(String path) => '${Brand.scheme}://$path';

void expectRoute(String input, String location) {
  final t = DeepLinks.resolve(input);
  expect(t, isA<OpenRoute>(), reason: input);
  expect((t as OpenRoute).location, location, reason: input);
}

void expectTab(String input, String path) {
  final t = DeepLinks.resolve(input);
  expect(t, isA<OpenCustomTab>(), reason: input);
  expect((t as OpenCustomTab).uri.host, Brand.domain);
  expect(t.uri.path, path);
}

void main() {
  group('path table (spec 3.3)', () {
    test('/ -> Home', () {
      expectRoute(site('/'), '/');
      expectRoute(site(''), '/');
    });
    test('/marketplace and /talk -> Explore, filters kept', () {
      expectRoute(site('/marketplace'), '/explore');
      expectRoute(site('/talk'), '/explore');
      expectRoute(site('/talk?lane=women&lang=hi&max=50&online=1&topics=career,love'),
          '/explore?lane=women&topics=career%2Clove&lang=hi&max=50&online=1');
    });
    test('an unknown lane or unknown query key is dropped', () {
      expectRoute(site('/marketplace?lane=nope&x=1'), '/explore');
    });
    test('/women-only -> Explore lane=women', () => expectRoute(site('/women-only'), '/explore?lane=women'));
    test('/lgbtq -> Explore lane=lgbtq', () => expectRoute(site('/lgbtq'), '/explore?lane=lgbtq'));
    test('/h/<slug> -> host profile', () {
      expectRoute(site('/h/asha-k'), '/h/asha-k');
      expectRoute(www('/h/asha-k'), '/h/asha-k');
    });
    test('/people/<slug> -> Explore', () => expectRoute(site('/people/asha'), '/explore'));
    test('/wallet and /dashboard/wallet -> Wallet, query kept', () {
      expectRoute(site('/wallet'), '/wallet');
      expectRoute(site('/dashboard/wallet'), '/wallet');
      expectRoute(site('/wallet?topup=ok'), '/wallet?topup=ok');
    });
    test('/review/<token> -> token review', () => expectRoute(site('/review/abc123'), '/review/abc123'));
    test('/hosts/dashboard -> Host tab', () => expectRoute(site('/hosts/dashboard'), '/host'));
    test('/hosts/onboarding, /hosts/join, /hosts/kyc -> host onboarding', () {
      expectRoute(site('/hosts/onboarding'), '/host/onboarding');
      expectRoute(site('/hosts/onboarding?step=photo'), '/host/onboarding?step=photo');
      expectRoute(site('/hosts/join'), '/host/onboarding');
      expectRoute(site('/hosts/kyc'), '/host/onboarding');
    });
    test('DigiLocker returns', () {
      for (final input in [
        app('hosts/onboarding?step=aadhaar&dl=return'),
        site('/hosts/kyc/return?app=1'),
      ]) {
        final t = DeepLinks.resolve(input);
        expect(t, isA<DigiLockerReturn>(), reason: input);
        expect((t as DigiLockerReturn).location, '/host/onboarding?step=aadhaar&dl=return');
      }
    });
    test('/verify/lane -> lanes', () {
      expectRoute(site('/verify/lane?lane=women'), '/lanes?lane=women');
      expectRoute(site('/verify/lane'), '/lanes');
      expectRoute(site('/verify/lane?lane=other'), '/lanes');
    });
    test('/account/close -> delete account', () => expectRoute(site('/account/close'), '/me/delete'));
    test('/sign-in and /sign-up -> sign-in', () {
      expectRoute(site('/sign-in'), '/sign-in');
      expectRoute(site('/sign-up'), '/sign-in');
    });
    test('policy and content pages open in a Custom Tab', () {
      expectTab(site('/terms'), '/terms');
      expectTab(site('/privacy'), '/privacy');
      expectTab(site('/help'), '/help');
      expectTab(site('/hosts/rules'), '/hosts/rules');
      expectTab(site('/hosts/rates'), '/hosts/rates');
      expectTab(site('/shop'), '/shop');
      expectTab(site('/admin/hosts'), '/admin/hosts');
    });
    test('the custom-tab page is always on the brand host', () {
      final t = DeepLinks.resolve(www('/terms')) as OpenCustomTab;
      expect(t.uri.host, Brand.domain);
      expect(t.uri.scheme, 'https');
    });
    test('never opened: /api, /.well-known, /_astro', () {
      for (final p in ['/api/config', '/.well-known/assetlinks.json', '/_astro/x.js']) {
        expect(DeepLinks.resolve(site(p)), isA<IgnoreLink>(), reason: p);
      }
    });
  });

  group('inputs', () {
    test('custom scheme', () {
      expectRoute(app('h/asha-k'), '/h/asha-k');
      expectRoute(app('wallet'), '/wallet');
    });
    test('bare app path (push data.path)', () {
      expectRoute('/h/asha-k', '/h/asha-k');
      expectRoute('/review/tok', '/review/tok');
    });
    test('foreign hosts and schemes are ignored', () {
      expect(DeepLinks.resolve('https://example.org/h/x'), isA<IgnoreLink>());
      expect(DeepLinks.resolve('http://${Brand.domain}/h/x'), isA<IgnoreLink>());
      expect(DeepLinks.resolve('mailto:a@b.c'), isA<IgnoreLink>());
      expect(DeepLinks.resolve('other://h/x'), isA<IgnoreLink>());
    });
    test('protocol-relative and empty are ignored', () {
      expect(DeepLinks.resolve('//evil.example/h/x'), isA<IgnoreLink>());
      expect(DeepLinks.resolve(''), isA<IgnoreLink>());
      expect(DeepLinks.resolve('   '), isA<IgnoreLink>());
    });
    test('host match is case-insensitive', () {
      expectRoute('https://${Brand.domain.toUpperCase()}/h/x', '/h/x');
    });
  });

  group('telemetryPath', () {
    test('ids, slugs and tokens are templated; the query is dropped', () {
      expect(DeepLinks.telemetryPath(site('/h/asha-k?src=wa')), '/h/:id');
      expect(DeepLinks.telemetryPath(site('/review/secret')), '/review/:id');
      expect(DeepLinks.telemetryPath('/review/call/abc'), '/review/call/:id');
      expect(DeepLinks.telemetryPath(site('/wallet?topup=ok')), '/wallet');
      expect(DeepLinks.telemetryPath(site('/')), '/');
    });
    test('never contains the slug', () {
      expect(DeepLinks.telemetryPath(site('/h/very-private-slug')), isNot(contains('very-private-slug')));
    });
  });
}
