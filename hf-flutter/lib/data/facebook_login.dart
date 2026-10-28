import 'package:url_launcher/url_launcher.dart';

/// [HF-INTRO-A3] Opens the Facebook login page in an in-app browser tab (Chrome Custom Tab), the same way [InstagramLogin] does for Instagram
/// (Specs/HF-FACEBOOK-LOGIN-1.md). The answer does not come back here: the server redirects to `<scheme>://channels?fb=connected|error&...`
/// and the deep-link handler (core/deep_links.dart) opens Social media verification. Kept behind an interface so screens can be tested.
abstract class FacebookLogin {
  /// True when the browser tab was opened. Only https links to www.facebook.com are ever opened. Never throws.
  Future<bool> open(Uri url);
}

class UrlLauncherFacebookLogin implements FacebookLogin {
  const UrlLauncherFacebookLogin();

  @override
  Future<bool> open(Uri url) async {
    if (url.scheme != 'https' || url.host != 'www.facebook.com') return false;
    try {
      return await launchUrl(url, mode: LaunchMode.inAppBrowserView);
    } catch (_) {
      return false;
    }
  }
}
