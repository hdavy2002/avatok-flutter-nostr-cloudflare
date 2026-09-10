import 'dart:convert';

import 'api_auth.dart';
import 'config.dart';
import 'disk_cache.dart';
import '../identity/identity.dart';
import '../features/calendar/calendar_data.dart';

/// A typed client for the unified creator schedule contract.
///
/// The schedule is creator-scoped when [listingId] is null and listing-scoped
/// when a listing id is supplied. Cache entries are stored through [DiskCache],
/// which namespaces the files by the active account.
class AvailabilityApi {
  static const _scheduleCachePrefix = 'availability_schedule_v2';
  static const _availabilityCachePrefix = 'listing_availability_v2';

  static String scheduleCacheKey({String? listingId}) =>
      '${_scheduleCachePrefix}_${listingId ?? 'shared'}';

  static String availabilityCacheKey({
    required String listingId,
    required String from,
    required String to,
    required String timezone,
  }) =>
      '${_availabilityCachePrefix}_${listingId}_${from}_${to}_${timezone.replaceAll('/', '_')}';

  static Future<AvailabilityCache<AvailabilitySchedule>?> cachedSchedule(
      {String? listingId}) async {
    final scope = AccountScope.id;
    final raw = await DiskCache.readForScope(
        scheduleCacheKey(listingId: listingId),
        scope: scope);
    _ensureScope(scope);
    if (raw == null) return null;
    try {
      final root = (jsonDecode(raw) as Map).cast<String, dynamic>();
      final value = root['schedule'];
      if (value is! Map) return null;
      return AvailabilityCache(
        AvailabilitySchedule.fromJson(value.cast<String, dynamic>()),
        _cacheDate(root['cached_at']),
      );
    } catch (_) {
      return null;
    }
  }

  static Future<AvailabilityCache<ListingAvailability>?>
      cachedListingAvailability({
    required String listingId,
    required String from,
    required String to,
    required String timezone,
  }) async {
    final scope = AccountScope.id;
    final raw = await DiskCache.readForScope(
      availabilityCacheKey(
          listingId: listingId, from: from, to: to, timezone: timezone),
      scope: scope,
    );
    _ensureScope(scope);
    if (raw == null) return null;
    try {
      final root = (jsonDecode(raw) as Map).cast<String, dynamic>();
      final value = root['availability'];
      if (value is! Map) return null;
      return AvailabilityCache(
        ListingAvailability.fromJson(value.cast<String, dynamic>()),
        _cacheDate(root['cached_at']),
      );
    } catch (_) {
      return null;
    }
  }

  static DateTime _cacheDate(Object? value) {
    final ms = value is num ? value.toInt() : int.tryParse('$value');
    return ms == null
        ? DateTime.fromMillisecondsSinceEpoch(0)
        : DateTime.fromMillisecondsSinceEpoch(ms);
  }

  static Map<String, dynamic> _json(String body) {
    try {
      final parsed = jsonDecode(body);
      return parsed is Map
          ? parsed.cast<String, dynamic>()
          : <String, dynamic>{};
    } catch (_) {
      return <String, dynamic>{};
    }
  }

  static Map<String, dynamic> _requiredJson(String body, String resource) {
    try {
      final parsed = jsonDecode(body);
      if (parsed is Map) return parsed.cast<String, dynamic>();
    } catch (_) {
      // Fall through to the same typed error for malformed and non-JSON 2xx.
    }
    throw AvailabilityApiException(
      statusCode: 200,
      code: 'invalid_response',
      message: 'The server returned an invalid $resource response.',
    );
  }

  static AvailabilityApiException _error(int status, String body) {
    final value = _json(body);
    final error = value['error'];
    final message =
        error is Map ? error['message']?.toString() : error?.toString();
    return AvailabilityApiException(
      statusCode: status,
      code:
          error is Map ? error['code']?.toString() : value['code']?.toString(),
      message: message?.isNotEmpty == true
          ? message!
          : 'Could not load availability right now.',
    );
  }

