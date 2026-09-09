/// UI-independent model for the eight-step native listing wizard.
///
/// The field names intentionally follow the web wizard and worker wire
/// contract. Serialization belongs in listing_draft_serialization.dart.
library;

typedef JsonMap = Map<String, dynamic>;

enum ListingKind { liveEvent, consult, aiAgent }

enum ListingScheduleMode { fixedDate, recurring, onRequest, alwaysOn }

String listingKindWire(ListingKind value) => switch (value) {
      ListingKind.liveEvent => 'live_event',
      ListingKind.consult => 'consult',
      ListingKind.aiAgent => 'ai_agent',
    };

ListingKind listingKindFromWire(Object? value) => switch ('$value') {
      'live' || 'live_event' => ListingKind.liveEvent,
      'consult' => ListingKind.consult,
      _ => ListingKind.aiAgent,
    };

String listingScheduleModeWire(ListingScheduleMode value) => switch (value) {
      ListingScheduleMode.fixedDate => 'fixed_date',
      ListingScheduleMode.recurring => 'recurring',
      ListingScheduleMode.onRequest => 'on_request',
      ListingScheduleMode.alwaysOn => 'always_on',
    };

ListingScheduleMode listingScheduleModeFromWire(Object? value) => switch ('$value') {
      'recurring' => ListingScheduleMode.recurring,
      'on_request' => ListingScheduleMode.onRequest,
      'always_on' => ListingScheduleMode.alwaysOn,
      _ => ListingScheduleMode.fixedDate,
    };

class ListingHowItWorksStep {
  final String label;
  final String body;

  const ListingHowItWorksStep({this.label = '', this.body = ''});

  factory ListingHowItWorksStep.fromJson(Object? value) {
    final map = _map(value);
    return ListingHowItWorksStep(label: _string(map['label']), body: _string(map['body']));
  }

  JsonMap toJson() => {'label': label, 'body': body};
}

class ListingHouseRule {
  final String heading;
  final String body;

  const ListingHouseRule({this.heading = '', this.body = ''});

  factory ListingHouseRule.fromJson(Object? value) {
    final map = _map(value);
    return ListingHouseRule(heading: _string(map['heading']), body: _string(map['body']));
  }

  JsonMap toJson() => {'heading': heading, 'body': body};
}

class ListingQa {
  final String q;
  final String a;

  const ListingQa({this.q = '', this.a = ''});

  factory ListingQa.fromJson(Object? value) {
    final map = _map(value);
    return ListingQa(q: _string(map['q']), a: _string(map['a']));
  }

  JsonMap toJson() => {'q': q, 'a': a};
}

class ListingSampleChatLine {
  final String who;
  final String line;

  const ListingSampleChatLine({this.who = '', this.line = ''});

  factory ListingSampleChatLine.fromJson(Object? value) {
    final map = _map(value);
    return ListingSampleChatLine(who: _string(map['who']), line: _string(map['line']));
  }

  JsonMap toJson() => {'who': who, 'line': line};
}

class ListingJoinRequirements {
  final bool? mic;
  final bool? cam;
  final bool? listenOnly;
  final int? replayDays;
  final bool? recording;

  const ListingJoinRequirements({this.mic, this.cam, this.listenOnly, this.replayDays, this.recording});

  factory ListingJoinRequirements.fromJson(Object? value) {
    final map = _map(value);
    return ListingJoinRequirements(
      mic: _nullableBool(map['mic']),
      cam: _nullableBool(map['cam']),
      listenOnly: _nullableBool(map['listen_only']),
      replayDays: _nullableInt(map['replay_days']),
      recording: _nullableBool(map['recording']),
    );
  }

  JsonMap toJson() => {
        if (mic != null) 'mic': mic,
        if (cam != null) 'cam': cam,
        if (listenOnly != null) 'listen_only': listenOnly,
        if (replayDays != null) 'replay_days': replayDays,
        if (recording != null) 'recording': recording,
      };

  bool get isEmpty => toJson().isEmpty;
}

