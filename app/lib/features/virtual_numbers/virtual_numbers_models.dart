import 'package:flutter/material.dart';

import '../../core/ui/avatok_dark.dart';

enum VirtualLineKind { did, avatok }

enum VirtualLineStatus {
  provisioning,
  active,
  pastDue,
  suspended,
  releasing,
  released,
  failed
}

enum VirtualActivityType {
  all,
  calls,
  recordings,
  voicemail,
  receptionist,
  otp,
  textMessages,
}

VirtualLineKind _kind(Object? value) => value.toString().toLowerCase() == 'did'
    ? VirtualLineKind.did
    : VirtualLineKind.avatok;

VirtualLineStatus _status(Object? value) {
  final raw = value.toString().toLowerCase().replaceAll('-', '_');
  return VirtualLineStatus.values.firstWhere(
    (item) =>
        item.name.toLowerCase().replaceAll('_', '') == raw.replaceAll('_', ''),
    orElse: () => VirtualLineStatus.failed,
  );
}

/// Swatch for a virtual line's `colorKey`.
///
/// [DESIGN-GUARD-DEBT-2 2026-08-31] The five hexes moved onto `AD.*` tokens.
///
/// THE FIVE KEYS ARE FROZEN. `color_key` is persisted and arrives from the
/// server (see `VirtualLine.fromJson`), so renaming or dropping one silently
/// falls every existing line back to blue. Only the VALUES changed.
///
/// Two are not exact ports, deliberately:
///   * 'teal' was `#5CB8A6` — the sea-turquoise [RAJ-INDIGO-1] retired after the
///     owner rejected it outright. Re-adding it here would quietly bring the
///     retired hue back into the app through a new feature. It is now `AD.online`
///     (`#2E7D68`), the deep green the palette actually kept.
///   * 'ink' was `#4A453E`, a warm grey with no token. It is now `AD.textPrimary`,
///     the real ink — darker, and the thing the key was already naming.
Color virtualLineColor(String key) {
  const colors = <String, Color>{
    'pink': AD.bandRani, // #C9316E
    'blue': AD.bandJodhpur, // #2E4A8C
    'amber': AD.bandHaldi, // #E9A227
    'teal': AD.online, // #2E7D68 — was the retired turquoise
    'ink': AD.textPrimary, // #16110D
  };
  return colors[key] ?? colors['blue']!;
}

class VirtualLine {
  final String id;
  final String label;
  final VirtualLineKind kind;
  final String canonicalNumber;
  final String displayNumber;
  final String? countryIso2;
  final String? region;
  final String colorKey;
  final VirtualLineStatus status;
  final Map<String, bool> capabilities;
  final bool isDefaultOutgoing;
  final int unreadCount;
  final int monthlyTokens;
  final DateTime? nextRenewalAt;
  final String? provider;

  const VirtualLine({
    required this.id,
    required this.label,
    required this.kind,
    required this.canonicalNumber,
    required this.displayNumber,
    this.countryIso2,
    this.region,
    this.colorKey = 'blue',
    this.status = VirtualLineStatus.active,
    this.capabilities = const {},
    this.isDefaultOutgoing = false,
    this.unreadCount = 0,
    this.monthlyTokens = 0,
    this.nextRenewalAt,
    this.provider,
  });

  factory VirtualLine.fromJson(Map<String, dynamic> json) {
    final rawCapabilities = json['capabilities'] ?? json['capabilities_json'];
    Map<String, bool> capabilities = {};
    if (rawCapabilities is Map) {
      capabilities =
          rawCapabilities.map((key, value) => MapEntry('$key', value == true));
    }
    final renewal = json['next_renewal_at'] ?? json['nextRenewalAt'];
    final renewalMs =
        renewal is num ? renewal.toInt() : int.tryParse('$renewal');
    return VirtualLine(
      id: '${json['id'] ?? ''}',
      label: '${json['label'] ?? 'Virtual number'}',
      kind: _kind(json['kind']),
      canonicalNumber:
          '${json['canonical_number'] ?? json['canonicalNumber'] ?? ''}',
      displayNumber:
          '${json['display_number'] ?? json['displayNumber'] ?? json['canonical_number'] ?? ''}',
      countryIso2:
          json['country_iso2']?.toString() ?? json['countryIso2']?.toString(),
      region: json['region']?.toString(),
      colorKey: '${json['color_key'] ?? json['colorKey'] ?? 'blue'}',
      status: _status(json['status']),
      capabilities: capabilities,
      isDefaultOutgoing: json['is_default_outgoing'] == true ||
          json['isDefaultOutgoing'] == true,
      unreadCount: (json['unread_count'] as num?)?.toInt() ??
          (json['unreadCount'] as num?)?.toInt() ??
          0,
      monthlyTokens: (json['monthly_tokens'] as num?)?.toInt() ??
          (json['monthlyTokens'] as num?)?.toInt() ??
          ((json['monthlyTokensSubunits'] as num?)?.toInt() ?? 0) ~/ 1000,
      nextRenewalAt: renewalMs == null
          ? null
          : DateTime.fromMillisecondsSinceEpoch(renewalMs),
      provider: json['provider']?.toString(),
    );
  }

  bool can(String capability) => capabilities[capability] == true;
  bool get isDid => kind == VirtualLineKind.did;
  bool get isActive => status == VirtualLineStatus.active;
  String get typeLabel => isDid ? 'DID number' : 'AvaTOK number';
  String get statusLabel => switch (status) {
        VirtualLineStatus.active => 'Active',
        VirtualLineStatus.provisioning => 'Setting up',
        VirtualLineStatus.pastDue => 'Past due',
        VirtualLineStatus.suspended => 'Suspended',
        VirtualLineStatus.releasing => 'Releasing',
        VirtualLineStatus.released => 'Released',
        VirtualLineStatus.failed => 'Needs attention',
      };

