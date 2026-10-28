import 'api_exception.dart';
import 'services.dart';

/// [HF-INTRO-A3] The three public flags of the intro-video project, read from `GET /api/config`:
/// `hfCallOptionEnabled`, `hfIntroOnboardingEnabled`, `hfFacebookLoginEnabled`. All false until the server says exactly `true`
/// (or when the config could not be read), so with the flags off the app behaves exactly as before.
/// Read lazily (first screen that needs them) so no shared start-up file has to change.
abstract final class IntroFlags {
  /// "How do you take calls?" (Bookings only / Bookings + live) on the influencer Home and the footer button.
  static bool callOption = false;

  /// The ACTION NEEDED intro banner and the app-only onboarding.
  static bool introOnboarding = false;

  /// "Log in with Facebook" under Social media verification.
  static bool facebookLogin = false;

  static Future<void>? _loading;

  static void apply(Map<String, dynamic> j) {
    callOption = j['hfCallOptionEnabled'] == true;
    introOnboarding = j['hfIntroOnboardingEnabled'] == true;
    facebookLogin = j['hfFacebookLoginEnabled'] == true;
  }

  /// Reads the config once. A failed read leaves every flag false and the next call tries again. Never throws.
  static Future<void> ensureLoaded() => _loading ??= _load();

  static Future<void> _load() async {
    try {
      apply(await Services.instance.api.getJson('/api/config', auth: false, store: true));
    } on ApiException {
      _loading = null;
    } catch (_) {
      _loading = null;
    }
  }

  /// Tests: back to the all-off state.
  static void reset() {
    callOption = false;
    introOnboarding = false;
    facebookLogin = false;
    _loading = null;
  }
}
