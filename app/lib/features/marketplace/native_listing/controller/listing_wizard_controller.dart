import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../../../../core/api_auth.dart';
import '../../../../core/config.dart';
import 'listing_draft.dart';
import 'listing_wizard_state.dart';

typedef ListingHttp = Future<ListingHttpResponse> Function(
    String method, String path, Object? body);

class ListingHttpResponse {
  final int status;
  final Map<String, dynamic> body;
  const ListingHttpResponse(this.status, this.body);
}

/// Injectable Worker adapter. The default implementation uses the app's
/// authenticated transport; tests can provide a deterministic fake.
class ListingWizardRepository {
  final ListingHttp request;
  ListingWizardRepository({ListingHttp? request})
      : request = request ?? _request;

  static Future<ListingHttpResponse> _request(
      String method, String path, Object? body) async {
    final url = 'https://$kSignalingHost/api$path';
    final response = switch (method) {
      'GET' => await ApiAuth.getSigned(url),
      'POST' => await ApiAuth.postJson(url, body ?? {}),
      'PUT' => await ApiAuth.putJson(url, body ?? {}),
      _ => throw ArgumentError('Unsupported listing method $method'),
    };
    Map<String, dynamic> json = {};
    try {
      final decoded = jsonDecode(response.body);
      if (decoded is Map) json = Map<String, dynamic>.from(decoded);
    } catch (_) {}
    return ListingHttpResponse(response.statusCode, json);
  }

  Future<ListingDraft?> load(String id) async {
    final r =
        await request('GET', '/listings/${Uri.encodeComponent(id)}', null);
    if (r.status != 200) return null;
    final raw = r.body['listing'];
    return raw is Map
        ? ListingDraft.fromListing(Map<String, dynamic>.from(raw))
        : null;
  }

  Future<String> create(ListingDraft d) async {
    final r = await request('POST', '/listings',
        {'kind': d.kind, ...d.toSaveBody(includePolicy: false)});
    if (r.status != 200 && r.status != 201)
      throw ListingWizardException.fromResponse(r);
    final id = r.body['listing_id']?.toString() ?? r.body['id']?.toString();
    if (id == null || id.isEmpty)
      throw const ListingWizardException(
          'no_id', 'The draft was saved without an id.', 200);
    return id;
  }

  Future<void> update(String id, ListingDraft d) async {
    final r = await request(
        'PUT', '/listings/${Uri.encodeComponent(id)}', d.toSaveBody());
    if (r.status != 200) throw ListingWizardException.fromResponse(r);
  }

  Future<ListingReviewResult> review(String id) async {
    final r = await request(
        'POST', '/listings/${Uri.encodeComponent(id)}/review', {});
    if (r.status != 200) throw ListingWizardException.fromResponse(r);
    return ListingReviewResult.fromJson(r.body);
  }

  Future<void> submit(String id) async {
    final r = await request(
        'POST', '/listings/${Uri.encodeComponent(id)}/submit', {});
    if (r.status != 200) throw ListingWizardException.fromResponse(r);
  }

  Future<List<String>> repeat(String id, int weeks) async {
    final r = await request('POST',
        '/listings/${Uri.encodeComponent(id)}/repeat', {'weeks': weeks});
    if (r.status != 200) throw ListingWizardException.fromResponse(r);
    return ((r.body['listing_ids'] as List?) ?? const [])
        .map((e) => e.toString())
        .toList();
  }
}

