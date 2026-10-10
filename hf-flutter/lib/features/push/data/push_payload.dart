import '../../../core/router/deep_links.dart';
import '../../../core/router/routes.dart';

/// One push message, as the app sees it. The worker (`consumers/src/fcm.ts buildHfPayload`) sends a
/// notification `{title, body}` plus `data: {type: 'hf_push', kind, path}` on channel `hf_default`.
class PushMessage {
  const PushMessage({this.title = '', this.body = '', this.data = const <String, String>{}});

  final String title;
  final String body;
  final Map<String, String> data;

  PushPayload? get payload => PushPayload.fromData(data);
}

/// The kinds the worker sends (`worker/src/lib/hf_push_pure.ts`). Anything else is "other": it still
/// opens its path, and telemetry records `other` so a new kind never leaks free text.
enum PushKind {
  notifyMe('notify_me'),
  hostApproved('host_approved'),
  hostChanges('host_changes'),
  withdrawalApproved('withdrawal_approved'),
  withdrawalPaid('withdrawal_paid'),
  lowBalance('low_balance'),
  reviewRequest('review_request'),
  other('other');

  const PushKind(this.wire);
  final String wire;

  static PushKind parse(String? v) {
    for (final k in PushKind.values) {
      if (k.wire == v && k != PushKind.other) return k;
    }
    return PushKind.other;
  }
}

/// `data` of a push, validated. Null from [fromData] means "not one of ours, do nothing".
class PushPayload {
  const PushPayload({required this.kind, required this.path});

  final PushKind kind;

  /// An app path from the worker, for example `/h/<slug>`. Always starts with a single `/`.
  final String path;

  static const String dataType = 'hf_push';

  static PushPayload? fromData(Map<String, String> data) {
    final type = data['type'];
    if (type != null && type.isNotEmpty && type != dataType) return null;
    final kind = PushKind.parse(data['kind']);
    final raw = (data['path'] ?? '').trim();
    if (raw.isNotEmpty) {
      // Only same-site paths: a push can never send the person to another host.
      if (!raw.startsWith('/') || raw.startsWith('//')) return null;
      return PushPayload(kind: kind, path: raw);
    }
    // No path (an older worker): the kinds that need no id still have a home.
    final fallback = _fallbackPath(kind);
    return fallback == null ? null : PushPayload(kind: kind, path: fallback);
  }

  static String? _fallbackPath(PushKind kind) {
    switch (kind) {
      case PushKind.hostApproved:
      case PushKind.hostChanges:
      case PushKind.withdrawalApproved:
      case PushKind.withdrawalPaid:
        return '/hosts/dashboard';
      case PushKind.lowBalance:
        return Routes.wallet;
      case PushKind.notifyMe:
      case PushKind.reviewRequest:
      case PushKind.other:
        return null; // these need a slug or a token
    }
  }

  /// Where the app goes for this push, by the same mapper the links use (spec 3.3).
  DeepLinkTarget get target => DeepLinks.resolve(path);

  @override
  String toString() => 'PushPayload(${kind.wire}, ${DeepLinks.telemetryPath(path)})';
}
