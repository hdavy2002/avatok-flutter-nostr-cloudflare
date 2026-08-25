import 'package:uuid/uuid.dart';

import '../../../core/analytics.dart';
import 'messenger_call_billing_api.dart';
import 'messenger_call_billing_models.dart';

/// Shared pre-provider gate for every Messenger audio/video entry point.
///
/// The gate owns no media transport and has no wallet debit capability. It
/// returns the server's frozen authorization so a caller can pass it to either
/// provider adapter without changing the payer, rate or SKU.
class MessengerCallBillingGate {
  MessengerCallBillingGate._();

  static const Uuid _uuid = Uuid();

  static String newAttemptId() => _uuid.v4();

  static Future<MessengerCallPricingCatalog> pricing({
    MessengerCallMedia? media,
  }) async {
    final catalog = await MessengerCallBillingApi.fetchPricing(media: media);
    _track('messenger_call_pricing_loaded', {
      'price_version': catalog.priceVersion,
      'available_skus': catalog.rates.values.where((r) => r.isAvailable).length,
    });
    return catalog;
  }

  static Future<MessengerCallGateResult> authorize({
    required String calleeUid,
    required MessengerCallMedia media,
    MessengerCallQualitySku? qualitySku,
    required String attemptId,
    String? consentId,
  }) async {
    final sku = qualitySku ??
        (media == MessengerCallMedia.video
            ? MessengerCallQualitySku.videoHd
            : MessengerCallQualitySku.audio);
    _track('messenger_call_authorization_requested', {
      'attempt_id': attemptId,
      'media': media.name,
      'quality_sku': sku.wireName,
    });
    try {
      final result = await MessengerCallBillingApi.authorize(
        calleeUid: calleeUid,
        media: media,
        qualitySku: sku,
        attemptId: attemptId,
        consentId: consentId,
      );
      _track('messenger_call_authorization_result', {
        'attempt_id': attemptId,
        'media': media.name,
        'quality_sku': sku.wireName,
        'status': result.status.name,
        'code': result.code,
      });
      return result;
    } catch (_) {
      const result = MessengerCallGateResult.refused(
        code: 'authorization_unavailable',
        message: 'Calling is temporarily unavailable. Please try again.',
      );
      _track('messenger_call_authorization_result', {
        'attempt_id': attemptId,
        'media': media.name,
        'quality_sku': sku.wireName,
        'status': result.status.name,
        'code': result.code,
      });
      return result;
    }
  }

  static void _track(String event, Map<String, Object> properties) {
    try {
      Analytics.capture(event, properties);
    } catch (_) {
      // Billing telemetry is diagnostic and must never affect call admission.
    }
  }
}