class ListingDraftSlot {
  final String? id;
  final int startsAt;
  final int durationMin;
  final String label;
  final int capacity;

  const ListingDraftSlot({this.id, this.startsAt = 0, this.durationMin = 60, this.label = '', this.capacity = 1});

  factory ListingDraftSlot.fromJson(Object? value) {
    final map = _map(value);
    return ListingDraftSlot(
      id: _nullableString(map['id']),
      startsAt: _int(map['starts_at']),
      durationMin: _int(map['duration_min'], fallback: 60),
      label: _string(map['label']),
      capacity: _int(map['capacity'], fallback: 1),
    );
  }

  JsonMap toJson({bool includeId = true}) => {
        if (includeId && id != null) 'id': id,
        'starts_at': startsAt,
        'duration_min': durationMin,
        'label': label,
        'capacity': capacity,
      };
}

class ListingCoverMedia {
  final String type;
  final String url;

  const ListingCoverMedia({this.type = 'image', this.url = ''});

  factory ListingCoverMedia.fromJson(Object? value) {
    if (value is String) return ListingCoverMedia(url: value);
    final map = _map(value);
    return ListingCoverMedia(type: _string(map['type'], fallback: 'image'), url: _string(map['url']));
  }

  JsonMap toJson() => {'type': type, 'url': url};
}

class ListingPosterMirror {
  final String? status;
  final String? url;
  final String? lettering;
  final String? title;
  final String? tagline;
  final Map<String, ListingPosterVariant> variants;
  final String? error;

  const ListingPosterMirror({this.status, this.url, this.lettering, this.title, this.tagline, this.variants = const {}, this.error});

  factory ListingPosterMirror.fromJson(Object? value) {
    final map = _map(value);
    final copy = _map(map['copy']);
    final rawVariants = _map(map['variants']);
    return ListingPosterMirror(
      status: _nullableString(map['status']),
      url: _nullableString(map['url']),
      lettering: _nullableString(map['lettering']),
      title: _nullableString(copy['title']),
      tagline: _nullableString(copy['tagline']),
      variants: {
        for (final entry in rawVariants.entries)
          if (_map(entry.value).isNotEmpty) entry.key: ListingPosterVariant.fromJson(entry.value),
      },
      error: _nullableString(map['error']),
    );
  }

  JsonMap toJson() => {
        if (status != null) 'status': status,
        if (url != null) 'url': url,
        if (lettering != null) 'lettering': lettering,
        if (title != null || tagline != null) 'copy': {if (title != null) 'title': title, if (tagline != null) 'tagline': tagline},
        if (variants.isNotEmpty) 'variants': {for (final e in variants.entries) e.key: e.value.toJson()},
        if (error != null) 'error': error,
      };
}

class ListingPosterVariant {
  final String url;
  const ListingPosterVariant({this.url = ''});
  factory ListingPosterVariant.fromJson(Object? value) => ListingPosterVariant(url: _string(_map(value)['url']));
  JsonMap toJson() => {'url': url};
}

class ListingDraft {
  final String? id;
  final String? status;
  final ListingKind kind;
  final bool freeEntry;
  final String contentFreeCapTokens;
  final ListingScheduleMode scheduleMode;
  final String title, blurb, description, category, mediaMode;
  final List<String> vibeTags, spokenLang;
  final String price, billingUnit, earlyBirdPct, promoCode;
  final String timezone, startsAt;
  final int durationMin;
  final List<int> recurrenceDays;
  final String recurrenceTime;
  final List<ListingDraftSlot> slots;
  final String responseTimeMin;
  final int maxPerBooking, capacity;
  final List<ListingHowItWorksStep> contentHowItWorks;
  final String contentHouseRulesIntro;
  final List<ListingHouseRule> contentHouseRules;
  final List<String> contentWhatYouGet, contentWhoFor, contentNotFor;
  final List<ListingQa> contentFaq;
  final ListingJoinRequirements joinRequirements;
  final int contentJoinLeadMinutes;
  final List<ListingQa> contentSampleQa;
  final String credential, commercialPreparationInstructions;
  final List<ListingSampleChatLine> contentSampleChat;
  final List<String> contentCanDo, contentCantDo;
  final List<ListingCoverMedia> coverMedia;
  final String? facePhoto;
  final String videoUrl, location;
  final bool adultsOnly;
  final int commercialRefundWindowHours, commercialCancellationWindowHours;
  final bool commercialRescheduleAllowed;
  final int commercialBookingNoticeHours;
  final ListingPosterMirror? poster;
  final String? defaultsAppliedFor;

