import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('library opens private media through the account-scoped media path', () {
    final screen = File('lib/features/library/avalibrary_screen.dart').readAsStringSync();
    final media = File('lib/features/avatok/media.dart').readAsStringSync();
    expect(screen, contains('LibraryMediaViewer(item: m)'));
    expect(screen, isNot(contains('Private file — open it from the original chat')));
    expect(media, contains('downloadLibraryItem(LibraryItem item)'));
    expect(media, contains('encBlob'));
  });
}