  VirtualLine copyWith({
    String? label,
    String? colorKey,
    VirtualLineStatus? status,
    bool? isDefaultOutgoing,
    int? unreadCount,
    Map<String, bool>? capabilities,
  }) =>
      VirtualLine(
        id: id,
        label: label ?? this.label,
        kind: kind,
        canonicalNumber: canonicalNumber,
        displayNumber: displayNumber,
        countryIso2: countryIso2,
        region: region,
        colorKey: colorKey ?? this.colorKey,
        status: status ?? this.status,
        capabilities: capabilities ?? this.capabilities,
        isDefaultOutgoing: isDefaultOutgoing ?? this.isDefaultOutgoing,
        unreadCount: unreadCount ?? this.unreadCount,
        monthlyTokens: monthlyTokens,
        nextRenewalAt: nextRenewalAt,
        provider: provider,
      );
}

class VirtualLineSettings {
  final String label;
  final String colorKey;
  final bool receptionistEnabled;
  final String personaName;
  final String language;
  final String voice;
  final String greeting;
  final String instructions;
  final String answerTiming;
  final int maxConversationMinutes;
  final bool recordCalls;
  final bool transcribeCalls;
  final bool blockUnknownCallers;

  const VirtualLineSettings({
    this.label = '',
    this.colorKey = 'blue',
    this.receptionistEnabled = false,
    this.personaName = 'Ava',
    this.language = 'Auto',
    this.voice = 'Warm',
    this.greeting = '',
    this.instructions = '',
    this.answerTiming = 'after_3_rings',
    this.maxConversationMinutes = 5,
    this.recordCalls = false,
    this.transcribeCalls = false,
    this.blockUnknownCallers = false,
  });

  factory VirtualLineSettings.fromJson(Map<String, dynamic> j) =>
      VirtualLineSettings(
        label: '${j['label'] ?? ''}',
        colorKey: '${j['color_key'] ?? j['colorKey'] ?? 'blue'}',
        receptionistEnabled: j['receptionist_enabled'] == true ||
            j['receptionistEnabled'] == true,
        personaName: '${j['persona_name'] ?? j['personaName'] ?? 'Ava'}',
        language: '${j['language'] ?? 'Auto'}',
        voice: '${j['voice'] ?? 'Warm'}',
        greeting: '${j['greeting'] ?? ''}',
        instructions: '${j['instructions'] ?? ''}',
        answerTiming:
            '${j['answer_timing'] ?? j['answerTiming'] ?? 'after_3_rings'}',
        maxConversationMinutes:
            (j['max_conversation_minutes'] as num?)?.toInt() ?? 5,
        recordCalls: j['record_calls'] == true || j['recordCalls'] == true,
        transcribeCalls:
            j['transcribe_calls'] == true || j['transcribeCalls'] == true,
        blockUnknownCallers: j['block_unknown_callers'] == true ||
            j['blockUnknownCallers'] == true,
      );

  Map<String, dynamic> toJson() => {
        'label': label,
        'color_key': colorKey,
        'receptionist_enabled': receptionistEnabled,
        'persona_name': personaName,
        'language': language,
        'voice': voice,
        'greeting': greeting,
        'instructions': instructions,
        'answer_timing': answerTiming,
        'max_conversation_minutes': maxConversationMinutes,
        'record_calls': recordCalls,
        'transcribe_calls': transcribeCalls,
        'block_unknown_callers': blockUnknownCallers,
      };
}

class VirtualLineActivity {
  final String id;
  final VirtualActivityType type;
  final String title;
  final String subtitle;
  final String direction;
  final DateTime occurredAt;
  final int durationSeconds;
  final bool unread;
  final bool hasRecording;
  final String? recordingRef;
  final String? transcript;

  const VirtualLineActivity({
    required this.id,
    required this.type,
    required this.title,
    required this.subtitle,
    required this.direction,
    required this.occurredAt,
    this.durationSeconds = 0,
    this.unread = false,
    this.hasRecording = false,
    this.recordingRef,
    this.transcript,
  });

  factory VirtualLineActivity.fromJson(Map<String, dynamic> j) {
    final raw = '${j['type'] ?? 'call.incoming'}'.toLowerCase();
    final type = raw.contains('otp')
        ? VirtualActivityType.otp
        : raw.contains('sms')
            ? VirtualActivityType.textMessages
            : raw.contains('voicemail')
                ? VirtualActivityType.voicemail
                : raw.contains('recording')
                    ? VirtualActivityType.recordings
                    : raw.contains('receptionist')
                        ? VirtualActivityType.receptionist
                        : VirtualActivityType.calls;
    final stamp = j['occurred_at'] ?? j['occurredAt'] ?? j['created_at'];
    final n = stamp is num ? stamp.toInt() : int.tryParse('$stamp') ?? 0;
    return VirtualLineActivity(
      id: '${j['id'] ?? ''}',
      type: type,
      title: '${j['title'] ?? j['remote_display'] ?? 'Unknown caller'}',
      subtitle: '${j['subtitle'] ?? j['summary'] ?? ''}',
      direction: '${j['direction'] ?? 'incoming'}',
      occurredAt:
          DateTime.fromMillisecondsSinceEpoch(n < 100000000000 ? n * 1000 : n),
      durationSeconds: (j['duration_seconds'] as num?)?.toInt() ?? 0,
      unread: j['unread'] == true,
      hasRecording: j['has_recording'] == true || j['recording_ref'] != null,
      recordingRef: j['recording_ref']?.toString(),
      transcript: j['transcript']?.toString(),
    );
  }
}
