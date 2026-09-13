import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/analytics.dart';
import '../../../core/ava_log.dart';
import '../../../core/availability_time.dart';
import '../../../core/cached_image.dart';
import '../../../core/listings_api.dart';
import '../../../core/remote_config.dart';
import '../../../core/ui/avatok_dark.dart';
import '../../../core/ui/messenger_theme.dart';
import '../../../core/ui/zine_widgets.dart';
import '../../../core/ui/motion/motion.dart';
import '../../calendar/avacalendar_screen.dart';
import '../../identity/listing_liveness_gate.dart';
import '../../identity/public_action_gate.dart' show isIdentityRequired;

/// The app-native counterpart of the web listing wizard.
///
/// This screen deliberately talks to the wizard endpoints rather than the
/// legacy flat listing editor. The Worker remains authoritative for field
/// validation, eligibility, moderation, review, and publishing.
class NativeListingWizardScreen extends StatefulWidget {
  const NativeListingWizardScreen({
    super.key,
    this.listingId,
    this.initialKind,
    this.source = 'menu',
    this.returnOnSubmit = false,
  });

  final String? listingId;
  final String? initialKind;
  final String source;
  final bool returnOnSubmit;

  @override
  State<NativeListingWizardScreen> createState() => _NativeListingWizardScreenState();
}

class _NativeListingWizardScreenState extends State<NativeListingWizardScreen> {
  static const _steps = <String>[
    'Type', 'Pitch', 'Money', 'Time', 'How it works', 'House rules', 'Photos', 'Review'
  ];

  final _title = TextEditingController();
  final _blurb = TextEditingController();
  final _description = TextEditingController();
  final _price = TextEditingController();
  final _location = TextEditingController();
  final _timezone = TextEditingController();
  final _how = TextEditingController();
  final _rules = TextEditingController();
  final _faq = TextEditingController();
  final _preparation = TextEditingController();
  final _whatGet = TextEditingController();
  final _whoFor = TextEditingController();
  final _notFor = TextEditingController();

  final _videoUrl = TextEditingController();
  final _startsAt = TextEditingController();
  final _duration = TextEditingController(text: '60');
  final _capacity = TextEditingController(text: '0');

  int _step = 0;
  String _kind = 'live_event';
  String _category = '';
  String _mediaMode = 'audio_video';
  // [LIST-WIZARD-CONTRACT-1] join_requirements was a free-text "JSON" box. The
  // server accepts only the keys below and 422s anything else
  // (contentAttrsError, worker/src/routes/listings.ts:534), so a creator typing
  // prose into it could not save at all. Checkboxes can only produce a legal
  // object.
  final _joinReq = <String, bool>{'mic': false, 'cam': false, 'listen_only': false, 'recording': false};
  String _scheduleMode = 'fixed_date';
  String? _id;
  String? _error;
  bool _loading = false, _freeEntry = false, _adultsOnly = false, _dirty = false;
  // [LIST-WIZARD-GATE-1] Commercial policy is a SERVER CONTRACT, not free text:
  // worker/src/routes/listings.ts commercialPolicyError() allows exactly
  // `commercial_refund_window_hours` on live_event and exactly the five consult
  // keys on consult, and rejects the whole save with "unsupported commercial
  // policy field" if any other commercial_* key appears. This wizard used to
  // post `commercial_preparation_instructions` unconditionally, so EVERY
  // live_event save 422'd at step 2 (owner report 2026-09-13). These fields
  // carry the values the listing already has so an edit never silently rewrites
  // a policy the creator set elsewhere; the wizard has no UI for them yet.
  // [LIST-WIZARD-GATE-1] Server-computed, per-account: may this creator hold a
  // free_entry listing at all? Starts false so the switch is never painted
  // before the answer arrives — the owner's instruction is that nobody but the
  // allowlisted account ever sees it, and a flash counts as seeing it.
  bool _freeEntryAllowed = false;
  int _refundWindowHours = 24;
  int _cancellationWindowHours = 24;
  int _bookingNoticeHours = 6;
  bool _rescheduleAllowed = true;
  bool _saving = false;
  bool _publishing = false;
  List<ExploreCategory> _categories = const [];

  // [LIST-APP-PARITY-1] AI copy assist on the Pitch step. `POST /api/listings/
  // copy-review` reviews all three fields in ONE call, so a per-field blip that
  // re-requested per field would pay three round trips for one answer: the first
  // run stores every field's suggestion and the rest are served from here.
  //
  // `_aiReviewedText` is BOTH the "has this field been through AI" record (the
  // gate on leaving this step) and the idempotency key: a field whose text still
  // equals what was reviewed does not re-run.
  final _aiSuggestion = <String, CopyReviewField>{};
  final _aiReviewedText = <String, String>{};
  String? _aiBusyField;
  String? _aiSource;
  // A failed call must not trap the creator on step 2 forever. One failure
  // unlocks the step; the affordance stays so they can try again.
  bool _aiUnavailable = false;

  // [LIST-APP-PARITY-1] Spoken languages -> the `spoken_lang` CSV.
  final _spokenLangs = <String>{};

  // [LIST-APP-PARITY-1] Creator-side discounts. These are NOT listing columns —
  // they become rows in `listing_promotions` via POST /api/listings/:id/
  // promotions, reconciled by [_syncPromotions].
  //
  // [LIST-PROMO-OFF-1] SHELVED. Every read and write of the three controllers
  // below is gated on [RemoteConfig.listingPromotionsEnabled] (default false).
  // The controllers themselves stay declared, created and disposed so turning
  // the flag back on needs no client change.
  final _earlyBirdPct = TextEditingController();
  final _promoCode = TextEditingController();
  final _promoPct = TextEditingController();
  List<Map<String, dynamic>> _promotions = const [];
  final _coverUrls = <String>[];
  String? _faceUrl;

  @override
  void initState() {
    super.initState();
    _id = widget.listingId;
    _kind = widget.initialKind ?? _kind;
    // Keep the schedule mode consistent with the kind from the first frame, not
    // only when the radio is touched — the sheet that opens this screen can pass
    // initialKind: 'consult' and skip step 0 entirely.
    _scheduleMode = _kind == 'consult' ? 'on_request' : 'fixed_date';
    Analytics.capture('listing_native_wizard_opened', {
      'source': widget.source,
      'resumed': widget.listingId != null,
    });
    _load();
  }

