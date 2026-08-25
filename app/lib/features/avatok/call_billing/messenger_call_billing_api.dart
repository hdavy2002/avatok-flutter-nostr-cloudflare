import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/foundation.dart' show visibleForTesting;

import '../../../core/api_auth.dart';
import '../../../core/config.dart';
import 'messenger_call_billing_models.dart';

/// Client contract for the provider-neutral Messenger billing gate.
///
/// This file deliberately does not create or join a media call. A future
/// provider adapter must receive the returned authorization and may proceed
/// only after this contract approves the attempt.
class MessengerCallBillingApi {
  MessengerCallBillingApi._();

  static const String authorizeUrl = '$kApiBase/messenger-calls/authorize';
  static const String pricingUrl = '$kApiBase/messenger-calls/pricing';
  static const String statusUrl = '$kApiBase/messenger-calls/status';
  static const String receiptUrl = '$kApiBase/messenger-calls/receipt';

  /// Fetches the server-owned catalog for the consent sheet. Missing or zero
  /// rates remain unavailable; this method never supplies a client fallback.
  static Future<MessengerCallPricingCatalog> fetchPricing({
    MessengerCallMedia? media,
  }) async {
    try {
      final response = await ApiAuth.getSigned(
        media == MessengerCallMedia.video
            ? '$pricingUrl?media=video'
            : pricingUrl,
      );
      var catalog = _pricingFromResponse(response);
      if (media == MessengerCallMedia.video && !_hasAllVideoRates(catalog)) {
        // Older Workers expose one flat preview per quality. Prefer the full
        // catalog when present, but remain wire-compatible while the endpoint
        // is rolled out by composing the four immutable previews.
        final previews = await Future.wait(
          [
            MessengerCallQualitySku.videoSd,
            MessengerCallQualitySku.videoHd,
            MessengerCallQualitySku.video2k,
            MessengerCallQualitySku.video4k,
          ].map((sku) async {
            try {
              final quality = sku.wireName.replaceFirst('video_', '');
              return _pricingFromResponse(await ApiAuth.getSigned(
                '$pricingUrl?media=video&quality=$quality',
              ));
            } catch (_) {
              return const MessengerCallPricingCatalog(rates: {});
            }
          }),
        );
        catalog = _mergePricing([catalog, ...previews]);
      }
      return catalog;
    } catch (_) {
      // Transport/auth failures are unavailable pricing, never free pricing.
    }
    return const MessengerCallPricingCatalog(rates: {});
  }

  static MessengerCallPricingCatalog _pricingFromResponse(dynamic response) {
    if (response.statusCode != 200) {
      return const MessengerCallPricingCatalog(rates: {});
    }
    try {
      final decoded = jsonDecode(response.body);
      if (decoded is Map) return _pricingFromJson(decoded.cast<String, dynamic>());
    } catch (_) {
      // A failed catalog is an unavailable catalog, never free pricing.
    }
    return const MessengerCallPricingCatalog(rates: {});
  }

  static bool _hasAllVideoRates(MessengerCallPricingCatalog catalog) =>
      const [
        MessengerCallQualitySku.videoSd,
        MessengerCallQualitySku.videoHd,
        MessengerCallQualitySku.video2k,
        MessengerCallQualitySku.video4k,
      ].every((sku) => catalog.rateFor(sku).isAvailable);

  static MessengerCallPricingCatalog _mergePricing(
    Iterable<MessengerCallPricingCatalog> catalogs,
  ) {
    final rates = <MessengerCallQualitySku, MessengerCallRate>{};
    var freeSeconds = 0;
    int? spendableTokens;
    var priceVersion = 0;
    for (final catalog in catalogs) {
      rates.addAll(catalog.rates);
      freeSeconds = math.max(freeSeconds, catalog.freeParticipantSecondsRemaining);
      spendableTokens ??= catalog.spendableTokens;
      priceVersion = math.max(priceVersion, catalog.priceVersion);
    }
    return MessengerCallPricingCatalog(
      rates: rates,
      freeParticipantSecondsRemaining: freeSeconds,
      spendableTokens: spendableTokens,
      priceVersion: priceVersion,
    );
  }

