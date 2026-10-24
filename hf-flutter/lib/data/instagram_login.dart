import 'package:url_launcher/url_launcher.dart';

/// [HF-IG-LOGIN-1] Opens the Instagram login page in an in-app browser tab (Chrome Custom Tab). The answer does not come back here: the server
/// redirects to `<scheme>://channels?ig=...` and the deep-link handler (core/deep_links.dart) opens the Channels screen.
/// Kept behind an interface so screens can be tested without a browser.
abstract class InstagramLogin {
  /// True when the browser tab was opened. Only https links to www.instagram.com are ever opened. Never throws.
  Future<bool> open(Uri url);
}

class UrlLauncherInstagramLogin implements InstagramLogin {
  const UrlLauncherInstagramLogin();

  @override
  Future<bool> open(Uri url) async {
    if (url.scheme != 'https' || url.host != 'www.instagram.com') return false;
    try {
      return await launchUrl(url, mode: LaunchMode.inAppBrowserView);
    } catch (_) {
      return false;
    }
  }
}
