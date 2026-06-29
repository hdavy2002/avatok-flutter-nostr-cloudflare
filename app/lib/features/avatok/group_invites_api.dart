import 'dart:convert';

import '../../core/analytics.dart';
import '../../core/api_auth.dart';
import '../../core/config.dart';

/// A pending group invite the user can Accept or Decline (Phase D — true
/// pending membership). Only present when the server flag groupInvitesEnabled is
/// ON; otherwise the list is always empty and the app behaves as before.
class GroupInvite {
  final String conv;       // group conversation id (g_…)
  final String inviter;    // inviter uid
  final String groupName;  // group title (best-effort)
  final int memberCount;
  final int createdAt;
  GroupInvite({required this.conv, required this.inviter, required this.groupName, required this.memberCount, required this.createdAt});

  factory GroupInvite.fromJson(Map<String, dynamic> j) => GroupInvite(
        conv: (j['conv'] ?? '').toString(),
        inviter: (j['inviter'] ?? '').toString(),
        groupName: (j['group_name'] ?? 'a group').toString(),
        memberCount: (j['member_count'] as num?)?.toInt() ?? 0,
        createdAt: (j['created_at'] as num?)?.toInt() ?? 0,
      );
}

class GroupInvitesApi {
  /// My pending group invites (empty unless the server flag is on).
  static Future<List<GroupInvite>> list() async {
    try {
      final r = await ApiAuth.getSigned(kConvInvitesUrl);
      if (r.statusCode != 200) return [];
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      return ((j['invites'] as List?) ?? const [])
          .map((e) => GroupInvite.fromJson((e as Map).cast<String, dynamic>()))
          .toList();
    } catch (_) {
      return [];
    }
  }

  /// Accept or decline a pending invite. Accept → join the group; decline → out.
  static Future<bool> respond({required String conv, required bool accept}) async {
    try {
      final r = await ApiAuth.postJson(kConvInviteRespondUrl, {'conv': conv, 'accept': accept});
      Analytics.capture('group_invite_response', {'accept': accept, 'ok': r.statusCode == 200});
      return r.statusCode == 200;
    } catch (_) {
      return false;
    }
  }
}