  static Future<MessengerCallGateResult> authorize({
    required String calleeUid,
    required MessengerCallMedia media,
    required MessengerCallQualitySku qualitySku,
    required String attemptId,
    String? consentId,
  }) async {
    if (calleeUid.isEmpty || attemptId.isEmpty) {
      return const MessengerCallGateResult.refused(
        code: 'invalid_request',
        message: 'This call could not be prepared. Please try again.',
      );
    }

    final response = await ApiAuth.postJsonH(
      authorizeUrl,
      <String, Object?>{
        'callee_uid': calleeUid,
        'media': media == MessengerCallMedia.video ? 'video' : 'audio',
        'quality': media == MessengerCallMedia.video
            ? qualitySku.wireName.replaceFirst('video_', '')
            : 'audio',
        'attempt_id': attemptId,
        if (consentId != null && consentId.isNotEmpty) 'consent_id': consentId,
      },
      const <String, String>{},
    );

    Map<String, dynamic> body = const <String, dynamic>{};
    try {
      final decoded = jsonDecode(response.body);
      if (decoded is Map) body = decoded.cast<String, dynamic>();
    } catch (_) {
      // ApiAuth records the transport/HTTP failure; callers receive a typed
      // refusal rather than attempting provider work on malformed JSON.
    }

    if (response.statusCode == 200 && body['approved'] == true) {
      final authorization = _authorizationFromJson(
        _nestedAuthorization(body),
        media: media,
        requestedQuality: qualitySku,
      );
      if (authorization == null) {
        return const MessengerCallGateResult.refused(
          code: 'invalid_authorization',
          message: 'This call could not be authorized. Please try again.',
        );
      }
      return MessengerCallGateResult.approved(
        // The request id is authoritative even when the response omits it;
        // provider placement must reuse this exact billing attempt.
        authorization.copyWith(attemptId: attemptId),
      );
    }

    final code = '${body['code'] ?? body['error'] ?? 'authorization_refused'}';
    final message = '${body['message'] ?? _fallbackMessage(code, response.statusCode)}';
    if (code == 'consent_required') {
      final challenge = _authorizationFromJson(
        _nestedAuthorization(body),
        media: media,
        requestedQuality: qualitySku,
        allowPendingConsent: true,
      );
      final challengeConsentId = challenge?.consentId;
      if (challenge == null ||
          challengeConsentId == null ||
          challengeConsentId.isEmpty) {
        return const MessengerCallGateResult.refused(
          code: 'invalid_consent_challenge',
          message: 'This call could not be prepared. Please try again.',
        );
      }
      return MessengerCallGateResult.consentRequired(
        code: code,
        message: message,
        authorization: challenge.copyWith(attemptId: attemptId),
        consentId: challengeConsentId,
        pricing: _pricingFromJson(body['preview'] is Map
            ? (body['preview'] as Map).cast<String, dynamic>()
            : body),
      );
    }
    return MessengerCallGateResult.refused(code: code, message: message);
  }

  /// Receipt reads are intentionally separate from authorization. A missing
  /// receipt must not be treated as permission to debit or to retry settlement.
  static Future<MessengerCallReceipt?> fetchReceipt(String authorizationId) async {
    if (authorizationId.isEmpty) return null;
    final url = '$receiptUrl?authorization_id=${Uri.encodeQueryComponent(authorizationId)}';
    final response = await ApiAuth.getSigned(url);
    if (response.statusCode != 200) return null;
    try {
      final decoded = jsonDecode(response.body);
      if (decoded is Map) {
        return decodeReceiptForTesting(decoded.cast<String, dynamic>());
      }
    } catch (_) {
      // A receipt screen can show the locally held terminal state while the
      // server read is retried; malformed data is never presented as money.
    }
    return null;
  }

  /// Reads server-owned runtime billing state for a Stream call. This is a
  /// status snapshot only: the client never derives balance, time, or charges
  /// from its own timer. Older Workers may not expose this endpoint yet, so a
  /// transport/404 response is simply an unavailable snapshot.
  static Future<MessengerCallBillingRuntimeState?> fetchRuntimeState(
    MessengerCallAuthorization authorization,
  ) async {
    if (authorization.authorizationId.isEmpty) return null;
    try {
      final response = await ApiAuth.getSigned(
        '$statusUrl?authorization_id=${Uri.encodeQueryComponent(authorization.authorizationId)}',
      );
      if (response.statusCode != 200) return null;
      final decoded = jsonDecode(response.body);
      if (decoded is! Map) return null;
      return decodeRuntimeStateForTesting(
        decoded.cast<String, dynamic>(),
        authorization,
      );
    } catch (_) {
      return null;
    }
  }

