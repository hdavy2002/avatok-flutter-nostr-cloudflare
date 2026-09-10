/// Wire conversion for [ListingDraft]. Keeps the cumulative-save contract in
/// one place so every native wizard step sends the same shape as the web flow.
library;

import 'dart:convert';

import '../../../../core/availability_time.dart';
import 'listing_draft.dart';

const _timezoneAliases = <String, String>{'Asia/Calcutta': 'Asia/Kolkata'};

String normalizeListingTimezone(String value) => _timezoneAliases[value] ?? (value.isEmpty ? 'UTC' : value);

String bestEffortLocalTimezone() {
  final name = DateTime.now().timeZoneName;
  if (name.contains('/')) return normalizeListingTimezone(name);
  final offset = DateTime.now().timeZoneOffset;
  if (offset == Duration.zero) return 'UTC';
  final hours = offset.inHours;
  // Etc/GMT signs are POSIX-inverted. This is a valid, DST-free IANA zone.
  return 'Etc/GMT${hours <= 0 ? '+${-hours}' : '-$hours'}';
}

ListingDraft emptyListingDraft({ListingDraft? initial}) {
  final draft = initial ?? const ListingDraft();
  return draft.copyWith(timezone: normalizeListingTimezone(draft.timezone.isEmpty ? bestEffortLocalTimezone() : draft.timezone));
}

int? listingLocalToEpoch(String value, {String timezone = 'UTC'}) {
  if (value.trim().isEmpty) return null;
  final parsed = DateTime.tryParse(value);
  if (parsed == null) return null;
  try {
    return AvailabilityTime.wallTimeToUtc(
      date: DateTime(parsed.year, parsed.month, parsed.day),
      minutes: parsed.hour * 60 + parsed.minute,
      timezone: timezone,
    ).millisecondsSinceEpoch;
  } catch (_) {
    return null;
  }
}

String listingEpochToLocal(Object? value) {
  final epoch = value is num ? value.toInt() : int.tryParse('$value');
  if (epoch == null || epoch == 0) return '';
  final date = DateTime.fromMillisecondsSinceEpoch(epoch).toLocal();
  String pad(int number) => number.toString().padLeft(2, '0');
  return '${date.year}-${pad(date.month)}-${pad(date.day)}T${pad(date.hour)}:${pad(date.minute)}';
}

/// Hydrates the complete draft from GET /api/listings/:id. The API has shipped
/// attrs both as an object and as an encoded JSON string, so malformed attrs
/// safely become an empty map rather than breaking edit/resume.
ListingDraft listingDraftFromListing(Map<String, dynamic> listing) {
  final attrs = _attrs(listing['attrs']);
  final face = attrs['face_photo'];
  final faceUrl = face is String ? face : _string(_map(face)['url']);
  return ListingDraft(
    id: _nullableString(listing['id']),
    status: _nullableString(listing['status']),
    kind: listingKindFromWire(listing['kind']),
    freeEntry: _bool(listing['free_entry']),
    contentFreeCapTokens: _string(attrs['content_free_cap_tokens']),
    scheduleMode: listingScheduleModeFromWire(listing['schedule_mode']),
    availabilityMode: _string(listing['availability_mode'], fallback: 'shared'),
    availabilityRules: _list(listing['availability_rules']).whereType<Map>().map((e) => e.cast<String, dynamic>()).toList(),
    availabilityVersion: _int(listing['availability_version']),
    title: _string(listing['title']), blurb: _string(listing['blurb']), description: _string(listing['description']),
    category: _string(listing['category']),
    mediaMode: _string(listing['media_mode'], fallback: 'audio_video') == 'audio_only' ? 'audio_only' : 'audio_video',
    vibeTags: _strings(listing['vibe_tags']), spokenLang: _csvStrings(listing['spoken_lang']),
    price: _string(listing['price']), billingUnit: _string(listing['billing_unit'], fallback: 'session'),
    timezone: normalizeListingTimezone(_string(listing['timezone'], fallback: 'Asia/Kolkata')),
    startsAt: listingEpochToLocal(listing['starts_at']), durationMin: _int(listing['duration_min'], fallback: 60),
    recurrenceDays: _ints(listing['recurrence_days']), recurrenceTime: _string(listing['recurrence_time'], fallback: '18:00'),
    responseTimeMin: _string(listing['response_time_min']), maxPerBooking: _int(listing['max_per_booking'], fallback: 4),
    capacity: _int(listing['capacity']),
    contentHowItWorks: _list(attrs['content_how_it_works']).map(ListingHowItWorksStep.fromJson).toList(),
    contentHouseRulesIntro: _string(attrs['content_house_rules_intro']),
    contentHouseRules: _list(attrs['content_house_rules']).map(ListingHouseRule.fromJson).toList(),
    contentWhatYouGet: _strings(attrs['content_what_you_get']), contentWhoFor: _strings(attrs['content_who_for']),
    contentNotFor: _strings(attrs['content_not_for']), contentFaq: _list(attrs['content_faq']).map(ListingQa.fromJson).toList(),
    joinRequirements: ListingJoinRequirements.fromJson(attrs['join_requirements']),
    contentJoinLeadMinutes: _int(attrs['content_join_lead_minutes'], fallback: 5),
    contentSampleQa: _list(attrs['content_sample_qa']).map(ListingQa.fromJson).toList(),
    credential: _string(listing['credential']), commercialPreparationInstructions: _string(attrs['commercial_preparation_instructions']),
    contentSampleChat: _list(attrs['content_sample_chat']).map(ListingSampleChatLine.fromJson).toList(),
    contentCanDo: _strings(attrs['content_can_do']), contentCantDo: _strings(attrs['content_cant_do']),
    coverMedia: _list(listing['cover_media']).map(ListingCoverMedia.fromJson).toList(),
    facePhoto: faceUrl.startsWith('https://') ? faceUrl : null, videoUrl: _string(listing['video_url']), location: _string(listing['location']),
    adultsOnly: _bool(listing['adults_only']),
    commercialRefundWindowHours: _int(attrs['commercial_refund_window_hours'], fallback: 24),
    commercialCancellationWindowHours: _int(attrs['commercial_cancellation_window_hours'], fallback: 24),
    commercialRescheduleAllowed: _bool(attrs['commercial_reschedule_allowed'], fallback: true),
    commercialBookingNoticeHours: _int(attrs['commercial_booking_notice_hours'], fallback: 6),
    poster: attrs['poster'] is Map ? ListingPosterMirror.fromJson(attrs['poster']) : null,
  );
}