  const ListingDraft({
    this.id,
    this.status,
    this.kind = ListingKind.liveEvent,
    this.freeEntry = false,
    this.contentFreeCapTokens = '',
    this.scheduleMode = ListingScheduleMode.fixedDate,
    this.title = '',
    this.blurb = '',
    this.description = '',
    this.category = '',
    this.mediaMode = 'audio_video',
    this.vibeTags = const [],
    this.spokenLang = const [],
    this.price = '',
    this.billingUnit = 'session',
    this.earlyBirdPct = '',
    this.promoCode = '',
    this.timezone = 'UTC',
    this.startsAt = '',
    this.durationMin = 60,
    this.recurrenceDays = const [],
    this.recurrenceTime = '18:00',
    this.slots = const [],
    this.responseTimeMin = '',
    this.maxPerBooking = 4,
    this.capacity = 0,
    this.contentHowItWorks = const [],
    this.contentHouseRulesIntro = '',
    this.contentHouseRules = const [],
    this.contentWhatYouGet = const [],
    this.contentWhoFor = const [],
    this.contentNotFor = const [],
    this.contentFaq = const [],
    this.joinRequirements = const ListingJoinRequirements(),
    this.contentJoinLeadMinutes = 5,
    this.contentSampleQa = const [],
    this.credential = '',
    this.commercialPreparationInstructions = '',
    this.contentSampleChat = const [],
    this.contentCanDo = const [],
    this.contentCantDo = const [],
    this.coverMedia = const [],
    this.facePhoto,
    this.videoUrl = '',
    this.location = '',
    this.adultsOnly = false,
    this.commercialRefundWindowHours = 24,
    this.commercialCancellationWindowHours = 24,
    this.commercialRescheduleAllowed = true,
    this.commercialBookingNoticeHours = 6,
    this.poster,
    this.defaultsAppliedFor,
  });

