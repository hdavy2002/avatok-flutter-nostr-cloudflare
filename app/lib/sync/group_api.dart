import 'dart:convert';

import '../core/analytics.dart';
import '../core/api_auth.dart';
import '../core/config.dart';
import '../core/disk_cache.dart';
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

  /// Locally-stored copy of [conv], or null. Deliberately NOT `firstOrNull`:
  /// that's a package:collection extension and this library doesn't import it.
  static Future<Group?> _local(String conv) async {
    for (final g in await GroupStore().load()) {
      if (g.id == conv) return g;
    }
    return null;
  }

  /// Members → admins/members split for a local [Group]. owner+admin → admins.
  static Group _groupFrom(String id, String title, List<Map<String, dynamic>> members,
      {String avatarUrl = '', String description = ''}) {
    final mem = <String>[];
    final admins = <String>[];
    for (final m in members) {
      final uid = (m['uid'] ?? '').toString();
      if (uid.isEmpty) continue;
      mem.add(uid);
      final role = (m['role'] ?? 'member').toString();
      if (role == 'owner' || role == 'admin') admins.add(uid);
    }
    return Group(id: id, name: title.isEmpty ? 'Group' : title, members: mem, admins: admins,
        avatarUrl: avatarUrl, description: description);
  }

  /// Create a group server-side with [memberUids] (Clerk uids, excluding me).
  /// Persists it locally and returns the [Group], or null on failure.
  static Future<Group?> create(String name, List<String> memberUids) async {
    final me = _myUid;
    if (me == null || me.isEmpty) return null;
    final uids = memberUids.where((u) => u.isNotEmpty && u != me).toSet().toList();
    Analytics.capture('group_create_attempt', {'member_count': uids.length});
    try {
      final r = await ApiAuth.postJson(kConversationsUrl, {
        'members': uids,
        'title': name,
      });
      if (r.statusCode != 200) {
        Analytics.capture('group_create_failed', {'status': r.statusCode, 'member_count': uids.length});
        return null;
      }
      final conv = (jsonDecode(r.body) as Map<String, dynamic>)['conv']?.toString();
      if (conv == null || conv.isEmpty) {
        Analytics.capture('group_create_failed', {'status': 200, 'reason': 'no_conv', 'member_count': uids.length});
        return null;
      }
      final g = Group(id: conv, name: name, members: [me, ...uids], admins: [me]);
      await GroupStore().upsert(g);
      Analytics.capture('group_created', {'gid': conv, 'member_count': g.members.length});
      return g;
    } catch (e) {
      Analytics.capture('group_create_failed', {'reason': 'exception', 'member_count': uids.length});
      return null;
    }
  }

  /// [GROUP-AVATAR-1] Set (or, with an empty [url], clear) the group photo.
  /// Admins only — the server enforces it; the UI just hides the control.
  /// Returns the updated [Group], or null on failure.
  static Future<Group?> setAvatar(String conv, String url) async {
    try {
      final r = await ApiAuth.postJson(kConvAvatarUrl, {'conv': conv, 'avatar_url': url});
      if (r.statusCode != 200) {
        Analytics.capture('group_avatar_failed', {'status': r.statusCode, 'clearing': url.isEmpty});
        return null;
      }
      // Update the local copy immediately rather than waiting for a refresh, so
      // the photo appears the moment the sheet closes.
      final prev = await _local(conv);
      if (prev == null) return null;
      final g = prev.copyWith(avatarUrl: url);
      await GroupStore().upsert(g);
      Analytics.capture(url.isEmpty ? 'group_avatar_removed' : 'group_avatar_set', {'gid': conv});
      return g;
    } catch (e) {
      Analytics.capture('group_avatar_failed', {'error': e.toString(), 'clearing': url.isEmpty});
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
      // [GROUP-AVATAR-1] `description` is LOCAL-ONLY — the server has no column
      // for it and never returns it. _groupFrom builds a fresh Group, and upsert
      // REPLACES the stored row wholesale, so rebuilding from the server payload
      // alone silently erased the group description on every refresh (the same
      // shape of bug as the contact avatar backfill wiping AvaTOK numbers,
      // ISSUE-CONTACT-AVATAR-1). Carry local-only fields across explicitly.
      final prev = await _local(conv);
      final g = _groupFrom(conv, (j['title'] ?? 'Group').toString(), members,
          avatarUrl: (j['avatar_url'] ?? '').toString(),
          description: prev?.description ?? '');
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
      // [GROUP-AVATAR-1] Same local-only-field preservation as refresh() above.
      final prev = await _local(conv);
      await GroupStore().upsert(_groupFrom(conv, title, list,
          avatarUrl: (j['avatar_url'] ?? '').toString(),
          description: prev?.description ?? ''));
      return (title: title, roles: roles);
    } catch (_) {
      return null;
    }
  }

  /// Pull server `group` conversations and MERGE them into the local store (so a
  /// user added to a group elsewhere sees it appear), AND push any LOCAL-only
  /// groups UP to the server so they survive a reinstall / new device.
  ///
  /// SAFETY (data-loss fix 2026-06-30): this NEVER deletes local groups. The old
  /// `resetLocalOnce()` wiped local-only groups on first run, trusting the server
  /// to refill them — but pre-server-backed groups were never on the server, so
  /// they were permanently destroyed on update/reinstall (owner report). Removed.
  /// Reconciliation is now strictly additive + upload-only.
  static Future<List<Group>> sync() async {
    final serverIds = <String>{};
    try {
      final r = await ApiAuth.getSigned(kConversationsUrl);
      if (r.statusCode == 200) {
        final convs = ((jsonDecode(r.body) as Map<String, dynamic>)['conversations'] as List?) ?? const [];
        for (final c in convs) {
          final m = (c as Map).cast<String, dynamic>();
          if ((m['kind'] ?? '').toString() != 'group') continue;
          final id = (m['id'] ?? '').toString();
          if (id.isEmpty) continue;
          serverIds.add(id);
          await refresh(id); // hydrate members + title and upsert
        }
      }
      // Durability: any LOCAL group the server doesn't know about is a pre-
      // server-backed local-only group — push it up (keeping its id so message
      // history stays linked) so it can be restored after a fresh install.
      final local = await GroupStore().load();
      for (final g in local) {
        if (g.id.isEmpty || serverIds.contains(g.id)) continue;
        await _adopt(g);
      }
      Analytics.capture('group_synced',
          {'server_group_count': serverIds.length, 'local_total': local.length});
    } catch (_) {/* best-effort; keep local */}
    return GroupStore().load();
  }

  /// Best-effort upload of a local-only group to the server, PRESERVING its id so
  /// the conv-key (and message history) stays consistent. Idempotent server-side.
  static Future<void> _adopt(Group g) async {
    try {
      final r = await ApiAuth.postJson(kConvAdoptUrl, {
        'id': g.id,
        'title': g.name,
        'members': g.members.where((u) => u.isNotEmpty).toList(),
      });
      Analytics.capture(r.statusCode == 200 ? 'group_adopted' : 'group_adopt_failed',
          {'gid': g.id, 'member_count': g.members.length, if (r.statusCode != 200) 'status': r.statusCode});
    } catch (_) {
      Analytics.capture('group_adopt_failed', {'gid': g.id, 'reason': 'exception'});
    }
  }

  static Future<bool> addMembers(String conv, List<String> uids) async {
    final add = uids.where((u) => u.isNotEmpty).toSet().toList();
    if (add.isEmpty) return false;
    try {
      final r = await ApiAuth.postJson(kConvAddMembersUrl, {'conv': conv, 'members': add});
      final ok = r.statusCode == 200;
      Analytics.capture(ok ? 'group_members_added' : 'group_members_add_failed',
          {'gid': conv, 'count': add.length, if (!ok) 'status': r.statusCode});
      return ok;
    } catch (_) {
      Analytics.capture('group_members_add_failed', {'gid': conv, 'count': add.length, 'reason': 'exception'});
      return false;
    }
  }

  static Future<bool> removeMember(String conv, String uid) async {
    try {
      final r = await ApiAuth.postJson(kConvRemoveMemberUrl, {'conv': conv, 'uid': uid});
      final ok = r.statusCode == 200;
      Analytics.capture(ok ? 'group_member_removed' : 'group_member_remove_failed',
          {'gid': conv, if (!ok) 'status': r.statusCode});
      return ok;
    } catch (_) {
      Analytics.capture('group_member_remove_failed', {'gid': conv, 'reason': 'exception'});
      return false;
    }
  }

  /// Promote ([role] = 'admin') or demote ([role] = 'member') a member.
  static Future<bool> setRole(String conv, String uid, String role) async {
    try {
      final r = await ApiAuth.postJson(kConvSetRoleUrl, {'conv': conv, 'uid': uid, 'role': role});
      final ok = r.statusCode == 200;
      Analytics.capture(ok ? 'group_role_changed' : 'group_role_change_failed',
          {'gid': conv, 'role': role, if (!ok) 'status': r.statusCode});
      return ok;
    } catch (_) {
      Analytics.capture('group_role_change_failed', {'gid': conv, 'role': role, 'reason': 'exception'});
      return false;
    }
  }

  static Future<bool> leave(String conv) async {
    try {
      final r = await ApiAuth.postJson(kConvLeaveUrl, {'conv': conv});
      final ok = r.statusCode == 200;
      Analytics.capture(ok ? 'group_left' : 'group_leave_failed',
          {'gid': conv, if (!ok) 'status': r.statusCode});
      return ok;
    } catch (_) {
      Analytics.capture('group_leave_failed', {'gid': conv, 'reason': 'exception'});
      return false;
    }
  }

  static Future<bool> deleteGroup(String conv) async {
    try {
      final r = await ApiAuth.postJson(kConvDeleteUrl, {'conv': conv});
      final ok = r.statusCode == 200;
      Analytics.capture(ok ? 'group_deleted' : 'group_delete_failed',
          {'gid': conv, if (!ok) 'status': r.statusCode});
      return ok;
    } catch (_) {
      Analytics.capture('group_delete_failed', {'gid': conv, 'reason': 'exception'});
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
      Analytics.capture('group_announce_sent', {'gid': conv});
    } catch (_) {/* best-effort */}
  }
}
