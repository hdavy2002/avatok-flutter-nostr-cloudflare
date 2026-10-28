import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:posthog_flutter/posthog_flutter.dart';

import '../core/brand.dart';

/// One place the app reports to. Event names come from Specs/SPEC-2026-09-02-TELEMETRY-CATALOG.md
/// (section "Hello Fraands native app"); [catalogEvents] below is the same list, and the PostHog sink drops
/// anything that is not on it.
///
/// Where the events go:
/// - `--dart-define=HF_POSTHOG_KEY=<project key>` set (CI passes the HF_POSTHOG_KEY secret): PostHog, EU cloud by
///   default (`HF_POSTHOG_HOST` overrides). The visitor stays anonymous: no identify(), no person profile.
/// - key empty (local runs, tests, `mode=check`): the debug console only.
///
/// No PII, ever: [_clean] drops phone, WhatsApp, email, name, token, OTP and payment-handle keys, and any value that
/// looks like an email or a phone number. Nothing in here may throw into the caller.
typedef TelemetrySink = void Function(String event, Map<String, Object?> props);

abstract final class Telemetry {
  static const String _key = String.fromEnvironment('HF_POSTHOG_KEY');
  static const String _host = String.fromEnvironment('HF_POSTHOG_HOST', defaultValue: 'https://eu.i.posthog.com');
  static const String _release = String.fromEnvironment('GIT_SHA', defaultValue: 'dev');