  @override
  void dispose() {
    for (final c in [_title, _blurb, _description, _price, _location, _timezone, _how, _rules, _faq, _preparation, _whatGet, _whoFor, _notFor, _videoUrl, _startsAt, _duration, _capacity, _earlyBirdPct, _promoCode, _promoPct]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      _freeEntryAllowed = await ListingsApi.freeEntryAllowed();
      _categories = await ListingsApi.categories();
      if (_id != null) {
        final raw = await ListingsApi.wizardGet(_id!);
        if (raw['ok'] != true) throw StateError('Could not load listing');
        final detail = ListingDetail.fromJson(raw);
        final l = detail.listing;
        _kind = l.kind == 'live' ? 'live_event' : l.kind;
        _title.text = l.title;
        _blurb.text = l.blurb ?? '';
        _description.text = l.description ?? '';
        _price.text = l.price > 0 ? '${l.price}' : '';
        _location.text = l.location ?? '';
        _timezone.text = l.timezone ?? '';
        _category = l.category;
        _mediaMode = l.mediaMode;
        _scheduleMode = l.scheduleMode ?? _scheduleMode;
        _freeEntry = l.freeEntry;
        _startsAt.text = _epochToLocal(l.startsAt, (l.timezone ?? '').isEmpty ? 'Asia/Kolkata' : l.timezone!);
        _duration.text = '${l.durationMin ?? 60}';
        _capacity.text = '${l.capacity ?? 0}';
        _coverUrls.addAll(l.coverMedia.map((m) => m is Map ? m['url']?.toString() : null).whereType<String>().where((u) => u.isNotEmpty));
        final attrs = l.attrs;
        // [LIST-WIZARD-CONTRACT-1] These are OBJECT lists on the server, and the
        // editor below is line-based, so they must be rendered back into the same
        // "Label: body" form the parser reads — `_asText` used to print raw Dart
        // map literals (`{label: Warm up, body: …}`) into the box, which the next
        // save then re-parsed as a label of "{label" and silently corrupted.
        _how.text = _pairsToText(attrs['content_how_it_works'], 'label', 'body');
        _rules.text = _pairsToText(attrs['content_house_rules'], 'heading', 'body');
        _faq.text = _pairsToText(attrs['content_faq'], 'q', 'a');
        _preparation.text = (attrs['commercial_preparation_instructions'] ?? '').toString();
        _refundWindowHours = _policyInt(attrs['commercial_refund_window_hours'], 24, const [0, 12, 24, 48]);
        _cancellationWindowHours = _policyInt(attrs['commercial_cancellation_window_hours'], 24, const [0, 12, 24, 48]);
        _bookingNoticeHours = _policyInt(attrs['commercial_booking_notice_hours'], 6, const [1, 2, 6, 24]);
        _rescheduleAllowed = attrs['commercial_reschedule_allowed'] is bool ? attrs['commercial_reschedule_allowed'] as bool : true;
        _whatGet.text = _asText(attrs['content_what_you_get']);
        _whoFor.text = _asText(attrs['content_who_for']);
        _notFor.text = _asText(attrs['content_not_for']);
        final jr = attrs['join_requirements'];
        if (jr is Map) { for (final k in _joinReq.keys) _joinReq[k] = jr[k] == true; }
        _videoUrl.text = l.videoUrl ?? '';
        final face = attrs['face_photo'];
        _faceUrl = face is String ? face : (face is Map ? face['url']?.toString() : null);
        // [LIST-APP-PARITY-1] `spoken_lang` is a CSV. Only names this picker can
        // render are taken back in; anything else (an older free-text value) is
        // dropped rather than shown as an unselectable chip.
        for (final raw in (l.spokenLang ?? '').split(',')) {
          final name = raw.trim();
          if (name.isEmpty) continue;
          for (final known in _kLanguages) {
            if (known.toLowerCase() == name.toLowerCase()) { _spokenLangs.add(known); break; }
          }
        }
        // [LIST-PROMO-OFF-1] While promotions are shelved the boxes are not
        // rendered, so there is nothing to hydrate and no reason to spend a
        // round trip on a list the creator cannot act on.
        if (RemoteConfig.listingPromotionsEnabled) {
          _promotions = await ListingsApi.listingPromotions(_id!);
          for (final promotion in _promotions) {
            final kind = (promotion['kind'] ?? '').toString();
            final pct = (promotion['pct_off'] as num?)?.toInt() ?? 0;
            if (kind == 'early_bird' && pct > 0) {
              _earlyBirdPct.text = '$pct';
            } else if (kind == 'promo_code' && pct > 0) {
              _promoPct.text = '$pct';
              _promoCode.text = (promotion['code'] ?? '').toString();
            }
          }
        }
        _step = 7;
      }
    } catch (e) {
      _error = 'Could not load this listing. Try again.';
    }
    if (mounted) setState(() => _loading = false);
  }

  /// A stored policy value is only reusable if the server would still accept it
  /// (commercialPolicyError() checks membership, not range), so anything outside
  /// the allowed set falls back to the default rather than failing the next save.
  static int _policyInt(dynamic value, int fallback, List<int> allowed) {
    final n = value is num ? value.toInt() : int.tryParse('$value');
    return n != null && allowed.contains(n) ? n : fallback;
  }

  static String _asText(dynamic value) {
    if (value is List) return value.map((v) => v.toString()).join('\n');
    return value?.toString() ?? '';
  }

  /// [LISTING-EXPIRY-1 / P1-6] The listing's IANA zone, IST when blank — the
  /// same default the server's `listings.timezone` column has.
  String get _zone {
    final z = _timezone.text.trim();
    return z.isEmpty ? 'Asia/Kolkata' : z;
  }

  /// Wall-clock text for the start field, in the LISTING's timezone. It used to
  /// be `toLocal()`, so the field showed a different time on a phone set to
  /// another zone than the time the buyer page advertises.
  static String _epochToLocal(int? epoch, [String timezone = 'Asia/Kolkata']) {
    if (epoch == null || epoch == 0) return '';
    final instant = DateTime.fromMillisecondsSinceEpoch(epoch < 100000000000 ? epoch * 1000 : epoch, isUtc: true);
    DateTime d;
    try {
      d = AvailabilityTime.inTimezone(instant, timezone);
    } catch (_) {
      d = instant.toLocal();
    }
    String p(int n) => n.toString().padLeft(2, '0');
    return '${d.year}-${p(d.month)}-${p(d.day)}T${p(d.hour)}:${p(d.minute)}';
  }

  /// The typed start time read AS the listing's wall clock. `DateTime.tryParse`
  /// alone read it in the phone's zone — on a phone set to UTC, "21:12" became
  /// 02:42 IST, which is how the prod "Cooking with Davy" show got its time.
  int? _startsAtEpoch() {
    final text = _startsAt.text.trim();
    final parsed = DateTime.tryParse(text);
    if (parsed == null) return null;
    try {
      return AvailabilityTime.wallTimeToUtc(
        date: DateTime(parsed.year, parsed.month, parsed.day),
        minutes: parsed.hour * 60 + parsed.minute,
        timezone: _zone,
      ).millisecondsSinceEpoch;
    } catch (_) {
      return parsed.millisecondsSinceEpoch;
    }
  }

  // ---------------------------------------------------------------------------
  // [LIST-WIZARD-CONTRACT-1] THE PAYLOAD IS A CONTRACT, NOT A FORM DUMP.
  //
  // This screen used to post every box it had, in whatever shape the box
  // happened to hold, and let the Worker sort it out. It could not save a single
  // listing: `contentAttrsError` (worker/src/routes/listings.ts:439) validates
  // each `content_*` key ONLY WHEN PRESENT, and the wizard sent all of them on
  // every step — as empty arrays before the creator has reached those steps, and
  // as arrays of plain strings where the server wants objects. Step 2 therefore
  // answered with whichever contract was checked first
  // ("content_how_it_works must be 1-5 items of {label<=24, body<=240}"), and
  // fixing that one only uncovered the next.
  //
  // Two rules hold everything below together:
  //   1. OMIT what the creator has not filled in. Absent is always legal;
  //      present-and-empty almost never is.
  //   2. Send the server's SHAPE, capped to the server's LIMITS, at the point of
  //      construction — never a shape the UI happens to use.
  // ---------------------------------------------------------------------------
  Map<String, dynamic> _body() {
    final consult = _kind == 'consult';
    return {
      'title': _title.text.trim(),
      'blurb': _cap(_blurb.text.trim(), 120), // server: blurb <= 120 (listings.ts:413)
      'description': _description.text.trim(),
      'category': _category,
      'price': _freeEntry ? 0 : (int.tryParse(_price.text.trim()) ?? 0),
      'free_entry': _freeEntry,
      'kind': _kind,
      'location': _location.text.trim(),
      'video_url': _videoUrl.text.trim(),
      // [LIST-APP-PARITY-1] The server stores at most 64 characters and
      // SILENTLY truncates the rest (listings.ts:1211), so the picker caps the
      // CSV rather than letting a half-cut language name reach a buyer. An
      // empty string is stored as NULL by the same line.
      'spoken_lang': _spokenLangCsv(),
      'timezone': _zone, // never the raw box: an invalid IANA zone 400s the save
      'schedule_mode': _scheduleMode,
      // Only a fixed-date listing carries a start. Sending null the rest of the
      // time is deliberate: it CLEARS a start left behind by switching modes.
      'starts_at': _scheduleMode == 'fixed_date' ? _startsAtEpoch() : null,
      'duration_min': int.tryParse(_duration.text.trim()) ?? 60,
      // A 1:1 consultation has exactly one seat and the server refuses anything
      // else at publish (listing_blockers.ts:246). The old wizard offered a
      // "Capacity (0 = unlimited)" box that defaulted to 0, which normFields
      // stores as NULL — so every consult built here was unpublishable.
      'capacity': consult ? 1 : (int.tryParse(_capacity.text.trim()) ?? 0),
      'media_mode': _mediaMode,
      'cover_media': [for (final url in _coverUrls) {'type': 'image', 'url': url}],
      'adults_only': _adultsOnly,
      'attrs': _attrs(),
    };
  }

