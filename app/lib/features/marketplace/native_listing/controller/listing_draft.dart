import 'dart:convert';

/// The complete native-wizard draft. Field names intentionally mirror the web
/// wizard and Worker listing contract so a save is cumulative and lossless.
class ListingDraft {
  final String? id;
  final String? status;
  final String kind;
  final bool freeEntry;
  final String scheduleMode;
  final String title, blurb, description, category, mediaMode;
  final List<String> spokenLang;
  final String price;
  final String earlyBirdPct, promoCode;
  final String timezone, startsAt, recurrenceTime, responseTimeMin;
  final int durationMin, maxPerBooking, capacity;
  final List<int> recurrenceDays;
  final List<Map<String, dynamic>> slots;
  final List<Map<String, dynamic>> howItWorks, houseRules, faq;
  final List<String> whatYouGet, whoFor, notFor, canDo, cantDo;
  final String houseRulesIntro, credential, preparationInstructions;
  final Map<String, dynamic> joinRequirements;
  final List<Map<String, dynamic>> sampleQa, sampleChat;
  final List<Map<String, dynamic>> coverMedia;
  final String? facePhoto;
  final String videoUrl, location;
  final bool adultsOnly;
  final int refundWindowHours, cancellationWindowHours, bookingNoticeHours;
  final bool rescheduleAllowed;
  final Map<String, dynamic>? poster;

  const ListingDraft({
    this.id,
    this.status,
    this.kind = 'live_event',
    this.freeEntry = false,
    this.scheduleMode = 'fixed_date',
    this.title = '',
    this.blurb = '',
    this.description = '',
    this.category = '',
    this.mediaMode = 'audio_video',
    this.spokenLang = const [],
    this.price = '',
    this.earlyBirdPct = '',
    this.promoCode = '',
    this.timezone = 'Asia/Kolkata',
    this.startsAt = '',
    this.recurrenceTime = '18:00',
    this.responseTimeMin = '',
    this.durationMin = 60,
    this.maxPerBooking = 4,
    this.capacity = 0,
    this.recurrenceDays = const [],
    this.slots = const [],
    this.howItWorks = const [],
    this.houseRules = const [],
    this.faq = const [],
    this.whatYouGet = const [],
    this.whoFor = const [],
    this.notFor = const [],
    this.canDo = const [],
    this.cantDo = const [],
    this.houseRulesIntro = '',
    this.credential = '',
    this.preparationInstructions = '',
    this.joinRequirements = const {},
    this.sampleQa = const [],
    this.sampleChat = const [],
    this.coverMedia = const [],
    this.facePhoto,
    this.videoUrl = '',
    this.location = '',
    this.adultsOnly = false,
    this.refundWindowHours = 24,
    this.cancellationWindowHours = 24,
    this.bookingNoticeHours = 6,
    this.rescheduleAllowed = true,
    this.poster,
  });

