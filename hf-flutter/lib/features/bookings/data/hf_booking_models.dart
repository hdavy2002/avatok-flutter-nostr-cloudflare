num? _number(Object? value) =>
    value is num ? value : num.tryParse((value ?? '').toString());
String? _text(Object? value) {
  final text = (value ?? '').toString().trim();
  return text.isEmpty ? null : text;
}
Map<String, dynamic>? _object(Object? value) =>
    value is Map ? Map<String, dynamic>.from(value) : null;
List<Map<String, dynamic>> _objects(Object? value) => value is List
    ? [for (final item in value) if (item is Map) Map<String, dynamic>.from(item)]
    : const [];
DateTime? _date(Object? value) {
  if (value is num) return DateTime.fromMillisecondsSinceEpoch(value.toInt(), isUtc: true);
  final text = _text(value);
  return text == null ? null : DateTime.tryParse(text)?.toUtc();
}

class BookingWindow {
  const BookingWindow({required this.weekday, required this.startMin, required this.endMin});
  final int weekday;
  final int startMin;
  final int endMin;

  factory BookingWindow.fromJson(Map<String, dynamic> json) {
    final apiWeekday = (_number(json['weekday']) ?? 1).toInt();
    return BookingWindow(
      // The editor uses ISO weekdays (Monday=1 … Sunday=7); the API uses JS weekdays (Sunday=0 … Saturday=6).
      weekday: apiWeekday == 0 ? 7 : apiWeekday,
      startMin: (_number(json['startMin']) ?? 540).toInt(),
      endMin: (_number(json['endMin']) ?? 1020).toInt(),
    );
  }
  Map<String, dynamic> toJson() => {
    'weekday': weekday == 7 ? 0 : weekday,
    'startMin': startMin,
    'endMin': endMin,
  };
}

class BookingException {
  const BookingException({required this.date, required this.status, this.startMin, this.endMin});
  final String date;
  final String status;
  final int? startMin;
  final int? endMin;

  factory BookingException.fromJson(Map<String, dynamic> json) => BookingException(
    date: (_text(json['date']) ?? '').split('T').first,
    status: (_text(json['status']) ?? 'unavailable'),
    startMin: _number(json['startMin'])?.toInt(),
    endMin: _number(json['endMin'])?.toInt(),
  );
  Map<String, dynamic> toJson() => {
    'date': date, 'status': status,
    if (startMin != null) 'startMin': startMin,
    if (endMin != null) 'endMin': endMin,
  };
}

class LegacyAvailabilityPreview {
  const LegacyAvailabilityPreview({
    required this.requiresHostTimezoneConfirmation,
    required this.days,
    required this.startMin,
    required this.endMin,
  });
  final bool requiresHostTimezoneConfirmation;
  final List<int> days;
  final int? startMin;
  final int? endMin;

  factory LegacyAvailabilityPreview.fromJson(Map<String, dynamic> source) {
    final hours = _object(source['hours']) ?? source;
    final rawDays = hours['days'];
    final weekdayNames = {
      'mon': 1, 'monday': 1, 'tue': 2, 'tuesday': 2,
      'wed': 3, 'wednesday': 3, 'thu': 4, 'thursday': 4,
      'fri': 5, 'friday': 5, 'sat': 6, 'saturday': 6,
      'sun': 7, 'sunday': 7,
    };
    final dayValues = rawDays is List ? rawDays : (rawDays is String ? rawDays.split(RegExp(r'[,\s]+')) : const []);
    final days = <int>{};
    for (final value in dayValues) {
      final text = (value ?? '').toString().trim().toLowerCase();
      final numeric = int.tryParse(text);
      final day = numeric == 0 ? 7 : numeric ?? weekdayNames[text];
      if (day != null && day >= 1 && day <= 7) days.add(day);
    }
    int? minute(Object? value) {
      if (value is num) return value.toInt();
      final text = (value ?? '').toString().trim();
      final clock = RegExp(r'^(\d{1,2}):(\d{2})$').firstMatch(text);
      if (clock != null) {
        final hour = int.parse(clock.group(1)!);
        final mins = int.parse(clock.group(2)!);
        if (hour <= 24 && mins < 60 && (hour < 24 || mins == 0)) return hour * 60 + mins;
      }
      return int.tryParse(text);
    }
    return LegacyAvailabilityPreview(
      requiresHostTimezoneConfirmation: source['requiresHostTimezoneConfirmation'] == true,
      days: days.toList()..sort(),
      startMin: minute(hours['from']),
      endMin: minute(hours['to']),
    );
  }
}

class BookingSchedule {
  const BookingSchedule({
    this.timezone = 'Asia/Kolkata', this.version = 0,
    this.durationsMinutes = const [15, 30, 45, 60],
    this.slotIntervalMinutes = 15, this.bufferMinutes = 10,
    this.minNoticeMinutes = 120, this.horizonDays = 60,
    this.rules = const [], this.exceptions = const [], this.legacyPreview,
  });
  final String timezone;
  final int version;
  final List<int> durationsMinutes;
  final int slotIntervalMinutes;
  final int bufferMinutes;
  final int minNoticeMinutes;
  final int horizonDays;
  final List<BookingWindow> rules;
  final List<BookingException> exceptions;
  final LegacyAvailabilityPreview? legacyPreview;

