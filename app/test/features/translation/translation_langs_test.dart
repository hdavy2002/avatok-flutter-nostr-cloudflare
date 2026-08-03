import 'package:flutter_test/flutter_test.dart';
import 'package:avatok_call/features/translation/translation_langs.dart';

void main() {
  test('[CALL-TRANSLATE-1] exposes the complete unique Live Translate picker', () {
    final codes = kTranslationLangs.map((language) => language.code).toList();
    expect(codes.length, greaterThanOrEqualTo(70));
    expect(codes.toSet().length, codes.length);
    expect(codes, containsAll(<String>['en', 'hi', 'es', 'zh-Hans', 'zh-Hant', 'pt-BR']));
  });
}
