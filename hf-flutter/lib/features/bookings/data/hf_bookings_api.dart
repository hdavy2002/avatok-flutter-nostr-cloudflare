import '../../../core/api/api_client.dart';
import 'hf_booking_models.dart';

class HfBookingsApi {
  const HfBookingsApi(this._api);
  final ApiClient _api;

  static String _dateOnly(DateTime value) =>
      '${value.year.toString().padLeft(4, '0')}-${value.month.toString().padLeft(2, '0')}-${value.day.toString().padLeft(2, '0')}';

  static BookingRecord _booking(Map<String, dynamic> response) {
    final raw = response['booking'];
    if (raw is! Map) return BookingRecord.fromJson(response);
    final booking = Map<String, dynamic>.from(raw);
    for (final key in const ['canStart', 'canCancel', 'callId']) {
      if (!booking.containsKey(key) && response[key] != null) booking[key] = response[key];
    }
    return BookingRecord.fromJson(booking);
  }

  Future<BookingSchedule> availability() async =>
      BookingSchedule.fromJson(await _api.getJson('/api/hosts/me/availability'));

  Future<BookingSchedule> saveAvailability(BookingSchedule schedule, {bool confirmLegacyPreview = false}) async =>
      BookingSchedule.fromJson((await _api.putJson(
        '/api/hosts/me/availability',
        body: {
          'schedule': schedule.toJson(),
          'expectedVersion': schedule.version,
          if (confirmLegacyPreview) 'confirmLegacyPreview': true,
        },
      ))['schedule'] as Map<String, dynamic>);

  Future<List<BookingSlot>> slots({
    required String slug, required DateTime from, required DateTime to,
    required int durationMinutes,
  }) async {
    final json = await _api.getJson(
      '/api/hf/hosts/${Uri.encodeComponent(slug)}/availability',
      auth: false,
      query: {
        'from': _dateOnly(from),
        'to': _dateOnly(to),
        'durationMinutes': durationMinutes,
      },
    );
    final rows = json['slots'];
    return rows is List ? [for (final row in rows) if (row is Map) BookingSlot.fromJson(Map<String, dynamic>.from(row))] : const [];
  }

  Future<BookingQuote> quote({required String hostSlug, required BookingSlot slot, required int durationMinutes}) async =>
      BookingQuote.fromJson((await _api.postJson('/api/hf/bookings/quote', body: {
        'hostSlug': hostSlug, 'startUtc': slot.startUtc.toIso8601String(),
        'durationMinutes': durationMinutes,
      }))['quote'] as Map<String, dynamic>);

  Future<BookingRecord> confirm(String quoteId, {required bool policyAccepted, required String idempotencyKey}) async =>
      _booking(await _api.postJson('/api/hf/bookings', body: {
        'quoteId': quoteId, 'policyAccepted': policyAccepted,
      }, idempotencyKey: idempotencyKey));

  Future<List<BookingRecord>> list({required String role}) async {
    final json = await _api.getJson('/api/hf/bookings', query: {'role': role});
    final rows = json['bookings'];
    return rows is List ? [for (final row in rows) if (row is Map) BookingRecord.fromJson(Map<String, dynamic>.from(row))] : const [];
  }

  Future<BookingRecord> detail(String id) async =>
      _booking(await _api.getJson('/api/hf/bookings/${Uri.encodeComponent(id)}'));

  Future<void> cancel(String id) async {
    await _api.postJson('/api/hf/bookings/${Uri.encodeComponent(id)}/cancel');
  }

  Future<BookingRecord> start(String id) async =>
      _booking(await _api.postJson('/api/hf/bookings/${Uri.encodeComponent(id)}/start'));

  Future<BookingSummary> hostSummary() async =>
      BookingSummary.fromJson((await _api.getJson('/api/hosts/me/bookings/summary'))['summary'] as Map<String, dynamic>);
}