  /// Every event the app may send. Keep in step with the telemetry catalog.
  static const Set<String> catalogEvents = {
    // [HF-INTRO-A1] influencer intro-video onboarding (never carries a name, the description, Aadhaar details or the video)
    'hf_onb_step_view', // {step}
    'hf_onb_categories', // {n, has_sensitive}
    'hf_intro_record', // {duration_ms, retake_n}
    'hf_intro_upload', // {bytes, ms, ok, reason?}
    'hf_onb_submitted', // {n_categories, has_sensitive, call_option, lang}
    'hf_onb_submit_refused', // {reason}
    'hf_onb_social_login', // {platform, ok}
    // [HF-CHANNEL-APP-1] channel page, bag and profile photo (same names as the web)
    'channel_viewed',
    'merch_filter_used',
    'bag_added',
    'bag_checkout_started',
    'bag_paid',
    'channel_video_played',
    'channel_slot_requested',
    'profile_photo_saved',
    'api_error',
    // [HF-CREATOR-SPACES-1] never carries gender, the declaration or any Aadhaar detail
    'hf_space_creator_chosen', // {kind}
    'hf_channel_threshold', // {result, followers, views}
    'hf_space_gate_shown', // {lane, missing}
    'hf_space_filter', // {space, surface}
    'hf_search_filter', // {active, sort, surface} [HF-SEARCH-FILTERS-1]
    'hf_video_kyc_badge_shown', // {surface}
    'hf_space_verify_step', // {lane, step}
    // [HF-CREATOR-BADGES-1] never carries gender or the declaration
    'hf_verify_badge_added', // {badge}
    'hf_caller_level_set', // {level}
    'hf_space_joined', // {space}
    'hf_space_left',
    'hf_caller_gate_shown', // {reason: video_kyc|women|lgbtq}
    'hf_app_cache', // [HF-APP-CACHE-1]
    'app_crash',
    'hf_app_open',
    'hf_app_deeplink_opened',
    'hf_app_push_opened', // [HF-BOOK-APPROVE-PUSH]
    'hf_push_registered',
    'hf_signup_code_sent',
    'hf_signup_verified',
    'hf_signup_age_confirmed',
    'hf_channels_open',
    'hf_channel_add_start',
    'hf_channel_check_tap',
    'hf_topup_started',
    'hf_topup_result',
    'hf_app_call_confirm_viewed',
    'hf_app_call_started',
    'hf_app_call_status',
    'hf_app_call_ended',
    'hf_app_call_cancelled',
    'hf_app_call_cap_warning',
    'hf_app_review_submitted',
    'hf_presence_toggled', // [HF-BOOK-APPROVE-5]
    'hf_availability_saved', // [HF-BOOK-APPROVE-6]
    'hf_app_booking_requested', // [HF-BOOK-APPROVE]
    'hf_app_booking_accept_tapped',
    'hf_app_booking_decline_tapped',
    'hf_app_booking_mode_changed',
    'hf_app_mode_changed', // [HF-CALL-MODES-E2] {from, to, surface}
    'hf_app_queue_joined', // [HF-CALL-MODES-E2] {position}
    'hf_app_queue_left', // [HF-CALL-MODES-E2] {wait_s, reason}
    'hf_app_queue_failed', // [HF-CALL-MODES-E2] {reason}
    'hf_app_booking_length_picked', // [HF-CALL-MODES-E2] {minutes}
    'hf_call_option_ui', // [HF-INTRO-A3] {option: A|B} she picked (or tapped the footer for) Bookings only / Bookings + live
    'hf_intro_banner_click', // [HF-INTRO-A3] {status: none|submitted|rejected} tapped the intro banner on Home
    'hf_fb_login_open', // [HF-INTRO-A3] {ok} the Facebook login tab was opened
    'hf_fb_login_result', // [HF-INTRO-A3] {fb: connected|error, reason?, result?} the Facebook login came back
    'hf_app_call_topup_tapped', // [HF-CALL-MODES-E2] {surface}
    'hf_reel_action',
    'hf_reel_start', // [HF-INTRO-A2] {platform, ms, warmed, source?: intro}
    'hf_reel_share', // [HF-INTRO-A2] {source: intro}
    'hf_social_link_open', // [HF-INTRO-A2] {platform: youtube|instagram|facebook, surface}
    'hf_women_gate', // [HF-INTRO-A2] {result: blocked_aadhaar|blocked_female_only|allowed|verify_now|not_now|verified|verify_incomplete}
    'reel_profile_tap', // [HF-REEL-CALL-2] {source: rail|callbar, kind: network|invite}
    'reel_deeplink_open', // [HF-REEL-CALL-2] {reel_id, cached}
    'hf_reel_bookmark_sync',
    'hf_intro_decision',
    'hf_auth_entry',
    'hf_auth_outcome',
    'hf_reel_play_fail', // [HF-REEL-PLAYER-2] platform + reason when a reel embed could not start
    'hf_page_not_found', // [HF-REELS-FAV-1] unknown route shown the friendly page
    'profile_share_tapped', // [HF-SHARE-APP-1] {own, slug}
    'merch_strip_viewed', // [HF-MERCH-APP-1]
    'merch_product_viewed',
    'merch_buy_clicked',
    'merch_pay_method_chosen',
    'merch_studio_step',
    'merch_ai', // [HF-MERCH-STUDIO-2] {action: open|generate_started|generate_done|generate_failed|use|bg_removed|...}
    'merch_order_opened',
    'profile_share_clicked', // [HF-APP-PARITY-MERCH-1] {own, network} (same name as the web)
    'merch_tracking_opened', // [HF-APP-PARITY-MERCH-1] {order_id}
    'merch_problem_submitted', // [HF-APP-PARITY-MERCH-1] {order_id, kind, has_photo, ok}
    'merch_product_edited', // [HF-APP-PARITY-MERCH-1] {product_id, markup}
    'merch_receipt_opened', // [HF-APP-PARITY-MERCH-1] {order_id, ok}
    'merch_checkout_failed', // [HF-APP-PARITY-MERCH-1] {code, status, surface}
    'merch_gstin_saved', // [HF-APP-PARITY-MERCH-1] {has_gstin}
    // [HF-CALL-SAFETY-APP] strikes, appeals, call rules and the pre/post-call screens (never carries the quote, the appeal text or a name)
    'hf_safety_view', // {surface: strikes|paused|rules|post_call, status?, strikes?}
    'hf_safety_gate_shown', // {code: account_paused|call_rules_required, surface}
    'hf_safety_appeal', // {outcome: ok|failed, reason?}
    'hf_safety_rules_accepted', // {version, surface: onboarding|gate|me, outcome: ok|failed, reason?}
    'hf_call_notice_shown', // {surface: call|booking}
    'hf_call_notice_ack', // {surface, dont_show_again}
    'hf_call_report_sent', // {outcome: ok|failed, reasons, n, reason?}
    'hf_call_report_good', // {}
  };

