import 'dart:math' as math;

/// The media choices understood by the provider-neutral Messenger billing
/// contract. The server freezes the provider in the authorization before a
/// caller enters either the free Cloudflare or paid GetStream lane.
enum MessengerCallMedia { audio, video }

enum MessengerCallQualitySku {
  audio,
  videoSd,
  videoHd,
  video2k,
  video4k,
}

extension MessengerCallQualitySkuWire on MessengerCallQualitySku {
  String get wireName => switch (this) {
        MessengerCallQualitySku.audio => 'audio',
        MessengerCallQualitySku.videoSd => 'video_sd',
        MessengerCallQualitySku.videoHd => 'video_hd',
        MessengerCallQualitySku.video2k => 'video_2k',
        MessengerCallQualitySku.video4k => 'video_4k',
      };

  String get label => switch (this) {
        MessengerCallQualitySku.audio => 'Audio',
        MessengerCallQualitySku.videoSd => 'SD',
        MessengerCallQualitySku.videoHd => 'HD',
        MessengerCallQualitySku.video2k => '2K',
        MessengerCallQualitySku.video4k => '4K',
      };

  bool get isVideo => this != MessengerCallQualitySku.audio;

  static MessengerCallQualitySku? fromWire(Object? value) {
    final s = '$value';
    for (final sku in MessengerCallQualitySku.values) {
      if (sku.wireName == s) return sku;
    }
    return null;
  }
}

/// A remotely supplied rate.  Zero and missing rates are unavailable; they
/// are never interpreted as a free paid SKU.
class MessengerCallRate {
  const MessengerCallRate({
    required this.sku,
    required this.centitokensPerParticipantMinute,
    this.supported = true,
    this.publicCap,
  });

  final MessengerCallQualitySku sku;
  final int? centitokensPerParticipantMinute;
  final bool supported;
  final String? publicCap;

  bool get isAvailable =>
      supported &&
      centitokensPerParticipantMinute != null &&
      centitokensPerParticipantMinute! > 0;

  /// Estimate for two connected participants. This is display-only; the
  /// ledger remains the authority for actual participant time and rounding.
  int? get estimatedTwoPersonTokensPerHour {
    final rate = centitokensPerParticipantMinute;
    if (!isAvailable || rate == null) return null;
    return (rate * 60 * 2 / 100).ceil();
  }

  String get unavailableReason {
    if (!supported) return 'Not supported on this device yet';
    if (centitokensPerParticipantMinute == null) {
      return 'Pricing is not available yet';
    }
    if (centitokensPerParticipantMinute! <= 0) {
      return 'Pricing is not configured yet';
    }
    return '';
  }
}

class MessengerCallPricingCatalog {
  const MessengerCallPricingCatalog({
    required this.rates,
    this.freeParticipantSecondsRemaining = 0,
    this.spendableTokens,
    this.priceVersion = 0,
  });

  final Map<MessengerCallQualitySku, MessengerCallRate> rates;
  final int freeParticipantSecondsRemaining;
  final int? spendableTokens;
  final int priceVersion;

  MessengerCallRate rateFor(MessengerCallQualitySku sku) => rates[sku] ??
      MessengerCallRate(sku: sku, centitokensPerParticipantMinute: null);
}

class MessengerCallAuthorization {
  const MessengerCallAuthorization({
    required this.authorizationId,
    required this.callId,
    required this.payer,
    required this.provider,
    required this.qualitySku,
    required this.rateCentitokensPerParticipantMinute,
    required this.priceVersion,
    required this.freeParticipantSecondsRemaining,
    required this.reservedTokens,
    required this.authorizationExpiresAt,
    this.media,
    this.attemptId,
    this.consentId,
    this.status = 'authorized',
  });

  final String authorizationId;
  final String callId;
  final String payer;
  final String provider;
  final MessengerCallQualitySku qualitySku;
  final int rateCentitokensPerParticipantMinute;
  final int priceVersion;
  final int freeParticipantSecondsRemaining;
  final int reservedTokens;
  final DateTime? authorizationExpiresAt;
  final MessengerCallMedia? media;
  /// The client request id that produced this frozen authorization. It is
  /// carried into provider placement so billing and media cannot split into
  /// two independent attempts.
  final String? attemptId;
  /// Server-issued consent challenge bound to this authorization, never a
  /// client-generated token.
  final String? consentId;
  final String status;

