import 'dart:convert';

import '../core/api_auth.dart';
import '../core/config.dart';
import '../core/group_store.dart';
import '../identity/identity.dart';

/// Server-backed group management (Cloudflare-native). A group is a `group`
/// conversation in D1 (`conversations` + `conversation_members`), addressed by the
/// server conv id (e.g. `g_<uuid>`), which is ALSO used as [Group.id] locally so
/// the existing `g:<id>` conv-key, message fan-out and offline FCM all line up.
///
/// This replaces the deprecated Nostr ginfo broadcast: creating a group or adding
/// a member now mutates server membership, so added users immediately receive the
/// group's messages + an offline push, and the group appears for them on sync.
class GroupApi {
  static String? get _myUid => AccountScope.id;

  /// Members → admins/members split for a local [Group]. owner+admin → admins.
  static Group _groupFrom(String id, String title, List<Map<String, dynamic>> members) {
    final mem = <String>[];
    final admins = <String>[];
    for (final m in members) {
      final uid = (m['uid'] ?? '').toString();
      if (uid.isEmpty) continue;
      mem.add(uid);
      final role = (m['role'] ?? 'member').toString();
      if (role == 'owner' || role == 'admin') admins.add(uid);
    }
    return Group(id: id, name: title.isEmpty ? 'Group' : title, members: mem, admins: admins);
  }

  /// Create a group server-side with [memberUids] (Clerk uids, excluding me).
  /// Persists it locally and returns the [Group], or null on failure.
  static Future<Group?> create(String name, List<String> memberUids) async {
    final me = _myUid;
    if (me == null || me.isEmpty) return null;
    final uids = memberUids.where((u) => u.isNotEmpty && u != me).toSet().toList();
    try {
      final r = await ApiAuth.postJson(kConversationsUrl, {
        'members': uids,
        'title': name,
      });
      if (r.statusCode != 200) return null;
      final conv = (jsonDecode(r.body) as Map<String, dynamic>)['conv']?.toString();
      if (conv == null || conv.isEmpty) return null;
      final g = Group(id: conv, name: name, members: [me, ...uids], admins: [me]);
      await GroupStore().upsert(g);
      return g;
    } catch (_) {
      return null;
    }
  }

  /// Fetch the authoritative member list for [conv] and refresh the local [Group].
  /// Returns the refreshed group, or null if not a member / failure.
  static Future<Group?> refresh(String conv) async {
    try {
      final r = await ApiAuth.getSigned('$kConvMembersUrl?conv=${Uri.encodeQueryComponent(conv)}');
      if (r.statusCode != 200) return null;
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      final members = ((j['members'] as List?) ?? const [])
          .map((e) => (e as Map).cast<String, dynamic>())
          .toList();
      final g = _groupFrom(conv, (j['title'] ?? 'Group').toString(), members);
      await GroupStore().upsert(g);
      return g;
    } catch (_) {
      return null;
    }
  }

  /// Authoritative roles for [conv]: uid → ('owner'|'admin'|'member'), plus the
  /// group title. Also refreshes the local [Group]. Null if not a member/failure.
  static Future<({String title, Map<String, String> roles})?> rolesOf(String conv) async {
    try {
      final r = await ApiAuth.getSigned('$kConvMembersUrl?conv=${Uri.encodeQueryComponent(conv)}');
      if (r.statusCode != 200) return null;
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      final list = ((j['members'] as List?) ?? const [])
          .map((e) => (e as Map).cast<String, dynamic>())
          .toList();
      final title = (j['title'] ?? 'Group').toString();
      final roles = <String, String>{};
      for (final m in list) {
        final uid = (m['uid'] ?? '').toString();
        if (uid.isNotEmpty) roles[uid] = (m['role'] ?? 'member').toString();
      }
      await GroupStore().upsert(_groupFrom(conv, title, list));
      return (title: title, roles: roles);
    } catch (_) {
      return null;
    }
  }

  /// Pull all server `group` conversations and merge them into the local store so
  /// a user who was ADDED to a group (on another device) sees it appear. Returns
  /// the resulting local group list.
  static Future<List<Group>> sync() async {
    try {
      final r = await ApiAuth.getSigned(kConversationsUrl);
      if (r.statusCode != 200) return GroupStore().load();
      final convs = ((jsonDecode(r.body) as Map<String, dynamic>)['conversations'] as List?) ?? const [];
      for (final c in convs) {
        final m = (c as Map).cast<String, dynamic>();
        if ((m['kind'] ?? '').toString() != 'group') continue;
        final id = (m['id'] ?? '').toString();
        if (id.isEmpty) continue;
        await refresh(id); // hydrate members + title and upsert
      }
    } catch (_) {/* best-effort; keep local */}
    return GroupStore().load();
  }

  static Future<bool> addMembers(String conv, List<String> uids) async {
    final add = uids.where((u) => u.isNotEmpty).toSet().toList();
    if (add.isEmpty) return false;
    try {
      final r = await ApiAuth.postJson(kConvAddMembersUrl, {'conv': conv, 'members': add});
      return r.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  static Future<bool> removeMember(String conv, String uid) async {
    try {
      final r = await ApiAuth.postJson(kConvRemoveMemberUrl, {'conv': conv, 'uid': uid});
      return r.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  /// Promote ([role] = 'admin') or demote ([role] = 'member') a member.
  static Future<bool> setRole(String conv, String uid, String role) async {
    try {
      final r = await ApiAuth.postJson(kConvSetRoleUrl, {'conv': conv, 'uid': uid, 'role': role});
      return r.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  static Future<bool> leave(String conv) async {
    try {
      final r = await ApiAuth.postJson(kConvLeaveUrl, {'conv': conv});
      return r.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  static Future<bool> deleteGroup(String conv) async {
    try {
      final r = await ApiAuth.postJson(kConvDeleteUrl, {'conv': conv});
      return r.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  /// Post a plain-text system announcement to the group's conversation. This rides
  /// the normal message fan-out, so every member (incl. just-added offline ones)
  /// gets it as a chat line + an offline FCM banner — the "you were added" notice.
  static Future<void> announce(String conv, String text) async {
    try {
      await ApiAuth.postJson(kMsgSendUrl, {
        'conv': conv,
        'kind': 'text',
        'body': jsonEncode({'t': 'gtext', 'gid': conv, 'body': text, 'system': true}),
      });
    } catch (_) {/* best-effort */}
  }
}