  factory BookingSchedule.fromJson(Map<String, dynamic> source) {
    final json = _object(source['schedule']) ?? source;
    return BookingSchedule(
      timezone: _text(json['timezone']) ?? 'Asia/Kolkata',
      version: (_number(json['version']) ?? 0).toInt(),
      durationsMinutes: [for (final v in (json['durationsMinutes'] as List? ?? const [15,30,45,60])) if (_number(v) != null) _number(v)!.toInt()],
      slotIntervalMinutes: (_number(json['slotIntervalMinutes']) ?? 15).toInt(),
      bufferMinutes: (_number(json['bufferMinutes']) ?? 10).toInt(),
      minNoticeMinutes: (_number(json['minNoticeMinutes']) ?? 120).toInt(),
      horizonDays: (_number(json['horizonDays']) ?? 60).toInt(),
      rules: [for (final row in _objects(json['rules'])) BookingWindow.fromJson(row)],
      exceptions: [for (final row in _objects(json['exceptions'])) BookingException.fromJson(row)],
      legacyPreview: _object(source['legacyPreview']) == null
          ? null
          : LegacyAvailabilityPreview.fromJson(_object(source['legacyPreview'])!),
    );
  }

  Map<String, dynamic> toJson() => {
    'timezone': timezone, 'version': version, 'durationsMinutes': durationsMinutes,
    'slotIntervalMinutes': slotIntervalMinutes, 'bufferMinutes': bufferMinutes,
    'minNoticeMinutes': minNoticeMinutes, 'horizonDays': horizonDays,
    'rules': [for (final row in rules) row.toJson()],
    'exceptions': [for (final row in exceptions) row.toJson()],
  };
}

class BookingSlot {
  const BookingSlot({required this.startUtc, required this.endUtc, this.hostLocalLabel, this.offsetLabel});
  final DateTime startUtc;
  final DateTime endUtc;
  final String? hostLocalLabel;
  final String? offsetLabel;

  factory BookingSlot.fromJson(Map<String, dynamic> json) => BookingSlot(
    startUtc: _date(json['startUtc']) ?? DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
    endUtc: _date(json['endUtc']) ?? DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
    hostLocalLabel: _text(json['hostLocalLabel']),
    offsetLabel: _text(json['offsetLabel']),
  );
}

class BookingQuote {
  const BookingQuote({
    required this.id, required this.expiresAt, required this.startUtc,
    required this.endUtc, required this.durationMinutes, required this.reservedPaise,
    required this.priceRupees,
  });
  final String id;
  final DateTime? expiresAt;
  final DateTime startUtc;
  final DateTime endUtc;
  final int durationMinutes;
  final int reservedPaise;
  final num priceRupees;

  factory BookingQuote.fromJson(Map<String, dynamic> source) {
    final j = _object(source['quote']) ?? source;
    return BookingQuote(
      id: (_text(j['id']) ?? _text(j['quoteId']) ?? ''),
      expiresAt: _date(j['expiresAt']),
      startUtc: _date(j['startUtc']) ?? DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
      endUtc: _date(j['endUtc']) ?? DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
      durationMinutes: (_number(j['durationMinutes']) ?? 0).toInt(),
      reservedPaise: (_number(j['reservedPaise']) ?? 0).toInt(),
      priceRupees: _number(j['priceRupees']) ?? 0,
    );
  }
}

class BookingRecord {
  const BookingRecord({
    required this.id, required this.status, required this.startUtc,
    required this.endUtc, this.hostUid, this.customerUid, this.hostTimezone,
    this.reservedPaise = 0, this.expectedHostNetPaise, this.callId,
    this.canStart = false, this.canCancel = false,
  });
  final String id;
  final String status;
  final DateTime startUtc;
  final DateTime endUtc;
  final String? hostUid;
  final String? customerUid;
  final String? hostTimezone;
  final int reservedPaise;
  final int? expectedHostNetPaise;
  final String? callId;
  final bool canStart;
  final bool canCancel;

  factory BookingRecord.fromJson(Map<String, dynamic> source) {
    final j = _object(source['booking']) ?? source;
    final call = _object(source['call']);
    return BookingRecord(
      id: (_text(j['id']) ?? ''),
      status: (_text(j['status']) ?? 'unknown'),
      startUtc: _date(j['startUtc']) ?? DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
      endUtc: _date(j['endUtc']) ?? DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
      hostUid: _text(j['hostUid']), customerUid: _text(j['customerUid']),
      hostTimezone: _text(j['hostTimezone']),
      reservedPaise: (_number(j['reservedPaise']) ?? 0).toInt(),
      expectedHostNetPaise: _number(j['expectedHostNetPaise'])?.toInt(),
      callId: _text(j['callId']) ?? _text(source['callId']) ?? _text(call?['id']),
      canStart: j['canStart'] == true || source['canStart'] == true,
      canCancel: j['canCancel'] == true || source['canCancel'] == true,
    );
  }
}

class BookingSummary {
  const BookingSummary({this.upcomingCount = 0, this.expectedHostNetPaise = 0, this.nextBooking});
  final int upcomingCount;
  final int expectedHostNetPaise;
  final BookingRecord? nextBooking;

  factory BookingSummary.fromJson(Map<String, dynamic> source) {
    final j = _object(source['summary']) ?? source;
    return BookingSummary(
      upcomingCount: (_number(j['upcomingCount']) ?? 0).toInt(),
      expectedHostNetPaise: (_number(j['expectedHostNetPaise']) ?? 0).toInt(),
      nextBooking: _object(j['nextBooking']) == null ? null : BookingRecord.fromJson(_object(j['nextBooking'])!),
    );
  }
}