  /// Creator-owned `attrs`, built to `contentAttrsError` + `commercialPolicyError`
  /// exactly. Every entry is conditional: a key the creator has not filled in is
  /// left out entirely rather than sent empty.
  Map<String, dynamic> _attrs() {
    final consult = _kind == 'consult';
    final how = _pairs(_how.text, 'label', 'body', 24, 240, 5);
    final rules = _pairs(_rules.text, 'heading', 'body', 32, 200, 8);
    final faq = _pairs(_faq.text, 'q', 'a', 120, 300, 6);
    final whatGet = _capped(_whatGet.text, 80, 5);
    final whoFor = _capped(_whoFor.text, 80, 3);
    final notFor = _capped(_notFor.text, 80, 3);
    final join = {for (final e in _joinReq.entries) if (e.value) e.key: true};
    return {
      if (how.isNotEmpty) 'content_how_it_works': how,
      if (rules.isNotEmpty) 'content_house_rules': rules,
      // 3 is the server's FLOOR for these two, not a nicety (listings.ts:503,
      // :515). Fewer than three is held back rather than sent to be refused —
      // _validate() is what tells the creator, on the step that owns the field.
      if (whatGet.length >= 3) 'content_what_you_get': whatGet,
      if (faq.length >= 3) 'content_faq': faq,
      if (whoFor.isNotEmpty) 'content_who_for': whoFor,
      if (notFor.isNotEmpty) 'content_not_for': notFor,
      if (join.isNotEmpty) 'join_requirements': join,
      // Commercial policy is an exact per-kind set; see the [LIST-WIZARD-GATE-1]
      // note on the fields above.
      if (_kind == 'live_event') 'commercial_refund_window_hours': _refundWindowHours,
      if (consult) ...{
        'commercial_cancellation_window_hours': _cancellationWindowHours,
        'commercial_reschedule_allowed': _rescheduleAllowed,
        'commercial_booking_notice_hours': _bookingNoticeHours,
        'commercial_no_show_policy': 'session_charged',
        'commercial_preparation_instructions': _cap(_preparation.text.trim(), 600),
      },
      if (_faceUrl != null) 'face_photo': {'url': _faceUrl},
    };
  }

  /// One line -> one `{keyA: label, keyB: body}` object, which is the shape every
  /// object-list `content_*` key uses. The creator writes "Label: body"; an
  /// em/en dash or " - " works too, and a line with no separator becomes a short
  /// label plus the whole line as the body rather than being rejected.
  ///
  /// Caps are applied HERE so a long line is trimmed instead of 422ing the save.
  static List<Map<String, String>> _pairs(String text, String keyA, String keyB, int aMax, int bMax, int max) {
    final out = <Map<String, String>>[];
    for (final line in _lines(text)) {
      if (out.length >= max) break;
      final m = _kPairSeparator.firstMatch(line);
      String a, b;
      if (m == null) {
        // No separator: a short leading label plus the whole line as the body is
        // still a legal pair, and keeps everything the creator typed.
        a = _shortLabel(line, aMax);
        b = line;
      } else if (line[m.start] == '?') {
        // The question mark belongs to the question, so it stays on the left.
        a = line.substring(0, m.end).trim();
        b = line.substring(m.end).trim();
      } else {
        a = line.substring(0, m.start).trim();
        b = line.substring(m.end).trim();
      }
      if (a.isEmpty) a = _shortLabel(b, aMax);
      if (b.isEmpty) b = a;
      out.add({keyA: _cap(a, aMax), keyB: _cap(b, bMax)});
    }
    return out;
  }

  /// First "?", ":" or spaced dash. Matching the separator as a PATTERN, rather
  /// than hunting indexes one character at a time, is what keeps the two halves
  /// clean: " - " is three characters wide, and slicing it as if it were one
  /// leaves a stray dash at the head of every body.
  static final RegExp _kPairSeparator = RegExp(r'\?|:|\s[—–-]\s');

  static String _shortLabel(String line, int max) {
    final words = line.split(RegExp(r'\s+'));
    final buf = StringBuffer();
    for (final w in words) {
      if (buf.isNotEmpty && buf.length + 1 + w.length > max) break;
      if (buf.isNotEmpty) buf.write(' ');
      buf.write(w);
    }
    return buf.isEmpty ? _cap(line, max) : buf.toString();
  }

  static List<String> _capped(String text, int itemMax, int max) =>
      [for (final line in _lines(text).take(max)) _cap(line, itemMax)];

  static String _cap(String value, int max) => value.length <= max ? value : value.substring(0, max);

  /// Renders a stored object list back into the line form the editor parses.
  static String _pairsToText(dynamic value, String keyA, String keyB) {
    if (value is! List) return _asText(value);
    return value.map((x) {
      if (x is Map) {
        final a = (x[keyA] ?? '').toString().trim();
        final b = (x[keyB] ?? '').toString().trim();
        if (a.isEmpty) return b;
        if (b.isEmpty || a == b) return a;
        return a.endsWith('?') ? '$a $b' : '$a: $b';
      }
      return x.toString();
    }).join('\n');
  }

  static List<String> _lines(String value) => value.split('\n').map((s) => s.trim()).where((s) => s.isNotEmpty).toList();


  /// Client-side validation is a MIRROR of the server's rules, step by step, so
  /// a creator hears about a problem on the screen that owns the field instead of
  /// two steps later in the Worker's words. Every bound below is quoted from the
  /// rule it mirrors — when one changes on the server, change it here too.
  String? _validate() {
    switch (_step) {
      case 1:
        if (_title.text.trim().isEmpty || _description.text.trim().isEmpty) return 'Add a title and description.';
        if (_category.isEmpty) return 'Choose a category — a listing cannot be published without one.';
        // [LIST-APP-PARITY-1] Every card is AI-checked before it can be
        // published (owner decision, mirrored from the web wizard). The gate is
        // "has been through the check", not "accepted the suggestion" — the
        // words stay the creator's. `_aiUnavailable` releases it after a failed
        // attempt, because a provider outage must not make listing impossible.
        if (!_aiUnavailable) {
          final pending = _kCopyFields.where((f) => !_aiReviewedText.containsKey(f)).toList();
          if (pending.isNotEmpty) {
            return 'Run the AI check on ${pending.map((f) => _kCopyFieldLabels[f]!.toLowerCase()).join(', ')} before continuing.';
          }
        }
        return null;
      case 2:
        if (_freeEntry) return null;
        final price = int.tryParse(_price.text.trim()) ?? 0;
        // session_pricing.ts:27 — MIN_PRICE_TOKENS_PER_HOUR. Refused at save when
        // above zero, and again on the stored row at submit.
        if (price < _minPricePerHour) return 'Price must be at least $_minPricePerHour tokens/hour (₹$_minPricePerHour).';
        // listings.ts:3434 — the promotions route accepts pct_off 1..100 only,
        // and a promo_code row without a code is refused outright.
        //
        // [LIST-PROMO-OFF-1] Off the active path while promotions are shelved:
        // the three boxes are not rendered, so a creator must never be blocked
        // here by a field they cannot see or clear.
        if (RemoteConfig.listingPromotionsEnabled) {
          final earlyText = _earlyBirdPct.text.trim();
          final early = int.tryParse(earlyText);
          if (earlyText.isNotEmpty && (early == null || early < 1 || early > 100)) {
            return 'Early-bird discount must be a whole number from 1 to 100, or empty.';
          }
          final promoText = _promoPct.text.trim();
          final promoPct = int.tryParse(promoText);
          if (promoText.isNotEmpty && (promoPct == null || promoPct < 1 || promoPct > 100)) {
            return 'Promo discount must be a whole number from 1 to 100, or empty.';
          }
          final code = _promoCode.text.trim();
          if (code.isNotEmpty && (promoPct == null || promoPct < 1)) {
            return 'Give the promo code a discount percentage, or clear the code.';
          }
          if (code.isEmpty && promoPct != null && promoPct >= 1) {
            return 'Give the promo discount a code customers can type, or clear the percentage.';
          }
        }
        return null;
      case 3:
        final duration = int.tryParse(_duration.text.trim()) ?? 0;
        if (duration < 5 || duration > 480) return 'Duration must be between 5 and 480 minutes.';
        if (_kind == 'live_event') {
          // listing_blockers.ts:227 — checked on KIND, not on schedule_mode, so a
          // live event needs a future start whatever mode it is in.
          final start = _startsAtEpoch();
          if (start == null) return 'Add a start date and time, as 2026-12-31T18:00.';
          if (start <= DateTime.now().millisecondsSinceEpoch) return 'Choose a future date and time.';
        }
        return null;
      case 4:
        if (_lines(_how.text).length > 5) return 'At most 5 steps in How it works.';
        return null;
      case 5:
        if (_lines(_rules.text).length > 8) return 'At most 8 house rules.';
        // contentAttrsError:503 — 3 is the floor, so 1 or 2 would be dropped
        // silently. Say so rather than losing what the creator typed.
        final get = _lines(_whatGet.text).length;
        if (get > 0 && get < 3) return 'List at least 3 things customers get, or leave the box empty.';
        if (get > 5) return 'At most 5 things customers get.';
        if (_lines(_whoFor.text).length > 3) return 'At most 3 lines for who this is for.';
        if (_lines(_notFor.text).length > 3) return 'At most 3 lines for who this is not for.';
        // [LIST-APP-PARITY-1] The FAQ editor moved here when step 8 became a
        // read-only summary, so its rule moved with it — contentAttrsError:515.
        final faq = _lines(_faq.text).length;
        if (faq > 0 && faq < 3) return 'Add at least 3 questions and answers, or leave the FAQ empty.';
        if (faq > 6) return 'At most 6 FAQ entries.';
        return null;
      case 6:
        if (_coverUrls.isEmpty || _faceUrl == null || _faceUrl!.isEmpty) return 'Add a cover photo and private face photo.';
        return null;
      // [LIST-APP-PARITY-1] Step 8 is a read-only summary now: it owns no field,
      // so it has no rule of its own. The server still validates on submit.
      case 7:
        return null;
      default:
        return null;
    }
  }