class ListingWizardException implements Exception {
  final String code, message;
  final int status;
  final String? field;
  const ListingWizardException(this.code, this.message, this.status,
      {this.field});
  factory ListingWizardException.fromResponse(ListingHttpResponse r) {
    final code = (r.body['error'] ?? r.body['code'] ?? r.body['reason'] ?? '')
        .toString();
    final field = r.body['field']?.toString();
    return ListingWizardException(code, _message(code, r.body), r.status,
        field: field);
  }
  static String _message(String code, Map<String, dynamic> body) {
    const known = <String, String>{
      'identity_required':
          'We need to verify it’s really you before you can create a listing.',
      'identity verification required':
          'Publishing a paid session needs your identity verified first.',
      'free_entry_not_allowed':
          'Free shows are limited to test accounts right now. Turn off free entry and set a price.',
      'cover_required': 'Add at least one photo before submitting.',
      'approval_required': 'This listing has been sent for review.',
      'listing not draft': 'This listing has already been submitted.',
    };
    final detail = body['message'] ?? body['detail'];
    if (detail is String &&
        detail.trim().isNotEmpty &&
        !RegExp(r'^[a-z0-9_]+$').hasMatch(detail.trim())) return detail.trim();
    if (known.containsKey(code)) return known[code]!;
    if (code.contains(' ') || code.contains('='))
      return '${code[0].toUpperCase()}${code.substring(1)}';
    return 'That didn’t go through. Please try again.';
  }

  @override
  String toString() => message;
}

class ListingWizardController extends ChangeNotifier {
  final ListingWizardRepository repository;
  ListingWizardState _state;
  ListingWizardState get state => _state;
  Timer? _debounce;
  Future<void> _saveQueue = Future.value();
  String _savedSnapshot = '';
  bool _disposed = false;

  ListingWizardController(
      {ListingWizardRepository? repository,
      ListingDraft? initial,
      int startAt = 0})
      : repository = repository ?? ListingWizardRepository(),
        _state = ListingWizardState(
            draft: initial ?? const ListingDraft(), step: startAt) {
    _savedSnapshot = _snapshot(_state.draft);
  }

  void patchDraft(ListingDraft next) {
    _set(_state.copyWith(
        draft: next,
        dirty: _snapshot(next) != _savedSnapshot,
        saveState: ListingSaveState.idle,
        clearError: true,
        clearFieldError: true,
        clearReview: true));
    _debounce?.cancel();
    if (next.id != null)
      _debounce = Timer(const Duration(milliseconds: 700), () {
        unawaited(saveDraft());
      });
  }

  void goBack() {
    if (_state.step > 0) _set(_state.copyWith(step: _state.step - 1));
  }

  Future<bool> next() async {
    final problem = validateStep(_state.draft, _state.step);
    if (problem != null) {
      _set(_state.copyWith(fieldError: problem, error: problem.message));
      return false;
    }
    if (_state.step == 0) {
      _set(_state.copyWith(step: 1, clearError: true, clearFieldError: true));
      return true;
    }
    final origin = _state.step;
    if (origin < 7)
      _set(_state.copyWith(
          step: origin + 1, clearError: true, clearFieldError: true));
    final ok = await saveDraft(step: origin);
    if (!ok && origin < 7 && !_disposed) _set(_state.copyWith(step: origin));
    return ok;
  }

  Future<void> resume(String id, {int startAt = 0}) async {
    _set(_state.copyWith(loading: true, clearError: true));
    try {
      final draft = await repository.load(id);
      if (draft == null)
        throw const ListingWizardException(
            'not_found', 'Could not load this listing.', 404);
      _savedSnapshot = _snapshot(draft);
      _set(_state.copyWith(
          draft: draft,
          step: startAt,
          loading: false,
          dirty: false,
          saveState: ListingSaveState.saved));
    } catch (e) {
      _fail(e, loading: false);
    }
  }

  Future<bool> saveDraft({int? step}) async {
    if (_state.draft.id == null && _state.step < 1) return true;
    final draftAtCall = _state.draft;
    final future =
        _saveQueue.then((_) => _save(draftAtCall, step ?? _state.step));
    _saveQueue = future.then<void>((_) {}, onError: (_) {});
    return future;
  }

  Future<bool> _save(ListingDraft draft, int step) async {
    _set(_state.copyWith(saveState: ListingSaveState.saving, clearError: true));
    try {
      final id = draft.id ?? await repository.create(draft);
      final saved = draft.copyWith(id: id);
      if (draft.id == null || id.isNotEmpty) await repository.update(id, saved);
      _savedSnapshot = _snapshot(saved);
      if (!_disposed)
        _set(_state.copyWith(
            draft: _state.draft.copyWith(id: id),
            dirty: _snapshot(_state.draft) != _savedSnapshot,
            saveState: ListingSaveState.saved));
      return true;
    } catch (e) {
      _fail(e, step: step);
      return false;
    }
  }