  ListingDraft copyWith({
    String? id, bool clearId = false, String? status, ListingKind? kind, bool? freeEntry,
    String? contentFreeCapTokens, ListingScheduleMode? scheduleMode, String? title, String? blurb,
    String? description, String? category, String? mediaMode, List<String>? vibeTags,
    List<String>? spokenLang, String? price, String? billingUnit, String? earlyBirdPct,
    String? promoCode, String? timezone, String? startsAt, int? durationMin, List<int>? recurrenceDays,
    String? recurrenceTime, List<ListingDraftSlot>? slots, String? responseTimeMin, int? maxPerBooking,
    int? capacity, List<ListingHowItWorksStep>? contentHowItWorks, String? contentHouseRulesIntro,
    List<ListingHouseRule>? contentHouseRules, List<String>? contentWhatYouGet, List<String>? contentWhoFor,
    List<String>? contentNotFor, List<ListingQa>? contentFaq, ListingJoinRequirements? joinRequirements,
    int? contentJoinLeadMinutes, List<ListingQa>? contentSampleQa, String? credential,
    String? commercialPreparationInstructions, List<ListingSampleChatLine>? contentSampleChat,
    List<String>? contentCanDo, List<String>? contentCantDo, List<ListingCoverMedia>? coverMedia,
    String? facePhoto, bool clearFacePhoto = false, String? videoUrl, String? location, bool? adultsOnly,
    int? commercialRefundWindowHours, int? commercialCancellationWindowHours, bool? commercialRescheduleAllowed,
    int? commercialBookingNoticeHours, ListingPosterMirror? poster, bool clearPoster = false,
    String? defaultsAppliedFor,
  }) => ListingDraft(
        id: clearId ? null : (id ?? this.id), status: status ?? this.status, kind: kind ?? this.kind,
        freeEntry: freeEntry ?? this.freeEntry, contentFreeCapTokens: contentFreeCapTokens ?? this.contentFreeCapTokens,
        scheduleMode: scheduleMode ?? this.scheduleMode, title: title ?? this.title, blurb: blurb ?? this.blurb,
        description: description ?? this.description, category: category ?? this.category, mediaMode: mediaMode ?? this.mediaMode,
        vibeTags: vibeTags ?? this.vibeTags, spokenLang: spokenLang ?? this.spokenLang, price: price ?? this.price,
        billingUnit: billingUnit ?? this.billingUnit, earlyBirdPct: earlyBirdPct ?? this.earlyBirdPct, promoCode: promoCode ?? this.promoCode,
        timezone: timezone ?? this.timezone, startsAt: startsAt ?? this.startsAt, durationMin: durationMin ?? this.durationMin,
        recurrenceDays: recurrenceDays ?? this.recurrenceDays, recurrenceTime: recurrenceTime ?? this.recurrenceTime,
        slots: slots ?? this.slots, responseTimeMin: responseTimeMin ?? this.responseTimeMin,
        maxPerBooking: maxPerBooking ?? this.maxPerBooking, capacity: capacity ?? this.capacity,
        contentHowItWorks: contentHowItWorks ?? this.contentHowItWorks, contentHouseRulesIntro: contentHouseRulesIntro ?? this.contentHouseRulesIntro,
        contentHouseRules: contentHouseRules ?? this.contentHouseRules, contentWhatYouGet: contentWhatYouGet ?? this.contentWhatYouGet,
        contentWhoFor: contentWhoFor ?? this.contentWhoFor, contentNotFor: contentNotFor ?? this.contentNotFor,
        contentFaq: contentFaq ?? this.contentFaq, joinRequirements: joinRequirements ?? this.joinRequirements,
        contentJoinLeadMinutes: contentJoinLeadMinutes ?? this.contentJoinLeadMinutes, contentSampleQa: contentSampleQa ?? this.contentSampleQa,
        credential: credential ?? this.credential, commercialPreparationInstructions: commercialPreparationInstructions ?? this.commercialPreparationInstructions,
        contentSampleChat: contentSampleChat ?? this.contentSampleChat, contentCanDo: contentCanDo ?? this.contentCanDo,
        contentCantDo: contentCantDo ?? this.contentCantDo, coverMedia: coverMedia ?? this.coverMedia,
        facePhoto: clearFacePhoto ? null : (facePhoto ?? this.facePhoto), videoUrl: videoUrl ?? this.videoUrl,
        location: location ?? this.location, adultsOnly: adultsOnly ?? this.adultsOnly,
        commercialRefundWindowHours: commercialRefundWindowHours ?? this.commercialRefundWindowHours,
        commercialCancellationWindowHours: commercialCancellationWindowHours ?? this.commercialCancellationWindowHours,
        commercialRescheduleAllowed: commercialRescheduleAllowed ?? this.commercialRescheduleAllowed,
        commercialBookingNoticeHours: commercialBookingNoticeHours ?? this.commercialBookingNoticeHours,
        poster: clearPoster ? null : (poster ?? this.poster), defaultsAppliedFor: defaultsAppliedFor ?? this.defaultsAppliedFor,
      );
}

Map<String, dynamic> _map(Object? value) => value is Map ? value.cast<String, dynamic>() : <String, dynamic>{};
String _string(Object? value, {String fallback = ''}) => value == null ? fallback : '$value';
String? _nullableString(Object? value) => value == null || '$value'.isEmpty ? null : '$value';
int _int(Object? value, {int fallback = 0}) => value is num ? value.toInt() : int.tryParse('$value') ?? fallback;
int? _nullableInt(Object? value) => value == null ? null : _int(value);
bool _bool(Object? value, {bool fallback = false}) => value is bool ? value : value == null ? fallback : '$value'.toLowerCase() == 'true';
bool? _nullableBool(Object? value) => value == null ? null : _bool(value);