  static const int _minPricePerHour = 49;

  /// The zones a creator can pick. Deliberately short: the server accepts any
  /// IANA zone, but a free-text box only ever produced typos that 400'd the save.
  static const List<String> _kZones = [
    'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London',
    'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney', 'UTC',
  ];


  // ---------------------------------------------------------------------------
  // [LIST-APP-PARITY-1] Language picker.
  //
  // The native wizard had NO language control at all, even though the draft
  // carries `spoken_lang` and the server accepts it — so every listing made in
  // the app was published with no language, while the same listing made on the
  // web had one.
  // ---------------------------------------------------------------------------

  /// The web wizard's list, in the web wizard's order, ending in "Others".
  static const List<String> _kLanguages = [
    'Hindi', 'English', 'Bengali', 'Tamil', 'Telugu', 'Marathi', 'Gujarati',
    'Punjabi', 'Urdu', 'Kannada', 'Malayalam', 'Odia', 'Assamese', 'Maithili',
    'Bhojpuri', 'Konkani', 'Kashmiri', 'Nepali', 'Sanskrit', 'Sindhi', 'Dogri',
    'Manipuri', 'Santali', 'Tulu', 'Rajasthani', 'Chhattisgarhi', 'Haryanvi',
    'Others',
  ];

  /// `listings.spoken_lang` holds 64 characters and the Worker truncates the
  /// rest without saying so, so the cap is enforced HERE where it can be
  /// explained. Anything else stores "Hindi,English,Beng".
  static const int _kSpokenLangMax = 64;

  /// Always in [_kLanguages] order, whatever order they were tapped in.
  String _spokenLangCsv([Set<String>? langs]) =>
      _kLanguages.where((l) => (langs ?? _spokenLangs).contains(l)).join(',');

  void _toggleLang(String lang, bool selected) {
    if (!selected) {
      setState(() { _spokenLangs.remove(lang); _dirty = true; });
      return;
    }
    final next = {..._spokenLangs, lang};
    if (_spokenLangCsv(next).length > _kSpokenLangMax) {
      setState(() => _error =
          'That is as many languages as fit — the list is limited to $_kSpokenLangMax characters. Remove one first.');
      return;
    }
    setState(() { _spokenLangs.add(lang); _dirty = true; _error = null; });
  }

  // ---------------------------------------------------------------------------
  // [LIST-APP-PARITY-1] AI copy assist (POST /api/listings/copy-review).
  // ---------------------------------------------------------------------------

  static const List<String> _kCopyFields = ['title', 'blurb', 'description'];
  static const Map<String, String> _kCopyFieldLabels = {
    'title': 'Title',
    'blurb': 'Short blurb',
    'description': 'Description',
  };
  static const Map<String, String> _kCopyFieldHints = {
    'title': 'A clear, specific title',
    'blurb': 'The one-line promise',
    'description': 'What customers should know',
  };

  TextEditingController _copyController(String key) =>
      key == 'title' ? _title : (key == 'blurb' ? _blurb : _description);

  /// True when the stored suggestion was produced from exactly the text that is
  /// in the box now — i.e. re-running would ask the same question again.
  bool _aiFresh(String key) => _aiReviewedText[key] == _copyController(key).text.trim();

  Future<void> _runCopyReview(String key) async {
    if (_aiBusyField != null || _aiFresh(key)) return;
    final startedMs = DateTime.now().millisecondsSinceEpoch;
    setState(() { _aiBusyField = key; _error = null; });
    try {
      final result = await ListingsApi.copyReview(
        title: _title.text.trim(),
        blurb: _blurb.text.trim(),
        description: _description.text.trim(),
        kind: _kind,
        category: _category,
        freeEntry: _freeEntry,
      );
      final data = result.data;
      if (!result.ok || data == null) {
        throw StateError(result.error?.userMessage ?? 'The AI check did not answer.');
      }
      if (!mounted) return;
      setState(() {
        _aiSource = data.source;
        _aiUnavailable = false;
        for (final field in _kCopyFields) {
          final value = data.field(field);
          if (value == null) continue;
          _aiSuggestion[field] = value;
          _aiReviewedText[field] = _copyController(field).text.trim();
        }
      });
      Analytics.uiInteraction(
        'listing_ai_copy_assist',
        DateTime.now().millisecondsSinceEpoch - startedMs,
        phase: 'interactive',
        extra: {
          'field': key,
          'outcome': 'ok',
          'ai_source': data.source,
          'kind': _kind,
          'listing_id': _id ?? '',
        },
      );
    } catch (e, stack) {
      if (mounted) {
        setState(() {
          _aiUnavailable = true;
          _error = 'The AI check could not run just now. You can continue without it.';
        });
      }
      AvaLog.I.warn('listing', 'copy review failed on field $key');
      await Analytics.captureException(e, stack,
          screen: 'native_listing_wizard',
          handled: true,
          extra: {'stage': 'copy_review', 'field': key, 'listing_id': _id ?? ''});
      await Analytics.capture('listing_ai_copy_assist_failed',
          {'field': key, 'outcome': 'error', 'kind': _kind, 'listing_id': _id ?? ''});
    } finally {
      if (mounted) setState(() => _aiBusyField = null);
    }
  }

  /// Applying is the creator's own act — the route suggests and never saves.
  void _applySuggestion(String key) {
    final suggestion = _aiSuggestion[key];
    if (suggestion == null || suggestion.suggested.isEmpty) return;
    setState(() {
      _copyController(key).text = suggestion.suggested;
      // Keep the field "reviewed and fresh" so applying a suggestion does not
      // immediately ask for another round trip.
      _aiReviewedText[key] = suggestion.suggested;
      _dirty = true;
    });
    Analytics.capture('listing_ai_copy_applied', {
      'field': key,
      'outcome': 'applied',
      'ai_source': _aiSource ?? 'rules',
      'kind': _kind,
      'listing_id': _id ?? '',
    });
  }

  // ---------------------------------------------------------------------------
  // [LIST-APP-PARITY-1] The creator-facing discount sum.
  //
  // Mirrors web/src/lib/listingTaxonomy.ts `PRICING` + `feeSplit`. FOR DISPLAY
  // ONLY, exactly as the web helper's own warning says: the Worker recomputes
  // this when money actually moves, and a client-computed fee must never reach
  // a ledger row. Keep the two in step.
  // ---------------------------------------------------------------------------
  static const int _kFlatTokensPerHour = 25;
  static const int _kCommissionPct = 20;

  static ({int fee, int creator}) _feeSplit(int pricePerHour) {
    final price = pricePerHour < 0 ? 0 : pricePerHour;
    if (price <= _kFlatTokensPerHour) return (fee: price, creator: 0);
    final fee = _kFlatTokensPerHour +
        ((price - _kFlatTokensPerHour) * _kCommissionPct / 100).round();
    return (fee: fee, creator: price - fee);
  }