  Future<bool> runReview() async {
    final id = _state.draft.id;
    if (id == null) return false;
    _set(_state.copyWith(reviewing: true, clearError: true));
    try {
      final review = await repository.review(id);
      _set(_state.copyWith(
          review: review,
          reviewing: false,
          readiness: readinessFor(_state.draft, review)));
      return true;
    } catch (e) {
      _fail(e);
      _set(_state.copyWith(reviewing: false, clearReview: true));
      return false;
    }
  }

  Future<bool> submitForReview() async {
    final id = _state.draft.id;
    if (id == null) return false;
    if (!canSubmit) {
      _set(_state.copyWith(
          error:
              'Run the listing check and fix every blocking issue before submitting.'));
      return false;
    }
    _set(_state.copyWith(
        publishing: true, clearError: true, gate: ListingWizardGate.none));
    try {
      if (!await saveDraft(step: 7)) return false;
      await repository.submit(id);
      _set(_state.copyWith(
          publishing: false,
          draft: _state.draft.copyWith(status: 'pending_review'),
          dirty: false));
      return true;
    } catch (e) {
      _fail(e);
      _set(_state.copyWith(publishing: false));
      return false;
    } finally {
      if (!_disposed && _state.publishing)
        _set(_state.copyWith(publishing: false));
    }
  }

  Future<List<String>?> repeat({int weeks = 1}) async {
    final id = _state.draft.id;
    if (id == null || weeks < 1 || weeks > 12) return null;
    _set(_state.copyWith(repeating: true, clearError: true));
    try {
      final ids = await repository.repeat(id, weeks);
      _set(_state.copyWith(repeating: false));
      return ids;
    } catch (e) {
      _fail(e);
      _set(_state.copyWith(repeating: false));
      return null;
    }
  }

  List<ListingReadinessCheck> readinessFor(
      ListingDraft d, ListingReviewResult? review) {
    if (review == null)
      return const [
        ListingReadinessCheck(false, 'Check your listing — not run yet')
      ];
    final checks = <ListingReadinessCheck>[
      ListingReadinessCheck(
          review.verdict != 'fail',
          review.verdict == 'fail'
              ? 'The check found issues that must be fixed.'
              : 'Checked against the publishing rules.')
    ];
    checks.addAll(review.issues
        .where((i) => i.severity == 'fail')
        .map((i) => ListingReadinessCheck(false, i.message)));
    checks.add(ListingReadinessCheck(
        true,
        d.coverMedia.isEmpty
            ? 'No photos — the AI poster will be used.'
            : 'Photos added (${d.coverMedia.length}/5).',
        informational: true));
    return checks;
  }

  bool get canSubmit =>
      _state.draft.id != null &&
      _state.review != null &&
      _state.readiness.every((c) => c.ok || c.informational);

  void _fail(Object error, {int? step, bool? loading}) {
    final e = error is ListingWizardException
        ? error
        : ListingWizardException(
            'network', 'Could not save. Please try again.', 0);
    final code = e.code;
    final gate = code == 'identity_required'
        ? ListingWizardGate.liveness
        : (code == 'identity verification required' || code == 'kyc'
            ? ListingWizardGate.kyc
            : ListingWizardGate.none);
    _set(_state.copyWith(
        saveState: ListingSaveState.failed,
        error: e.message,
        fieldError:
            e.field == null ? null : ListingFieldError(e.field!, e.message),
        gate: gate));
  }

  void _set(ListingWizardState next) {
    if (_disposed) return;
    _state = next;
    notifyListeners();
  }

  static String _snapshot(ListingDraft d) => jsonEncode(d.snapshot());

  @override
  void dispose() {
    _disposed = true;
    _debounce?.cancel();
    super.dispose();
  }
}

