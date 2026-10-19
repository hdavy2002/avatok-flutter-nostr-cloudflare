import 'package:google_sign_in/google_sign_in.dart';

/// [HF-WIRE-14] "Sign in with YouTube" (HF-REEL-33). Google sign-in with the read-only YouTube scope.
/// Signing in proves the channel is hers: the server asks YouTube for the channel that belongs to this token.
const String kYoutubeReadonlyScope = 'https://www.googleapis.com/auth/youtube.readonly';

/// She closed the Google sheet without choosing an account.
class YoutubeSignInCancelled implements Exception {
  const YoutubeSignInCancelled();
}

/// Google sign-in failed (no Play Services, wrong OAuth client, no network...). [message] is plain English.
class YoutubeSignInFailed implements Exception {
  const YoutubeSignInFailed([this.message = 'We could not sign in with Google. Please try again.']);
  final String message;
}

/// Kept behind an interface so screens can be tested without Google.
abstract class YoutubeSignIn {
  /// Opens the Google account sheet and returns an access token for [kYoutubeReadonlyScope].
  /// Throws [YoutubeSignInCancelled] or [YoutubeSignInFailed].
  Future<String> accessToken();

  /// Forgets the Google account on this phone so the next connect asks again. Never throws.
  Future<void> signOut();
}

class GoogleYoutubeSignIn implements YoutubeSignIn {
  GoogleYoutubeSignIn() : _google = GoogleSignIn(scopes: const [kYoutubeReadonlyScope]);

  final GoogleSignIn _google;

  @override
  Future<String> accessToken() async {
    try {
      await _google.signOut().catchError((Object _) => null); // always show the account chooser
      final account = await _google.signIn();
      if (account == null) throw const YoutubeSignInCancelled();
      final token = (await account.authentication).accessToken;
      if (token == null || token.isEmpty) throw const YoutubeSignInFailed();
      return token;
    } on YoutubeSignInCancelled {
      rethrow;
    } on YoutubeSignInFailed {
      rethrow;
    } catch (_) {
      throw const YoutubeSignInFailed();
    }
  }

  @override
  Future<void> signOut() async {
    try {
      await _google.signOut();
    } catch (_) {}
  }
}
