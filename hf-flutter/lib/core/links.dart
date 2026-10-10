import 'package:flutter/foundation.dart';
import 'package:url_launcher/url_launcher.dart';

import 'brand.dart';
import 'env.dart';

/// Opening things outside the app. One place, so tests can replace it ([LinkOpener.instance]).
class LinkOpener {
  const LinkOpener();

  /// Replaced in tests with a recorder.
  static LinkOpener instance = const LinkOpener();

  /// A site page in a Custom Tab (never an external intent: that bounces back into this app through
  /// the App Link). Returns false when nothing could open it.
  Future<bool> customTab(Uri uri) async {
    try {
      return await launchUrl(uri, mode: LaunchMode.inAppBrowserView);
    } catch (e) {
      debugPrint('customTab failed: $e');
      return false;
    }
  }

  /// A page of the site by path: `openSite('/terms')`.
  Future<bool> site(String path) => customTab(Uri.parse(Brand.url(path)));

  /// A phone number in the dialer (crisis lines): the person taps Call themselves.
  Future<bool> tel(String number) async {
    try {
      return await launchUrl(Uri(scheme: 'tel', path: number));
    } catch (e) {
      debugPrint('tel failed: $e');
      return false;
    }
  }

  /// This app's page in the Play Store (the update button). Falls back to the web page.
  Future<bool> playStore() async {
    try {
      if (await launchUrl(Uri.parse(Env.playMarketUri), mode: LaunchMode.externalApplication)) return true;
    } catch (_) {
      // fall through to the web page
    }
    try {
      return await launchUrl(
        Uri.https('play.google.com', '/store/apps/details', {'id': Brand.hfPlayPackageId}),
        mode: LaunchMode.externalApplication,
      );
    } catch (e) {
      debugPrint('playStore failed: $e');
      return false;
    }
  }
}