  static TelemetrySink sink = _debugSink;
  static bool _posthogOn = false;

  /// True once events really go to PostHog.
  static bool get postHogOn => _posthogOn;

  /// Call once from main(). Without a key it does nothing and the debug sink stays. Never throws.
  static Future<void> init() async {
    if (_key.isEmpty) return;
    try {
      final config = PostHogConfig(_key)
        ..host = _host
        ..debug = false
        ..captureApplicationLifecycleEvents = false // only catalog events are sent
        ..personProfiles = PostHogPersonProfiles.never; // anonymous: no person profile, no identify()
      await Posthog().setup(config);
      _posthogOn = true;
      sink = _postHogSink;
    } catch (e) {
      if (kDebugMode) debugPrint('[telemetry] PostHog setup failed: $e');
    }
  }

  static void _debugSink(String event, Map<String, Object?> props) {
    if (kDebugMode) {
      final note = catalogEvents.contains(event) ? '' : '  (NOT IN CATALOG)';
      debugPrint('[telemetry] $event $props$note');
    }
  }

  static void _postHogSink(String event, Map<String, Object?> props) {
    if (!catalogEvents.contains(event)) return;
    final out = <String, Object>{
      ..._clean(props),
      'platform': 'android-app',
      'service_name': 'hf-app',
      'app': Brand.slug,
      'release': _release,
    };
    unawaited(Posthog().capture(eventName: event, properties: out).catchError((Object _) {}));
  }

  static final RegExp _emailLike = RegExp(r'[^\s@]+@[^\s@]+\.[^\s@]+');
  static final RegExp _phoneLike = RegExp(r'(?:\+?\d[\s-]?){10,}');
  static const Set<String> _blockedKeys = {
    'name', 'first_name', 'last_name', 'display_name', 'full_name', 'uid', 'user_id', 'clerk_uid',
    'vpa', 'upi', 'utr', 'account', 'address', 'bio', 'message', 'note', 'caption', 'password',
  };
  static const List<String> _blockedFragments = ['phone', 'mobile', 'whatsapp', 'email', 'token', 'otp', 'secret'];

  /// Keeps only plain values and drops anything personal. Public for tests.
  @visibleForTesting
  static Map<String, Object> cleanForTest(Map<String, Object?> props) => _clean(props);

  static Map<String, Object> _clean(Map<String, Object?> props) {
    final out = <String, Object>{};
    props.forEach((k, v) {
      final key = k.toLowerCase();
      if (v == null) return;
      if (_blockedKeys.contains(key)) return;
      if (_blockedFragments.any(key.contains)) return;
      if (v is bool || v is int || v is double) {
        out[k] = v;
      } else if (v is String) {
        if (_emailLike.hasMatch(v) || _phoneLike.hasMatch(v)) return;
        out[k] = v.length > 200 ? v.substring(0, 200) : v;
      } else if (v is List) {
        out[k] = [
          for (final e in v)
            if ((e is String && !_emailLike.hasMatch(e) && !_phoneLike.hasMatch(e)) || e is num || e is bool) '$e',
        ];
      }
    });
    return out;
  }

  static void event(String name, [Map<String, Object?> props = const {}]) {
    try {
      sink(name, props);
    } catch (_) {
      // telemetry never throws into a request
    }
  }

  static final Set<String> _cacheSeen = {};

