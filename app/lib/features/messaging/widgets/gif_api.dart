// GIF tab data source — talks to our Tenor proxy (worker/src/routes/gif.ts).
//
// STREAM E. The Tenor key stays server-side; the app only calls our two routes:
//   GET /api/gif/search?q=&pos=   and   GET /api/gif/trending?pos=
// When the server returns 503 (TENOR_API_KEY unset) we surface `unavailable`
// so the tab shows "GIFs unavailable" instead of an error.
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import '../../../core/api_auth.dart';
import '../../../core/config.dart';

class GifResult {
  final String id;
  final String preview; // small looping mp4/gif for the grid (muted autoplay)
  final String url; // full media to download → encrypt → upload to R2
  final int width;
  final int height;
  final String desc;
  GifResult({
    required this.id,
    required this.preview,
    required this.url,
    required this.width,
    required this.height,
    required this.desc,
  });

  factory GifResult.fromJson(Map<String, dynamic> j) => GifResult(
        id: (j['id'] ?? '').toString(),
        preview: (j['preview'] ?? '').toString(),
        url: (j['url'] ?? '').toString(),
        width: (j['width'] as num?)?.toInt() ?? 0,
        height: (j['height'] as num?)?.toInt() ?? 0,
        desc: (j['desc'] ?? '').toString(),
      );

  Map<String, dynamic> toRecent() =>
      {'id': id, 'preview': preview, 'url': url, 'w': width, 'h': height, 'desc': desc};

  static GifResult fromRecent(Map<String, dynamic> j) => GifResult(
        id: (j['id'] ?? '').toString(),
        preview: (j['preview'] ?? '').toString(),
        url: (j['url'] ?? '').toString(),
        width: (j['w'] as num?)?.toInt() ?? 0,
        height: (j['h'] as num?)?.toInt() ?? 0,
        desc: (j['desc'] ?? '').toString(),
      );
}

class GifPage {
  final List<GifResult> results;
  final String next; // cursor for the next page ('' = end)
  final bool unavailable; // TENOR_API_KEY not configured on the server
  GifPage(this.results, this.next, {this.unavailable = false});
}

class GifApi {
  static Future<GifPage> trending({String pos = ''}) =>
      _page('$kApiBase/gif/trending${pos.isNotEmpty ? '?pos=$pos' : ''}');

  static Future<GifPage> search(String q, {String pos = ''}) {
    final query = Uri.encodeQueryComponent(q);
    final url =
        '$kApiBase/gif/search?q=$query${pos.isNotEmpty ? '&pos=$pos' : ''}';
    return _page(url);
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
      return GifPage(list, (j['next'] ?? '').toString());
    } catch (_) {
      return GifPage(const [], '');
    }
  }

  /// Downloads the full GIF/MP4 bytes so they can be re-uploaded to R2 through
  /// the normal encrypted media path (recipients fetch from R2, never Tenor).
  /// The URL is a Tenor CDN URL (returned by our proxy), so this is a plain
  /// unsigned fetch — no ApiAuth signature is sent to a third-party host.
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