  /// Make `listing_promotions` match what the creator typed.
  ///
  /// `POST /api/listings/:id/promotions` is INSERT-only (listings.ts:3439), so
  /// posting on every save would stack a new row each time a draft was reopened
  /// and the buyer would get whichever one the server happened to read first.
  /// This reads the current rows, writes at most one row per kind, and removes
  /// whatever it replaced.
  ///
  /// [PROMO-SYNC-2 2026-09-13] Two money-shaped defects fixed here.
  ///
  ///   (a) ORDER. It used to DELETE the existing rows and only then insert the
  ///       replacement. When `addPromotion` failed it threw, the creator was
  ///       told "your listing was saved, but the discount could not be" — and
  ///       their LIVE discount was already gone. Navigating away made that
  ///       permanent and silent. Insert first: a failure now leaves the old
  ///       discount exactly as it was, which is the safe end of the two.
  ///   (b) `deleteListingPromotion` returns a bool and the result was dropped.
  ///       A failed delete leaves a row the wizard no longer displays and that
  ///       CHECKOUT WILL STILL HONOUR — the creator believes they cancelled a
  ///       50% discount and buyers keep getting it. It is now checked and said
  ///       out loud.
  ///
  /// Idempotent by construction: an existing row that already matches what the
  /// creator wants is KEPT rather than re-inserted, so re-running after a
  /// partial failure converges on one row per kind instead of stacking more.
  Future<void> _syncPromotions() async {
    // [LIST-PROMO-OFF-1] Shelved. The Worker answers 403 `promotions_disabled`
    // to POST /promotions while the flag is off, and this function turns any
    // failure into "the discount could not be saved" on the Money step — which
    // `_next()` treats as a blocker. Running it with the flag off would trap
    // every creator on step 2 over a field they cannot even see. Left intact
    // for the day the flag flips back on.
    if (!RemoteConfig.listingPromotionsEnabled) return;
    final id = _id;
    if (id == null) return;
    final early = int.tryParse(_earlyBirdPct.text.trim()) ?? 0;
    final promoPct = int.tryParse(_promoPct.text.trim()) ?? 0;
    final code = _promoCode.text.trim().toUpperCase();
    // Rows we inserted/kept but could NOT clear the old copy of. Non-empty means
    // a stale discount is still live and the creator must be told.
    final stillLive = <String>[];
    try {
      final existing = await ListingsApi.listingPromotions(id);
      Future<void> reconcile(String kind, int pct, String? wantedCode) async {
        final rows = existing.where((row) => (row['kind'] ?? '').toString() == kind).toList();
        final want = pct >= 1 && pct <= 100 && (kind != 'promo_code' || (wantedCode ?? '').isNotEmpty);
        bool matchesWanted(Map<String, dynamic> row) =>
            ((row['pct_off'] as num?)?.toInt() ?? 0) == pct &&
            (row['code'] ?? '').toString().toUpperCase() == (wantedCode ?? '').toUpperCase();
        // The one existing row that already IS what the creator asked for, if any.
        Map<String, dynamic>? keep;
        if (want) {
          for (final row in rows) {
            if (matchesWanted(row)) {
              keep = row;
              break;
            }
          }
        }
        final stale = rows.where((row) => !identical(row, keep)).toList();
        if (keep != null && stale.isEmpty) return; // already correct
        if (!want && stale.isEmpty) return; // nothing there, nothing wanted

        // 1. Write the replacement FIRST. If this fails the creator keeps the
        //    discount they had — see (a) above.
        if (want && keep == null) {
          final ok = await ListingsApi.addPromotion(id, kind: kind, pctOff: pct, code: wantedCode);
          Analytics.capture('listing_promotion_saved', {
            'listing_id': id,
            'promotion_kind': kind,
            'pct_off': pct,
            'outcome': ok ? 'ok' : 'error',
          });
          if (!ok) throw StateError('The discount could not be saved.');
        }

        // 2. Only now remove what it replaced, and BELIEVE THE RESULT — see (b).
        for (final row in stale) {
          final rowId = (row['id'] ?? '').toString();
          if (rowId.isEmpty) continue;
          final removed = await ListingsApi.deleteListingPromotion(id, rowId);
          if (removed) continue;
          stillLive.add(kind);
          AvaLog.I.warn('listing',
              'promotion delete failed for listing $id kind $kind row $rowId — stale discount is still live');
          await Analytics.captureException(
              StateError('deleteListingPromotion returned false'), StackTrace.current,
              screen: 'native_listing_wizard',
              handled: true,
              extra: {
                'stage': 'promotion_delete',
                'listing_id': id,
                'promotion_kind': kind,
                'promotion_id': rowId,
              });
          await Analytics.capture('listing_promotion_delete_failed', {
            'listing_id': id,
            'promotion_kind': kind,
            'promotion_id': rowId,
            'outcome': 'error',
          });
        }
      }
      await reconcile('early_bird', early, null);
      await reconcile('promo_code', promoPct, code);
      _promotions = await ListingsApi.listingPromotions(id);
      if (stillLive.isNotEmpty && mounted) {
        // Plainly: the creator did NOT cancel what they think they cancelled.
        setState(() => _error =
            'Your listing was saved, but an old discount (${stillLive.toSet().join(', ')}) could not be removed and buyers may still get it. Try Save and continue again.');
      }
    } catch (e, stack) {
      if (mounted) {
        setState(() => _error = stillLive.isEmpty
            ? 'Your listing was saved, but the discount could not be. Your previous discount, if any, is unchanged. Try Save and continue again.'
            : 'Your listing was saved, but an old discount (${stillLive.toSet().join(', ')}) could not be removed and buyers may still get it. Try Save and continue again.');
      }
      AvaLog.I.warn('listing', 'promotion sync failed for listing $id');
      await Analytics.captureException(e, stack,
          screen: 'native_listing_wizard',
          handled: true,
          extra: {'stage': 'promotion_sync', 'listing_id': id});
    }
  }