ListingFieldError? validateStep(ListingDraft d, int step) {
  if (step == 1) {
    if (d.title.trim().length < 3)
      return const ListingFieldError(
          'title', 'Give your listing a title (at least 3 characters).');
    if (d.blurb.trim().isEmpty)
      return const ListingFieldError('blurb',
          'Write the one-line blurb — it is the line buyers read on the card.');
    if (d.blurb.length > 120)
      return const ListingFieldError(
          'blurb', 'The blurb must be at most 120 characters.');
    if (d.category.isEmpty)
      return const ListingFieldError('category', 'Pick one category.');
  }
  if (step == 2 && !d.freeEntry) {
    final p = int.tryParse(d.price.trim());
    if (p == null || p <= 0)
      return const ListingFieldError(
          'price', 'Set a price per hour, or mark this a free show.');
  }
  if (step == 2 && d.earlyBirdInvalid)
    return const ListingFieldError(
        'early_bird_pct', 'Early-bird discount must be 1–100%.');
  if (step == 3) {
    if (d.timezone.isEmpty)
      return const ListingFieldError('timezone', 'Pick a valid timezone.');
    if (d.scheduleMode == 'fixed_date' &&
        (d.startsAt.isEmpty || ListingDraft.localEpoch(d.startsAt) == null))
      return const ListingFieldError(
          'starts_at', 'Pick the date and time this starts.');
    if (d.scheduleMode == 'fixed_date' &&
        (ListingDraft.localEpoch(d.startsAt)! <=
            DateTime.now().millisecondsSinceEpoch))
      return const ListingFieldError(
          'starts_at', 'The start time needs to be in the future.');
    if (d.scheduleMode == 'recurring' && d.recurrenceDays.isEmpty)
      return const ListingFieldError(
          'recurrence_days', 'Pick at least one day of the week.');
    if (d.scheduleMode == 'recurring' &&
        !RegExp(r'^([01]\d|2[0-3]):[0-5]\d$').hasMatch(d.recurrenceTime))
      return const ListingFieldError('recurrence_time', 'Pick a valid time.');
    if (d.durationMin < 5 || d.durationMin > 480)
      return const ListingFieldError(
          'duration_min', 'Length must be between 5 minutes and 8 hours.');
    if (d.maxPerBooking < 1 || d.maxPerBooking > 20)
      return const ListingFieldError(
          'max_per_booking', 'Bookings per person must be 1–20.');
  }
  if (step == 4 &&
      (d.howItWorks.length > 5 ||
          d.howItWorks.any((e) =>
              (e['label'] ?? '').toString().trim().isEmpty ||
              (e['label'] ?? '').toString().length > 24 ||
              (e['body'] ?? '').toString().trim().isEmpty ||
              (e['body'] ?? '').toString().length > 240)))
    return const ListingFieldError('content_how_it_works',
        'Each step needs a label (≤24 chars) and body (≤240 chars), with no more than 5 steps.');
  if (step == 5 &&
      (d.houseRules.length > 8 ||
          d.houseRulesIntro.length > 280 ||
          d.houseRules.any((e) =>
              (e['heading'] ?? '').toString().trim().isEmpty ||
              (e['heading'] ?? '').toString().length > 32 ||
              (e['body'] ?? '').toString().trim().isEmpty ||
              (e['body'] ?? '').toString().length > 200)))
    return const ListingFieldError('content_house_rules',
        'Each rule needs a heading (≤32 chars) and body (≤200 chars), with no more than 8 rules.');
  if (step == 5 &&
      d.whatYouGet.isNotEmpty &&
      (d.whatYouGet.length < 3 || d.whatYouGet.length > 5))
    return const ListingFieldError(
        'content_what_you_get', 'List 3–5 things people get.');
  if (step == 5 && d.faq.isNotEmpty && (d.faq.length < 3 || d.faq.length > 6))
    return const ListingFieldError(
        'content_faq', 'Add 3–6 FAQ entries, or remove the section entirely.');
  if (step == 6 &&
      (d.kind == 'live_event' || d.kind == 'consult') &&
      (d.facePhoto == null || d.facePhoto!.isEmpty))
    return const ListingFieldError('face_photo',
        'Upload a photo of your face — it is not shown on your listing.');
  return null;
}
