import 'dart:convert';

import 'package:http/http.dart' as http;

import '../../core/api_auth.dart';
import '../../core/config.dart';
import 'virtual_numbers_models.dart';

/// Domain API for Virtual Numbers. Provider-specific fields never cross this
/// boundary; the Worker returns the stable virtual-line contract from the spec.
class VirtualNumbersApi {
  VirtualNumbersApi({String? baseUrl})
      : _base = baseUrl ?? 'https://$kSignalingHost/api';
  final String _base;

  Uri _uri(String path, [Map<String, String>? query]) =>
      Uri.parse('$_base$path').replace(queryParameters: query);

  Future<List<VirtualLine>> listLines() async {
    final response = await ApiAuth.getSigned(_uri('/virtual-lines').toString());
    _check(response);
    final body = _json(response);
    final rows = body is List
        ? body
        : (body['lines'] ?? body['virtual_lines'] ?? const []);
    return (rows as List)
        .whereType<Map>()
        .map((row) => VirtualLine.fromJson(Map<String, dynamic>.from(row)))
        .toList();
  }

  Future<VirtualLine> createAvaTok(
      {String? requestedNumber, String label = 'AvaTOK number'}) async {
    final response = await ApiAuth.postJson('$_base/virtual-lines/avatok', {
      if (requestedNumber != null && requestedNumber.trim().isNotEmpty)
        'requested_number': requestedNumber.trim(),
      'label': label,
    });
    _check(response);
    final body = _json(response) as Map<String, dynamic>;
    return VirtualLine.fromJson(
        Map<String, dynamic>.from((body['line'] as Map?) ?? body));
  }

  Future<List<Map<String, dynamic>>> searchDids(
      {String country = 'IN', String? region}) async {
    final response =
        await ApiAuth.getSigned(_uri('/virtual-lines/dids/search', {
      'country': country,
      if (region != null && region.isNotEmpty) 'region': region,
    }).toString());
    _check(response);
    final body = _json(response);
    final rows = body is List
        ? body
        : (body['items'] ?? body['inventory'] ?? body['numbers'] ?? const []);
    return rows
        .whereType<Map>()
        .map((row) => Map<String, dynamic>.from(row))
        .toList();
  }

  Future<VirtualLine> purchaseDid(
      {required String inventoryId, required String label}) async {
    final response =
        await ApiAuth.postJson('$_base/virtual-lines/dids/purchase', {
      'e164': inventoryId,
      'label': label,
    });
    _check(response);
    final body = _json(response) as Map<String, dynamic>;
    return VirtualLine.fromJson(
        Map<String, dynamic>.from((body['line'] as Map?) ?? body));
  }

  Future<VirtualLine> updateLine(
      String lineId, Map<String, dynamic> patch) async {
    final response = await _patch(
        '$_base/virtual-lines/${Uri.encodeComponent(lineId)}', patch);
    _check(response);
    final body = _json(response) as Map<String, dynamic>;
    return VirtualLine.fromJson(
        Map<String, dynamic>.from((body['line'] as Map?) ?? body));
  }

  Future<void> setDefaultOutgoing(String lineId) async {
    final response = await ApiAuth.putJson(
        '$_base/virtual-lines/${Uri.encodeComponent(lineId)}/default-outgoing',
        const {});
    _check(response);
  }

  Future<List<VirtualLineActivity>> activity(String lineId,
      {VirtualActivityType filter = VirtualActivityType.all}) async {
    final response = await ApiAuth.getSigned(
        _uri('/virtual-lines/${Uri.encodeComponent(lineId)}/activity', {
      if (filter != VirtualActivityType.all) 'type': _filterName(filter),
    }).toString());
    _check(response);
    final body = _json(response);
    final rows =
        body is List ? body : (body['activity'] ?? body['events'] ?? const []);
    return rows
        .whereType<Map>()
        .map((row) =>
            VirtualLineActivity.fromJson(Map<String, dynamic>.from(row)))
        .toList();
  }

  Future<VirtualLineSettings> getSettings(String lineId) async {
    final response = await ApiAuth.getSigned(
        '$_base/virtual-lines/${Uri.encodeComponent(lineId)}/settings');
    _check(response);
    final body = _json(response) as Map<String, dynamic>;
    final settings = (body['settings'] as Map?) ?? body;
    final policy = (settings['policy'] as Map?) ?? settings;
    return VirtualLineSettings.fromJson(Map<String, dynamic>.from(policy));
  }

  Future<VirtualLineSettings> saveSettings(
      String lineId, VirtualLineSettings settings) async {
    final response = await ApiAuth.putJson(
        '$_base/virtual-lines/${Uri.encodeComponent(lineId)}/settings',
        settings.toJson());
    _check(response);
    // The server intentionally returns only an acknowledgement. The submitted
    // validated settings are the client-side canonical copy for this frame.
    return settings;
  }

  Future<void> suspend(String lineId) async {
    final response = await ApiAuth.postJson(
        '$_base/virtual-lines/${Uri.encodeComponent(lineId)}/suspend',
        const {});
    _check(response);
  }

  Future<void> resume(String lineId) async {
    final response = await ApiAuth.postJson(
        '$_base/virtual-lines/${Uri.encodeComponent(lineId)}/resume', const {});
    _check(response);
  }

  Future<void> release(String lineId) async {
    final response = await ApiAuth.deleteSigned(
        '$_base/virtual-lines/${Uri.encodeComponent(lineId)}');
    _check(response);
  }

  Future<http.Response> _patch(String url, Object body) async {
    final encoded = utf8.encode(jsonEncode(body));
    final headers = await ApiAuth.signedHeaders('PATCH', url, body: encoded);
    return http
        .patch(Uri.parse(url), headers: headers, body: jsonEncode(body))
        .timeout(const Duration(seconds: 12));
  }

  String _filterName(VirtualActivityType type) => switch (type) {
        VirtualActivityType.calls => 'calls',
        VirtualActivityType.recordings => 'recordings',
        VirtualActivityType.voicemail => 'voicemail',
        VirtualActivityType.receptionist => 'receptionist',
        VirtualActivityType.otp => 'otp',
        VirtualActivityType.textMessages => 'sms',
        VirtualActivityType.all => 'all',
      };

  dynamic _json(http.Response response) =>
      response.body.isEmpty ? <String, dynamic>{} : jsonDecode(response.body);

  void _check(http.Response response) {
    if (response.statusCode >= 200 && response.statusCode < 300) return;
    var reason = 'Request failed (${response.statusCode})';
    try {
      final body = _json(response);
      if (body is Map && body['error'] != null)
        reason = body['error'].toString();
    } catch (_) {}
    throw VirtualNumbersApiException(reason, response.statusCode);
  }
}

class VirtualNumbersApiException implements Exception {
  final String message;
  final int? statusCode;
  const VirtualNumbersApiException(this.message, [this.statusCode]);
  @override
  String toString() => message;
}
