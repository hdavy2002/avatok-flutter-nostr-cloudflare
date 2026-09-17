import 'ui_text.dart';

// Allowlist of authored validation/display templates. Unknown server errors and
// all captured user values stay unchanged; this does not translate identifiers.
String? knownUiError(String? value) => value == null ? null : knownUiCopy(value);
String knownUiCopy(String value) {
  final exact = authoredUiCopy(value);
  if (exact != value) return exact;
  for (final entry in _patterns) {
    final match = entry.pattern.firstMatch(value);
    if (match == null) continue;
    return uiCopy(entry.message, {
      for (var i = 0; i < entry.names.length; i++) entry.names[i]: entry.message == UiMessage.m_run_the_ai_check_on_1771abd32d
          ? _copyFieldList(match.group(i + 1)!) : match.group(i + 1)!,
    });
  }
  return value;
}
final _patterns = <({UiMessage message, RegExp pattern, List<String> names})>[
  (message: UiMessage.m_peerfirst_s_phone_appears_to_6c1accc3df, pattern: RegExp("^(.*?)'s\\ phone\\ appears\\ to\\ be\\ off\\ or\\ unreachable\$", dotAll: true), names: <String>["peerFirst"]),
  (message: UiMessage.m_connecting_you_to_peerfirst_s_57b6dff390, pattern: RegExp("^Connecting\\ you\\ to\\ (.*?)'s\\ Ava\\ AI\\ agent…\$", dotAll: true), names: <String>["peerFirst"]),
  (message: UiMessage.m_peerfirst_can_t_take_your_d3ca4a8387, pattern: RegExp("^(.*?)\\ can't\\ take\\ your\\ call\\ right\\ now\$", dotAll: true), names: <String>["peerFirst"]),
  (message: UiMessage.m_peerfirst_is_busy_on_another_63f98d7b08, pattern: RegExp("^(.*?)\\ is\\ busy\\ on\\ another\\ call\$", dotAll: true), names: <String>["peerFirst"]),
  (message: UiMessage.m_peerfirst_isn_t_answering_8ca8111bc7, pattern: RegExp("^(.*?)\\ isn't\\ answering\$", dotAll: true), names: <String>["peerFirst"]),
  (message: UiMessage.m_that_time_does_not_exist_6ce565b4b2, pattern: RegExp("^That\\ time\\ does\\ not\\ exist\\ in\\ (.*?)\\ because\\ of\\ a\\ daylight\\-saving\\ clock\\ change\\.\\ Pick\\ another\\ time\\.\$", dotAll: true), names: <String>["zone"]),
  (message: UiMessage.m_price_must_be_at_least_2e1714f8b5, pattern: RegExp("^Price\\ must\\ be\\ at\\ least\\ (.*?)\\ tokens/hour\\ \\(₹(.*?)\\)\\.\$", dotAll: true), names: <String>["minPricePerHour", "minPricePerHour_2"]),
  (message: UiMessage.m_a_few_things_still_needed_838ec46db3, pattern: RegExp("^A\\ few\\ things\\ still\\ needed\\ —\\ starting\\ with:\\ (.*?)\$", dotAll: true), names: <String>["field"]),
  (message: UiMessage.m_run_the_ai_check_on_1771abd32d, pattern: RegExp("^Run\\ the\\ AI\\ check\\ on\\ (.*?)\\ before\\ continuing\\.\$", dotAll: true), names: <String>["value1"]),
  (message: UiMessage.m_reason_reconnect_or_refresh_google_6de7c73977, pattern: RegExp("^(.*?)\\ Reconnect\\ or\\ refresh\\ Google\\ Calendar,\\ then\\ check\\ again\\ —\\ AvaTOK\\ will\\ not\\ treat\\ busy\\ times\\ as\\ protected\\ until\\ it\\ can\\ confirm\\ this\\.\$", dotAll: true), names: <String>["reason"]),
  (message: UiMessage.m_effective_minimum_notice_value1_from_8255b42ee7, pattern: RegExp("^Effective\\ minimum\\ notice:\\ (.*?)\\ from\\ your\\ calendar\\.\\ A\\ listing\\ can\\ require\\ longer\\ notice;\\ the\\ larger\\ value\\ applies\\.\$", dotAll: true), names: <String>["value1"]),
  (message: UiMessage.m_the_last_successful_sync_is_a37ad7079e, pattern: RegExp("^The\\ last\\ successful\\ sync\\ is\\ older\\ than\\ (.*?)\\ minutes\\.\\ Refresh\\ Google\\ Calendar\\ before\\ you\\ publish\\.\$", dotAll: true), names: <String>["value1"]),
  (message: UiMessage.m_a_schedule_can_hold_at_3579b5501d, pattern: RegExp("^A\\ schedule\\ can\\ hold\\ at\\ most\\ (.*?)\\ exceptions\\.\\ Remove\\ some\\ before\\ adding\\ more\\.\$", dotAll: true), names: <String>["kMaxExceptions"]),
  (message: UiMessage.m_your_selected_calendars_last_synced_841e13db86, pattern: RegExp("^Your\\ selected\\ calendars\\ last\\ synced\\ (.*?)\\ minutes\\ ago\\.\$", dotAll: true), names: <String>["minutes"]),
  (message: UiMessage.m_all_day_value1_value2_value3_8f5bc19c75, pattern: RegExp("^All\\ day\\ ·\\ (.*?)\\ (.*?)\\ –\\ (.*?)\\ (.*?)\$", dotAll: true), names: <String>["value1", "value2", "value3", "value4"]),
  (message: UiMessage.m_value1_pick_another_time_before_def4cf27eb, pattern: RegExp("^(.*?)\\ Pick\\ another\\ time\\ before\\ continuing\\.\$", dotAll: true), names: <String>["value1"]),
  (message: UiMessage.m_last_successful_sync_minutes_minutes_431b2755cf, pattern: RegExp("^Last\\ successful\\ sync:\\ (.*?)\\ minutes\\ ago\\.\$", dotAll: true), names: <String>["minutes"]),
  (message: UiMessage.m_last_successful_sync_hours_hours_0e2f8cf42c, pattern: RegExp("^Last\\ successful\\ sync:\\ (.*?)\\ hours\\ ago\\.\$", dotAll: true), names: <String>["hours"]),
  (message: UiMessage.m_enter_a_number_between_min_eefaf91aff, pattern: RegExp("^Enter\\ a\\ number\\ between\\ (.*?)\\ and\\ (.*?)\\.\$", dotAll: true), names: <String>["min", "max"]),
  (message: UiMessage.m_this_time_overlaps_title_value2_69195ed2c3, pattern: RegExp("^This\\ time\\ overlaps\\ (.*?)\\ \\((.*?)\\)\\.\$", dotAll: true), names: <String>["title", "value2"]),
  (message: UiMessage.m_kept_for_value1_range_82bf1c43b9, pattern: RegExp("^Kept\\ for\\ (.*?)\\ ·\\ (.*?)\$", dotAll: true), names: <String>["value1", "range"]),
  (message: UiMessage.m_only_this_listing_value1_d605e51ae7, pattern: RegExp("^Only\\ this\\ listing(.*?)\$", dotAll: true), names: <String>["value1"]),
  (message: UiMessage.m_i_m_available_range_0266ef98d2, pattern: RegExp("^I'm\\ available\\ ·\\ (.*?)\$", dotAll: true), names: <String>["range"]),
  (message: UiMessage.m_your_device_value1_70b8c2dd10, pattern: RegExp("^Your\\ device:\\ (.*?)\$", dotAll: true), names: <String>["value1"]),
  (message: UiMessage.m_availablecount_open_d1848e67b1, pattern: RegExp("^(.*?)\\ open\$", dotAll: true), names: <String>["availableCount"]),
  (message: UiMessage.m_maxperday_per_day_977df3cbb6, pattern: RegExp("^(.*?)\\ per\\ day\$", dotAll: true), names: <String>["maxPerDay"]),
  (message: UiMessage.m_times_in_timezone_4ca9686ed7, pattern: RegExp("^Times\\ in\\ (.*?)\$", dotAll: true), names: <String>["timezone"]),
  (message: UiMessage.m_i_m_busy_range_0c79270ede, pattern: RegExp("^I'm\\ busy\\ ·\\ (.*?)\$", dotAll: true), names: <String>["range"]),
  (message: UiMessage.m_editing_value1_84f89b8fce, pattern: RegExp("^Editing:\\ (.*?)\$", dotAll: true), names: <String>["value1"]),
  (message: UiMessage.m_updated_value1_582239ce75, pattern: RegExp("^Updated\\ (.*?)\$", dotAll: true), names: <String>["value1"]),
  (message: UiMessage.m_minutes_min_e1bded87ee, pattern: RegExp("^(.*?)\\ min\$", dotAll: true), names: <String>["minutes"]),
  (message: UiMessage.m_days_days_a2246fbc25, pattern: RegExp("^(.*?)\\ days\$", dotAll: true), names: <String>["days"]),
  (message: UiMessage.m_value1_h_b30c713499, pattern: RegExp("^(.*?)\\ h\$", dotAll: true), names: <String>["value1"]),
];

// These are the three authored field labels, never user or AI text.
String _copyFieldList(String value) => value.split(', ').map((field) => switch (field) {
  'title' => uiCopy(UiMessage.m_title_7e8cd2056d).toLowerCase(),
  'short blurb' => uiCopy(UiMessage.m_short_blurb_04b744c4d0).toLowerCase(),
  'description' => uiCopy(UiMessage.m_description_526e0087cc).toLowerCase(),
  _ => field,
}).join(', ');
