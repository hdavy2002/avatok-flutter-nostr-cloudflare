import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:pointycastle/export.dart';

/// NIP-44 v2 payload encryption (secp256k1 ECDH → HKDF → ChaCha20 → HMAC-SHA256).
/// Verified against the official NIP-44 test vectors (see test/nip44_test.dart),
/// which run in CI before every build.
class Nip44 {
  static final ECDomainParameters _secp = ECCurve_secp256k1();

  // ---- public API ----

  /// Shared conversation key from my private key (hex) and peer x-only pubkey (hex).
  static Uint8List conversationKey(String privHex, String pubXOnlyHex) {
    final pub = _secp.curve.decodePoint(_hexToBytes('02$pubXOnlyHex'))!;
    final priv = _bytesToBigInt(_hexToBytes(privHex));
    final shared = (pub * priv)!;
    final x = _bigIntTo32(shared.x!.toBigInteger()!);
    // HKDF-extract: HMAC(salt = "nip44-v2", ikm = shared_x)
    return _hmac(Uint8List.fromList(utf8.encode('nip44-v2')), x);
  }

  static String encrypt(String plaintext, Uint8List ck, Uint8List nonce) {
    final mk = _messageKeys(ck, nonce);
    final ct = _chacha(mk.chachaKey, mk.chachaNonce, _pad(Uint8List.fromList(utf8.encode(plaintext))));
    final mac = _hmac(mk.hmacKey, _concat(nonce, ct));
    return base64.encode(_concat(_concat(Uint8List.fromList([2]), nonce), _concat(ct, mac)));
  }

  /// Decrypt a base64 payload; returns null on bad version / MAC.
  static String? decrypt(String payloadB64, Uint8List ck) {
    try {
      final data = base64.decode(payloadB64);
      if (data.isEmpty || data[0] != 2 || data.length < 99) return null;
      final nonce = data.sublist(1, 33);
      final mac = data.sublist(data.length - 32);
      final ct = data.sublist(33, data.length - 32);
      final mk = _messageKeys(ck, nonce);
      if (!_constEq(_hmac(mk.hmacKey, _concat(nonce, ct)), mac)) return null;
      return utf8.decode(_unpad(_chacha(mk.chachaKey, mk.chachaNonce, ct)));
    } catch (_) {
      return null;
    }
  }

  /// Convenience: encrypt with a fresh random 32-byte nonce.
  static String encryptRandom(String plaintext, Uint8List ck) {
    final rnd = Random.secure();
    final nonce = Uint8List.fromList(List<int>.generate(32, (_) => rnd.nextInt(256)));
    return encrypt(plaintext, ck, nonce);
  }

  // ---- internals ----

  static int calcPaddedLen(int u) {
    if (u <= 32) return 32;
    final nextPow = 1 << (u - 1).bitLength; // == 2^(floor(log2(u-1))+1)
    final chunk = nextPow <= 256 ? 32 : nextPow ~/ 8;
    return chunk * (((u - 1) ~/ chunk) + 1);
  }

  static Uint8List _pad(Uint8List plain) {
    final ln = plain.length;
    final out = Uint8List(2 + calcPaddedLen(ln));
    out[0] = (ln >> 8) & 0xff;
    out[1] = ln & 0xff;
    out.setRange(2, 2 + ln, plain);
    return out;
  }

  static Uint8List _unpad(Uint8List padded) {
    final ln = (padded[0] << 8) | padded[1];
    return Uint8List.fromList(padded.sublist(2, 2 + ln));
  }

  static _MsgKeys _messageKeys(Uint8List ck, Uint8List nonce) {
    final k = _hkdfExpand(ck, nonce, 76);
    return _MsgKeys(k.sublist(0, 32), k.sublist(32, 44), k.sublist(44, 76));
  }

  static Uint8List _chacha(Uint8List key, Uint8List nonce12, Uint8List data) {
    final eng = ChaCha7539Engine()..init(true, ParametersWithIV(KeyParameter(key), nonce12));
    return eng.process(data);
  }

  static Uint8List _hmac(Uint8List key, Uint8List msg) {
    final h = HMac(SHA256Digest(), 64)..init(KeyParameter(key));
    return h.process(msg);
  }

  static Uint8List _hkdfExpand(Uint8List prk, Uint8List info, int length) {
    final out = BytesBuilder();
    Uint8List t = Uint8List(0);
    var i = 1;
    while (out.length < length) {
      final h = HMac(SHA256Digest(), 64)..init(KeyParameter(prk));
      t = h.process(_concat(_concat(t, info), Uint8List.fromList([i])));
      out.add(t);
      i++;
    }
    return out.toBytes().sublist(0, length);
  }

  // ---- helpers ----

  static Uint8List _concat(Uint8List a, Uint8List b) =>
      Uint8List(a.length + b.length)..setRange(0, a.length, a)..setRange(a.length, a.length + b.length, b);

  static bool _constEq(Uint8List a, Uint8List b) {
    if (a.length != b.length) return false;
    var r = 0;
    for (var i = 0; i < a.length; i++) {
      r |= a[i] ^ b[i];
    }
    return r == 0;
  }

  static Uint8List _hexToBytes(String h) {
    final out = Uint8List(h.length ~/ 2);
    for (var i = 0; i < out.length; i++) {
      out[i] = int.parse(h.substring(i * 2, i * 2 + 2), radix: 16);
    }
    return out;
  }

  static BigInt _bytesToBigInt(Uint8List b) {
    var r = BigInt.zero;
    for (final x in b) {
      r = (r << 8) | BigInt.from(x);
    }
    return r;
  }

  static Uint8List _bigIntTo32(BigInt v) {
    final out = Uint8List(32);
    var t = v;
    final mask = BigInt.from(0xff);
    for (var i = 31; i >= 0; i--) {
      out[i] = (t & mask).toInt();
      t = t >> 8;
    }
    return out;
  }

}

class _MsgKeys {
  final Uint8List chachaKey;
  final Uint8List chachaNonce;
  final Uint8List hmacKey;
  _MsgKeys(this.chachaKey, this.chachaNonce, this.hmacKey);
}