  bool get isPaid => qualitySku != MessengerCallQualitySku.audio ||
      rateCentitokensPerParticipantMinute > 0;

  MessengerCallRate get rate => MessengerCallRate(
        sku: qualitySku,
        centitokensPerParticipantMinute:
            rateCentitokensPerParticipantMinute,
      );

  MessengerCallAuthorization copyWith({
    int? freeParticipantSecondsRemaining,
    int? reservedTokens,
    String? attemptId,
    String? consentId,
    String? status,
  }) =>
      MessengerCallAuthorization(
        authorizationId: authorizationId,
        callId: callId,
        payer: payer,
        provider: provider,
        qualitySku: qualitySku,
        rateCentitokensPerParticipantMinute:
            rateCentitokensPerParticipantMinute,
        priceVersion: priceVersion,
        freeParticipantSecondsRemaining:
            freeParticipantSecondsRemaining ?? this.freeParticipantSecondsRemaining,
        reservedTokens: reservedTokens ?? this.reservedTokens,
        authorizationExpiresAt: authorizationExpiresAt,
        media: media,
        attemptId: attemptId ?? this.attemptId,
        consentId: consentId ?? this.consentId,
        status: status ?? this.status,
      );
}

/// The small, server-derived slice of billing state that a live call surface
/// may render. It is deliberately separate from [MessengerCallAuthorization]:
/// the authorization is frozen at admission, while allowance, reservation and
/// terminal state can change during a session.
class MessengerCallBillingRuntimeState {
  const MessengerCallBillingRuntimeState({
    required this.authorization,
    this.freeParticipantSecondsRemaining = 0,
    this.paidRemainingWallSeconds,
    this.lowBalance = false,
    this.fundsExhausted = false,
    this.renewalFailure,
    this.endReason,
    this.receipt,
    this.terminal = false,
  });

  final MessengerCallAuthorization authorization;
  final int freeParticipantSecondsRemaining;
  final int? paidRemainingWallSeconds;
  final bool lowBalance;
  final bool fundsExhausted;
  final String? renewalFailure;
  final String? endReason;
  final MessengerCallReceipt? receipt;
  final bool terminal;

  MessengerCallBillingRuntimeState copyWith({
    int? freeParticipantSecondsRemaining,
    int? paidRemainingWallSeconds,
    bool? lowBalance,
    bool? fundsExhausted,
    String? renewalFailure,
    String? endReason,
    MessengerCallReceipt? receipt,
    bool? terminal,
  }) => MessengerCallBillingRuntimeState(
        authorization: authorization,
        freeParticipantSecondsRemaining:
            freeParticipantSecondsRemaining ?? this.freeParticipantSecondsRemaining,
        paidRemainingWallSeconds:
            paidRemainingWallSeconds ?? this.paidRemainingWallSeconds,
        lowBalance: lowBalance ?? this.lowBalance,
        fundsExhausted: fundsExhausted ?? this.fundsExhausted,
        renewalFailure: renewalFailure ?? this.renewalFailure,
        endReason: endReason ?? this.endReason,
        receipt: receipt ?? this.receipt,
        terminal: terminal ?? this.terminal,
      );
}

enum MessengerCallGateStatus {
  approved,
  consentRequired,
  refused,
}

class MessengerCallGateResult {
  const MessengerCallGateResult._({
    required this.status,
    this.authorization,
    this.code = '',
    this.message = '',
    this.consentId,
    this.pricing,
  });

  const MessengerCallGateResult.approved(MessengerCallAuthorization authorization)
      : this._(status: MessengerCallGateStatus.approved, authorization: authorization);