  ListingDraft copyWith({
    String? id,
    bool clearId = false,
    String? status,
    String? kind,
    bool? freeEntry,
    String? scheduleMode,
    String? title,
    String? blurb,
    String? description,
    String? category,
    String? mediaMode,
    List<String>? spokenLang,
    String? price,
    String? timezone,
    String? startsAt,
    String? earlyBirdPct,
    String? promoCode,
    String? recurrenceTime,
    String? responseTimeMin,
    int? durationMin,
    int? maxPerBooking,
    int? capacity,
    List<int>? recurrenceDays,
    List<Map<String, dynamic>>? slots,
    List<Map<String, dynamic>>? howItWorks,
    List<Map<String, dynamic>>? houseRules,
    List<Map<String, dynamic>>? faq,
    List<String>? whatYouGet,
    List<String>? whoFor,
    List<String>? notFor,
    List<String>? canDo,
    List<String>? cantDo,
    String? houseRulesIntro,
    String? credential,
    String? preparationInstructions,
    Map<String, dynamic>? joinRequirements,
    List<Map<String, dynamic>>? sampleQa,
    List<Map<String, dynamic>>? sampleChat,
    List<Map<String, dynamic>>? coverMedia,
    String? facePhoto,
    bool clearFacePhoto = false,
    String? videoUrl,
    String? location,
    bool? adultsOnly,
    int? refundWindowHours,
    int? cancellationWindowHours,
    int? bookingNoticeHours,
    bool? rescheduleAllowed,
    Map<String, dynamic>? poster,
    bool clearPoster = false,
  }) =>
      ListingDraft(
        id: clearId ? null : (id ?? this.id),
        status: status ?? this.status,
        kind: kind ?? this.kind,
        freeEntry: freeEntry ?? this.freeEntry,
        scheduleMode: scheduleMode ?? this.scheduleMode,
        title: title ?? this.title,
        blurb: blurb ?? this.blurb,
        description: description ?? this.description,
        category: category ?? this.category,
        mediaMode: mediaMode ?? this.mediaMode,
        spokenLang: List.unmodifiable(spokenLang ?? this.spokenLang),
        price: price ?? this.price,
        earlyBirdPct: earlyBirdPct ?? this.earlyBirdPct,
        promoCode: promoCode ?? this.promoCode,
        timezone: timezone ?? this.timezone,
        startsAt: startsAt ?? this.startsAt,
        recurrenceTime: recurrenceTime ?? this.recurrenceTime,
        responseTimeMin: responseTimeMin ?? this.responseTimeMin,
        durationMin: durationMin ?? this.durationMin,
        maxPerBooking: maxPerBooking ?? this.maxPerBooking,
        capacity: capacity ?? this.capacity,
        recurrenceDays:
            List.unmodifiable(recurrenceDays ?? this.recurrenceDays),
        slots: List.unmodifiable(slots ?? this.slots),
        howItWorks: List.unmodifiable(howItWorks ?? this.howItWorks),
        houseRules: List.unmodifiable(houseRules ?? this.houseRules),
        faq: List.unmodifiable(faq ?? this.faq),
        whatYouGet: List.unmodifiable(whatYouGet ?? this.whatYouGet),
        whoFor: List.unmodifiable(whoFor ?? this.whoFor),
        notFor: List.unmodifiable(notFor ?? this.notFor),
        canDo: List.unmodifiable(canDo ?? this.canDo),
        cantDo: List.unmodifiable(cantDo ?? this.cantDo),
        houseRulesIntro: houseRulesIntro ?? this.houseRulesIntro,
        credential: credential ?? this.credential,
        preparationInstructions:
            preparationInstructions ?? this.preparationInstructions,
        joinRequirements:
            Map.unmodifiable(joinRequirements ?? this.joinRequirements),
        sampleQa: List.unmodifiable(sampleQa ?? this.sampleQa),
        sampleChat: List.unmodifiable(sampleChat ?? this.sampleChat),
        coverMedia: List.unmodifiable(coverMedia ?? this.coverMedia),
        facePhoto: clearFacePhoto ? null : (facePhoto ?? this.facePhoto),
        videoUrl: videoUrl ?? this.videoUrl,
        location: location ?? this.location,
        adultsOnly: adultsOnly ?? this.adultsOnly,
        refundWindowHours: refundWindowHours ?? this.refundWindowHours,
        cancellationWindowHours:
            cancellationWindowHours ?? this.cancellationWindowHours,
        bookingNoticeHours: bookingNoticeHours ?? this.bookingNoticeHours,
        rescheduleAllowed: rescheduleAllowed ?? this.rescheduleAllowed,
        poster: clearPoster ? null : (poster ?? this.poster),
      );