/// Builds the complete creator-owned attrs object. Poster is deliberately
/// excluded: it is server-owned and must never be posted back by the client.
Map<String, dynamic> listingBuildAttrs(ListingDraft draft, {bool includePolicy = false}) {
  final attrs = <String, dynamic>{};
  if (draft.facePhoto != null && draft.facePhoto!.isNotEmpty) attrs['face_photo'] = {'url': draft.facePhoto};
  if (draft.contentHowItWorks.isNotEmpty) attrs['content_how_it_works'] = draft.contentHowItWorks.take(5).map((e) => e.toJson()).toList();
  if (draft.contentHouseRules.isNotEmpty) attrs['content_house_rules'] = draft.contentHouseRules.take(8).map((e) => e.toJson()).toList();
  if (draft.contentHouseRulesIntro.trim().isNotEmpty) attrs['content_house_rules_intro'] = _truncate(draft.contentHouseRulesIntro.trim(), 280);
  attrs['content_join_lead_minutes'] = draft.contentJoinLeadMinutes;
  if (draft.freeEntry) {
    final cap = int.tryParse(draft.contentFreeCapTokens.trim());
    if (cap != null && cap > 0) attrs['content_free_cap_tokens'] = cap;
  }
  if (draft.contentWhatYouGet.length >= 3) attrs['content_what_you_get'] = draft.contentWhatYouGet.take(5).toList();
  if (draft.contentWhoFor.isNotEmpty) attrs['content_who_for'] = draft.contentWhoFor.take(3).toList();
  if (draft.contentNotFor.isNotEmpty) attrs['content_not_for'] = draft.contentNotFor.take(3).toList();
  if (draft.contentFaq.length >= 3) attrs['content_faq'] = draft.contentFaq.take(6).map((e) => e.toJson()).toList();
  if (draft.kind == ListingKind.consult) {
    if (draft.contentSampleQa.isNotEmpty) attrs['content_sample_qa'] = draft.contentSampleQa.take(3).map((e) => e.toJson()).toList();
    if (!draft.joinRequirements.isEmpty) attrs['join_requirements'] = draft.joinRequirements.toJson();
  }
  if (draft.kind == ListingKind.aiAgent) {
    if (draft.contentSampleChat.isNotEmpty) attrs['content_sample_chat'] = draft.contentSampleChat.take(6).map((e) => e.toJson()).toList();
    if (draft.contentCanDo.isNotEmpty) attrs['content_can_do'] = draft.contentCanDo.take(3).toList();
    if (draft.contentCantDo.isNotEmpty) attrs['content_cant_do'] = draft.contentCantDo.take(3).toList();
    if (!draft.joinRequirements.isEmpty) attrs['join_requirements'] = draft.joinRequirements.toJson();
  }
  if (includePolicy) {
    if (draft.kind == ListingKind.liveEvent) attrs['commercial_refund_window_hours'] = draft.commercialRefundWindowHours;
    if (draft.kind == ListingKind.consult) {
      attrs['commercial_cancellation_window_hours'] = draft.commercialCancellationWindowHours;
      attrs['commercial_reschedule_allowed'] = draft.commercialRescheduleAllowed;
      attrs['commercial_booking_notice_hours'] = draft.commercialBookingNoticeHours;
      attrs['commercial_no_show_policy'] = 'session_charged';
      attrs['commercial_preparation_instructions'] = _truncate(draft.commercialPreparationInstructions.trim(), 600);
    }
  }
  return attrs;
}

