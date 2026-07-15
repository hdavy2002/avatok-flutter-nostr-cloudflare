/// [PUSH-FG-BANNER-1 2026-07-14] Which conversation is currently ON SCREEN.
///
/// ## Why this exists
///
/// The foreground FCM handler must decide whether to post a banner for an
/// incoming message. Before this, it never posted one — reasoning that "the app
/// is open, so the socket already delivered it." That silenced the phone in
/// every case where the app process was foreground but the user was not
/// actually reading the thread: screen off with AvaTalk on top (the 2026-07-14
/// report), the user in AvaDialer, or the user in a different chat.
///
/// The correct suppression rule needs one fact the push layer had no way to
/// know: *which thread is the user looking at right now?* This holds it.
///
/// ## Contract
///
/// `ChatThreadScreen` sets [convKey] when its thread becomes visible and clears
/// it when it stops being visible. Anything that reads it MUST also check
/// `WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed` —
/// a thread can remain "current" while the screen is off, and a stale value
/// here must never be able to silence a notification on its own.
///
/// ## Why a plain global
///
/// Deliberately not scoped storage and deliberately not persisted. This is
/// ephemeral, main-isolate-only UI state with a lifetime shorter than a single
/// screen. Persisting it would be actively harmful: a stale "thread is open"
/// value surviving a restart would suppress banners for a thread nobody is
/// looking at — reintroducing the very bug this fixes. The FCM background
/// isolate cannot see this (separate isolate, separate statics) and does not
/// need to: if the bg isolate is running, the app is not foreground, so the
/// banner should always show.
abstract class ActiveThread {
  /// The on-screen conversation key ('1:<peerHex>' or 'g:<gid>'), or null when
  /// no thread is visible. Compare against the `conv` field on a `notify` push.
  static String? convKey;

  /// Mark [key] as the visible thread.
  static void enter(String? key) => convKey = key;

  /// Clear [convKey], but only if [key] still owns it.
  ///
  /// The guard matters: pushing thread B over thread A runs B's `enter` before
  /// A's `leave` (Flutter builds the new route before disposing the old one).
  /// An unconditional clear would wipe B's key and leave nothing marked as
  /// open — so the user reading B would get banners for B.
  static void leave(String? key) {
    if (key != null && convKey == key) convKey = null;
  }
}
