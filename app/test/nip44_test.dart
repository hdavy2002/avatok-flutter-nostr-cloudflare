import 'dart:convert';
import 'dart:typed_data';

import 'package:avatok_call/crypto/nip44.dart';
import 'package:flutter_test/flutter_test.dart';

/// Official NIP-44 v2 vectors (subset) — keeps the Dart port honest in CI.
/// Source: github.com/paulmillr/nip44 nip44.vectors.json
void main() {
  Uint8List hx(String h) => Uint8List.fromList([
        for (var i = 0; i < h.length; i += 2) int.parse(h.substring(i, i + 2), radix: 16)
      ]);

  test('conversation_key vectors', () {
    const v = [
      ['315e59ff51cb9209768cf7da80791ddcaae56ac9775eb25b6dee1234bc5d2268',
       'c2f9d9948dc8c7c38321e4b85c8558872eafa0641cd269db76848a6073e69133',
       '3dfef0ce2a4d80a25e7a328accf73448ef67096f65f79588e358d9a0eb9013f1'],
      ['a1e37752c9fdc1273be53f68c5f74be7c8905728e8de75800b94262f9497c86e',
       '03bb7947065dde12ba991ea045132581d0954f042c84e06d8c00066e23c1a800',
       '4d14f36e81b8452128da64fe6f1eae873baae2f444b02c950b90e43553f2178b'],
    ];
    for (final t in v) {
      final ck = Nip44.conversationKey(t[0], t[1]);
      expect(ck.map((b) => b.toRadixString(16).padLeft(2, '0')).join(), t[2]);
    }
  });

  test('encrypt + decrypt vectors', () {
    const v = [
      ['c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d',
       '0000000000000000000000000000000000000000000000000000000000000001',
       'a',
       'AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABee0G5VSK0/9YypIObAtDKfYEAjD35uVkHyB0F4DwrcNaCXlCWZKaArsGrY6M9wnuTMxWfp1RTN9Xga8no+kF5Vsb'],
      ['c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d',
       'f00000000000000000000000000000f00000000000000000000000000000000f',
       '🍕🫃',
       'AvAAAAAAAAAAAAAAAAAAAPAAAAAAAAAAAAAAAAAAAAAPSKSK6is9ngkX2+cSq85Th16oRTISAOfhStnixqZziKMDvB0QQzgFZdjLTPicCJaV8nDITO+QfaQ61+KbWQIOO2Yj'],
    ];
    for (final t in v) {
      final ck = hx(t[0]);
      final enc = Nip44.encrypt(t[2], ck, hx(t[1]));
      expect(enc, t[3], reason: 'encrypt mismatch');
      expect(Nip44.decrypt(t[3], ck), t[2], reason: 'decrypt mismatch');
    }
  });

  test('round-trip random nonce', () {
    final ck = hx('c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d');
    const msg = 'hello AvaTOK 👋 end-to-end';
    expect(Nip44.decrypt(Nip44.encryptRandom(msg, ck), ck), msg);
  });

  test('calc_padded_len', () {
    const v = [[16, 32], [32, 32], [33, 64], [37, 64], [45, 64], [49, 64], [65, 96]];
    for (final t in v) {
      expect(Nip44.calcPaddedLen(t[0]), t[1]);
    }
  });

  test('base64 sanity', () => expect(base64.encode([0]), 'AA=='));
}
