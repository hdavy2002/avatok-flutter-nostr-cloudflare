import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../features/avatok/contacts.dart';
import 'account_storage.dart';
import 'analytics.dart';
import 'api_auth.dart';
import 'config.dart';

/// The client-side state used by the universal AvaCalls dialpad.  The server
/// remains the routing authority; these values only describe what the UI may
/// show while admission is being prepared.
enum AvaCallsDestinationState {
  empty,
  resolving,
  avatok,
  pstn,
  noDid,
  insufficientWallet,
  unsupported,
  offline,
}

enum AvaCallsNumberKind { avatok, pstn }

/// A line that can be selected as the caller ID for a PSTN call.
@immutable
class AvaCallsLine {
  final String id;
  final String kind;
  final String canonicalNumber;
  final String displayNumber;
  final String label;
  final String countryIso2;
  final String status;
  final bool defaultOutgoing;
  final Map<String, dynamic> capabilities;

  const AvaCallsLine({
    required this.id,
    required this.kind,
    required this.canonicalNumber,
    required this.displayNumber,
    required this.label,
    required this.countryIso2,
    required this.status,
    required this.defaultOutgoing,
    required this.capabilities,
  });

  factory AvaCallsLine.fromJson(Map<String, dynamic> json) {
    final caps = json['capabilities'];
    return AvaCallsLine(
      id: '${json['id'] ?? json['line_id'] ?? ''}',
      kind: '${json['kind'] ?? 'did'}',
      canonicalNumber:
          '${json['canonical_number'] ?? json['canonicalNumber'] ?? json['number'] ?? ''}',
      displayNumber:
          '${json['display_number'] ?? json['displayNumber'] ?? json['number'] ?? ''}',
      label: '${json['label'] ?? ''}',
      countryIso2:
          '${json['country_iso2'] ?? json['countryIso2'] ?? ''}'.toUpperCase(),
      status: '${json['status'] ?? 'active'}',
      defaultOutgoing: json['is_default_outgoing'] == true ||
          json['is_default_outgoing'] == 1 ||
          json['default_outgoing'] == true ||
          json['defaultOutgoing'] == true,
      capabilities: caps is Map
          ? Map<String, dynamic>.from(caps)
          : const <String, dynamic>{},
    );
  }

  bool get isActive => status == 'active';

  bool get canPlaceOutbound =>
      isActive &&
      kind == 'did' &&
      (capabilities['outbound_caller_id'] == true ||
          capabilities['outboundCallerId'] == true ||
          // Older line payloads predate capability JSON. The server still
          // validates this at admission, so this is display-only fallback.
          capabilities.isEmpty);
}

/// Result of resolving one exact destination. No directory search data is
/// represented here: an AvaTOK result contains only the callable contact.
@immutable
class AvaCallsDestination {
  final AvaCallsDestinationState state;
  final AvaCallsNumberKind? kind;
  final String rawInput;
  final String canonicalNumber;
  final String countryIso2;
  final String countryName;
  final Contact? contact;
  final AvaCallsLine? outgoingLine;
  final String? message;
  final int walletSubunits;
  final double pstnTokensPerMinute;

  const AvaCallsDestination({
    required this.state,
    required this.kind,
    required this.rawInput,
    required this.canonicalNumber,
    this.countryIso2 = '',
    this.countryName = '',
    this.contact,
    this.outgoingLine,
    this.message,
    this.walletSubunits = 0,
    this.pstnTokensPerMinute = 0.50,
  });

  bool get canCall =>
      state == AvaCallsDestinationState.avatok ||
      state == AvaCallsDestinationState.pstn;

  AvaCallsDestination copyWith({
    AvaCallsDestinationState? state,
    AvaCallsLine? outgoingLine,
    String? message,
  }) =>
      AvaCallsDestination(
        state: state ?? this.state,
        kind: kind,
        rawInput: rawInput,
        canonicalNumber: canonicalNumber,
        countryIso2: countryIso2,
        countryName: countryName,
        contact: contact,
        outgoingLine: outgoingLine ?? this.outgoingLine,
        message: message ?? this.message,
        walletSubunits: walletSubunits,
        pstnTokensPerMinute: pstnTokensPerMinute,
      );
}

/// Lightweight E.164 normalisation shared by the dialpad and paste flows.
/// It intentionally does not claim to validate every national numbering plan;
/// the Worker performs canonical validation and country restrictions at call
/// admission. The locale is only used to add the common national prefix.
class AvaCallsNumberNormalizer {
  AvaCallsNumberNormalizer._();