  Future<bool> _save() async {
    setState(() { _saving = true; _error = null; });
    try {
      final result = _id == null
          ? await ListingsApi.wizardCreate(_kind, _body())
          : await ListingsApi.wizardUpdate(_id!, _body());
      if (result['ok'] != true) throw StateError(_serverMessage(result));
      _id ??= result['listing_id']?.toString();
      if (_id == null) throw StateError('The server did not return a listing id.');
      _dirty = false;
      Analytics.capture('listing_native_wizard_saved', {'listing_id': _id!, 'step': _step});
      return true;
    } catch (e) {
      _error = e.toString().replaceFirst('Bad state: ', '');
      // [LIST-WIZARD-GATE-1] The two bugs this change fixes were invisible in
      // telemetry: a refused save only ever painted red text on the creator's
      // phone. Emit the refusal (with the step and kind that produced it) so the
      // next one is a PostHog query, not a screenshot.
      Analytics.capture('listing_native_wizard_save_failed', {
        'step': _step,
        'kind': _kind,
        'free_entry': _freeEntry,
        'listing_id': _id ?? '',
        'message': _error ?? '',
      });
      return false;
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _next() async {
    final problem = _validate();
    if (problem != null) { setState(() => _error = problem); return; }
    if (_step == 0) { setState(() => _step = 1); return; }
    if (!await _save()) return;
    // [LIST-APP-PARITY-1] Discounts are separate rows, written once the listing
    // has an id — which `_save()` above has just guaranteed. A failure here does
    // not advance, so the creator sees it on the step that owns the field.
    if (_step == 2) {
      await _syncPromotions();
      if (_error != null) return;
    }
    if (mounted && _step < _steps.length - 1) setState(() => _step++);
  }

  Future<void> _upload({bool face = false}) async {
    if (!face && _coverUrls.length >= 5) return;
    final file = await ImagePicker().pickImage(source: ImageSource.gallery, maxWidth: 1800, imageQuality: 86);
    if (file == null) return;
    setState(() { _saving = true; _error = null; });
    try {
      final result = await ListingsApi.wizardUpload(await file.readAsBytes(), mime: 'image/jpeg', fileName: file.name);
      if (result['ok'] != true || result['url'] == null) throw StateError('Photo upload failed.');
      setState(() {
        if (face) {
          _faceUrl = result['url'].toString();
        } else {
          _coverUrls.add(result['url'].toString());
        }
        _dirty = true;
      });
      Analytics.capture('listing_native_wizard_upload_completed', {'source': widget.source});
    } catch (e) {
      setState(() => _error = e.toString().replaceFirst('Bad state: ', ''));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _submit() async {
    final problem = _validate();
    if (problem != null) { setState(() => _error = problem); return; }
    if (_id == null && !await _save()) return;
    // Last chance to write a discount the creator typed but never left the
    // Money step with (back-navigation, an interrupted save).
    await _syncPromotions();
    if (_error != null) return;
    setState(() { _publishing = true; _error = null; });
    try {
      final review = await ListingsApi.wizardReview(_id!);
      if (review['ok'] != true) throw StateError(_serverMessage(review));
      if (review['verdict']?.toString() == 'fail') {
        final issues = (review['issues'] as List? ?? const []).map((x) => x is Map ? (x['message'] ?? '').toString() : '').where((x) => x.isNotEmpty).join(' ');
        throw StateError(issues.isEmpty ? 'The server review found issues to fix before submitting.' : issues);
      }
      var result = await ListingsApi.wizardSubmit(_id!);
      if (isIdentityRequired((result['status'] as num?)?.toInt() ?? 0, jsonEncode(result))) {
        if (!mounted || !await ensureListingLiveness(context)) throw StateError('Verify your identity to submit this listing.');
        result = await ListingsApi.wizardSubmit(_id!);
      }
      if (result['ok'] != true) throw StateError(_serverMessage(result));
      Analytics.capture('listing_native_wizard_submitted', {'listing_id': _id!, 'source': widget.source});
      if (!mounted) return;
      showAdToast(context, message: 'Listing submitted for review.');
      Navigator.of(context).pop(true);
    } catch (e) {
      if (mounted) setState(() => _error = e.toString().replaceFirst('Bad state: ', ''));
    } finally {
      if (mounted) setState(() => _publishing = false);
    }
  }

  static String _serverMessage(Map<String, dynamic> result) =>
      (result['message'] ?? result['detail'] ?? result['error'] ?? result['reason'] ?? 'Could not save this listing.').toString();

  /// [LIST-APP-PARITY-1] `live: true` rebuilds the step on every keystroke. Only
  /// the price and discount boxes need it — they feed the running "what the
  /// customer pays / what you keep" sum, which would otherwise sit one edit
  /// behind. Every other field keeps the cheap `_dirty`-only path.
  Widget _field(String label, TextEditingController controller, {int maxLines = 1, String? hint, bool live = false}) => Padding(
        padding: const EdgeInsets.only(bottom: Msg.s3),
        child: TextField(
          controller: controller,
          maxLines: maxLines,
          onChanged: (_) {
            _dirty = true;
            if (live && mounted) setState(() {});
          },
          decoration: InputDecoration(labelText: label, hintText: hint, filled: true, fillColor: AD.inputField),
        ),
      );

  /// What customers need to join. The keys are the ONLY ones the server accepts
  /// (listings.ts:534); anything else fails the whole save.
  static const Map<String, String> _kJoinRequirementLabels = {
    'mic': 'A microphone',
    'cam': 'A camera',
    'listen_only': 'Listening only — no mic needed',
    'recording': 'This session is recorded',
  };

  /// The per-field "Use AI" blip that sits above Title / Blurb / Description.
  Widget _aiBlip(String key) {
    final busy = _aiBusyField == key;
    final reviewed = _aiReviewedText.containsKey(key);
    final fresh = reviewed && _aiFresh(key);
    final suggestion = _aiSuggestion[key];
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [
        Expanded(child: Text(_kCopyFieldLabels[key]!.toUpperCase(), style: ADText.sectionLabel(c: AD.textTertiary))),
        TextButton.icon(
          onPressed: _aiBusyField != null || fresh ? null : () => _runCopyReview(key),
          icon: busy
              ? const SizedBox.square(dimension: 14, child: CircularProgressIndicator(strokeWidth: 2))
              : Icon(PhosphorIcons.sparkle(PhosphorIconsStyle.regular), size: 16),
          label: Text(busy
              ? 'Checking…'
              : fresh
                  ? 'AI checked'
                  : reviewed
                      ? 'Check again'
                      : 'Use AI'),
        ),
      ]),
      if (fresh && suggestion != null) _aiSuggestionCard(key, suggestion),
    ]);
  }

  Widget _aiSuggestionCard(String key, CopyReviewField suggestion) {
    final current = _copyController(key).text.trim();
    final nothingToDo = suggestion.suggested.isEmpty || suggestion.suggested == current;
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: Msg.s2),
      padding: const EdgeInsets.all(Msg.s3),
      decoration: BoxDecoration(color: AD.cardHover, borderRadius: BorderRadius.circular(AD.rListCard)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        // Never claim an AI review that did not happen — `source` says which
        // half of the route answered (listing_copy_review.ts rule 2).
        Text(_aiSource == 'ai' ? 'AI SUGGESTION' : 'LENGTH CHECK · AI MODEL UNAVAILABLE',
            style: ADText.sectionLabel(c: AD.textTertiary)),
        const SizedBox(height: Msg.s1),
        Text(nothingToDo ? 'This reads well as it is — nothing to change.' : suggestion.suggested,
            style: ADText.preview(c: AD.textPrimary)),
        if (suggestion.note != null) ...[
          const SizedBox(height: Msg.s1),
          Text(suggestion.note!, style: ADText.preview()),
        ],
        if (!nothingToDo)
          Align(
            alignment: Alignment.centerRight,
            child: TextButton(onPressed: () => _applySuggestion(key), child: const Text('Apply')),
          ),
      ]),
    );
  }

  Widget _languagePicker() => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('Languages you will speak', style: ADText.rowName()),
        Text('Shown on your listing. The whole list is limited to $_kSpokenLangMax characters.',
            style: ADText.preview()),
        const SizedBox(height: Msg.s2),
        Wrap(spacing: Msg.s2, runSpacing: Msg.s2, children: [
          for (final lang in _kLanguages)
            FilterChip(
              label: Text(lang),
              selected: _spokenLangs.contains(lang),
              onSelected: (selected) => _toggleLang(lang, selected),
            ),
        ]),
      ]);

  /// The running customer-facing sum. Display only — see [_feeSplit].
  Widget _moneyBreakdown() {
    final price = int.tryParse(_price.text.trim()) ?? 0;
    if (price <= 0) return const SizedBox.shrink();
    // [LIST-PROMO-OFF-1] The fee split below is the PLATFORM fee and always
    // shows; only the discounted variants are shelved with promotions.
    final promotions = RemoteConfig.listingPromotionsEnabled;
    final early = !promotions
        ? 0
        : (int.tryParse(_earlyBirdPct.text.trim()) ?? 0).clamp(0, 100).toInt();
    final promo = !promotions
        ? 0
        : (int.tryParse(_promoPct.text.trim()) ?? 0).clamp(0, 100).toInt();
    Widget line(String label, int pct) {
      final pays = (price * (100 - pct) / 100).round();
      final split = _feeSplit(pays);
      return Padding(
        padding: const EdgeInsets.only(top: Msg.s1),
        child: Text(
            '$label — customer pays ₹$pays per hour · you keep ₹${split.creator} after the ₹${split.fee} platform fee',
            style: ADText.preview(c: AD.textPrimary)),
      );
    }
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(top: Msg.s2),
      padding: const EdgeInsets.all(Msg.s3),
      decoration: BoxDecoration(color: AD.cardHover, borderRadius: BorderRadius.circular(AD.rListCard)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('WHAT THIS EARNS', style: ADText.sectionLabel(c: AD.textTertiary)),
        line('Full price', 0),
        if (early > 0) line('Early bird $early% off', early),
        if (promo > 0) line('Promo code ${_promoCode.text.trim().toUpperCase()} $promo% off', promo),
        const SizedBox(height: Msg.s1),
        Text(
            'The platform fee is ₹$_kFlatTokensPerHour plus $_kCommissionPct% of everything above it, per participant per hour. The server recomputes every amount at checkout.',
            style: ADText.preview(c: AD.textTertiary)),
      ]),
    );
  }

  String _categoryLabel() {
    for (final c in _categories) {
      if (c.id == _category) return '${c.emoji} ${c.label}';
    }
    return _category;
  }

  Widget _summaryLine(String label, String value) => Padding(
        padding: const EdgeInsets.only(bottom: Msg.s2),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(label.toUpperCase(), style: ADText.sectionLabel(c: AD.textTertiary)),
          Text(value.trim().isEmpty ? '—' : value.trim(), style: ADText.preview(c: AD.textPrimary)),
        ]),
      );

  /// [LIST-APP-PARITY-1] Step 8: a plain read-only summary of everything the
  /// creator entered, the review-time promise, and one Submit button.
  ///
  /// It used to be a title+description echo with an "I reviewed this" checkbox
  /// and a "Repeat this listing for four weeks" control — the creator could not
  /// see what they were about to publish, and the repeat button silently created
  /// four extra drafts from a step whose only job is to submit one.
  Widget _reviewStep() {
    final consult = _kind == 'consult';
    final price = int.tryParse(_price.text.trim()) ?? 0;
    final split = _feeSplit(price);
    // [LIST-PROMO-OFF-1] Shelved: no discount rows on the summary while the
    // creator has no way to set one.
    final promotions = RemoteConfig.listingPromotionsEnabled;
    final early = promotions ? (int.tryParse(_earlyBirdPct.text.trim()) ?? 0) : 0;
    final promoPct = promotions ? (int.tryParse(_promoPct.text.trim()) ?? 0) : 0;
    final join = _joinReq.entries
        .where((e) => e.value)
        .map((e) => _kJoinRequirementLabels[e.key] ?? e.key)
        .join(', ');
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text('Check your listing', style: ADText.appTitle()),
      const SizedBox(height: Msg.s1),
      Text('Nothing on this step can be edited — step back to change anything.', style: ADText.preview()),
      const SizedBox(height: Msg.s3),
      AdCard(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        _summaryLine('Type', consult ? '1:1 consultation' : 'Live event'),
        _summaryLine('Title', _title.text),
        _summaryLine('Short blurb', _blurb.text),
        _summaryLine('Description', _description.text),
        _summaryLine('Category', _categoryLabel()),
        _summaryLine('Languages', _spokenLangCsv().replaceAll(',', ', ')),
        _summaryLine(
            'Price',
            _freeEntry
                ? 'Free entry'
                : price > 0
                    ? '₹$price per hour · you keep ₹${split.creator} after the ₹${split.fee} platform fee'
                    : ''),
        if (!_freeEntry && early > 0) _summaryLine('Early-bird discount', '$early% off'),
        if (!_freeEntry && promoPct > 0)
          _summaryLine('Promo code', '${_promoCode.text.trim().toUpperCase()} · $promoPct% off'),
        _summaryLine('Media', _mediaMode == 'audio_only' ? 'Audio only' : 'Audio and video'),
        _summaryLine('Schedule',
            _scheduleMode == 'fixed_date' ? 'Fixed date and time' : 'On request (from my availability)'),
        _summaryLine('Time zone', _zone),
        if (_scheduleMode == 'fixed_date' || _kind == 'live_event') _summaryLine('Starts', _startsAt.text),
        _summaryLine('Duration', '${int.tryParse(_duration.text.trim()) ?? 60} minutes'),
        _summaryLine(
            'Capacity',
            consult
                ? '1 seat — a 1:1 consultation'
                : (int.tryParse(_capacity.text.trim()) ?? 0) == 0
                    ? 'Unlimited'
                    : _capacity.text),
        _summaryLine('Location / meeting note', _location.text),
        _summaryLine('How it works', _how.text),
        _summaryLine('House rules', _rules.text),
        _summaryLine('What customers get', _whatGet.text),
        _summaryLine('Who this is for', _whoFor.text),
        _summaryLine('Who this is not for', _notFor.text),
        _summaryLine('FAQ', _faq.text),
        _summaryLine('What customers need to join', join),
        if (consult) _summaryLine('Preparation instructions', _preparation.text),
        _summaryLine('Video', _videoUrl.text),
      ])),
      const SizedBox(height: Msg.s3),
      Text('Photos', style: ADText.rowName()),
      const SizedBox(height: Msg.s2),
      if (_coverUrls.isEmpty)
        Text('No cover photos added.', style: ADText.preview())
      else
        Wrap(spacing: Msg.s2, runSpacing: Msg.s2, children: [
          for (final url in _coverUrls) CachedImage(url, width: 84, height: 84, radius: Msg.brMd),
        ]),
      if (_faceUrl != null) ...[
        const SizedBox(height: Msg.s3),
        Text('Private face photo — never shown publicly', style: ADText.preview()),
        Padding(
            padding: const EdgeInsets.only(top: Msg.s2),
            child: CachedImage(_faceUrl!, width: 84, height: 84, radius: Msg.brMd)),
      ],
      const SizedBox(height: Msg.s4),
      AdCard(
          child: Text(
              'Submitting sends this listing for review. Reviews take 24 to 48 hours, and you will be told as soon as it is approved or sent back with changes.',
              style: ADText.preview(c: AD.textPrimary))),
    ]);
  }

  Widget _stepBody() {
    switch (_step) {
      case 0:
        return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('What are you offering?', style: ADText.appTitle()),
          const SizedBox(height: Msg.s3),
          for (final option in const {'consult': '1:1 consultation', 'live_event': 'Live event'}.entries)
            RadioListTile<String>(title: Text(option.value), value: option.key, groupValue: _kind, onChanged: (v) => setState(() {
              _kind = v!;
              // A consult is booked against the creator's calendar; a live event
              // happens at a fixed time. `availability` — the value this screen's
              // schedule dropdown used to offer — is not a schedule_mode the
              // server knows (listings.ts:372) and 400'd every save it was used on.
              _scheduleMode = _kind == 'consult' ? 'on_request' : 'fixed_date';
              _dirty = true;
            })),
          // [LIST-WIZARD-GATE-1] Free entry is allowlist-gated server-side
          // (worker/src/lib/free_entry_gate.ts: ADMIN_UIDS or FREE_ENTRY_ALLOWLIST
          // while freeEntryAllowlistOnly stays true), so an ordinary creator who
          // flipped this only ever got a 403 "Free-entry listings are limited to
          // approved creators right now." two steps later. Owner instruction
          // 2026-09-13: nobody but the admin account sees this control.
          //
          // The condition is the SERVER's per-account answer (`free_entry_allowed`
          // from GET /api/listings/mine), which the web wizard already uses, not a
          // client guess: RemoteConfig.isAdmin would cover ADMIN_UIDS only and
          // would wrongly hide the switch from FREE_ENTRY_ALLOWLIST testers. It
          // fails closed. This hides an affordance that cannot work; the Worker
          // gate is still the only gate.
          //
          // `|| _freeEntry` keeps the switch reachable on a listing that ALREADY
          // has free entry, so its owner can turn it off. Without that, an account
          // whose allowlisting was revoked would be left with a listing it can
          // never save again.
          if (_freeEntryAllowed || _freeEntry)
            SwitchListTile(contentPadding: EdgeInsets.zero, title: const Text('This is a free show'), value: _freeEntry, onChanged: (v) => setState(() { _freeEntry = v; _dirty = true; })),
        ]);
      case 1:
        return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          // [LIST-APP-PARITY-1] Each of the three copy fields carries its own AI
          // blip. The category list is fetched from /api/explore/categories, so
          // a new category (e.g. "Puja") appears here with no client change.
          for (final key in _kCopyFields) ...[
            _aiBlip(key),
            _field(_kCopyFieldLabels[key]!, _copyController(key),
                maxLines: key == 'description' ? 6 : 1, hint: _kCopyFieldHints[key]),
          ],
          if (_aiUnavailable)
            Padding(
                padding: const EdgeInsets.only(bottom: Msg.s3),
                child: Text(
                    'The AI check is unavailable right now, so it is not holding you up. You can run it again from any of the three fields.',
                    style: ADText.preview(c: AD.textTertiary))),
          DropdownButtonFormField<String>(value: _category.isEmpty ? null : _category, decoration: const InputDecoration(labelText: 'Category'), items: _categories.map((c) => DropdownMenuItem(value: c.id, child: Text('${c.emoji} ${c.label}'))).toList(), onChanged: (v) => setState(() { _category = v ?? ''; _dirty = true; })),
          const SizedBox(height: Msg.s4),
          _languagePicker(),
        ]);
      case 2:
        return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          if (!_freeEntry) _field('Price per hour (Tokens = ₹)', _price, hint: 'At least $_minPricePerHour tokens per hour', live: true),
          DropdownButtonFormField<String>(value: _mediaMode, decoration: const InputDecoration(labelText: 'Media mode'), items: const [DropdownMenuItem(value: 'audio_video', child: Text('Audio + video')), DropdownMenuItem(value: 'audio_only', child: Text('Audio only'))], onChanged: (v) => setState(() { _mediaMode = v ?? 'audio_video'; _dirty = true; })),
          // [LIST-APP-PARITY-1] Discounts. Free entry has nothing to discount.
          // [LIST-PROMO-OFF-1] Shelved behind the kill switch. The fee
          // breakdown below it is the PLATFORM fee (the flat-per-hour charge
          // plus the commission, see [_feeSplit]), not a promotion, so it
          // keeps rendering whenever there is a price.
          if (!_freeEntry && RemoteConfig.listingPromotionsEnabled) ...[
            const SizedBox(height: Msg.s4),
            Text('Discounts', style: ADText.rowName()),
            Text('Optional. An early-bird cut applies to everyone; a promo code applies only to customers who type it at checkout.',
                style: ADText.preview()),
            const SizedBox(height: Msg.s3),
            _field('Early-bird discount %', _earlyBirdPct, hint: '1 to 100 — leave empty for none', live: true),
            _field('Promo code', _promoCode, hint: 'MONSOON20', live: true),
            _field('Promo code discount %', _promoPct, hint: '1 to 100', live: true),
          ],
          if (!_freeEntry) _moneyBreakdown(),
        ]);
      case 3:
        return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          // Only the two modes this wizard can actually fill in are offered, and
          // the choice follows the kind.
          DropdownButtonFormField<String>(
            value: _scheduleMode == 'fixed_date' ? 'fixed_date' : 'on_request',
            decoration: const InputDecoration(labelText: 'Schedule'),
            items: const [
              DropdownMenuItem(value: 'fixed_date', child: Text('Fixed date and time')),
              DropdownMenuItem(value: 'on_request', child: Text('On request (from my availability)')),
            ],
            onChanged: (v) => setState(() { _scheduleMode = v ?? 'fixed_date'; _dirty = true; }),
          ),
          const SizedBox(height: Msg.s3),
          // A free-text zone is checked against Intl and 400s on a typo
          // (listings.ts:386). A list cannot be mistyped.
          DropdownButtonFormField<String>(
            value: _kZones.contains(_zone) ? _zone : _kZones.first,
            decoration: const InputDecoration(labelText: 'Time zone'),
            items: [for (final z in _kZones) DropdownMenuItem(value: z, child: Text(z))],
            onChanged: (v) => setState(() { _timezone.text = v ?? _kZones.first; _dirty = true; }),
          ),
          const SizedBox(height: Msg.s3),
          // Shown for EVERY live event, not only in fixed-date mode: the server
          // requires a future `starts_at` on the kind regardless of schedule_mode
          // (listing_blockers.ts:227). Hiding it by mode would leave an edited
          // recurring event demanding a start with no field to type it in.
          if (_scheduleMode == 'fixed_date' || _kind == 'live_event')
            _field('Start date and time (YYYY-MM-DDTHH:MM)', _startsAt, hint: '2026-12-31T18:00'),
          _field('Duration (minutes)', _duration, hint: '5 to 480'),
          // Capacity is a live-event idea. A consult always has one seat and the
          // server refuses any other value at publish (listing_blockers.ts:246).
          if (_kind == 'live_event') _field('Capacity (0 = unlimited)', _capacity, hint: '0'),
          _field('Location / meeting note', _location),
          if (_kind == 'consult') ...[
            const SizedBox(height: Msg.s2),
            Text('A 1:1 consultation cannot be published until you have availability in AvaCalendar — that is what customers book against.', style: ADText.preview()),
            const SizedBox(height: Msg.s2),
            OutlinedButton.icon(
              onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const AvaCalendarScreen())),
              icon: Icon(PhosphorIcons.calendarBlank(PhosphorIconsStyle.regular)),
              label: const Text('Open AvaCalendar'),
            ),
          ],
        ]);
      case 4:
        return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('One step per line, written as "Label: what happens". Up to 5.', style: ADText.preview()),
          const SizedBox(height: Msg.s2),
          _field('How it works', _how, maxLines: 8, hint: 'Warm up: five minutes of breathing'),
        ]);
      case 5:
        return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('One rule per line, written as "Heading: the rule". Up to 8.', style: ADText.preview()),
          const SizedBox(height: Msg.s2),
          _field('House rules', _rules, maxLines: 8, hint: 'Be on time: the room locks 5 minutes in'),
          _field('What customers get (3 to 5 lines, or leave empty)', _whatGet, maxLines: 5),
          _field('Who this is for (up to 3 lines)', _whoFor, maxLines: 4),
          _field('Who this is not for (up to 3 lines)', _notFor, maxLines: 4),
          const SizedBox(height: Msg.s2),
          Text('What customers need to join', style: ADText.rowName()),
          // Was a free-text "Join requirements JSON" box. The server accepts only
          // these keys and 422s anything else (listings.ts:534), so prose in that
          // box made the listing unsaveable. Checkboxes can only produce a legal
          // object.
          for (final entry in _kJoinRequirementLabels.entries)
            CheckboxListTile(
              contentPadding: EdgeInsets.zero,
              dense: true,
              value: _joinReq[entry.key] ?? false,
              title: Text(entry.value),
              onChanged: (v) => setState(() { _joinReq[entry.key] = v ?? false; _dirty = true; }),
            ),
          if (_kind == 'consult') _field('Preparation instructions', _preparation, maxLines: 5),
          const SizedBox(height: Msg.s2),
          // [LIST-APP-PARITY-1] Moved off step 8, which is now read-only. Same
          // 3-to-6 rule (contentAttrsError:515), now checked on this step.
          _field('FAQ (3 to 6 lines, or leave empty)', _faq, maxLines: 6, hint: 'Do I need a mic? Yes, any headset works'),
        ]);
      case 6:
        return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Cover photos (${_coverUrls.length}/5)', style: ADText.rowName()),
          const SizedBox(height: Msg.s2),
          Wrap(
            spacing: Msg.s2,
            runSpacing: Msg.s2,
            children: [
              for (var i = 0; i < _coverUrls.length; i++)
                Stack(children: [
                  CachedImage(_coverUrls[i], width: 84, height: 84, radius: Msg.brMd),
                  Positioned(right: 0, child: IconButton(icon: Icon(PhosphorIcons.x(PhosphorIconsStyle.bold)), onPressed: () => setState(() => _coverUrls.removeAt(i)))),
                ]),
            ],
          ),
          const SizedBox(height: Msg.s3),
          OutlinedButton.icon(onPressed: _saving ? null : () => _upload(), icon: Icon(PhosphorIcons.imageSquare(PhosphorIconsStyle.regular)), label: const Text('Add photos')),
          const SizedBox(height: Msg.s3),
          Text('Private face photo', style: ADText.rowName()),
          Text('Used for identity-safe poster generation and never shown publicly.', style: ADText.preview()),
          if (_faceUrl != null) Padding(padding: const EdgeInsets.only(top: 8), child: CachedImage(_faceUrl!, width: 84, height: 84, radius: Msg.brMd)),
          OutlinedButton.icon(onPressed: _saving ? null : () => _upload(face: true), icon: Icon(PhosphorIcons.smiley(PhosphorIconsStyle.regular)), label: const Text('Choose face photo')),
          _field('Video URL', _videoUrl),
        ]);
      default:
        return _reviewStep();
    }
  }

  @override
  Widget build(BuildContext context) {
    return WillPopScope(
      onWillPop: () async {
        if (!_dirty || _publishing) return true;
        return await showDialog<bool>(context: context, builder: (context) => AlertDialog(
          title: const Text('Leave listing?'),
          content: const Text('Your last saved draft will remain available in My listings.'),
          actions: [TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Stay')), FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Leave'))],
        )) ?? false;
      },
      child: Scaffold(
      backgroundColor: AD.bg,
      appBar: ZineAppBar(title: _id == null ? 'Create listing' : 'Edit listing', showBack: true),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : SafeArea(child: LayoutBuilder(builder: (context, constraints) {
              final width = constraints.maxWidth > 720 ? 640.0 : constraints.maxWidth;
              return Center(child: SizedBox(width: width, child: ListView(padding: const EdgeInsets.all(Msg.s4), children: [
                Text('Step ${_step + 1} of ${_steps.length} · ${_steps[_step]}', style: ADText.preview(c: AD.textSecondary)),
                const SizedBox(height: Msg.s2),
                LinearProgressIndicator(value: (_step + 1) / _steps.length),
                const SizedBox(height: Msg.s4),
                if (_error != null) AdCard(child: Text(_error!, style: ADText.preview(c: AD.danger))),
                _stepBody(),
                const SizedBox(height: Msg.s4),
                Row(children: [
                  if (_step > 0) TextButton(onPressed: _saving || _publishing ? null : () => setState(() => _step--), child: const Text('Back')),
                  const Spacer(),
                  FilledButton(onPressed: _saving || _publishing ? null : (_step == 7 ? _submit : _next), child: Text(_step == 7 ? (_publishing ? 'Submitting…' : 'Submit for review') : (_saving ? 'Saving…' : 'Save and continue'))),
                ]),
              ])));
            })),
      ),
    );
  }
}