  @visibleForTesting
  static MessengerCallBillingRuntimeState? decodeRuntimeStateForTesting(
    Map<String, dynamic> root,
    MessengerCallAuthorization authorization,
  ) {
    final nested = root['status'] ?? root['billing_status'] ?? root['state'];
    final payload = nested is Map
        ? nested.cast<String, dynamic>()
        : root;
    final nestedAuthorization = payload['authorization'];
    final rootAuthorizationId = '${payload['authorization_id'] ?? root['authorization_id'] ?? ''}';
    final rootCallId = '${payload['call_id'] ?? root['call_id'] ?? ''}';
    if (rootAuthorizationId.isNotEmpty &&
        rootAuthorizationId != authorization.authorizationId) {
      return null;
    }
    if (rootCallId.isNotEmpty && rootCallId != authorization.callId) {
      return null;
    }
    if (nestedAuthorization is Map) {
      final nestedId = '${nestedAuthorization['authorization_id'] ?? ''}';
      if (nestedId.isNotEmpty && nestedId != authorization.authorizationId) {
        return null;
      }
    }

    int? nonNegativeInteger(Object? value) {
      if (value is int) return value >= 0 ? value : null;
      if (value is num && value == value.toInt()) {
        return value.toInt() >= 0 ? value.toInt() : null;
      }
      final parsed = int.tryParse('$value');
      return parsed != null && parsed >= 0 ? parsed : null;
    }

    final free = nonNegativeInteger(
          payload['free_participant_seconds_remaining'] ??
              payload['allowance_remaining_participant_seconds'],
        ) ??
        authorization.freeParticipantSecondsRemaining;
    final paid = nonNegativeInteger(
      payload['paid_remaining_wall_seconds'] ??
          payload['remaining_paid_wall_seconds'] ??
          payload['paid_runway_wall_seconds'],
    );
    final status =
        '${payload['status'] ?? payload['billing_status'] ?? root['status'] ?? ''}';
    final reason = '${payload['reason'] ?? payload['ending_reason'] ?? payload['end_reason'] ?? ''}';
    final renewalFailure = payload['renewal_failed'] == true ||
        status == 'renewal_failed' ||
        status == 'billing_renewal_failed';
    final exhausted = payload['funds_exhausted'] == true ||
        payload['exhausted'] == true ||
        status == 'funds_exhausted' ||
        status == 'billing_exhausted';
    final receiptRaw = payload['receipt'] ?? root['receipt'];
    MessengerCallReceipt? receipt;
    if (receiptRaw is Map) {
      final candidate = decodeReceiptForTesting(
        receiptRaw.cast<String, dynamic>(),
      );
      if (candidate != null &&
          candidate.authorizationId == authorization.authorizationId &&
          candidate.callId == authorization.callId) {
        receipt = candidate;
      }
    }
    final terminal = payload['terminal'] == true ||
        payload['terminal_state'] == true ||
        renewalFailure ||
        exhausted ||
        const {
          'ended',
          'settled',
          'expired',
          'cancelled',
          'failed',
          'reconciliation_pending',
        }.contains(status);
    if (terminal && reason.isEmpty && receipt == null && status.isEmpty) {
      return null;
    }
    return MessengerCallBillingRuntimeState(
      authorization: authorization,
      freeParticipantSecondsRemaining: free,
      paidRemainingWallSeconds: paid,
      lowBalance: payload['low_balance'] == true ||
          payload['warning'] == true,
      fundsExhausted: exhausted,
      renewalFailure: renewalFailure ? (reason.isEmpty ? status : reason) : null,
      endReason: reason.isEmpty ? (terminal ? status : null) : reason,
      receipt: receipt,
      terminal: terminal,
    );
  }

  @visibleForTesting
  static MessengerCallReceipt? decodeReceiptForTesting(
    Map<String, dynamic> root,
  ) {
    try {
      final receipt = root['receipt'];
      final row = receipt is Map
          ? receipt.cast<String, dynamic>()
          : root;
      return MessengerCallReceipt.fromJson(row);
    } catch (_) {
      return null;
    }
  }

  static Map<String, dynamic> _nestedAuthorization(
    Map<String, dynamic> body,
  ) {
    final nested = body['authorization'];
    if (nested is Map) return nested.cast<String, dynamic>();
    return body;
  }