  static String? normalize(String raw, {String? region}) {
    var value = raw.trim();
    if (value.isEmpty) return null;
    final isInternational = value.startsWith('+') || value.startsWith('00');
    var digits = value.replaceAll(RegExp(r'[^0-9]'), '');
    if (value.startsWith('00')) {
      if (digits.startsWith('00')) digits = digits.substring(2);
    } else if (!isInternational && digits.startsWith('0')) {
      final dialCode =
          _countryDialCodes[(region ?? _deviceRegion()).toUpperCase()];
      if (dialCode != null) digits = '$dialCode${digits.substring(1)}';
    } else if (!isInternational) {
      // Keep AvaTOK numbers and already-complete national numbers intact. The
      // exact resolver decides whether the value is an AvaTOK identity.
      final dialCode =
          _countryDialCodes[(region ?? _deviceRegion()).toUpperCase()];
      if (dialCode != null && digits.length <= 10) digits = '$dialCode$digits';
    }
    if (digits.length < 4 || digits.length > 15) return null;
    return '+$digits';
  }

  static String _deviceRegion() =>
      WidgetsBinding.instance.platformDispatcher.locale.countryCode ?? 'IN';

  // Covers the regions most commonly used by the app while retaining a
  // server-side validator for all other countries.
  static const _countryDialCodes = <String, String>{
    'IN': '91',
    'US': '1',
    'CA': '1',
    'GB': '44',
    'AU': '61',
    'NZ': '64',
    'AE': '971',
    'SA': '966',
    'SG': '65',
    'GH': '233',
    'NG': '234',
    'KE': '254',
    'ZA': '27',
    'DE': '49',
    'FR': '33',
    'IT': '39',
    'ES': '34',
    'BR': '55',
    'MX': '52',
    'JP': '81',
    'CN': '86',
  };
}

class AvaCallsApiException implements Exception {
  final String code;
  final String message;
  final bool retryable;
  const AvaCallsApiException(this.code, this.message, {this.retryable = false});
  @override
  String toString() => 'AvaCallsApiException($code): $message';
}

/// Domain client for universal resolution and PSTN admission. Provider names
/// never cross this boundary; the Worker selects the provider for each line.
class AvaCallsApi {
  AvaCallsApi._();

  static String _url(String path) => '$kApiBase$path';

  static Map<String, dynamic> _json(String body) {
    try {
      final value = jsonDecode(body);
      return value is Map ? Map<String, dynamic>.from(value) : const {};
    } catch (_) {
      return const {};
    }
  }

  static Future<List<AvaCallsLine>> listLines() async {
    final response = await ApiAuth.getSigned(_url('/virtual-lines'));
    if (response.statusCode != 200) {
      throw AvaCallsApiException(
          'lines_unavailable', 'Could not load Virtual Numbers',
          retryable: response.statusCode >= 500);
    }
    final payload = _json(response.body);
    final rows =
        payload['lines'] ?? payload['virtual_lines'] ?? payload['items'];
    if (rows is! List) return const [];
    return rows
        .whereType<Map>()
        .map((e) => AvaCallsLine.fromJson(Map<String, dynamic>.from(e)))
        .toList();
  }

  /// Resolve the exact canonical number. A legacy Directory fallback is kept
  /// for staged clients while the new endpoint rolls out; it only returns an
  /// AvaTOK contact and never turns a miss into directory-search results.
  static Future<AvaCallsDestination> resolve(String raw,
      {String? region}) async {
    final canonical = AvaCallsNumberNormalizer.normalize(raw, region: region);
    if (canonical == null) {
      return AvaCallsDestination(
        state: AvaCallsDestinationState.unsupported,
        kind: null,
        rawInput: raw,
        canonicalNumber: '',
        message: 'Enter a valid national or international number',
      );
    }
    try {
      final response = await ApiAuth.postJson(
          _url('/avacalls/resolve'),
          {
            'number': canonical,
          },
          timeout: const Duration(seconds: 8));
      if (response.statusCode == 200) {
        final j = _json(response.body);
        final kind =
            '${j['kind'] ?? j['destination_kind'] ?? ''}'.toLowerCase();
        final contactJson = j['contact'];
        final contact = contactJson is Map
            ? Contact.fromJson(Map<String, dynamic>.from(contactJson))
            : null;
        final isAvaTok = kind == 'avatok' || j['is_avatok'] == true;
        if (isAvaTok) {
          return AvaCallsDestination(
            state: AvaCallsDestinationState.avatok,
            kind: AvaCallsNumberKind.avatok,
            rawInput: raw,
            canonicalNumber: canonical,
            countryIso2: '${j['country_iso2'] ?? ''}'.toUpperCase(),
            countryName: '${j['country_name'] ?? ''}',
            contact: contact,
            message: 'AvaTOK number · free in-network call',
          );
        }
        final country =
            '${j['country_iso2'] ?? j['country'] ?? ''}'.toUpperCase();
        final price = (j['tokens_per_minute'] as num?)?.toDouble() ?? 0.50;
        final wallet = (j['wallet_subunits'] as num?)?.toInt() ?? 0;
        final lineJson = j['outgoing_line'] ?? j['line'];
        final line = lineJson is Map
            ? AvaCallsLine.fromJson(Map<String, dynamic>.from(lineJson))
            : null;
        final noDid = j['has_usable_did'] == false ||
            (line == null && j['requires_did'] == true);
        final insufficient = j['insufficient_wallet'] == true;
        return AvaCallsDestination(
          state: insufficient
              ? AvaCallsDestinationState.insufficientWallet
              : noDid
                  ? AvaCallsDestinationState.noDid
                  : AvaCallsDestinationState.pstn,
          kind: AvaCallsNumberKind.pstn,
          rawInput: raw,
          canonicalNumber: canonical,
          countryIso2: country,
          countryName: '${j['country_name'] ?? country}',
          outgoingLine: line,
          walletSubunits: wallet,
          pstnTokensPerMinute: price,
          message: insufficient
              ? 'Add wallet tokens to place this PSTN call'
              : noDid
                  ? 'Get a Virtual Number to call PSTN destinations'
                  : 'PSTN · ${price.toStringAsFixed(2)} tokens/minute',
        );
      }
      // The endpoint may not exist on a staged Worker yet. Directory.resolve
      // is exact-key and does not expose partial matches.
      if (response.statusCode == 404)
        return _legacyAvaTokFallback(raw, canonical);
      if (response.statusCode == 429 || response.statusCode >= 500) {
        return AvaCallsDestination(
            state: AvaCallsDestinationState.offline,
            kind: null,
            rawInput: raw,
            canonicalNumber: canonical,
            message: 'Can’t resolve right now. Try again.');
      }
      return AvaCallsDestination(
          state: AvaCallsDestinationState.unsupported,
          kind: null,
          rawInput: raw,
          canonicalNumber: canonical,
          message: 'This destination is not supported');
    } catch (_) {
      return AvaCallsDestination(
          state: AvaCallsDestinationState.offline,
          kind: null,
          rawInput: raw,
          canonicalNumber: canonical,
          message: 'You’re offline. Check your connection and retry.');
    }
  }

