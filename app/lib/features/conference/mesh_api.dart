// Free-tier P2P **mesh** group calling (≤5) client helper. Talks to the
// MeshRoom DO via the avatok-api Worker:
//   • WS  wss://<host>/mesh/<gid>?id=<peerId>   — join the mesh signaling room
//   • GET https://<host>/api/mesh/<gid>          — presence probe (live? count)
// Media is true P2P between devices (ICE via Cloudflare STUN/TURN); nothing is
// routed through our servers. Paid tiers use the LiveKit SFU instead.
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../../core/config.dart';

class MeshStatus {
  final bool live;
  final int count;
  const MeshStatus(this.live, this.count);
}

class MeshApi {
  /// Hard mesh cap (must match MeshRoom DO MAX_MESH and the Free plan).
  static const int maxMesh = 5;

  static String wsUrl(String gid, String peerId) =>
      'wss://$kSignalingHost/mesh/$gid?id=$peerId';

  /// Is there an ongoing mesh call for this group? (drives the join banner)
  static Future<MeshStatus> status(String gid) async {
    try {
      final res = await http
          .get(Uri.parse('https://$kSignalingHost/api/mesh/$gid'))
          .timeout(const Duration(seconds: 6));
      if (res.statusCode != 200) return const MeshStatus(false, 0);
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      return MeshStatus(j['live'] == true, (j['count'] as num?)?.toInt() ?? 0);
    } catch (_) {
      return const MeshStatus(false, 0);
    }
  }
}
