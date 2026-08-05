part of '../chat_thread.dart';


/// [AVAVM-PLAYER-1] Best-effort, in-memory registry of the [Chat] behind every
/// conversation key opened THIS app session, so the app-wide
/// [MiniAudioPlayerBar] (mounted at the shell root) can reopen the right
/// thread when its "now playing" bar is tapped for a voice note whose
/// `AudioTrack.originRoute` is that thread's `convKey`.
///
/// Not persisted — deliberately: it only needs to answer "have we been here
/// this session", and the bar can only ever be showing a track for a thread
/// that WAS opened this session (playback has to have started somewhere).
/// Installs itself once as [AudioPlaybackService.onTapOrigin]; other surfaces
/// (e.g. the AvaDial voicemail inbox) can compose with or override that hook
/// for their own `originRoute` scheme without needing anything from this file.
///
/// [AVAVM-PLAYER-2] COMPOSES rather than clobbers — mirrors
/// `InboxThreadRegistry._ensureHook()` (features/avadial/inbox/inbox_thread_screen.dart):
/// captures whatever `AudioPlaybackService.onTapOrigin` was already installed
/// and falls through to it for any track this registry doesn't recognise
/// (i.e. not one of `_byConvKey`'s keys). Previously this unconditionally
/// OVERWROTE the hook the first time any chat thread opened, so if a chat
/// thread happened to open AFTER the Inbox lane had already installed its own
/// hook, chat's install silently discarded Inbox's — tapping the mini-player
/// after a voicemail could then navigate to the wrong place (or no-op)
/// depending purely on which thread type was opened first (AVAINBOX-1
/// handover report, confirmed). Capturing+chaining `previous` here fixes the
/// reverse ordering that report flagged as NOT fixed by the Inbox side alone;
/// combined with `InboxThreadRegistry`'s existing capture-and-chain, BOTH
/// installation orders now compose correctly. `AudioPlaybackService
/// .onTapOrigin` itself is untouched (still a single nullable field) — no
/// public API change, so `InboxThreadRegistry` (owned by a different agent)
/// keeps compiling unchanged.
abstract class ChatThreadRegistry {
  static final Map<String, Chat> _byConvKey = {};
  static bool _installed = false;

  static void remember(String convKey, Chat chat) {
    _byConvKey[convKey] = chat;
    _ensureNavHook();
  }

  static void _ensureNavHook() {
    if (_installed) return;
    _installed = true;
    final previous = AudioPlaybackService.onTapOrigin;
    AudioPlaybackService.onTapOrigin = (context, track) async {
      final route = track.originRoute;
      final chat = route != null ? _byConvKey[route] : null;
      if (chat != null) {
        await Navigator.of(context, rootNavigator: true).push(
          MaterialPageRoute(builder: (_) => ChatThreadScreen(chat: chat)),
        );
        return;
      }
      // Not a chat-thread track (or not opened this session yet) — fall
      // through to whatever was installed before us (e.g. Inbox's hook).
      await previous?.call(context, track);
    };
  }
}

// [CHAT-UI-ROW-EXTRACT-1] Per-message row wrapper around `_bubble(m)`.
//
// EXTRACTION DECISION: `_bubble()` (~900 lines) reads a huge amount of
// `_ChatThreadScreenState` — theme/wallpaper getters, ~20 callbacks
// (`_react`, `_forward`, `_toggleStar`, `_openImageFull`, `_retryMediaUpload`,
// translation/transcription helpers, `_statusFor`, group receipt lookups,
// `_memberAvatars`/`_memberNames`, safety-flag maps, `_mediaAutoFetch`, audio
// playback service state, …) and itself derives theme/isMine/grouping from
// `m` internally. Lifting all of that into a standalone widget + a parameter
// object in this pass would mean re-threading ~20 call sites and is exactly
// the "full decoupling is too risky" case this task called out — done wrong
// it silently drops a callback and breaks reactions/translate/retry/etc. with
// no compiler to catch it (no local builds in this repo's workflow).
//
// So this is a THIN extraction: `_MessageRow` is a real widget with its own
// `State`, but it still closes over a `buildBubble` function reference
// (`_bubble` itself, passed from the State) rather than duplicating any of
// `_bubble`'s body. The win is still real: `_MessageRowState.build()` only
// calls `buildBubble(msg)` again when `revision` (the `_msgsRev` counter from
// [CHAT-UI-VISIBLE-MEMO-1], stamped onto the row at itemBuilder time) has
// changed since the LAST time this row (keyed by message id, so the Element
// is reused across rebuilds) built its bubble. An unrelated setState — a
// composer keystroke, the typing indicator, the 30s clock tick, an audio
// scrub position — no longer re-invokes `_bubble()` for every row on screen;
// only an actual `_mutMsgs`-tracked mutation does. `_msgsRev` is coarse (one
// counter for the whole thread, not per-message), so ANY message mutation
// invalidates every row's cache on the next build — a real but strictly
// smaller cost than before (every row, every rebuild, of which there were far
// more). Per-message revision tracking would tighten this further; left as a
// documented follow-up rather than risked in this pass.
class _MessageRow extends StatefulWidget {
  const _MessageRow({required Key key, required this.msg, required this.revision, required this.buildBubble})
      : super(key: key);
  final _Msg msg;
  final int revision;
  final Widget Function(_Msg) buildBubble;

  @override
  State<_MessageRow> createState() => _MessageRowState();
}

class _MessageRowState extends State<_MessageRow> {
  int? _builtRev;
  Widget? _cached;

  @override
  Widget build(BuildContext context) {
    if (_cached == null || _builtRev != widget.revision) {
      _cached = widget.buildBubble(widget.msg);
      _builtRev = widget.revision;
    }
    return _cached!;
  }
}
