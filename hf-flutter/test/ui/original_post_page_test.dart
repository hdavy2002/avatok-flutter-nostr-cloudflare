import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/demo/screens/original_post_page.dart';

void main() {
  test(
    '[HF-REEL-ORIGINAL-1] the in-app page stays on the platform and never hands off to another app',
    () {
      bool ok(String u) => OriginalPostPage.allowed(Uri.parse(u));
      expect(ok('https://www.instagram.com/reel/Cx12345/'), isTrue);
      expect(ok('https://m.youtube.com/shorts/abc12345'), isTrue);
      expect(ok('https://youtu.be/abc12345'), isTrue);
      expect(
        ok(
          'intent://instagram.com/reel/x#Intent;scheme=https;package=com.instagram.android;end',
        ),
        isFalse,
      );
      expect(ok('instagram://reel/x'), isFalse);
      expect(ok('vnd.youtube://abc12345'), isFalse);
      expect(ok('https://evil.example/instagram.com'), isFalse);
      expect(ok('http://www.instagram.com/reel/x'), isFalse);
      expect(
        OriginalPostPage.nameFor(Uri.parse('https://www.instagram.com/p/x')),
        'Instagram',
      );
      expect(
        OriginalPostPage.nameFor(Uri.parse('https://youtube.com/shorts/x')),
        'YouTube',
      );
    },
  );
}
