import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../lib/core/ui/avatok_dark.dart';
import '../lib/core/calls/call_session.dart';
import '../lib/core/calls/call_sfu_api.dart';
import '../lib/features/avatok/call_billing/messenger_call_billing_api.dart';
import '../lib/features/avatok/call_billing/messenger_call_billing_hud.dart';
import '../lib/features/avatok/call_billing/messenger_call_billing_models.dart';

void main() {
  group('MessengerCallRate', () {
    test('missing and zero rates are unavailable', () {
      expect(
        const MessengerCallRate(
          sku: MessengerCallQualitySku.videoHd,
          centitokensPerParticipantMinute: null,
        ).isAvailable,
        isFalse,
      );
      expect(
        const MessengerCallRate(
          sku: MessengerCallQualitySku.video4k,
          centitokensPerParticipantMinute: 0,
        ).isAvailable,
        isFalse,
      );
    });

    test('hourly estimate uses two connected participants', () {
      const rate = MessengerCallRate(
        sku: MessengerCallQualitySku.videoHd,
        centitokensPerParticipantMinute: 25,
      );
      expect(rate.estimatedTwoPersonTokensPerHour, 30);
    });
  });

  test('receipt parser preserves free and paid participant minutes', () {
    final receipt = MessengerCallReceipt.fromJson({
      'call_id': 'call-1',
      'authorization_id': 'auth-1',
      'media': 'audio',
      'quality_sku': 'audio',
      'provider': 'stream',
      'connected_wall_seconds': 90,
      'participant_count': 2,
      'participant_minutes': 3,
      'free_participant_minutes': 2,
      'paid_participant_minutes': 1,
      'rate_centitokens_per_participant_minute': 5,
      'price_version': 1,
      'tokens_charged': 1,
      'ended_reason': 'caller_hangup',
      'created_at': '2026-08-24T00:00:00Z',
    });

    expect(receipt.qualitySku, MessengerCallQualitySku.audio);
    expect(receipt.freeParticipantMinutes, 2);
    expect(receipt.paidParticipantMinutes, 1);
    expect(receipt.tokensCharged, 1);
    expect(receipt.providerLabel, 'GetStream');
    expect(receipt.connectedDurationLabel, '1m 30s');
  });

  test('receipt parser accepts backend aliases and epoch milliseconds', () {
    final row = <String, dynamic>{
      'call_id': 'call-2',
      'authorization_id': 'auth-2',
      'media': 'video',
      'quality_sku': 'video_hd',
      'provider': 'stream',
      'connected_wall_seconds': 60,
      'participant_seconds': 120,
      'free_participant_seconds': 0,
      'paid_participant_seconds': 120,
      'rate_centitokens_per_participant_minute': 25,
      'price_version': 2,
      'tokens_charged': 1,
      'ending_reason': 'caller_hangup',
      'created_at': 1763942400000,
    };
    final receipt = MessengerCallBillingApi.decodeReceiptForTesting(
      {'receipt': row},
    );
    expect(receipt, isNotNull);
    expect(receipt!.participantMinutes, 2);
    expect(receipt.createdAt.isUtc, isTrue);
  });

  test('receipt parser rejects malformed financial data', () {
    expect(
      () => MessengerCallReceipt.fromJson({
        'call_id': 'call-3',
        'authorization_id': 'auth-3',
        'media': 'audio',
        'quality_sku': 'audio',
        'provider': 'cloudflare',
        'connected_wall_seconds': 60,
        'participant_seconds': 120,
        'free_participant_seconds': 120,
        'paid_participant_seconds': 120,
        'rate_centitokens_per_participant_minute': 0,
        'price_version': 1,
        'tokens_charged': 0,
        'ending_reason': 'caller_hangup',
        'created_at': 'not-a-date',
      }),
      throwsFormatException,
    );
  });

  test('frozen authorization retains the billing attempt id', () {
    const authorization = MessengerCallAuthorization(
      authorizationId: 'auth-1',
      callId: 'call-1',
      payer: 'caller',
      provider: 'stream',
      qualitySku: MessengerCallQualitySku.videoHd,
      rateCentitokensPerParticipantMinute: 25,
      priceVersion: 1,
      freeParticipantSecondsRemaining: 0,
      reservedTokens: 10,
      authorizationExpiresAt: null,
      media: MessengerCallMedia.video,
      attemptId: 'attempt-1',
    );
    expect(authorization.copyWith(reservedTokens: 8).attemptId, 'attempt-1');
  });

  test('Cloudflare SFU billing join context contains identifiers only', () {
    const authorization = MessengerCallAuthorization(
      authorizationId: 'auth-sfu',
      callId: 'call-sfu',
      payer: 'caller',
      provider: 'cloudflare',
      qualitySku: MessengerCallQualitySku.audio,
      rateCentitokensPerParticipantMinute: 0,
      priceVersion: 4,
      freeParticipantSecondsRemaining: 120,
      reservedTokens: 0,
      authorizationExpiresAt: null,
      media: MessengerCallMedia.audio,
      attemptId: 'attempt-sfu',
    );
    final fields = callSfuBillingJoinFields(authorization);
    expect(fields, {
      'authorization_id': 'auth-sfu',
      'call_id': 'call-sfu',
      'attempt_id': 'attempt-sfu',
      'price_version': 4,
    });
    expect(fields.containsKey('payer'), isFalse);
    expect(fields.containsKey('provider'), isFalse);
    expect(fields.containsKey('rate_centitokens_per_participant_minute'), isFalse);
  });

  test('runtime billing state carries server warning and settlement fields', () {
    const authorization = MessengerCallAuthorization(
      authorizationId: 'auth-runtime',
      callId: 'call-runtime',
      payer: 'caller',
      provider: 'cloudflare',
      qualitySku: MessengerCallQualitySku.audio,
      rateCentitokensPerParticipantMinute: 5,
      priceVersion: 3,
      freeParticipantSecondsRemaining: 120,
      reservedTokens: 4,
      authorizationExpiresAt: null,
      media: MessengerCallMedia.audio,
    );
    const state = MessengerCallBillingRuntimeState(
      authorization: authorization,
      freeParticipantSecondsRemaining: 60,
      paidRemainingWallSeconds: 90,
      lowBalance: true,
      endReason: 'billing-renewal-failed',
    );
    expect(state.authorization.authorizationId, 'auth-runtime');
    expect(state.freeParticipantSecondsRemaining, 60);
    expect(state.paidRemainingWallSeconds, 90);
    expect(state.lowBalance, isTrue);
    expect(state.endReason, 'billing-renewal-failed');
  });

  test('runtime status decoder preserves server warnings and terminal state', () {
    const authorization = MessengerCallAuthorization(
      authorizationId: 'auth-stream-runtime',
      callId: 'call-stream-runtime',
      payer: 'caller',
      provider: 'stream',
      qualitySku: MessengerCallQualitySku.audio,
      rateCentitokensPerParticipantMinute: 5,
      priceVersion: 2,
      freeParticipantSecondsRemaining: 0,
      reservedTokens: 4,
      authorizationExpiresAt: null,
      media: MessengerCallMedia.audio,
    );
    final state = MessengerCallBillingApi.decodeRuntimeStateForTesting(
      {
        'status': 'billing_exhausted',
        'authorization_id': 'auth-stream-runtime',
        'call_id': 'call-stream-runtime',
        'paid_runway_wall_seconds': 0,
        'low_balance': true,
        'funds_exhausted': true,
        'reason': 'insufficient_balance',
      },
      authorization,
    );
    expect(state, isNotNull);
    expect(state!.lowBalance, isTrue);
    expect(state.fundsExhausted, isTrue);
    expect(state.terminal, isTrue);
    expect(state.endReason, 'insufficient_balance');
  });

  test('runtime status decoder rejects a receipt for another authorization', () {
    const authorization = MessengerCallAuthorization(
      authorizationId: 'auth-stream-runtime',
      callId: 'call-stream-runtime',
      payer: 'caller',
      provider: 'stream',
      qualitySku: MessengerCallQualitySku.audio,
      rateCentitokensPerParticipantMinute: 5,
      priceVersion: 2,
      freeParticipantSecondsRemaining: 0,
      reservedTokens: 4,
      authorizationExpiresAt: null,
      media: MessengerCallMedia.audio,
    );
    final state = MessengerCallBillingApi.decodeRuntimeStateForTesting(
      {
        'status': 'settled',
        'receipt': {
          'call_id': 'other-call',
          'authorization_id': 'other-auth',
          'media': 'audio',
          'quality_sku': 'audio',
          'provider': 'stream',
          'connected_wall_seconds': 60,
          'participant_count': 2,
          'participant_minutes': 2,
          'free_participant_minutes': 0,
          'paid_participant_minutes': 2,
          'rate_centitokens_per_participant_minute': 5,
          'price_version': 2,
          'tokens_charged': 1,
          'ended_reason': 'caller_hangup',
          'created_at': '2026-08-24T00:00:00Z',
        },
      },
      authorization,
    );
    expect(state, isNotNull);
    expect(state!.terminal, isTrue);
    expect(state.receipt, isNull);
  });

  test('billing challenge only reuses proof for the same nonce and epoch', () {
    expect(
      messengerCallBillingChallengeIsSameGeneration(
        previousNonce: 'nonce-1',
        previousEpoch: 3,
        nonce: 'nonce-1',
        epoch: 3,
      ),
      isTrue,
    );
    expect(
      messengerCallBillingChallengeIsSameGeneration(
        previousNonce: 'nonce-1',
        previousEpoch: 3,
        nonce: 'nonce-2',
        epoch: 3,
      ),
      isFalse,
    );
    expect(
      messengerCallBillingChallengeIsSameGeneration(
        previousNonce: 'nonce-1',
        previousEpoch: 3,
        nonce: 'nonce-1',
        epoch: 4,
      ),
      isFalse,
    );
  });

  group('MessengerCallBillingApi authorization decoder', () {
    Map<String, dynamic> valid({
      String media = 'audio',
      String quality = 'audio',
      String provider = 'cloudflare',
      String status = 'authorized',
      Object rate = 0,
      Object free = 28800,
      Object reserved = 0,
      Object priceVersion = 1,
      Object? expires,
    }) => {
      'authorization_id': 'auth-1',
      'call_id': 'call-1',
      'attempt_id': 'attempt-1',
      'payer': 'caller',
      'provider': provider,
      'media': media,
      'quality_sku': quality,
      'status': status,
      'rate_centitokens_per_participant_minute': rate,
      'free_participant_seconds_remaining': free,
      'reserved_tokens': reserved,
      'price_version': priceVersion,
      'authorization_expires_at':
          expires ?? DateTime.now().add(const Duration(minutes: 5)).toIso8601String(),
    };

    test('accepts a valid free audio authorization', () {
      final result = MessengerCallBillingApi.decodeAuthorizationForTesting(
        valid(),
        media: MessengerCallMedia.audio,
        requestedQuality: MessengerCallQualitySku.audio,
      );
      expect(result, isNotNull);
      expect(result!.provider, 'cloudflare');
      expect(result.rateCentitokensPerParticipantMinute, 0);
    });

    test('accepts a valid paid video authorization only on Stream', () {
      final result = MessengerCallBillingApi.decodeAuthorizationForTesting(
        valid(media: 'video', quality: 'video_hd', provider: 'stream', rate: 25),
        media: MessengerCallMedia.video,
        requestedQuality: MessengerCallQualitySku.videoHd,
      );
      expect(result, isNotNull);
      expect(result!.provider, 'stream');
      expect(result.rateCentitokensPerParticipantMinute, 25);
    });

    test('accepts paid audio only on GetStream', () {
      final result = MessengerCallBillingApi.decodeAuthorizationForTesting(
        valid(provider: 'stream', rate: 5, free: 0, reserved: 4),
        media: MessengerCallMedia.audio,
        requestedQuality: MessengerCallQualitySku.audio,
      );
      expect(result, isNotNull);
      expect(result!.provider, 'stream');
      expect(result.rateCentitokensPerParticipantMinute, 5);
    });

    test('rejects paid audio on Cloudflare and free audio on GetStream', () {
      final cloudflarePaid =
          MessengerCallBillingApi.decodeAuthorizationForTesting(
        valid(provider: 'cloudflare', rate: 5),
        media: MessengerCallMedia.audio,
        requestedQuality: MessengerCallQualitySku.audio,
      );
      final streamFree = MessengerCallBillingApi.decodeAuthorizationForTesting(
        valid(provider: 'stream', rate: 0),
        media: MessengerCallMedia.audio,
        requestedQuality: MessengerCallQualitySku.audio,
      );
      expect(cloudflarePaid, isNull);
      expect(streamFree, isNull);
    });

    test('accepts the backend nested approval shape', () {
      final backendAuthorization = valid()
        ..remove('payer')
        ..['payer_uid'] = 'user_caller'
        ..remove('reserved_tokens')
        ..['reservation_tokens'] = 4;
      final result = MessengerCallBillingApi.decodeAuthorizationForTesting(
        {'approved': true, 'authorization': backendAuthorization},
        media: MessengerCallMedia.audio,
        requestedQuality: MessengerCallQualitySku.audio,
      );
      expect(result, isNotNull);
      expect(result!.attemptId, 'attempt-1');
      expect(result.reservedTokens, 4);
    });

    test('preserves a server-issued consent challenge for the same attempt', () {
      final challenge = valid(
        status: 'pending_consent',
        provider: 'stream',
        rate: 5,
        free: 0,
        reserved: 4,
      )
        ..['consent_id'] = 'consent-server-1';
      final result = MessengerCallBillingApi.decodeConsentRequiredForTesting(
        {
          'code': 'consent_required',
          'preview': {
            'quality_sku': 'audio',
            'rate_centitokens_per_participant_minute': 5,
            'price_version': 1,
          },
          'authorization': challenge,
        },
        media: MessengerCallMedia.audio,
        requestedQuality: MessengerCallQualitySku.audio,
        attemptId: 'attempt-1',
      );
      expect(result.status, MessengerCallGateStatus.consentRequired);
      expect(result.consentId, 'consent-server-1');
      expect(result.authorization!.attemptId, 'attempt-1');
      expect(result.authorization!.status, 'pending_consent');
      expect(result.pricing!.rateFor(MessengerCallQualitySku.audio).isAvailable, isTrue);
    });

    test('rejects malformed or policy-incompatible authorization', () {
      final cases = <Map<String, dynamic>>[
        valid(quality: 'missing'),
        valid(provider: 'unknown'),
        valid(provider: 'stream'),
        valid(status: 'pending'),
        valid(priceVersion: 0),
        valid(rate: -1),
        valid(free: -1),
        valid(reserved: -1),
        (valid()..remove('authorization_expires_at')),
        valid(expires: DateTime.now().subtract(const Duration(minutes: 1)).toIso8601String()),
        valid(
          media: 'video',
          quality: 'video_hd',
          provider: 'stream',
          rate: 0,
        ),
      ];
      for (final body in cases) {
        expect(
          MessengerCallBillingApi.decodeAuthorizationForTesting(
            body,
            media: body['media'] == 'video'
                ? MessengerCallMedia.video
                : MessengerCallMedia.audio,
            requestedQuality: body['quality'] == 'video_hd'
                ? MessengerCallQualitySku.videoHd
                : MessengerCallQualitySku.audio,
          ),
          isNull,
          reason: 'malformed authorization should fail closed: $body',
        );
      }
    });
  });

  testWidgets('billing HUD renders caller-pays and low-balance state', (tester) async {
    const authorization = MessengerCallAuthorization(
      authorizationId: 'auth-1',
      callId: 'call-1',
      payer: 'caller',
      provider: 'stream',
      qualitySku: MessengerCallQualitySku.videoHd,
      rateCentitokensPerParticipantMinute: 25,
      priceVersion: 1,
      freeParticipantSecondsRemaining: 0,
      reservedTokens: 10,
      authorizationExpiresAt: null,
      media: MessengerCallMedia.video,
    );

    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: MessengerCallBillingHud(
            authorization: authorization,
            paidRemainingWallSeconds: 42,
            lowBalance: true,
          ),
        ),
      ),
    );

    expect(find.text('Low wallet balance'), findsOneWidget);
    expect(find.textContaining('You pay for both connected participants.'), findsNothing);
    expect(find.text('42s'), findsOneWidget);
    // [DESIGN-GUARD-ICONS-1] Was `Icons.account_balance_wallet`. The HUD moved
    // to Phosphor, the app's icon system, because the design guard forbids bare
    // Material `Icons.*` under `features/**`. The assertion that MATTERS is
    // unchanged and is the line below: the low-balance state tints the icon
    // with the destructive ink.
    final icon = tester.widget<Icon>(
        find.byIcon(PhosphorIcons.wallet(PhosphorIconsStyle.regular)));
    expect(icon.color, AD.destructiveInk);
  });

  testWidgets('paid audio HUD names GetStream and caller-pays rule', (tester) async {
    const authorization = MessengerCallAuthorization(
      authorizationId: 'auth-paid-audio',
      callId: 'call-paid-audio',
      payer: 'caller',
      provider: 'stream',
      qualitySku: MessengerCallQualitySku.audio,
      rateCentitokensPerParticipantMinute: 5,
      priceVersion: 1,
      freeParticipantSecondsRemaining: 0,
      reservedTokens: 4,
      authorizationExpiresAt: null,
      media: MessengerCallMedia.audio,
    );

    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: MessengerCallBillingHud(authorization: authorization),
        ),
      ),
    );

    expect(find.text('Paid audio call'), findsOneWidget);
    expect(find.text('You pay for both connected participants.'), findsOneWidget);
  });
}
