import 'dart:typed_data';

import '../api_client.dart';
import '../services.dart';

/// [HF-MOD-APP-PHOTOS] Which picture is being changed.
enum PhotoKind { profile, cover }

/// One picture slot from `GET /api/hf/me/photos`: the picture showing now, whether a new one is being checked, and the
/// sentence to show when the last one was refused (null otherwise).
class PhotoSlot {
  const PhotoSlot({this.url, this.checking = false, this.refused});

  factory PhotoSlot.fromJson(Object? j) {
    if (j is! Map) return const PhotoSlot();
    final u = j['url'];
    final r = j['refused'];
    return PhotoSlot(
      url: u is String && u.isNotEmpty ? u : null,
      checking: j['checking'] == true,
      refused: r is String && r.trim().isNotEmpty ? r.trim() : null,
    );
  }

  final String? url;
  final bool checking;
  final String? refused;
}

class MyPhotos {
  const MyPhotos({this.profile = const PhotoSlot(), this.cover = const PhotoSlot()});

  factory MyPhotos.fromJson(Map<String, dynamic> j) {
    final p = j['photos'];
    final m = p is Map ? p : const <String, Object?>{};
    return MyPhotos(profile: PhotoSlot.fromJson(m['profile']), cover: PhotoSlot.fromJson(m['cover']));
  }

  final PhotoSlot profile;
  final PhotoSlot cover;

  PhotoSlot slot(PhotoKind k) => k == PhotoKind.profile ? profile : cover;
}

/// The picture limits the server enforces (profile 200 x 200 minimum, cover 640 x 200 minimum, 4 MB at most).
abstract final class PhotoLimits {
  static const int maxBytes = 4 * 1024 * 1024;
  static const int profileMin = 200;
  static const int coverMinW = 640;
  static const int coverMinH = 200;
  static const int profileLongSide = 1080;
  static const int coverMaxW = 1600;
}

/// [HF-MOD-APP-PHOTOS] The fan's own profile photo and cover (behind `hfPhotoModerationEnabled`).
/// - `PUT /api/hf/me/photo` and `PUT /api/hf/me/cover`: raw JPEG bytes. 202 `{ok, id, status:'checking', message}`.
///   Errors `{ok:false, error, message}`: too_big | bad_type | too_small | empty | not_enabled (404) | store_failed.
/// - `GET /api/hf/me/photos` -> `{ok, photos:{profile:{url,checking,refused}, cover:{...}, host:{...}}}`.
class MyPhotosRepo {
  MyPhotosRepo(this._api);

  final ApiClient _api;

  static MyPhotosRepo? _override;
  static MyPhotosRepo? _cached;

  static MyPhotosRepo get instance => _override ?? (_cached ??= MyPhotosRepo(Services.instance.api));

  static set override(MyPhotosRepo? r) => _override = r;

  static String _path(PhotoKind k) => k == PhotoKind.profile ? '/api/hf/me/photo' : '/api/hf/me/cover';

  /// Throws [ApiException] (its message is the server's sentence, ready to show).
  Future<MyPhotos> load() async => MyPhotos.fromJson(await _api.getJson('/api/hf/me/photos'));

  /// Sends the shrunk JPEG. Returns when the server has accepted it for checking (HTTP 202). Throws [ApiException].
  Future<void> upload(PhotoKind kind, Uint8List jpeg) async {
    await _api.putBytes(_path(kind), jpeg, contentType: 'image/jpeg');
  }
}
