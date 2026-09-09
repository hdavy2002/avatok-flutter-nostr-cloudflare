import 'listing_draft.dart';

enum ListingWizardGate { none, liveness, kyc }

enum ListingSaveState { idle, saving, saved, failed }

class ListingFieldError {
  final String field, message;
  const ListingFieldError(this.field, this.message);
}

class ListingReviewResult {
  final String verdict, model;
  final List<ListingReviewIssue> issues;
  const ListingReviewResult(
      {required this.verdict, required this.model, this.issues = const []});
  factory ListingReviewResult.fromJson(Map<String, dynamic> j) =>
      ListingReviewResult(
        verdict: j['verdict']?.toString() ?? 'fail',
        model: j['model']?.toString() ?? 'unavailable',
        issues: ((j['issues'] as List?) ?? const [])
            .whereType<Map>()
            .map((e) =>
                ListingReviewIssue.fromJson(Map<String, dynamic>.from(e)))
            .toList(),
      );
}

class ListingReviewIssue {
  final String severity, field, message, source;
  const ListingReviewIssue(
      {required this.severity,
      required this.field,
      required this.message,
      required this.source});
  factory ListingReviewIssue.fromJson(Map<String, dynamic> j) =>
      ListingReviewIssue(
          severity: j['severity']?.toString() ?? 'fail',
          field: j['field']?.toString() ?? '',
          message: j['message']?.toString() ?? '',
          source: j['source']?.toString() ?? 'rules');
}

class ListingReadinessCheck {
  final bool ok, informational;
  final String label;
  const ListingReadinessCheck(this.ok, this.label,
      {this.informational = false});
}

class ListingWizardState {
  final ListingDraft draft;
  final int step;
  final bool loading, publishing, repeating, reviewing;
  final ListingSaveState saveState;
  final bool dirty;
  final ListingWizardGate gate;
  final ListingFieldError? fieldError;
  final String? error;
  final ListingReviewResult? review;
  final List<ListingReadinessCheck> readiness;

  const ListingWizardState({
    this.draft = const ListingDraft(),
    this.step = 0,
    this.loading = false,
    this.publishing = false,
    this.repeating = false,
    this.reviewing = false,
    this.saveState = ListingSaveState.idle,
    this.dirty = false,
    this.gate = ListingWizardGate.none,
    this.fieldError,
    this.error,
    this.review,
    this.readiness = const [],
  });

  ListingWizardState copyWith({
    ListingDraft? draft,
    int? step,
    bool? loading,
    bool? publishing,
    bool? repeating,
    bool? reviewing,
    ListingSaveState? saveState,
    bool? dirty,
    ListingWizardGate? gate,
    ListingFieldError? fieldError,
    bool clearFieldError = false,
    String? error,
    bool clearError = false,
    ListingReviewResult? review,
    bool clearReview = false,
    List<ListingReadinessCheck>? readiness,
  }) =>
      ListingWizardState(
        draft: draft ?? this.draft,
        step: step ?? this.step,
        loading: loading ?? this.loading,
        publishing: publishing ?? this.publishing,
        repeating: repeating ?? this.repeating,
        reviewing: reviewing ?? this.reviewing,
        saveState: saveState ?? this.saveState,
        dirty: dirty ?? this.dirty,
        gate: gate ?? this.gate,
        fieldError: clearFieldError ? null : (fieldError ?? this.fieldError),
        error: clearError ? null : (error ?? this.error),
        review: clearReview ? null : (review ?? this.review),
        readiness: readiness ?? this.readiness,
      );
}