  static Future<AvailabilitySchedule> fetchSchedule({String? listingId}) async {
    final scope = AccountScope.id;
    final query = listingId == null || listingId.isEmpty
        ? ''
        : '?listing_id=${Uri.encodeQueryComponent(listingId)}';
    final response = await ApiAuth.getSigned('$kCalendarBase/schedule$query');
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw _error(response.statusCode, response.body);
    }
    final root = _requiredJson(response.body, 'schedule');
    final scheduleValue = root['schedule'];
    if (scheduleValue is! Map ||
        scheduleValue['rules'] is! List ||
        scheduleValue['exceptions'] is! List) {
      throw const AvailabilityApiException(
        statusCode: 200,
        code: 'invalid_response',
        message: 'The server returned an invalid schedule response.',
      );
    }
    final schedule =
        AvailabilitySchedule.fromJson(scheduleValue.cast<String, dynamic>());
    _ensureScope(scope);
    await _writeSchedule(schedule, scope: scope);
    _ensureScope(scope);
    return schedule;
  }

  /// Semantic aliases used by booking surfaces so callers do not need to know
  /// whether a schedule came from the network or the cache-backed client.
  static Future<AvailabilitySchedule> getSchedule({String? listingId}) =>
      fetchSchedule(listingId: listingId);

  static Future<AvailabilitySchedule> saveSchedule(
      AvailabilitySchedule schedule) async {
    final scope = AccountScope.id;
    final query = schedule.listingId == null || schedule.listingId!.isEmpty
        ? ''
        : '?listing_id=${Uri.encodeQueryComponent(schedule.listingId!)}';
    final response = await ApiAuth.putJson(
        '$kCalendarBase/schedule$query', {'schedule': schedule.toJson()});
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw _error(response.statusCode, response.body);
    }
    final root = _requiredJson(response.body, 'schedule');
    final scheduleValue = root['schedule'];
    if (scheduleValue is! Map ||
        scheduleValue['rules'] is! List ||
        scheduleValue['exceptions'] is! List) {
      throw const AvailabilityApiException(
        statusCode: 200,
        code: 'invalid_response',
        message: 'The server returned an invalid schedule response.',
      );
    }
    final saved =
        AvailabilitySchedule.fromJson(scheduleValue.cast<String, dynamic>());
    _ensureScope(scope);
    await _writeSchedule(saved, scope: scope);
    _ensureScope(scope);
    return saved;
  }

  static Future<AvailabilitySchedule> putSchedule(
          AvailabilitySchedule schedule) =>
      saveSchedule(schedule);

  static Future<void> _writeSchedule(AvailabilitySchedule value,
      {required String? scope}) async {
    await DiskCache.writeForScope(
      scheduleCacheKey(listingId: value.listingId),
      jsonEncode({
        'cached_at': DateTime.now().millisecondsSinceEpoch,
        'schedule': value.toJson()
      }),
      scope: scope,
    );
  }

  static Future<ListingAvailability> fetchListingAvailability({
    required String listingId,
    required String from,
    required String to,
    required String timezone,
  }) async {
    final scope = AccountScope.id;
    final path =
        '$kApiBase/listings/${Uri.encodeComponent(listingId)}/availability'
        '?from=${Uri.encodeQueryComponent(from)}'
        '&to=${Uri.encodeQueryComponent(to)}'
        '&timezone=${Uri.encodeQueryComponent(timezone)}';
    final response = await ApiAuth.getSigned(path);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw _error(response.statusCode, response.body);
    }
    final root = _requiredJson(response.body, 'availability');
    if (root['days'] is! List || root['slots'] is! List) {
      throw const AvailabilityApiException(
        statusCode: 200,
        code: 'invalid_response',
        message: 'The server returned an invalid availability response.',
      );
    }
    final value = ListingAvailability.fromJson(root);
    _ensureScope(scope);
    await DiskCache.writeForScope(
      availabilityCacheKey(
          listingId: listingId, from: from, to: to, timezone: timezone),
      jsonEncode({
        'cached_at': DateTime.now().millisecondsSinceEpoch,
        'availability': value.toJson()
      }),
      scope: scope,
    );
    _ensureScope(scope);
    return value;
  }

  static Future<ListingAvailability> listingAvailability({
    required String listingId,
    required String from,
    required String to,
    required String timezone,
  }) =>
      fetchListingAvailability(
        listingId: listingId,
        from: from,
        to: to,
        timezone: timezone,
      );

  static void _ensureScope(String? captured) {
    if (captured != AccountScope.id) {
      throw const AvailabilityApiException(
        statusCode: 0,
        code: 'account_changed',
        message:
            'The active account changed while availability was loading. Refresh to continue.',
      );
    }
  }

  static Future<AvailabilityConflictPreview> previewConflicts({
    String? listingId,
    required int startAt,
    required int endAt,
    String? timezone,
  }) async {
    final scope = AccountScope.id;
    final response =
        await ApiAuth.postJson('$kCalendarBase/conflicts/preview', {
      if (listingId != null && listingId.isNotEmpty) 'listing_id': listingId,
      'start_at': startAt,
      'end_at': endAt,
      if (timezone != null && timezone.isNotEmpty) 'timezone': timezone,
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw _error(response.statusCode, response.body);
    }
    _ensureScope(scope);
    final root = _requiredJson(response.body, 'conflict preview');
    if (root['ok'] is! bool) {
      throw const AvailabilityApiException(
        statusCode: 200,
        code: 'invalid_response',
        message: 'The server returned an invalid conflict preview response.',
      );
    }
    return AvailabilityConflictPreview.fromJson(root);
  }

  static Future<AvailabilityConflictPreview> conflictsPreview({
    String? listingId,
    required int startAt,
    required int endAt,
    String? timezone,
  }) =>
      previewConflicts(
        listingId: listingId,
        startAt: startAt,
        endAt: endAt,
        timezone: timezone,
      );
}

class AvailabilityCache<T> {
  final T value;
  final DateTime cachedAt;

  const AvailabilityCache(this.value, this.cachedAt);

  bool isStale({Duration maxAge = const Duration(hours: 6)}) =>
      DateTime.now().difference(cachedAt) > maxAge;
}

class AvailabilityApiException implements Exception {
  final int statusCode;
  final String? code;
  final String message;

  const AvailabilityApiException(
      {required this.statusCode, this.code, required this.message});

  @override
  String toString() =>
      'AvailabilityApiException($statusCode${code == null ? '' : ', $code'}): $message';
}
