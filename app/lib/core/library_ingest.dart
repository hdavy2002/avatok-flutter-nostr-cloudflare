import 'analytics.dart';
import 'local_brain/local_brain.dart';
import 'money_api.dart';

/// Tier-aware routing for a newly-added AvaLibrary file (owner decision 2026-06-20).
///
///   • PAID (topped-up wallet)  → the SERVER vectorises/transcribes/embeds the
///     file into the premium RAG (worker `maybeEmitLibraryBrain`, gated on the
///     same wallet `premium` flag), so AvaChat can pull it by description. Nothing
///     to do on the client.
///   • FREE                     → index the file into the ON-DEVICE memory lane
///     ([AvaLocalBrain]) so AvaChat's free lane finds it locally, and
///     let the existing daily auto-backup ship the per-account SQLite (which now
///     contains this index) to the user's own Google Drive. Nothing is sent to
///     the server brain for free users.
///
/// Local-first retrieval: AvaChat checks the local index first and only augments
/// with the server lane for premium accounts. Everything here is best-effort and
/// never throws into the upload path.
class LibraryIngest {
  static bool? _premiumCache;
  static int _premiumAt = 0;
  static const _ttlMs = 5 * 60 * 1000;

  /// Premium = topped-up wallet (`balance.premium == 1`). Cached ~5 min so a burst
  /// of uploads doesn't hit the wallet endpoint repeatedly. On lookup failure we
  /// fall back to the last known value, else treat as FREE (index locally) — the
  /// fail-safe is to keep the user's data retrievable on their own device.
  static Future<bool> _isPremium() async {
    final now = DateTime.now().millisecondsSinceEpoch;
    if (_premiumCache != null && now - _premiumAt < _ttlMs) return _premiumCache!;
    try {
      final b = await MoneyApi.balance();
      final p = b['premium'] == 1 || b['premium'] == true;
      _premiumCache = p;
      _premiumAt = now;
      return p;
    } catch (_) {
      return _premiumCache ?? false;
    }
  }

  /// Invalidate the cached premium flag (e.g. right after a successful top-up).
  static void invalidatePremium() => _premiumCache = null;

  static String _catOf(String mime) {
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime == 'application/pdf') return 'pdf';
    if (mime.startsWith('text/') ||
        mime.startsWith('application/msword') ||
        mime.startsWith('application/vnd.')) return 'document';
    return 'other';
  }

  /// Route a just-added library file by tier. Call fire-and-forget after a
  /// successful upload (it returns fast for premium accounts).
  static Future<void> afterUpload({
    required String id,
    required String name,
    required String mime,
    String app = 'avalibrary',
  }) async {
    try {
      if (id.isEmpty) return;
      if (await _isPremium()) return; // paid → server vectorises/embeds it
      final cat = _catOf(mime);
      // Index the file's name + type into the device lane (AvaLocalBrain — the
      // §2.1 device_private brain). The filename is the searchable signal
      // ("invoice-june.pdf" → AvaChat can find "the invoice"); for premium users
      // the server additionally embeds the CONTENT (OCR/text). [ONEBRAIN-B3-APP]
      // Routed through AvaLocalBrain.ingest so all device-lane content enters
      // through the one networkless device-brain boundary.
      await AvaLocalBrain.I.ingest(
        domain: 'files',
        kind: 'library_file',
        text: '$name ($cat file)',
        meta: {'convKey': 'lib:$cat'},
        ts: DateTime.now().millisecondsSinceEpoch,
        sourceId: 'lib:$id',
      );
      Analytics.capture('library_local_index', {'category': cat, 'app': app, 'tier': 'free'});
    } catch (_) {/* best-effort — never block or break the upload */}
  }
}
