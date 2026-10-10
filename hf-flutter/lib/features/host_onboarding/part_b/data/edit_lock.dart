/// Which parts of the profile can still be changed, from `host.status` (worker rules in `hf_hosts.ts`):
///
/// - `generating` and `pending_review`: nothing (`409 locked`). The profile is being made or checked.
/// - `live`: only the price, the hours and a new voice introduction. Everything else is locked.
/// - anything else (`draft`, `pending_host`, `rejected`, `paused`): everything.
///
/// Locked steps still open, read-only, so a host can look at what they sent.
class EditLock {
  const EditLock(this.status);

  factory EditLock.of(String? status) => EditLock(status);

  final String? status;

  bool get inReview => status == 'generating' || status == 'pending_review';
  bool get live => status == 'live';

  /// Name, about, languages, style, topics and the comfort switches.
  bool get profileLocked => inReview || live;

  /// Price and hours.
  bool get priceHoursLocked => inReview;

  bool get avatarLocked => inReview || live;

  /// A live host may record a new introduction; the old one keeps playing until the new one is approved.
  bool get voiceLocked => inReview;

  static const String _generating = 'We are making your profile. You can change things when it is ready.';
  static const String _pending = 'Your profile is with our team. You can change things once they have looked at it.';
  static const String _live = 'Your profile is live. Only your price, hours and voice introduction can be changed here.';

  /// The calm note at the top of a locked step, or null when the step can be edited.
  /// [editableWhenLive]: price, hours and voice stay editable on a live profile.
  String? banner({bool editableWhenLive = false}) {
    if (status == 'generating') return _generating;
    if (status == 'pending_review') return _pending;
    if (live && !editableWhenLive) return _live;
    return null;
  }
}