  static MessengerCallAuthorization? _authorizationFromJson(
    Map<String, dynamic> json, {
    required MessengerCallMedia media,
    required MessengerCallQualitySku requestedQuality,
    bool allowPendingConsent = false,
  }) {
    final sku = MessengerCallQualitySkuWire.fromWire(json['quality_sku']);
    if (sku == null || sku != requestedQuality) return null;
    final responseMedia = switch ('${json['media'] ?? ''}') {
      'audio' => MessengerCallMedia.audio,
      'video' => MessengerCallMedia.video,
      _ => null,
    };
    if (responseMedia == null || responseMedia != media || sku.isVideo != (media == MessengerCallMedia.video)) {
      return null;
    }
    final provider = '${json['provider'] ?? ''}';
    if (provider != 'stream' && provider != 'cloudflare') return null;
    // Free Messenger audio is Cloudflare; paid audio is GetStream. The server
    // chooses which side of that boundary applies to this authorization.
    if (media == MessengerCallMedia.audio &&
        ((provider == 'cloudflare' && rateIsPaid(json)) ||
            (provider == 'stream' && !rateIsPaid(json)))) return null;
    if (media == MessengerCallMedia.video && provider != 'stream') return null;
    final payer = '${json['payer'] ?? ''}';
    final payerUid = '${json['payer_uid'] ?? ''}';
    if (payer != 'caller' && payerUid.isEmpty) return null;
    final status = '${json['status'] ?? ''}';
    if (status != 'authorized' &&
        !(allowPendingConsent && status == 'pending_consent')) {
      return null;
    }
    final callId = '${json['call_id'] ?? ''}';
    final authorizationId = '${json['authorization_id'] ?? ''}';
    if (callId.isEmpty || authorizationId.isEmpty) return null;
    int? nonNegativeInteger(Object? value) {
      if (value is int) return value >= 0 ? value : null;
      if (value is num) {
        final integer = value.toInt();
        return value == integer && integer >= 0 ? integer : null;
      }
      final parsed = int.tryParse('$value');
      return parsed != null && parsed >= 0 ? parsed : null;
    }
    final expiresRaw = json['authorization_expires_at'] ?? json['expires_at'];
    DateTime? expires;
    if (expiresRaw is num) {
      final rawInteger = nonNegativeInteger(expiresRaw);
      if (rawInteger == null) return null;
      final millis = rawInteger < 100000000000 ? rawInteger * 1000 : rawInteger;
      expires = DateTime.fromMillisecondsSinceEpoch(millis);
    } else if (expiresRaw != null) {
      expires = DateTime.tryParse('$expiresRaw');
    }
    if (expires == null || !expires.isAfter(DateTime.now())) return null;
    final rate = nonNegativeInteger(json['rate_centitokens_per_participant_minute']);
    final priceVersion = nonNegativeInteger(json['price_version']);
    final freeRaw = json['free_participant_seconds_remaining'] ??
        json['allowance_remaining_participant_seconds'];
    final reservedRaw = json['reserved_tokens'] ?? json['reservation_tokens'];
    final freeSeconds = freeRaw == null && allowPendingConsent
        ? 0
        : nonNegativeInteger(freeRaw);
    final reservedTokens = reservedRaw == null && allowPendingConsent
        ? 0
        : nonNegativeInteger(reservedRaw);
    if (rate == null || priceVersion == null || priceVersion <= 0 ||
        freeSeconds == null || reservedTokens == null) {
      return null;
    }
    if (media == MessengerCallMedia.video && rate <= 0) return null;
    return MessengerCallAuthorization(
      authorizationId: authorizationId,
      callId: callId,
      payer: 'caller',
      provider: provider,
      qualitySku: sku,
      rateCentitokensPerParticipantMinute: rate,
      priceVersion: priceVersion,
      freeParticipantSecondsRemaining: freeSeconds,
      reservedTokens: reservedTokens,
      authorizationExpiresAt: expires,
      media: media,
      attemptId: '${json['attempt_id'] ?? ''}'.isEmpty
          ? null
          : '${json['attempt_id']}',
      consentId: '${json['consent_id'] ?? ''}'.isEmpty
          ? null
          : '${json['consent_id']}',
      status: status,
    );
  }

  static bool rateIsPaid(Map<String, dynamic> json) {
    final raw = json['rate_centitokens_per_participant_minute'];
    final rate = raw is num ? raw.toInt() : int.tryParse('$raw');
    return rate != null && rate > 0;
  }

  /// Exposes the strict wire decoder to contract tests without making it a
  /// production integration point. Provider adapters still call [authorize].
  @visibleForTesting
  static MessengerCallAuthorization? decodeAuthorizationForTesting(
    Map<String, dynamic> json, {
    required MessengerCallMedia media,
    required MessengerCallQualitySku requestedQuality,
    bool allowPendingConsent = false,
  }) =>
    _authorizationFromJson(
        _nestedAuthorization(json),
        media: media,
        requestedQuality: requestedQuality,
        allowPendingConsent: allowPendingConsent,
      );

