import '../api_client.dart';
import '../api_exception.dart';
import '../models/booking.dart';
import '../response_cache.dart';

/// Bookings (HF-WIRE-8). The server holds 10 x the rate when a booking is made, starts the call at the booked
/// minute (influencer first) and sends the WhatsApp messages. The app only picks, shows and cancels.
///
/// - `GET  /api/hf/hosts/:slug/slots?from=&to=` (public) -> free slots per IST date.
/// - `POST /api/hf/bookings {hostSlug, startAt, note?}` -> `{booking}`; 409 `slot_unavailable`, 402 `low_balance` (+ `needPaise`).
/// - `GET  /api/hf/bookings?role=fan` / `role=host&from=&to=&day=` -> `{bookings[]}`.
/// - `DELETE /api/hf/bookings/:id` -> `{message, refundPaise}`; 409 `too_late` for a fan inside the last hour.
/// - `GET/PUT /api/hf/hosts/me/availability`, `GET/PUT /api/hf/hosts/me/rate`.
/// - [HF-BOOK-APPROVE] (dark behind `hfBookingApprovalEnabled`): `POST /api/hf/bookings/:id/accept`, `.../decline {reason?}`,
///   `GET/PUT /api/hf/hosts/me/booking-settings`, `topic` on the booking, `?status=pending|upcoming|past` on the lists.
class BookingsRepo {
  const BookingsRepo(this._api);

  final ApiClient _api;

  Future<HostSlots> slots(String slug, {String? from, String? to}) async => HostSlots.fromJson(
        await _api.getJson('/api/hf/hosts/${Uri.encodeComponent(slug)}/slots', query: {'from': from, 'to': to}, auth: false),
      );

  /// [HF-APP-CACHE-1] [slots] cached-first: the last list paints at once, then the server's. Booking still re-checks on the server
  /// (409 `slot_unavailable`), so a stale time can only cost one friendly "pick again".
  Stream<HostSlots> watchSlots(String slug, {String? from, String? to}) => _api
      .watchJson('/api/hf/hosts/${Uri.encodeComponent(slug)}/slots', query: {'from': from, 'to': to}, auth: false, policy: CachePolicy.slots)
      .map(HostSlots.fromJson);

  /// Throws [ApiException]; see [BookingProblem] for what the codes mean.
  Future<AppBooking> book(String slug, DateTime startAt, {String? note, String? topic}) async =>
      (await bookRequest(slug, startAt, note: note, topic: topic)).booking;

  /// Like [book], but also says whether the booking now waits for the influencer ([BookResult.needsApproval]) and the
  /// server's own sentence for the "Request sent" screen. [topic] is one of the influencer's topic slugs.
  Future<BookResult> bookRequest(String slug, DateTime startAt, {String? note, String? topic}) async {
    final j = await _api.postJson('/api/hf/bookings', body: {
      'hostSlug': slug,
      'startAt': startAt.toUtc().toIso8601String(),
      if (note != null && note.trim().isNotEmpty) 'note': note.trim(),
      if (topic != null && topic.isNotEmpty) 'topic': topic,
    });
    final b = j['booking'];
    if (b is! Map) throw ApiException.parse(200);
    return BookResult(
      booking: AppBooking.fromJson(Map<String, dynamic>.from(b)),
      needsApproval: j['needsApproval'] == true,
      approvalText: j['approvalText'] is String && (j['approvalText'] as String).isNotEmpty ? j['approvalText'] as String : null,
    );
  }

  /// The fan's bookings. No [status]: active ones (waiting for approval first). `past`: finished and cancelled ones.
  Future<List<AppBooking>> mine({String? status}) async =>
      _list(await _api.getJson('/api/hf/bookings', query: {'role': 'fan', 'status': status}, store: true));

  /// [HF-APP-CACHE-1] [mine] cached-first (always re-asks the server; a booking/cancel/accept/decline throws the cached copy away).
  Stream<List<AppBooking>> watchMine({String? status}) => _api
      .watchJson('/api/hf/bookings', query: {'role': 'fan', 'status': status}, policy: CachePolicy.live)
      .map(_list);

  /// [HF-APP-CACHE-1] [hostBookings] cached-first.
  Stream<List<AppBooking>> watchHostBookings({String? day, String? from, String? to, String? status}) => _api
      .watchJson('/api/hf/bookings',
          query: {'role': 'host', 'shape': 'app', 'day': day, 'from': from, 'to': to, 'status': status}, policy: CachePolicy.live)
      .map(_list);

  /// The influencer's own bookings: upcoming by default, or one IST [day] (`YYYY-MM-DD`).
  /// [status] is `pending`, `upcoming` or `past`; it only has an effect while the approval feature is on.
  Future<List<AppBooking>> hostBookings({String? day, String? from, String? to, String? status}) async => _list(
      await _api.getJson('/api/hf/bookings',
          query: {'role': 'host', 'shape': 'app', 'day': day, 'from': from, 'to': to, 'status': status}, store: true));

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

  /// Influencer accepts a booking that waits for approval. 409 `not_pending` / `expired`.
  Future<AppBooking> accept(String id) async => _decided(await _api.postJson('/api/hf/bookings/${Uri.encodeComponent(id)}/accept', body: const <String, Object?>{}));

  /// Influencer declines: the caller's full hold goes back to the wallet. 409 `not_pending` / `expired`.
  Future<DeclineResult> decline(String id, {String? reason}) async {
    final j = await _api.postJson('/api/hf/bookings/${Uri.encodeComponent(id)}/decline',
        body: {if (reason != null && reason.trim().isNotEmpty) 'reason': reason.trim()});
    final n = j['refundPaise'];
    return DeclineResult(booking: _decided(j), refundPaise: n is num ? n.round() : 0);
  }

  AppBooking _decided(Map<String, dynamic> j) {
    final b = j['booking'];
    if (b is! Map) throw ApiException.parse(200);
    return AppBooking.fromJson(Map<String, dynamic>.from(b));
  }

  /// `{approval: manual|auto, openAlerts}`. 404 while the approval feature is off.
  Future<BookingSettings> bookingSettings() async => BookingSettings.fromJson(await _api.getJson('/api/hf/hosts/me/booking-settings'));

  /// Sends only what is given.
  Future<BookingSettings> saveBookingSettings({String? approval, bool? openAlerts}) async =>
      BookingSettings.fromJson(await _api.putJson('/api/hf/hosts/me/booking-settings', body: {
        if (approval != null) 'approval': approval,
        if (openAlerts != null) 'openAlerts': openAlerts,
      }));

  Future<HostAvailability> availability() async => HostAvailability.fromJson(await _api.getJson('/api/hf/hosts/me/availability', store: true));

  /// [HF-APP-CACHE-1] [availability] cached-first. Saving (PUT) throws the cached copy away.
  Stream<HostAvailability> watchAvailability() =>
      _api.watchJson('/api/hf/hosts/me/availability', policy: CachePolicy.live).map(HostAvailability.fromJson);

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

  /// [HF-BOOK-APPROVE] Too close to the start for a booking that needs approval. Pick a later time.
  tooSoon,

  /// [HF-BOOK-APPROVE] The chosen topic is not one of the influencer's.
  badTopic,

  /// [HF-BOOK-APPROVE] Accept / decline on a booking that is no longer waiting, or was not accepted in time.
  notPending,

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
    case 'too_soon_for_approval':
      return BookingProblem.tooSoon;
    case 'bad_topic':
      return BookingProblem.badTopic;
    case 'not_pending':
    case 'expired':
      return BookingProblem.notPending;
  }
  return e.status == 404 ? BookingProblem.notOpen : BookingProblem.other;
}
