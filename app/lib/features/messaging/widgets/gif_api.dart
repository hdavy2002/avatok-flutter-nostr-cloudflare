// GIF / sticker grid data source — GIPHY (STREAM E, Tenor→GIPHY migration).
//
// Tenor was shut down. The rich picker now uses the official GIPHY Flutter SDK
// (see giphy_controller.dart) which fetches GIFs, stickers, text, emoji, and
// clips DIRECTLY from GIPHY on-device with the GIPHY *SDK* key. This file keeps a
// LIGHTWEIGHT fallback grid source that talks to our own worker proxy
// (worker/src/routes/gif.ts), which now forwards to GIPHY's REST API using the
// server-side GIPHY_API_KEY. Both paths converge on the same compact GifResult
// shape so the send pipeline (_sendGif → _sendMedia → R2) is unchanged.
//
//   GET /api/gif/search?q=&pos=   and   GET /api/gif/trending?pos=
// When the server returns 503 (GIPHY_API_KEY unset) we surface `unavailable`.
// (The primary SDK path does NOT depend on this proxy — GIPHY's key is present.)
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import '../../../core/api_auth.dart';
import '../../../core/config.dart';

/// Which GIPHY content type a picked item is — drives how it is sent (clips →
/// video message, sticker/text/emoji → bubble-less sticker, gif → animated media).
enum GifContentType { gif, sticker, text, emoji, clip }

GifContentType gifContentTypeFromName(String? s) {
  switch (s) {
    case 'sticker':
      return GifContentType.sticker;
    case 'text':
      return GifContentType.text;
    case 'emoji':
      return GifContentType.emoji;
    case 'clip':
    case 'clips':
    case 'video':
      return GifContentType.clip;
    default:
      return GifContentType.gif;
  }
}

extension GifContentTypeX on GifContentType {
  String get wire => this == GifContentType.clip ? 'clip' : name;
}

class GifResult {
  final String id;
  final String preview; // small looping mp4/gif/webp for the grid (muted autoplay)
  final String url; // full media to download → encrypt → upload to R2
  final int width;
  final int height;
  final String desc;
  final GifContentType contentType;
  GifResult({
    required this.id,
    required this.preview,
    required this.url,
    required this.width,
    required this.height,
    required this.desc,
    this.contentType = GifContentType.gif,
  });

  factory GifResult.fromJson(Map<String, dynamic> j) => GifResult(
        id: (j['id'] ?? '').toString(),
        preview: (j['preview'] ?? '').toString(),
        url: (j['url'] ?? '').toString(),
        width: (j['width'] as num?)?.toInt() ?? 0,
        height: (j['height'] as num?)?.toInt() ?? 0,
        desc: (j['desc'] ?? '').toString(),
        contentType: gifContentTypeFromName(j['ct']?.toString()),
      );

  Map<String, dynamic> toRecent() => {
        'id': id,
        'preview': preview,
        'url': url,
        'w': width,
        'h': height,
        'desc': desc,
        'ct': contentType.wire,
      };

  static GifResult fromRecent(Map<String, dynamic> j) => GifResult(
        id: (j['id'] ?? '').toString(),
        preview: (j['preview'] ?? '').toString(),
        url: (j['url'] ?? '').toString(),
        width: (j['w'] as num?)?.toInt() ?? 0,
        height: (j['h'] as num?)?.toInt() ?? 0,
        desc: (j['desc'] ?? '').toString(),
        contentType: gifContentTypeFromName(j['ct']?.toString()),
      );
}

class GifPage {
  final List<GifResult> results;
  final String next; // cursor for the next page ('' = end)
  final bool unavailable; // GIPHY_API_KEY not configured on the server (503)
  final bool throttled; // daily GIPHY budget exhausted (server degraded quietly)
  GifPage(this.results, this.next,
      {this.unavailable = false, this.throttled = false});
}

/// GIF/sticker grid source via our worker → GIPHY REST proxy. This is now the
/// PRIMARY browse path for the chat picker: the proxy caches every distinct
/// search/trending JSON call in KV (shared across all users) and enforces a
/// daily budget, so repeated/identical lookups cost ZERO GIPHY API calls and we
/// can never blow past the free 100/day quota. Grid previews + sent media come
/// from GIPHY's CDN (asset fetches, which don't count against the quota) and are
/// mirrored to R2. The native GIPHY SDK dialog (giphy_controller.dart) bypasses
/// this cache/guard, so it is NOT the default browse path anymore.
class GifApi {
  /// Trending GIFs (kind=gif) or stickers (kind=sticker). `pos` is the opaque
  /// pagination cursor returned as `next`.
  static Future<GifPage> trending({String pos = '', String kind = 'gif'}) {
    final qp = <String>[
      if (pos.isNotEmpty) 'pos=$pos',
      if (kind == 'sticker') 'kind=sticker',
    ];
    final qs = qp.isEmpty ? '' : '?${qp.join('&')}';
    return _page('$kApiBase/gif/trending$qs');
  }

  static Future<GifPage> search(String q,
      {String pos = '', String kind = 'gif'}) {
    final query = Uri.encodeQueryComponent(q);
    final qp = <String>[
      'q=$query',
      if (pos.isNotEmpty) 'pos=$pos',
      if (kind == 'sticker') 'kind=sticker',
    ];
    return _page('$kApiBase/gif/search?${qp.join('&')}');
  }

  static Future<GifPage> _page(String url) async {
    try {
      final res = await ApiAuth.getSigned(url, timeout: const Duration(seconds: 10));
      if (res.statusCode == 503) return GifPage(const [], '', unavailable: true);
      if (res.statusCode != 200) return GifPage(const [], '');
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      final list = (j['results'] as List? ?? [])
          .map((e) => GifResult.fromJson((e as Map).cast<String, dynamic>()))
          .toList();
      return GifPage(
        list,
        (j['next'] ?? '').toString(),
        throttled: j['throttled'] == true,
      );
    } catch (_) {
      return GifPage(const [], '');
    }
  }

  /// Downloads the full GIF/MP4/WebP bytes so they can be re-uploaded to R2
  /// through the normal encrypted media path (recipients fetch from R2, never
  /// GIPHY). The URL is a GIPHY CDN URL, so this is a plain unsigned fetch — no
  /// ApiAuth signature is sent to a third-party host.
  static Future<Uint8List?> download(String url) async {
    try {
      final res =
          await http.get(Uri.parse(url)).timeout(const Duration(seconds: 20));
      if (res.statusCode != 200) return null;
      return res.bodyBytes;
    } catch (_) {
      return null;
    }
  }
}
