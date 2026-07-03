import 'dart:convert';

import 'api_auth.dart';
import 'api_backoff.dart';
import 'config.dart';

/// TeamApi — Team Receptionist (IVR / auto-attendant).
/// Spec: Specs/TEAM-RECEPTIONIST-IVR-SPEC.md. A manager subscribes to a Team plan,
/// adds staff (name, role, voice, greeting, AvaTOK number); the staff list is the
/// "press 1 / press 2" menu on the team number. Staff become Pro for free, billed
/// by the team. The server is the source of truth; this is the thin client.
const String _base = 'https://$kSignalingHost/api/team';

class TeamMember {
  final String id;
  final int slot;
  final String displayName;
  final String roleLabel;
  final String? memberUid;
  final String memberNumber;
  final String voiceName;
  final String greetingText;
  final String inviteStatus; // pending | active | removed
  const TeamMember({
    required this.id,
    required this.slot,
    required this.displayName,
    required this.roleLabel,
    required this.memberUid,
    required this.memberNumber,
    required this.voiceName,
    required this.greetingText,
    required this.inviteStatus,
  });
  bool get active => inviteStatus == 'active';
  factory TeamMember.fromJson(Map<String, dynamic> j) => TeamMember(
        id: (j['id'] ?? '').toString(),
        slot: (j['slot'] as num?)?.toInt() ?? 0,
        displayName: (j['display_name'] ?? '').toString(),
        roleLabel: (j['role_label'] ?? '').toString(),
        memberUid: j['member_uid']?.toString(),
        memberNumber: (j['member_number'] ?? '').toString(),
        voiceName: (j['voice_name'] ?? 'Aoede').toString(),
        greetingText: (j['greeting_text'] ?? '').toString(),
        inviteStatus: (j['invite_status'] ?? 'pending').toString(),
      );
}

class TeamPool {
  final int used;
  final int quota;
  const TeamPool(this.used, this.quota);
  factory TeamPool.fromJson(Map<String, dynamic>? j) =>
      TeamPool((j?['used'] as num?)?.toInt() ?? 0, (j?['quota'] as num?)?.toInt() ?? 0);
  double get fraction => quota <= 0 ? 0 : (used / quota).clamp(0, 1).toDouble();
}

class Team {
  final String id;
  final String ownerUid;
  final String name;
  final String? teamNumber;
  final String greetingText;
  final int seatLimit;
  final TeamPool receptMin;
  final TeamPool aiMsg;
  final List<TeamMember> members;
  const Team({
    required this.id,
    required this.ownerUid,
    required this.name,
    required this.teamNumber,
    required this.greetingText,
    required this.seatLimit,
    required this.receptMin,
    required this.aiMsg,
    required this.members,
  });
  factory Team.fromJson(Map<String, dynamic> j) {
    final pools = (j['pools'] ?? {}) as Map<String, dynamic>;
    return Team(
      id: (j['id'] ?? '').toString(),
      ownerUid: (j['owner_uid'] ?? '').toString(),
      name: (j['name'] ?? '').toString(),
      teamNumber: j['team_number']?.toString(),
      greetingText: (j['greeting_text'] ?? '').toString(),
      seatLimit: (j['seat_limit'] as num?)?.toInt() ?? 5,
      receptMin: TeamPool.fromJson(pools['recept_min'] as Map<String, dynamic>?),
      aiMsg: TeamPool.fromJson(pools['ai_msg'] as Map<String, dynamic>?),
      members: ((j['members'] ?? []) as List)
          .map((m) => TeamMember.fromJson(m as Map<String, dynamic>))
          .toList(),
    );
  }
}

/// A voicemail card (one ended receptionist session under the team).
class TeamMessage {
  final String id;
  final String? callerUid;
  final String? callerPhone;
  final String? callerName;
  final int? slot;
  final String? message;
  final String? callback;
  final String? urgency;
  final int durationS;
  final bool hasRecording;
  final int createdAt;
  const TeamMessage({
    required this.id,
    required this.callerUid,
    required this.callerPhone,
    required this.callerName,
    required this.slot,
    required this.message,
    required this.callback,
    required this.urgency,
    required this.durationS,
    required this.hasRecording,
    required this.createdAt,
  });
  factory TeamMessage.fromJson(Map<String, dynamic> j) => TeamMessage(
        id: (j['id'] ?? '').toString(),
        callerUid: j['caller_uid']?.toString(),
        callerPhone: j['caller_phone']?.toString(),
        callerName: j['caller_name']?.toString(),
        slot: (j['slot'] as num?)?.toInt(),
        message: j['message']?.toString(),
        callback: j['callback']?.toString(),
        urgency: j['urgency']?.toString(),
        durationS: (j['duration_s'] as num?)?.toInt() ?? 0,
        hasRecording: j['has_recording'] == true,
        createdAt: (j['created_at'] as num?)?.toInt() ?? 0,
      );
}

class TeamApi {
  /// Cached "am I on a paid team?" flag for the sidebar (owner OR active member).
  /// Refreshed by [status]; lets the sidebar drop the PAID badge on the Team row.
  static bool onPaidTeam = false;

  /// Backoff state for /api/team calls (prevents 503 hammering + 422 permanent fail).
  static final _statusBackoff = ApiBackoffState('/api/team');