  static Future<AvaCallsDestination> _legacyAvaTokFallback(
      String raw, String canonical) async {
    try {
      final hit = await Directory.resolve(canonical);
      if (hit != null && hit.uid.isNotEmpty) {
        return AvaCallsDestination(
            state: AvaCallsDestinationState.avatok,
            kind: AvaCallsNumberKind.avatok,
            rawInput: raw,
            canonicalNumber: canonical,
            contact: hit,
            message: 'AvaTOK number · free in-network call');
      }
    } catch (_) {/* staged fallback is best effort */}
    return AvaCallsDestination(
        state: AvaCallsDestinationState.pstn,
        kind: AvaCallsNumberKind.pstn,
        rawInput: raw,
        canonicalNumber: canonical,
        message: 'PSTN · 0.50 tokens/minute');
  }

  static Future<Map<String, dynamic>> preparePstn({
    required String number,
    required String lineId,
  }) async {
    final response = await ApiAuth.postJson(_url('/avacalls/pstn/prepare'), {
      'destination': number,
      'line_id': lineId,
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw AvaCallsApiException(
          'pstn_prepare_failed', 'PSTN call could not be prepared',
          retryable: response.statusCode >= 500);
    }
    return _json(response.body);
  }

  static Future<Map<String, dynamic>> placePstn({
    required String number,
    required String lineId,
    required String attemptId,
  }) async {
    final response = await ApiAuth.postJsonH(_url('/avacalls/pstn/place'), {
      'destination': number,
      'line_id': lineId,
    }, {
      'Idempotency-Key': attemptId
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw AvaCallsApiException(
          'pstn_place_failed', 'PSTN call could not be placed',
          retryable: response.statusCode >= 500);
    }
    Analytics.capture('avacalls_pstn_started',
        {'country': number.startsWith('+') ? 'international' : 'unknown'});
    return _json(response.body);
  }
}

/// Account-scoped default outgoing DID. Only the opaque line ID is persisted.
class AvaCallsOutgoingLineStore {
  AvaCallsOutgoingLineStore._();
  static final AvaCallsOutgoingLineStore instance =
      AvaCallsOutgoingLineStore._();
  static const _key = 'avacalls_default_outgoing_line_v1';
  static const _secure = FlutterSecureStorage();

  Future<String?> read() => readScoped(_secure, _key);
  Future<void> save(String lineId) =>
      _secure.write(key: scopedKey(_key), value: lineId);
  Future<void> clear() => _secure.delete(key: scopedKey(_key));

  /// Selects the saved default when eligible, then the server's default, then
  /// the first active voice-capable DID. This prevents a suspended default from
  /// blocking calls and leaves the authoritative eligibility check to admission.
  Future<AvaCallsLine?> select(List<AvaCallsLine> lines) async {
    final eligible = lines.where((l) => l.canPlaceOutbound).toList();
    if (eligible.isEmpty) return null;
    final saved = await read();
    for (final line in eligible) {
      if (line.id == saved) return line;
    }
    for (final line in eligible) {
      if (line.defaultOutgoing) return line;
    }
    return eligible.first;
  }
}