  const MessengerCallGateResult.consentRequired({
    required String code,
    required String message,
    MessengerCallAuthorization? authorization,
    String? consentId,
    MessengerCallPricingCatalog? pricing,
  }) : this._(
          status: MessengerCallGateStatus.consentRequired,
          code: code,
          message: message,
          authorization: authorization,
          consentId: consentId,
          pricing: pricing,
        );

  const MessengerCallGateResult.refused({
    required String code,
    required String message,
  }) : this._(status: MessengerCallGateStatus.refused, code: code, message: message);

  final MessengerCallGateStatus status;
  final MessengerCallAuthorization? authorization;
  final String code;
  final String message;
  final String? consentId;
  final MessengerCallPricingCatalog? pricing;

  bool get approved => status == MessengerCallGateStatus.approved;
}

class MessengerCallReceipt {
  const MessengerCallReceipt({
    required this.callId,
    required this.authorizationId,
    required this.media,
    required this.qualitySku,
    required this.provider,
    required this.connectedWallSeconds,
    required this.participantCount,
    required this.participantMinutes,
    required this.freeParticipantMinutes,
    required this.paidParticipantMinutes,
    required this.rateCentitokensPerParticipantMinute,
    required this.priceVersion,
    required this.tokensCharged,
    required this.endedReason,
    required this.createdAt,
    this.settlementStatus = 'settled',
  });

  final String callId;
  final String authorizationId;
  final MessengerCallMedia media;
  final MessengerCallQualitySku qualitySku;
  final String provider;
  final int connectedWallSeconds;
  final int participantCount;
  final double participantMinutes;
  final double freeParticipantMinutes;
  final double paidParticipantMinutes;
  final int rateCentitokensPerParticipantMinute;
  final int priceVersion;
  final int tokensCharged;
  final String endedReason;
  final DateTime createdAt;
  final String settlementStatus;

  String get providerLabel => provider == 'stream' ? 'GetStream' : 'Cloudflare';

  bool get isFree => tokensCharged == 0;

