import '../api_client.dart';
import '../api_exception.dart';
import '../models/booking.dart';

/// Bookings (HF-WIRE-8). The server holds 10 x the rate when a booking is made, starts the call at the booked
/// minute (influencer first) and sends the WhatsApp messages. The app only picks, shows and cancels.
///
/// - `GET  /api/hf/hosts/:slug/slots?from=&to=` (public) -> free slots per IST date.
/// - `POST /api/hf/bookings {hostSlug, startAt, note?}` -> `{booking}`; 409 `slot_unavailable`, 402 `low_balance` (+ `needPaise`).
/// - `GET  /api/hf/bookings?role=fan` / `role=host&from=&to=&day=` -> `{bookings[]}`.
/// - `DELETE /api/hf/bookings/:id` -> `{message, refundPaise}`; 409 `too_late` for a fan inside the last hour.
/// - `GET/PUT /api/hf/hosts/me/availability`, `GET/PUT /api/hf/hosts/me/rate`.
class BookingsRepo {
  const BookingsRepo(this._api);

  final ApiClient _api;

  Future<HostSlots> slots(String slug, {String? from, String? to}) async => HostSlots.fromJson(
        await _api.getJson('/api/hf/hosts/${Uri.encodeComponent(slug)}/slots', query: {'from': from, 'to': to}, auth: false),
      );

  /// Throws [ApiException]; see [BookingProblem] for what the codes mean.
  Future<AppBooking> book(String slug, DateTime startAt, {String? note}) async {
    final j = await _api.postJson('/api/hf/bookings', body: {
      'hostSlug': slug,
      'startAt': startAt.toUtc().toIso8601String(),
      if (note != null && note.trim().isNotEmpty) 'note': note.trim(),
    });
    final b = j['booking'];
    if (b is! Map) throw ApiException.parse(200);
    return AppBooking.fromJson(Map<String, dynamic>.from(b));
  }

  Future<List<AppBooking>> mine() async => _list(await _api.getJson('/api/hf/bookings', query: {'role': 'fan'}));

  /// The influencer's own bookings: upcoming by default, or one IST [day] (`YYYY-MM-DD`).
  Future<List<AppBooking>> hostBookings({String? day, String? from, String? to}) async =>
      _list(await _api.getJson('/api/hf/bookings', query: {'role': 'host', 'shape': 'app', 'day': day, 'from': from, 'to': to}));

  List<AppBooking> _list(Map<String, dynamic> j) {
    final raw = j['bookings'];
    return [
      if (raw is List)
        for (final e in raw)
          if (e is Map) AppBooking.fromJson(Map<String, dynamic>.from(e)),
    ];
  }

  Future<CancelResult> cancel(String id) async =>
      CancelResult.fromJson(await _api.deleteJson('/api/hf/bookings/${Uri.encodeComponent(id)}'));

  Future<HostAvailability> availability() async => HostAvailability.fromJson(await _api.getJson('/api/hf/hosts/me/availability'));

  /// Replaces just the dates in [days]. 409 `slot_booked` when a booked time would be closed.
  Future<HostAvailability> saveAvailability(Map<String, DayPlan> days, {int? expectedVersion}) async =>
      HostAvailability.fromJson(await _api.putJson('/api/hf/hosts/me/availability', body: {
        if (expectedVersion != null) 'expectedVersion': expectedVersion,
        'days': {
          for (final e in days.entries) e.key: {'open': e.value.open, 'slots': (e.value.slots.toList()..sort())},
        },
      }));

  Future<RateInfo> rate() async => RateInfo.fromJson(_inner(await _api.getJson('/api/hf/hosts/me/rate')));

  /// What she would get a minute at [rate], by the server's rule.
  Future<RateInfo> previewRate(int rate) async => RateInfo.fromJson(_inner(await _api.getJson('/api/hf/hosts/me/rate', query: {'rate': rate})));

  /// 409 `rate_fixed` when the Standard plan sets one rate for everyone.
  Future<RateInfo> setRate(int rate) async => RateInfo.fromJson(_inner(await _api.putJson('/api/hf/hosts/me/rate', body: {'pricePerMin': rate})));

  static Map<String, dynamic> _inner(Map<String, dynamic> j) => j['rate'] is Map ? Map<String, dynamic>.from(j['rate'] as Map) : j;
}

/// What a failed booking request means for the person.
enum BookingProblem {
  /// The wallet is short. [ApiException.extra] has `needPaise`. Send them to top up.
  lowBalance,

  /// Someone took that time (or it closed). Go back and pick again.
  slotTaken,

  /// Inside the last hour: the hold is kept.
  tooLate,

  /// A booked time can't be closed until the booking is cancelled.
  slotBooked,

  /// Standard plan: no rate to set.
  rateFixed,

  /// The feature is off or not ready.
  notOpen,

  other,
}

BookingProblem bookingProblemOf(Object e) {
  if (e is! ApiException) return BookingProblem.other;
  switch (e.code) {
    case 'low_balance':
      return BookingProblem.lowBalance;
    case 'slot_unavailable':
    case 'slot_or_wallet_changed':
    case 'quote_expired':
      return BookingProblem.slotTaken;
    case 'too_late':
      return BookingProblem.tooLate;
    case 'slot_booked':
      return BookingProblem.slotBooked;
    case 'rate_fixed':
      return BookingProblem.rateFixed;
    case 'booking_payment_unavailable':
      return BookingProblem.notOpen;
  }
  return e.status == 404 ? BookingProblem.notOpen : BookingProblem.other;
}