  /// Catalog event `hf_app_cache` [HF-APP-CACHE-1]: how a cached read was served (`hit_fresh`, `revalidated`, `miss`,
  /// `stale_on_error`). Sent once per endpoint and outcome per app run, so it measures the hit rate without flooding.
  /// [endpoint] is the path with ids made generic.
  static void cacheOutcome(String endpoint, String outcome, {int? ageSeconds}) {
    final generic = endpoint.replaceAll(RegExp(r'/hosts/(?!me\b|public\b)[^/]+'), '/hosts/:slug').replaceAll(RegExp(r'/public/[^/]+'), '/public/:slug');
    if (!_cacheSeen.add('$generic|$outcome')) return;
    event('hf_app_cache', {'endpoint': generic, 'outcome': outcome, if (ageSeconds != null) 'age_s': ageSeconds});
  }

  /// Catalog event `api_error`: every non-2xx or network failure, reported once by the API client.
  static void reportFetchFailure({
    required String method,
    required String endpoint,
    required int status,
    required String code,
    required int ms,
  }) {
    event('api_error', {
      'endpoint': endpoint,
      'method': method,
      'status': status,
      'code': code,
      'ms': ms,
      'latency_ms': ms,
    });
  }

  /// Catalog event `hf_app_deeplink_opened`: [path] must already be anonymised (`/h/:id`).
  static void deepLinkOpened({required String path, required String source, required String launch}) {
    event('hf_app_deeplink_opened', {'path': path, 'source': source, 'launch': launch});
  }

  /// Catalog event `hf_app_push_opened` [HF-BOOK-APPROVE-PUSH]: a notification was tapped. [path] is anonymised like
  /// [deepLinkOpened] (`/bookings/:id`), or `/unmapped` when the app has no screen for it; [state] is
  /// `cold` | `background` | `foreground`.
  static void pushOpened({required String path, required String state}) {
    event('hf_app_push_opened', {'path': path, 'state': state});
  }

  /// Catalog event `hf_app_open`: once per process start, after the splash work.
  static void appOpen({required int coldMs, required bool signedIn}) {
    event('hf_app_open', {'cold_ms': coldMs, 'signed_in': signedIn});
  }

  // ------------------------------------------------------------------------------------------ crashes

  static int _crashesSent = 0;
  static final Set<String> _crashSeen = {};
  static const int _maxCrashesPerRun = 10;

  /// Catalog event `app_crash`. [source] is `flutter` (FlutterError.onError), `platform`
  /// (PlatformDispatcher.onError) or `zone` (runZonedGuarded). The error MESSAGE is never sent (it can hold
  /// typed text); only the error type, the library and the top of the stack trace. De-duplicated and capped per run.
  static void crash(Object error, StackTrace? stack, {required String source, bool fatal = false, String? library}) {
    try {
      final top = _topFrames(stack);
      final fingerprint = '${error.runtimeType}|${top.split('\n').first}';
      if (!_crashSeen.add(fingerprint) || _crashesSent >= _maxCrashesPerRun) return;
      _crashesSent++;
      event('app_crash', {
        'source': source,
        'fatal': fatal,
        'error_type': error.runtimeType.toString(),
        if (library != null) 'library': library,
        'stack_top': top,
      });
    } catch (_) {
      // a crash reporter must never crash
    }
  }

  static String _topFrames(StackTrace? stack) {
    if (stack == null) return '';
    final lines = stack.toString().split('\n').where((l) => l.trim().isNotEmpty).take(6);
    return lines.join('\n');
  }

  /// Installs the global handlers. Call from inside the guarded zone in main().
  static void installCrashHandlers() {
    final previous = FlutterError.onError;
    FlutterError.onError = (details) {
      if (previous != null) {
        previous(details);
      } else {
        FlutterError.presentError(details);
      }
      crash(details.exception, details.stack, source: 'flutter', library: details.library);
    };
    PlatformDispatcher.instance.onError = (error, stack) {
      crash(error, stack, source: 'platform', fatal: true);
      return true; // handled: do not kill the isolate
    };
  }

  /// For runZonedGuarded's onError.
  static void zoneError(Object error, StackTrace stack) => crash(error, stack, source: 'zone', fatal: true);
}