  Map<String, dynamic> toSaveBody({bool includePolicy = true}) {
    final body = <String, dynamic>{
      'kind': kind,
      'free_entry': freeEntry,
      'schedule_mode': scheduleMode,
      'title': title.trim(),
      if (blurb.trim().isNotEmpty) 'blurb': blurb.trim(),
      if (description.trim().isNotEmpty) 'description': description.trim(),
      if (category.isNotEmpty) 'category': category,
      'vibe_tags': <String>[],
      if (spokenLang.isNotEmpty) 'spoken_lang': spokenLang.join(','),
      'price': freeEntry ? 0 : (int.tryParse(price.trim()) ?? 0),
      'billing_unit': 'hour',
      'media_mode': mediaMode,
      'timezone': timezone,
      'max_per_booking': maxPerBooking,
      if (videoUrl.trim().isNotEmpty) 'video_url': videoUrl.trim(),
      if (location.trim().isNotEmpty) 'location': location.trim(),
      'adults_only': adultsOnly,
      if (credential.trim().isNotEmpty) 'credential': credential.trim(),
      'cover_media': coverMedia,
    };
    if (responseTimeMin.trim().isNotEmpty)
      body['response_time_min'] = int.tryParse(responseTimeMin.trim());
    if (scheduleMode == 'fixed_date') {
      body['starts_at'] = localEpoch(startsAt);
      body['duration_min'] = durationMin;
    } else if (scheduleMode == 'recurring') {
      body['recurrence_days'] = recurrenceDays;
      body['recurrence_time'] = recurrenceTime;
      body['duration_min'] = durationMin;
    }
    if (kind == 'consult')
      body['capacity'] = 1;
    else if (capacity > 0) body['capacity'] = capacity;
    body['attrs'] = _attrs(includePolicy);
    return body;
  }

  Map<String, dynamic> _attrs(bool includePolicy) => {
        if (facePhoto != null) 'face_photo': {'url': facePhoto},
        if (howItWorks.isNotEmpty)
          'content_how_it_works': howItWorks.take(5).toList(),
        if (houseRules.isNotEmpty)
          'content_house_rules': houseRules.take(8).toList(),
        if (houseRulesIntro.trim().isNotEmpty)
          'content_house_rules_intro': _cap(houseRulesIntro.trim(), 280),
        'content_join_lead_minutes': 5,
        if (whatYouGet.length >= 3)
          'content_what_you_get': whatYouGet.take(5).toList(),
        if (whoFor.isNotEmpty) 'content_who_for': whoFor.take(3).toList(),
        if (notFor.isNotEmpty) 'content_not_for': notFor.take(3).toList(),
        if (faq.length >= 3) 'content_faq': faq.take(6).toList(),
        if (kind == 'consult' && sampleQa.isNotEmpty)
          'content_sample_qa': sampleQa.take(3).toList(),
        if (kind == 'ai_agent' && sampleChat.isNotEmpty)
          'content_sample_chat': sampleChat.take(6).toList(),
        if (kind == 'ai_agent' && canDo.isNotEmpty)
          'content_can_do': canDo.take(3).toList(),
        if (kind == 'ai_agent' && cantDo.isNotEmpty)
          'content_cant_do': cantDo.take(3).toList(),
        if (joinRequirements.isNotEmpty) 'join_requirements': joinRequirements,
        if (kind == 'consult' && preparationInstructions.trim().isNotEmpty)
          'commercial_preparation_instructions': preparationInstructions.trim(),
        if (includePolicy && kind == 'live_event')
          'commercial_refund_window_hours': refundWindowHours,
        if (includePolicy && kind == 'consult') ...{
          'commercial_cancellation_window_hours': cancellationWindowHours,
          'commercial_reschedule_allowed': rescheduleAllowed,
          'commercial_booking_notice_hours': bookingNoticeHours,
          'commercial_no_show_policy': 'session_charged',
        },
      };

  Map<String, dynamic> snapshot() =>
      jsonDecode(jsonEncode(toSaveBody(includePolicy: true)))
          as Map<String, dynamic>;

  bool get earlyBirdInvalid {
    if (earlyBirdPct.trim().isEmpty) return false;
    final n = int.tryParse(earlyBirdPct.trim());
    return n == null || n < 1 || n > 100;
  }

  static int? localEpoch(String value) {
    if (value.isEmpty) return null;
    final ms = DateTime.tryParse(value)?.millisecondsSinceEpoch;
    return ms;
  }

  static String _cap(String value, int max) =>
      value.length <= max ? value : value.substring(0, max);