  @visibleForTesting
  static MessengerCallGateResult decodeConsentRequiredForTesting(
    Map<String, dynamic> json, {
    required MessengerCallMedia media,
    required MessengerCallQualitySku requestedQuality,
    required String attemptId,
  }) {
    final challenge = _authorizationFromJson(
      _nestedAuthorization(json),
      media: media,
      requestedQuality: requestedQuality,
      allowPendingConsent: true,
    );
    final consentId = challenge?.consentId;
    if (challenge == null || consentId == null || consentId.isEmpty) {
      return const MessengerCallGateResult.refused(
        code: 'invalid_consent_challenge',
        message: 'This call could not be prepared. Please try again.',
      );
    }
    return MessengerCallGateResult.consentRequired(
      code: 'consent_required',
      message: 'Please review the call cost before continuing.',
      authorization: challenge.copyWith(attemptId: attemptId),
      consentId: consentId,
      pricing: _pricingFromJson(json['preview'] is Map
          ? (json['preview'] as Map).cast<String, dynamic>()
          : json),
    );
  }

  static MessengerCallPricingCatalog _pricingFromJson(Map<String, dynamic> json) {
    final raw = json['rates'] ?? json['pricing'];
    final rates = <MessengerCallQualitySku, MessengerCallRate>{};
    if (raw is Map) {
      for (final sku in MessengerCallQualitySku.values) {
        final shortName = sku.isVideo
            ? sku.wireName.replaceFirst('video_', '')
            : sku.wireName;
        final value = raw[sku.wireName] ?? raw[shortName];
        if (value is Map) {
          final rate = value['centitokens_per_participant_minute'] ??
              value['rate_centitokens_per_participant_minute'];
          rates[sku] = MessengerCallRate(
            sku: sku,
            centitokensPerParticipantMinute: _intOrNull(rate),
            supported: value['supported'] != false,
            publicCap: value['public_cap']?.toString(),
          );
        } else {
          rates[sku] = MessengerCallRate(
            sku: sku,
            centitokensPerParticipantMinute: _intOrNull(value),
          );
        }
      }
    }
    final flatSku = MessengerCallQualitySkuWire.fromWire(json['quality_sku']);
    if (flatSku != null) {
      rates[flatSku] = MessengerCallRate(
        sku: flatSku,
        centitokensPerParticipantMinute: _intOrNull(
          json['rate_centitokens_per_participant_minute'],
        ),
      );
    }
    final flatRates = <MessengerCallQualitySku, Object?>{
      MessengerCallQualitySku.audio:
          json['audio_rate_centitokens_per_participant_minute'],
      MessengerCallQualitySku.videoSd:
          json['video_sd_rate_centitokens_per_participant_minute'],
      MessengerCallQualitySku.videoHd:
          json['video_hd_rate_centitokens_per_participant_minute'],
      MessengerCallQualitySku.video2k:
          json['video_2k_rate_centitokens_per_participant_minute'],
      MessengerCallQualitySku.video4k:
          json['video_4k_rate_centitokens_per_participant_minute'],
    };
    for (final entry in flatRates.entries) {
      if (entry.value != null) {
        rates[entry.key] = MessengerCallRate(
          sku: entry.key,
          centitokensPerParticipantMinute: _intOrNull(entry.value),
        );
      }
    }
    return MessengerCallPricingCatalog(
      rates: rates,
      freeParticipantSecondsRemaining:
          _intOrNull(json['free_participant_seconds_remaining'] ??
                  json['daily_audio_allowance_participant_seconds']) ??
              0,
      spendableTokens: _intOrNull(json['spendable_tokens']),
      priceVersion: _intOrNull(json['price_version']) ?? 0,
    );
  }

  static int? _intOrNull(Object? value) => value is num
      ? value.toInt()
      : value == null
          ? null
          : int.tryParse('$value');

  static String _fallbackMessage(String code, int status) => switch (code) {
        'insufficient_balance' => 'There are not enough tokens to start this call.',
        'quality_unavailable' || 'pricing_unavailable' =>
          'This video quality is not available right now.',
        'billing_disabled' => 'Calling payments are not available right now.',
        'consent_required' => 'Please review the call cost before continuing.',
        _ when status >= 500 => 'Calling is temporarily unavailable. Please try again.',
        _ => 'This call could not be authorized. Please try again.',
      };
}