  factory MessengerCallReceipt.fromJson(Map<String, dynamic> json) {
    String requiredString(String key) {
      final value = json[key];
      if (value is! String || value.isEmpty) {
        throw FormatException('receipt missing $key');
      }
      return value;
    }

    int nonNegativeInteger(Object? value, String key) {
      final parsed = value is int
          ? value
          : value is num && value == value.toInt()
              ? value.toInt()
              : int.tryParse('$value');
      if (parsed == null || parsed < 0) {
        throw FormatException('receipt invalid $key');
      }
      return parsed;
    }

    double nonNegativeNumber(Object? value, String key) {
      final parsed = value is num ? value.toDouble() : double.tryParse('$value');
      if (parsed == null || !parsed.isFinite || parsed < 0) {
        throw FormatException('receipt invalid $key');
      }
      return parsed;
    }

    final callId = requiredString('call_id');
    final authorizationId = requiredString('authorization_id');
    final mediaValue = requiredString('media');
    final media = switch (mediaValue) {
      'audio' => MessengerCallMedia.audio,
      'video' => MessengerCallMedia.video,
      _ => throw FormatException('receipt invalid media'),
    };
    final sku = MessengerCallQualitySkuWire.fromWire(json['quality_sku']);
    if (sku == null || sku.isVideo != (media == MessengerCallMedia.video)) {
      throw FormatException('receipt invalid quality_sku');
    }
    final provider = requiredString('provider');
    if (provider != 'cloudflare' && provider != 'stream') {
      throw FormatException('receipt invalid provider');
    }
    final rate = nonNegativeInteger(
      json['rate_centitokens_per_participant_minute'],
      'rate_centitokens_per_participant_minute',
    );
    if (media == MessengerCallMedia.video && provider != 'stream') {
      throw FormatException('receipt invalid provider');
    }
    if (media == MessengerCallMedia.audio &&
        ((provider == 'cloudflare' && rate > 0) ||
            (provider == 'stream' && rate <= 0))) {
      throw FormatException('receipt invalid audio provider');
    }
    final connectedWallSeconds = nonNegativeInteger(
      json['connected_wall_seconds'],
      'connected_wall_seconds',
    );
    final participantCount = nonNegativeInteger(
      json['participant_count'] ?? 2,
      'participant_count',
    );
    if (participantCount != 2) throw FormatException('receipt participant count');
    final participantSeconds = nonNegativeNumber(
      json['participant_seconds'] ??
          connectedWallSeconds * participantCount,
      'participant_seconds',
    );
    final participantMinutes = nonNegativeNumber(
      json['participant_minutes'] ?? participantSeconds / 60,
      'participant_minutes',
    );
    final expectedParticipantMinutes = participantSeconds / 60;
    if ((participantMinutes - expectedParticipantMinutes).abs() > 0.000001) {
      throw FormatException('receipt participant minutes mismatch');
    }
    final freeParticipantMinutes = json['free_participant_minutes'] != null
        ? nonNegativeNumber(json['free_participant_minutes'], 'free_participant_minutes')
        : nonNegativeNumber(
            json['free_participant_seconds'] ?? 0,
            'free_participant_seconds',
          ) /
            60;
    final paidParticipantMinutes = json['paid_participant_minutes'] != null
        ? nonNegativeNumber(json['paid_participant_minutes'], 'paid_participant_minutes')
        : nonNegativeNumber(
            json['paid_participant_seconds'] ?? 0,
            'paid_participant_seconds',
          ) /
            60;
    if ((freeParticipantMinutes + paidParticipantMinutes - participantMinutes).abs() >
        0.000001) {
      throw FormatException('receipt free/paid minutes mismatch');
    }
    if (media == MessengerCallMedia.video && rate <= 0) {
      throw FormatException('receipt video rate must be positive');
    }
    final priceVersion = nonNegativeInteger(json['price_version'], 'price_version');
    if (priceVersion <= 0) throw FormatException('receipt price_version');
    final tokensCharged = nonNegativeInteger(json['tokens_charged'], 'tokens_charged');
    final endedReason = '${json['ended_reason'] ?? json['ending_reason'] ?? ''}';
    if (endedReason.isEmpty) throw FormatException('receipt ending_reason');
    final createdAt = _receiptDateTime(json['created_at']);
    return MessengerCallReceipt(
      callId: callId,
      authorizationId: authorizationId,
      media: media,
      qualitySku: sku,
      provider: provider,
      connectedWallSeconds: connectedWallSeconds,
      participantCount: participantCount,
      participantMinutes: participantMinutes,
      freeParticipantMinutes: freeParticipantMinutes,
      paidParticipantMinutes: paidParticipantMinutes,
      rateCentitokensPerParticipantMinute: rate,
      priceVersion: priceVersion,
      tokensCharged: tokensCharged,
      endedReason: endedReason,
      createdAt: createdAt,
      settlementStatus: '${json['settlement_status'] ?? 'settled'}',
    );
  }

  static DateTime _receiptDateTime(Object? value) {
    if (value is num && value.isFinite) {
      final integer = value.toInt();
      if (value != integer || integer < 0) {
        throw const FormatException('receipt invalid created_at');
      }
      final millis = integer < 100000000000 ? integer * 1000 : integer;
      return DateTime.fromMillisecondsSinceEpoch(millis, isUtc: true);
    }
    if (value is String) {
      final parsed = DateTime.tryParse(value);
      if (parsed != null) return parsed.toUtc();
    }
    throw const FormatException('receipt invalid created_at');
  }

  String get connectedDurationLabel {
    final d = Duration(seconds: math.max(0, connectedWallSeconds));
    final h = d.inHours;
    final m = d.inMinutes.remainder(60);
    final s = d.inSeconds.remainder(60);
    if (h > 0) return '${h}h ${m}m';
    if (m > 0) return '${m}m ${s}s';
    return '${s}s';
  }
}

class MessengerCallConsentResult {
  const MessengerCallConsentResult.accepted({this.qualitySku})
      : consentId = null,
        _accepted = true;
  const MessengerCallConsentResult.cancelled()
      : consentId = null,
        qualitySku = null,
        _accepted = false;

  final String? consentId;
  final MessengerCallQualitySku? qualitySku;
  final bool _accepted;
  bool get accepted => _accepted;
}