/// Full cumulative POST/PUT body. Missing later-step values are omitted where
/// the web flow omits them, while attrs are sent wholesale when requested.
Map<String, dynamic> listingBodyForSave(ListingDraft draft, {bool includeAttrs = true, bool includePolicy = false}) {
  final body = <String, dynamic>{
    'kind': listingKindWire(draft.kind), 'free_entry': draft.freeEntry, 'schedule_mode': listingScheduleModeWire(draft.scheduleMode),
    'title': draft.title.trim(), 'vibe_tags': <String>[], 'price': draft.freeEntry ? 0 : (_number(draft.price)?.round() ?? 0),
    'billing_unit': 'hour', 'media_mode': draft.mediaMode, 'timezone': normalizeListingTimezone(draft.timezone),
    'max_per_booking': draft.maxPerBooking, 'adults_only': draft.adultsOnly,
    'cover_media': draft.coverMedia.map((e) => e.toJson()).toList(),
    if (draft.blurb.trim().isNotEmpty) 'blurb': draft.blurb.trim(), if (draft.description.trim().isNotEmpty) 'description': draft.description.trim(),
    if (draft.category.isNotEmpty) 'category': draft.category, if (draft.spokenLang.isNotEmpty) 'spoken_lang': draft.spokenLang.join(','),
    if (draft.videoUrl.trim().isNotEmpty) 'video_url': draft.videoUrl.trim(), if (draft.location.trim().isNotEmpty) 'location': draft.location.trim(),
    if (draft.credential.trim().isNotEmpty) 'credential': draft.credential.trim(),
    if (draft.responseTimeMin.trim().isNotEmpty) 'response_time_min': int.tryParse(draft.responseTimeMin.trim()),
  };
  if (draft.scheduleMode == ListingScheduleMode.fixedDate) { body['starts_at'] = listingLocalToEpoch(draft.startsAt, timezone: draft.timezone); body['duration_min'] = draft.durationMin; }
  if (draft.scheduleMode == ListingScheduleMode.recurring) { body['recurrence_days'] = draft.recurrenceDays; body['recurrence_time'] = draft.recurrenceTime; body['duration_min'] = draft.durationMin; }
  if (draft.kind == ListingKind.consult) body['capacity'] = 1;
  if (draft.kind != ListingKind.consult && draft.capacity > 0) body['capacity'] = draft.capacity;
  if (includeAttrs) body['attrs'] = listingBuildAttrs(draft, includePolicy: includePolicy);
  return body;
}

Map<String, dynamic> _attrs(Object? value) { if (value is Map) return value.cast<String, dynamic>(); if (value is String && value.isNotEmpty) { try { final decoded = jsonDecode(value); if (decoded is Map) return decoded.cast<String, dynamic>(); } catch (_) {} } return {}; }
Map<String, dynamic> _map(Object? value) => value is Map ? value.cast<String, dynamic>() : {};
List<dynamic> _list(Object? value) => value is List ? value : const [];
String _string(Object? value, {String fallback = ''}) => value == null ? fallback : '$value';
String? _nullableString(Object? value) => value == null || '$value'.isEmpty ? null : '$value';
bool _bool(Object? value, {bool fallback = false}) => value is bool ? value : value == null ? fallback : '$value'.toLowerCase() == 'true';
int _int(Object? value, {int fallback = 0}) => value is num ? value.toInt() : int.tryParse('$value') ?? fallback;
List<String> _strings(Object? value) => _list(value).map((e) => '$e').where((e) => e.isNotEmpty).toList();
List<String> _csvStrings(Object? value) => value is String ? value.split(',').map((e) => e.trim()).where((e) => e.isNotEmpty).toList() : _strings(value);
List<int> _ints(Object? value) => _list(value).map(_int).toList();
num? _number(String value) => num.tryParse(value.trim());
String _truncate(String value, int maxLength) => value.length <= maxLength ? value : value.substring(0, maxLength);
