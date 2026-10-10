import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/brand.dart';
import 'package:hf_app/core/links.dart';
import 'package:hf_app/core/router/app_router.dart';
import 'package:hf_app/core/router/deep_link_handler.dart';

import '../support/app_harness.dart';

/// Records Custom Tab opens instead of launching anything.
class _RecordingOpener extends LinkOpener {
  _RecordingOpener();
  final List<Uri> opened = <Uri>[];

  @override
  Future<bool> customTab(Uri uri) async {
    opened.add(uri);
    return true;
  }
}

String where(ProviderContainer container) => container.read(appRouterProvider).routeInformationProvider.value.uri.toString();

void main() {
  late LinkOpener saved;
  setUp(() => saved = LinkOpener.instance);
  tearDown(() => LinkOpener.instance = saved);

  // Home with no sign-in is the harness default, so no screen here needs a stub.
  testWidgets('warm: a link while the app runs goes straight to the route', (tester) async {
    final c = await pumpApp(tester);
    c.read(bootDoneProvider.notifier).markDone();

    await c.read(deepLinkHandlerProvider).handle('https://${Brand.domain}/sign-up', source: 'link', launch: 'warm');
    await tester.pump(const Duration(milliseconds: 100));

    expect(where(c), startsWith('/sign-in'));
  });

  testWidgets('a route that needs sign-in goes to /sign-in?next=<route> and remembers where to continue',
      (tester) async {
    final c = await pumpApp(tester);
    c.read(bootDoneProvider.notifier).markDone();

    await c.read(deepLinkHandlerProvider).handle('/wallet', source: 'push', launch: 'warm');
    await tester.pump(const Duration(milliseconds: 100));

    final uri = Uri.parse(where(c));
    expect(uri.path, '/sign-in');
    expect(uri.queryParameters['next'], '/wallet');
  });

  testWidgets('cold: a link before the splash finished waits, then opens once', (tester) async {
    final c = await pumpApp(tester);
    final handler = c.read(deepLinkHandlerProvider);

    await handler.handle('https://${Brand.domain}/wallet', source: 'link', launch: 'cold');
    expect(c.read(pendingLinkProvider), isNotNull, reason: 'held while booting');
    expect(where(c), '/');

    c.read(bootDoneProvider.notifier).markDone();
    expect(await handler.flushPending(), isTrue);
    await tester.pump(const Duration(milliseconds: 100));

    expect(c.read(pendingLinkProvider), isNull);
    expect(Uri.parse(where(c)).queryParameters['next'], '/wallet');
    expect(await handler.flushPending(), isFalse, reason: 'opened once only');
  });

  testWidgets('the custom scheme link is handled like the https one', (tester) async {
    final c = await pumpApp(tester);
    c.read(bootDoneProvider.notifier).markDone();

    await c.read(deepLinkHandlerProvider).handle('${Brand.scheme}://wallet', source: 'scheme', launch: 'warm');
    await tester.pump(const Duration(milliseconds: 100));

    expect(Uri.parse(where(c)).queryParameters['next'], '/wallet');
  });

  testWidgets('a page with no screen opens in a Custom Tab, never as an external intent', (tester) async {
    final opener = _RecordingOpener();
    LinkOpener.instance = opener;
    final c = await pumpApp(tester);
    c.read(bootDoneProvider.notifier).markDone();

    await c.read(deepLinkHandlerProvider).handle('/terms', source: 'push', launch: 'warm');

    expect(opener.opened.single.host, Brand.domain);
    expect(opener.opened.single.path, '/terms');
    expect(where(c), '/', reason: 'the screen stays where it was');
  });

  testWidgets('a link that is not ours does nothing', (tester) async {
    final opener = _RecordingOpener();
    LinkOpener.instance = opener;
    final c = await pumpApp(tester);
    c.read(bootDoneProvider.notifier).markDone();

    await c.read(deepLinkHandlerProvider).handle('https://example.org/wallet', source: 'link', launch: 'warm');
    await c.read(deepLinkHandlerProvider).handle('//evil.example/x', source: 'push', launch: 'warm');

    expect(opener.opened, isEmpty);
    expect(where(c), '/');
  });
}