  /// My team as owner or member (null when none). Also updates [onPaidTeam].
  /// On 503 (feature off): exponential backoff. On 422 (validation reject): stop retrying.
  static Future<({String? role, Team? team})> status() async {
    // Skip if backoff is active (either 503 waiting or 422 permanent fail)
    if (_statusBackoff.isBackingOff || _statusBackoff.isPermanentlyFailed) {
      return (role: null, team: null);
    }

    try {
      final r = await ApiAuth.getSigned('$_base');
      if (!_statusBackoff.shouldRetry(r.statusCode)) {
        return (role: null, team: null);
      }
      if (r.statusCode != 200) return (role: null, team: null);
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      final role = j['role']?.toString();
      final teamJson = j['team'];
      final team = teamJson == null ? null : Team.fromJson(teamJson as Map<String, dynamic>);
      onPaidTeam = team != null && (role == 'owner' || role == 'member');
      return (role: role, team: team);
    } catch (_) {
      return (role: null, team: null);
    }
  }

  static Future<Team?> create(String name) async {
    try {
      final r = await ApiAuth.postJson('$_base', {'name': name});
      if (r.statusCode != 200) return null;
      onPaidTeam = true;
      return Team.fromJson((jsonDecode(r.body) as Map<String, dynamic>)['team'] as Map<String, dynamic>);
    } catch (_) {
      return null;
    }
  }

  static Future<Team?> update({String? name, String? greetingText, String? teamNumber}) async {
    try {
      final r = await ApiAuth.putJson('$_base', {
        if (name != null) 'name': name,
        if (greetingText != null) 'greeting_text': greetingText,
        if (teamNumber != null) 'team_number': teamNumber,
      });
      if (r.statusCode != 200) return null;
      return Team.fromJson((jsonDecode(r.body) as Map<String, dynamic>)['team'] as Map<String, dynamic>);
    } catch (_) {
      return null;
    }
  }

  /// Add a staff entry. Returns (ok, error) — error is a server code on failure
  /// (e.g. 'seat_limit', 'missing_fields', 'menu_full').
  static Future<({bool ok, String? error})> addMember({
    required String displayName,
    required String roleLabel,
    required String memberNumber,
    required String voiceName,
    String? greetingText,
    int? slot,
  }) async {
    try {
      final r = await ApiAuth.postJson('$_base/members', {
        'display_name': displayName,
        'role_label': roleLabel,
        'member_number': memberNumber,
        'voice_name': voiceName,
        if (greetingText != null) 'greeting_text': greetingText,
        if (slot != null) 'slot': slot,
      });
      if (r.statusCode == 200) return (ok: true, error: null);
      String? err;
      try { err = (jsonDecode(r.body) as Map<String, dynamic>)['error']?.toString(); } catch (_) {}
      return (ok: false, error: err ?? 'failed');
    } catch (_) {
      return (ok: false, error: 'network');
    }
  }

  static Future<bool> updateMember(String id, {
    String? displayName,
    String? roleLabel,
    String? voiceName,
    String? greetingText,
    int? slot,
  }) async {
    try {
      final r = await ApiAuth.putJson('$_base/members/$id', {
        if (displayName != null) 'display_name': displayName,
        if (roleLabel != null) 'role_label': roleLabel,
        if (voiceName != null) 'voice_name': voiceName,
        if (greetingText != null) 'greeting_text': greetingText,
        if (slot != null) 'slot': slot,
      });
      return r.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  static Future<bool> removeMember(String id) async {
    try {
      final r = await ApiAuth.deleteSigned('$_base/members/$id');
      return r.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  static Future<bool> acceptInvite(String teamId) async {
    try {
      final r = await ApiAuth.postJson('$_base/invite/accept', {'team_id': teamId});
      return r.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  static Future<bool> declineInvite() async {
    try {
      final r = await ApiAuth.postJson('$_base/invite/decline', {});
      return r.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  static Future<List<TeamMessage>> messages() async {
    try {
      final r = await ApiAuth.getSigned('$_base/messages');
      if (r.statusCode != 200) return [];
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      return ((j['messages'] ?? []) as List)
          .map((m) => TeamMessage.fromJson(m as Map<String, dynamic>))
          .toList();
    } catch (_) {
      return [];
    }
  }

  /// Caller: fetch the IVR menu for a dialed number. Returns null when the number
  /// is not a team number (caller should dial it directly as a 1:1 call).
  static Future<Map<String, dynamic>?> ivrMenu(String number) async {
    try {
      final r = await ApiAuth.getSigned('$_base/ivr?number=${Uri.encodeQueryComponent(number)}');
      if (r.statusCode != 200) return null;
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      return j['is_team'] == true ? j : null;
    } catch (_) {
      return null;
    }
  }

  /// URL for a spoken IVR clip (greeting+menu, or a per-slot transfer line).
  /// Requires signed auth, so fetch the bytes with ApiAuth.getSigned and play them.
  static String ivrAudioUrl(String number, {int? slot}) =>
      '$_base/ivr/audio?number=${Uri.encodeQueryComponent(number)}${slot != null ? '&slot=$slot' : ''}';

  /// Caller: resolve a tapped slot to the dial target (member uid + number).
  static Future<Map<String, dynamic>?> ivrRoute(String number, int slot) async {
    try {
      final r = await ApiAuth.postJson('$_base/ivr/route', {'number': number, 'slot': slot});
      if (r.statusCode != 200) return null;
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      return j['ok'] == true ? j : null;
    } catch (_) {
      return null;
    }
  }
}
