import 'dart:math';
import 'package:bip340/bip340.dart' as bip340;

/// NIP-19 (bech32) encoding + secp256k1 key generation for Nostr.
/// The bech32 logic is verified against the official NIP-19 test vector
/// (npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg).
class NostrKeys {
  static const _charset = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  static const _gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

  /// 32 cryptographically-random bytes → 64-char hex private key.
  static String generatePrivateKey() {
    final rnd = Random.secure();
    final bytes = List<int>.generate(32, (_) => rnd.nextInt(256));
    return bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  }

  /// x-only public key hex (Nostr pubkey) from a private key hex.
  static String publicKeyFromPrivate(String privHex) =>
      bip340.getPublicKey(privHex);

  // Cloudflare-native pivot: identity is now the Clerk uid ("user_..."). These
  // helpers pass a uid through UNCHANGED so the chat layer can keep funnelling
  // peer ids through npub()/npubToHex() while actually carrying uids.
  static String npub(String pubHex) =>
      pubHex.startsWith('user_') ? pubHex : _toNip19('npub', pubHex);
  static String nsec(String privHex) => _toNip19('nsec', privHex);

  /// Decode an npub/nsec (bech32) back to 64-char hex. Returns null if invalid.
  static String? decodeToHex(String bech, String expectedHrp) {
    final pos = bech.lastIndexOf('1');
    if (pos < 1 || pos + 7 > bech.length) return null;
    final hrp = bech.substring(0, pos);
    if (hrp != expectedHrp) return null;
    final data = <int>[];
    for (final c in bech.substring(pos + 1).split('')) {
      final idx = _charset.indexOf(c);
      if (idx == -1) return null;
      data.add(idx);
    }
    if (_polymod([..._hrpExpand(hrp), ...data]) != 1) return null; // checksum
    final bytes = _convertBits(data.sublist(0, data.length - 6), 5, 8, false);
    return bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  }

  /// npub → x-only pubkey hex (or null). A Clerk uid ("user_...") passes through
  /// unchanged so call sites can treat the result as the opaque peer id.
  static String? npubToHex(String npub) =>
      npub.startsWith('user_') ? npub : decodeToHex(npub, 'npub');

  // ---- bech32 internals ----

  static int _polymod(List<int> values) {
    var chk = 1;
    for (final v in values) {
      final b = chk >> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ v;
      for (var i = 0; i < 5; i++) {
        if (((b >> i) & 1) == 1) chk ^= _gen[i];
      }
    }
    return chk;
  }

  static List<int> _hrpExpand(String hrp) {
    final hi = hrp.codeUnits.map((c) => c >> 5).toList();
    final lo = hrp.codeUnits.map((c) => c & 31).toList();
    return [...hi, 0, ...lo];
  }

  static List<int> _checksum(String hrp, List<int> data) {
    final values = [..._hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
    final pm = _polymod(values) ^ 1;
    return [for (var i = 0; i < 6; i++) (pm >> (5 * (5 - i))) & 31];
  }

  static String _bech32Encode(String hrp, List<int> data) {
    final combined = [...data, ..._checksum(hrp, data)];
    final sb = StringBuffer('${hrp}1');
    for (final d in combined) {
      sb.write(_charset[d]);
    }
    return sb.toString();
  }

  static List<int> _convertBits(List<int> data, int from, int to, bool pad) {
    var acc = 0, bits = 0;
    final ret = <int>[];
    final maxv = (1 << to) - 1;
    for (final b in data) {
      acc = (acc << from) | b;
      bits += from;
      while (bits >= to) {
        bits -= to;
        ret.add((acc >> bits) & maxv);
      }
    }
    if (pad && bits > 0) ret.add((acc << (to - bits)) & maxv);
    return ret;
  }

  static List<int> _hexToBytes(String hex) => [
        for (var i = 0; i < hex.length; i += 2)
          int.parse(hex.substring(i, i + 2), radix: 16)
      ];

  static String _toNip19(String hrp, String hex) =>
      _bech32Encode(hrp, _convertBits(_hexToBytes(hex), 8, 5, true));
}