  static ListingDraft fromListing(Map<String, dynamic> l) {
    final attrs = (l['attrs'] is Map)
        ? Map<String, dynamic>.from(l['attrs'] as Map)
        : <String, dynamic>{};
    List<Map<String, dynamic>> maps(dynamic v) => v is List
        ? v.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList()
        : <Map<String, dynamic>>[];
    List<String> strings(dynamic v) =>
        v is List ? v.map((e) => e.toString()).toList() : <String>[];
    final face = attrs['face_photo'];
    return ListingDraft(
      id: l['id']?.toString(),
      status: l['status']?.toString(),
      kind: l['kind'] == 'live' || l['kind'] == 'live_event'
          ? 'live_event'
          : (l['kind']?.toString() == 'consult' ? 'consult' : 'ai_agent'),
      freeEntry: l['free_entry'] == true,
      scheduleMode: l['schedule_mode']?.toString() ?? 'fixed_date',
      title: l['title']?.toString() ?? '',
      blurb: l['blurb']?.toString() ?? '',
      description: l['description']?.toString() ?? '',
      category: l['category']?.toString() ?? '',
      mediaMode: l['media_mode']?.toString() == 'audio_only'
          ? 'audio_only'
          : 'audio_video',
      spokenLang: (l['spoken_lang']?.toString() ?? '')
          .split(',')
          .where((e) => e.isNotEmpty)
          .toList(),
      price: l['price']?.toString() ?? '',
      earlyBirdPct: attrs['early_bird_pct']?.toString() ?? '',
      promoCode: attrs['promo_code']?.toString() ?? '',
      timezone: l['timezone']?.toString() ?? 'Asia/Kolkata',
      startsAt: _epochLocal(l['starts_at']),
      durationMin: (l['duration_min'] as num?)?.toInt() ?? 60,
      recurrenceDays: (l['recurrence_days'] as List?)
              ?.whereType<num>()
              .map((e) => e.toInt())
              .toList() ??
          const [],
      recurrenceTime: l['recurrence_time']?.toString() ?? '18:00',
      responseTimeMin: l['response_time_min']?.toString() ?? '',
      maxPerBooking: (l['max_per_booking'] as num?)?.toInt() ?? 4,
      capacity: (l['capacity'] as num?)?.toInt() ?? 0,
      howItWorks: maps(attrs['content_how_it_works']),
      houseRules: maps(attrs['content_house_rules']),
      faq: maps(attrs['content_faq']),
      whatYouGet: strings(attrs['content_what_you_get']),
      whoFor: strings(attrs['content_who_for']),
      notFor: strings(attrs['content_not_for']),
      canDo: strings(attrs['content_can_do']),
      cantDo: strings(attrs['content_cant_do']),
      houseRulesIntro: attrs['content_house_rules_intro']?.toString() ?? '',
      credential: l['credential']?.toString() ?? '',
      preparationInstructions:
          attrs['commercial_preparation_instructions']?.toString() ?? '',
      joinRequirements: attrs['join_requirements'] is Map
          ? Map<String, dynamic>.from(attrs['join_requirements'] as Map)
          : const {},
      sampleQa: maps(attrs['content_sample_qa']),
      sampleChat: maps(attrs['content_sample_chat']),
      coverMedia: maps(l['cover_media']),
      facePhoto: face is String
          ? face
          : (face is Map ? face['url']?.toString() : null),
      videoUrl: l['video_url']?.toString() ?? '',
      location: l['location']?.toString() ?? '',
      adultsOnly: l['adults_only'] == true,
      refundWindowHours:
          (attrs['commercial_refund_window_hours'] as num?)?.toInt() ?? 24,
      cancellationWindowHours:
          (attrs['commercial_cancellation_window_hours'] as num?)?.toInt() ??
              24,
      bookingNoticeHours:
          (attrs['commercial_booking_notice_hours'] as num?)?.toInt() ?? 6,
      rescheduleAllowed: attrs['commercial_reschedule_allowed'] != false,
      poster: attrs['poster'] is Map
          ? Map<String, dynamic>.from(attrs['poster'] as Map)
          : null,
    );
  }

  static String _epochLocal(dynamic value) {
    if (value == null) return '';
    final n = value is num ? value.toInt() : int.tryParse('$value');
    if (n == null) return '';
    final d =
        DateTime.fromMillisecondsSinceEpoch(n < 100000000000 ? n * 1000 : n)
            .toLocal();
    String p(int x) => x.toString().padLeft(2, '0');
    return '${d.year}-${p(d.month)}-${p(d.day)}T${p(d.hour)}:${p(d.minute)}';
  }
}
