import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/cached_image.dart';
import '../../core/marketplace_api.dart';
import '../../core/ui/avatok_dark.dart';
import '../identity/identity_screen.dart';
import '../identity/public_action_gate.dart';

/// AI listing composition — the conversation that replaces the 6-step form
/// (`sell_listing_flow.dart`).
///
/// Spec: Specs/PLAN-2026-07-17-ai-listing-creation-DRAFT.md §3.1–§3.7.
/// Server: worker/src/routes/compose.ts.
///
/// ── THE RULE (§3.3) ────────────────────────────────────────────────────────
/// **The server owns the draft. This screen does not.** There is no listing
/// state in this file — no title, no price, no attrs. It posts turns and
/// renders what comes back: what Ava said, what is still missing, and the
/// review card. That is deliberate: a killed app or a dropped connection
/// resumes mid-listing because the work was never here to lose. Do not add a
/// local draft "for responsiveness" — it will drift from the server's copy and
/// the server's copy is the listing.
///
/// **Publishing is a user tap, never a model decision.** The model has no
/// publish tool; it can only emit a review card that ASKS. [_publish] is the
/// only call that creates a listing, and only [_ReviewCard]'s button reaches it.
///
/// ── THE GATE IS CONVERSATIONAL (§3.1) ──────────────────────────────────────
/// An unverified seller is NOT bounced to the Identity page — the spec calls
/// that a drop-off cliff. Ava says it plainly and offers a button that runs
/// `ensurePublicActionAllowed` INLINE, then the chat carries on in place. The
/// "how do I do this?" link to [IdentityScreen] is the fallback for the stuck
/// case, not the main road.
class ComposeChatScreen extends StatefulWidget {
  /// Which vertical's taxonomy to open with. `commerce` is the only scheduled
  /// one (plan §0.1); `connect` is design-of-record and unscheduled.
  final String vertical;

  const ComposeChatScreen({super.key, this.vertical = 'commerce'});

  @override
  State<ComposeChatScreen> createState() => _ComposeChatScreenState();
}

enum _Role {
  /// The seller.
  user,

  /// Ava.
  ava,

  /// A client-side fact, not something Ava said (upload failed, draft moved on).
  notice,

  /// §3.1 — the inline verification offer.
  identity,

  /// §3.3 — "You were listing a 3-bed in Bandra. Carry on?"
  resume,

  /// §3.3 — the review card. The only route to publish.
  review,

  /// A dead session; the only way forward is a fresh one.
  restart,
}

class _Msg {
  final _Role role;
  final String text;

  /// Local thumbnails for photos sent with this turn (§3.4).
  final List<String> photoUrls;

  /// Only for [_Role.review].
  final Map<String, dynamic>? card;

  /// Only for [_Role.resume].
  final ComposeResume? resume;

  /// True while this Ava bubble is being typed out live from `say_delta`
  /// frames — renders a trailing cursor and (when still empty) the "thinking"
  /// placeholder. Cleared when the authoritative `say` reconciles it.
  final bool streaming;

  const _Msg(
    this.role,
    this.text, {
    this.photoUrls = const [],
    this.card,
    this.resume,
    this.streaming = false,
  });
}

/// Per-turn UX telemetry accumulator (§7.4). Times the user's FELT latency
/// client-side from the moment the POST fires: how long until the first byte,
/// until the first text they can read, and until the reply finished. Emitted
/// once per logical turn as `compose_turn_ux`.
class _TurnUx {
  final Stopwatch sw = Stopwatch()..start();
  final String sessionId;
  final int textLen;
  final bool hadMedia;
  final bool fromChip;
  int? firstByteMs; // first SSE frame of any kind (network + server TTFB)
  int? firstTextMs; // first say_delta/say — when the user first SEES a reply
  int? doneMs; // stream drained ([DONE])
  bool streamed = false; // did any say_delta arrive (vs only a final say)
  bool chipsShown = false;
  bool reachedReview = false;
  String? error;
  _TurnUx({
    required this.sessionId,
    required this.textLen,
    required this.hadMedia,
    required this.fromChip,
  });
}

/// A photo that has LANDED on the server and is waiting to ride the next turn.
/// Keyed by content hash — that is the whole contract with `attach_media`, and
/// it is why a retried attach is a no-op rather than a duplicate cover (§3.3c).
class _Photo {
  final String hash;
  final String? url;
  const _Photo(this.hash, this.url);
}

class _ComposeChatScreenState extends State<ComposeChatScreen> {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  final _msgs = <_Msg>[];

  /// Photos uploaded but not yet attached to a turn.
  final _pending = <_Photo>[];

  String? _sessionId;

  /// §3.3c — the client increments; the server demands exactly `turn_seq + 1`.
  /// Only advanced when the server ACTUALLY applied a turn, so a refused or
  /// lost turn cannot desync us.
  int _turnSeq = 0;

  /// §3.3c — the optimistic version from the latest review card.
  int? _rev;

  /// Index in [_msgs] of the Ava bubble currently being streamed into from
  /// `say_delta` frames. Non-null only while a turn is in flight; deltas append
  /// here and the final `say` reconciles it. Cleared when the turn finalises.
  int? _streamIdx;

  bool _identityOk = true;
  String? _identityReason;
  List<String> _chips = const [];

  /// Server-computed. Displayed, never recomputed here.
  double _progress = 0;
  List<String> _missing = const [];
  Map<String, dynamic>? _card;

  bool _opening = true;
  bool _busy = false;
  bool _uploading = false;
  bool _publishing = false;
  bool _published = false;

  /// Set only for states with no way forward (flag off, signed out).
  String? _fatal;

  late final String _lang;
  final _openedAt = DateTime.now();

  static const _avaGreen = Color(0xFF7BE08C);
  static const _maxPending = 10;

  @override
  void initState() {
    super.initState();
    // §3.7 — detect and follow. No language picker: the server converses in the
    // user's language and stores English-canonical.
    _lang = WidgetsBinding.instance.platformDispatcher.locale.languageCode
        .toLowerCase();
    // Deferred one microtask: _open() setStates before its first await, and
    // that would otherwise land inside initState. The first build renders the
    // spinner from the field defaults either way.
    Future<void>.microtask(_open);
  }

  @override
  void dispose() {
    // §7.4 — the funnel that decides whether this replaces the form:
    // compose_started → listing_published. An abandon must be as measurable as
    // a publish, or "the chat is worse than the form" is unfalsifiable.
    if (!_published && _sessionId != null) {
      Analytics.capture('compose_abandoned', {
        'session_id': _sessionId!,
        'turns': _turnSeq,
        'progress': _progress,
        'missing_count': _missing.length,
        'had_review_card': _card != null,
        'identity_ok': _identityOk,
        'vertical': widget.vertical,
        'ms': DateTime.now().difference(_openedAt).inMilliseconds,
      });
    }
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _jumpToEnd() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(_scroll.position.maxScrollExtent,
            duration: const Duration(milliseconds: 220), curve: Curves.easeOut);
      }
    });
  }

  void _add(_Msg m) {
    setState(() => _msgs.add(m));
    _jumpToEnd();
  }

  /// Keep the view pinned to the bottom WITHOUT an animation — used on every
  /// streamed delta, where an animated scroll would fight itself many times a
  /// second and stutter the typewriter.
  void _stickToEnd() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.jumpTo(_scroll.position.maxScrollExtent);
      }
    });
  }

  // ── Streaming render helpers (§3.3) ─────────────────────────────────────────

  /// Append a `say_delta` chunk to the live Ava bubble and rebuild, so the
  /// reply types out as it arrives.
  void _appendDelta(String delta) {
    final idx = _streamIdx;
    if (idx == null || idx >= _msgs.length) return;
    final m = _msgs[idx];
    if (m.role != _Role.ava) return;
    setState(() => _msgs[idx] = _Msg(_Role.ava, m.text + delta, streaming: true));
    _stickToEnd();
  }

  /// Reconcile the live bubble to the authoritative full `say` text (in case a
  /// delta was dropped) and drop the typing cursor.
  void _finalizeSay(String say) {
    final idx = _streamIdx;
    if (idx == null || idx >= _msgs.length || _msgs[idx].role != _Role.ava) {
      if (say.isNotEmpty) setState(() => _msgs.add(_Msg(_Role.ava, say)));
      _jumpToEnd();
      return;
    }
    setState(() => _msgs[idx] = _Msg(_Role.ava, say));
    _jumpToEnd();
  }

  /// End-of-turn cleanup: an Ava bubble that never received any text (e.g. an
  /// error fired first) is removed rather than left blank; a bubble that still
  /// carries the streaming flag has its cursor dropped. Call inside setState.
  void _finalizeStream() {
    final idx = _streamIdx;
    _streamIdx = null;
    if (idx == null || idx >= _msgs.length) return;
    final m = _msgs[idx];
    if (m.role != _Role.ava) return;
    if (m.text.isEmpty) {
      _msgs.removeAt(idx);
    } else if (m.streaming) {
      _msgs[idx] = _Msg(_Role.ava, m.text);
    }
  }

  void _emitTurnUx(_TurnUx ux, int seq, int attempt) {
    Analytics.capture('compose_turn_ux', {
      'session_id': ux.sessionId,
      'category': _card?['category']?.toString() ?? '',
      'text_len': ux.textLen,
      'had_media': ux.hadMedia,
      'chip_tap': ux.fromChip,
      'streamed': ux.streamed,
      'chips_shown': ux.chipsShown,
      'reached_review': ux.reachedReview,
      'sent_ms': 0, // baseline: the moment the POST fired
      'attempt': attempt,
      'turn_seq': seq,
      'lang': _lang,
      if (ux.firstByteMs != null) 'first_byte_ms': ux.firstByteMs!,
      if (ux.firstTextMs != null) 'first_text_ms': ux.firstTextMs!,
      if (ux.doneMs != null) 'done_ms': ux.doneMs!,
      if (ux.error != null) 'error': ux.error!,
    });
  }

  // ── Open ──────────────────────────────────────────────────────────────────

  Future<void> _open() async {
    setState(() {
      _opening = true;
      _fatal = null;
      _msgs.clear();
      _pending.clear();
      _chips = const [];
      _card = null;
      _rev = null;
      _turnSeq = 0;
      _progress = 0;
      _missing = const [];
    });

    Analytics.capture('listing_pipeline_opened', {
      'via': 'compose',
      'vertical': widget.vertical,
    });
    Analytics.capture('compose_started', {
      'vertical': widget.vertical,
      'lang': _lang,
    });

    final res = await MarketplaceApi.composeSession(
        vertical: widget.vertical, lang: _lang);
    if (!mounted) return;

    if (!res.ok) {
      Analytics.capture('compose_open_failed', {
        'status': res.status,
        'error': res.error ?? '',
      });
      setState(() {
        _opening = false;
        _fatal = res.message ?? 'Ava could not start a listing right now.';
      });
      return;
    }

    final s = res.session!;
    setState(() {
      _opening = false;
      _sessionId = s.sessionId;
      _identityOk = s.identityOk;
      _identityReason = s.identityReason;
      _msgs.add(_Msg(_Role.ava, s.greeting));
      // §3.2 — turn 0 chips ARE the taxonomy. Never a hard-coded list.
      _chips = [for (final c in s.categories) c.display];
    });

    // §3.1 — state, not a gate. The chat opens either way; only the WRITE is
    // gated, and Ava offers the fix here so it is done before it bites.
    if (!s.identityOk) {
      _add(const _Msg(
        _Role.identity,
        "Before this can go live I'll need to check there's a real person "
        "behind it — it's a 20-second face check, right here.",
      ));
      Analytics.capture('compose_identity_offered', {
        'session_id': s.sessionId,
        'reason': s.identityReason ?? '',
      });
    }

    // §3.3 — offer the unfinished draft rather than silently starting over.
    if (s.resume != null) {
      _add(_Msg(
        _Role.resume,
        'You were listing ${s.resume!.summary}. Carry on?',
        resume: s.resume,
      ));
      Analytics.capture('compose_resume_offered', {
        'session_id': s.sessionId,
        'resume_session_id': s.resume!.sessionId,
      });
    }
    _jumpToEnd();
  }

  // ── Resume ────────────────────────────────────────────────────────────────

  /// Switch this chat onto the earlier draft.
  ///
  /// ⚠️ The server's `resume` object carries only `{session_id, summary}` — no
  /// `turn_seq`. Every turn must send exactly `server.turn_seq + 1`, and the
  /// `stale_session` error reports no server-side sequence, so there is nothing
  /// to resync from: if the old draft is past turn 0, the first turn we send is
  /// refused and we can only offer a fresh start. [ComposeResume.turnSeq] is
  /// parsed defensively and used the moment the server begins sending it.
  void _carryOn(ComposeResume r) {
    setState(() {
      _sessionId = r.sessionId;
      _turnSeq = r.turnSeq ?? 0;
      _rev = r.rev;
      _chips = const [];
      _msgs.add(const _Msg(
        _Role.ava,
        "Good — picking that back up. Where were we? Tell me what's changed, "
        "or just carry on.",
      ));
    });
    Analytics.capture('compose_resumed', {
      'session_id': r.sessionId,
      'turn_seq_known': r.turnSeq != null,
    });
    _jumpToEnd();
  }

  void _declineResume() {
    setState(() => _msgs.removeWhere((m) => m.role == _Role.resume));
    Analytics.capture('compose_resume_declined', {'session_id': _sessionId ?? ''});
  }

  // ── Identity, inline (§3.1) ───────────────────────────────────────────────

  Future<void> _runIdentityFlow() async {
    Analytics.capture('compose_identity_started', {
      'session_id': _sessionId ?? '',
      'reason': _identityReason ?? '',
    });
    // consent (BIPA) → Didit → back here. This already fires
    // public_action_gate_shown/passed/abandoned; the compose_* events above and
    // below are the funnel-scoped companions, not duplicates.
    final passed = await ensurePublicActionAllowed(context, PublicAction.listing);
    if (!mounted) return;
    setState(() {
      _identityOk = passed;
      _msgs.removeWhere((m) => m.role == _Role.identity);
      _msgs.add(_Msg(
        _Role.ava,
        passed
            ? "That's you verified — nothing else to do. Carry on."
            : "No problem, we can keep going. I'll need it before this goes "
                "live, and I'll ask again then.",
      ));
    });
    _jumpToEnd();
  }

  Future<void> _openIdentityHelp() async {
    Analytics.capture('compose_identity_help_opened', {
      'session_id': _sessionId ?? '',
    });
    await Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => const IdentityScreen()),
    );
  }

  // ── Photos (§3.4) ─────────────────────────────────────────────────────────

  Future<void> _pickPhoto() async {
    if (_uploading || _busy) return;
    if (_pending.length >= _maxPending) {
      _add(const _Msg(_Role.notice,
          "That's enough photos for one go — send these first."));
      return;
    }
    final x = await ImagePicker()
        .pickImage(source: ImageSource.gallery, maxWidth: 1600, imageQuality: 85);
    if (x == null || !mounted) return;

    setState(() => _uploading = true);
    List<int>? bytes;
    try {
      bytes = await x.readAsBytes();
    } catch (_) {
      bytes = null;
    }
    if (!mounted) return;
    if (bytes == null) {
      setState(() {
        _uploading = false;
        _msgs.add(const _Msg(
            _Role.notice, "I couldn't read that photo off your phone — try another?"));
      });
      return;
    }

    final up = await MarketplaceApi.uploadListingPhoto(bytes);
    if (!mounted) return;
    setState(() {
      _uploading = false;
      if (up.ok) {
        _pending.add(_Photo(up.hash!, up.url));
      } else {
        // §3.4 — THE FIX. sell_listing_flow.dart:115 caught this and showed
        // nothing: the spinner stopped, no photo appeared, no reason given, and
        // the seller was left to guess. A failure that says nothing is worse
        // than the failure.
        _msgs.add(_Msg(_Role.notice, up.error ?? "That photo didn't upload."));
      }
    });
    Analytics.capture(
      up.ok ? 'compose_media_uploaded' : 'compose_media_upload_failed',
      {
        'session_id': _sessionId ?? '',
        'pending': _pending.length,
        if (!up.ok) 'error': up.error ?? '',
      },
    );
    _jumpToEnd();
  }

  // ── Turns (§3.3, §3.3c) ───────────────────────────────────────────────────

  Future<void> _send(String raw, {bool fromChip = false}) async {
    final sid = _sessionId;
    final text = raw.trim();
    if (sid == null || _busy || _fatal != null) return;
    final media = [for (final p in _pending) p.hash];
    if (text.isEmpty && media.isEmpty) return;

    final photoUrls = [
      for (final p in _pending)
        if (p.url != null) p.url!,
    ];
    final seq = _turnSeq + 1;
    // §3.3c — minted ONCE for this turn and reused on every retry below, so a
    // flaky connection replays the stored response instead of re-running the
    // model and re-applying its tools.
    final idem = MarketplaceApi.newIdemKey();

    if (fromChip) {
      Analytics.capture('compose_chip_tapped', {
        'session_id': sid,
        'chip': text,
        'category': _card?['category']?.toString() ?? '',
      });
    }

    _input.clear();
    setState(() {
      _msgs.add(_Msg(_Role.user, text, photoUrls: photoUrls));
      _pending.clear();
      _chips = const [];
      _busy = true;
      // Show Ava's bubble IMMEDIATELY (empty, with a cursor) so the reply feels
      // instant — the deltas stream into it. Replaces the old behaviour where
      // the bubble only appeared once the whole reply had arrived.
      _msgs.add(const _Msg(_Role.ava, '', streaming: true));
      _streamIdx = _msgs.length - 1;
    });
    _jumpToEnd();

    // Stopwatch starts as close to the POST as possible — its zero is `sent_ms`.
    final ux = _TurnUx(
      sessionId: sid,
      textLen: text.length,
      hadMedia: media.isNotEmpty,
      fromChip: fromChip,
    );
    await _runTurn(sid, seq, idem, text, media,
        attempt: 1, ux: ux, fromChip: fromChip);
  }

  Future<void> _runTurn(
    String sid,
    int seq,
    String idem,
    String text,
    List<String> media, {
    required int attempt,
    required _TurnUx ux,
    bool fromChip = false,
  }) async {
    Analytics.capture('compose_turn', {
      'session_id': sid,
      'turn_seq': seq,
      'attempt': attempt,
      'from_chip': fromChip,
      'has_media': media.isNotEmpty,
      'media_count': media.length,
      'lang': _lang,
      'identity_ok': _identityOk,
    });

    // On a RETRY the server replays the whole stored reply as fresh deltas
    // (same idem_key), so clear the live bubble first — otherwise the text
    // doubles up until the final `say` reconciles it.
    if (attempt > 1 && _streamIdx != null && _streamIdx! < _msgs.length) {
      setState(() =>
          _msgs[_streamIdx!] = const _Msg(_Role.ava, '', streaming: true));
    }

    var applied = false; // the server actually moved the draft on
    var failed = false;

    try {
      final stream = MarketplaceApi.composeTurn(
        sessionId: sid,
        turnSeq: seq,
        idemKey: idem,
        text: text.isEmpty ? null : text,
        media: media,
      );
      await for (final e in stream) {
        if (!mounted) return;
        // First frame of ANY kind — network + server TTFB, felt as "it woke up".
        ux.firstByteMs ??= ux.sw.elapsedMilliseconds;
        switch (e) {
          case ComposeSayDelta(text: final delta):
            // The user first SEES a reply here — the key "feels fast" metric.
            ux.firstTextMs ??= ux.sw.elapsedMilliseconds;
            ux.streamed = true;
            applied = true;
            if (delta.isNotEmpty) _appendDelta(delta);
            break;
          case ComposeSay(text: final say):
            ux.firstTextMs ??= ux.sw.elapsedMilliseconds;
            // Authoritative full text — reconcile the streamed bubble to it.
            _finalizeSay(say);
            applied = true;
            break;
          case ComposeDraftState(progress: final p, missing: final m):
            setState(() {
              _progress = p;
              _missing = m;
            });
            applied = true;
            break;
          case ComposeChips(chips: final c):
            ux.chipsShown = c.isNotEmpty;
            setState(() => _chips = c);
            break;
          case ComposeReview(card: final card):
            ux.reachedReview = true;
            setState(() {
              _card = card;
              _rev = (card['rev'] as num?)?.toInt();
              _msgs.add(_Msg(_Role.review, '', card: card));
            });
            applied = true;
            _jumpToEnd();
            break;
          case ComposeError(error: final code, message: final msg):
            failed = true;
            ux.error = code;
            _onTurnError(code, msg);
            break;
        }
      }
      // Stream drained cleanly ([DONE]) — the reply is fully in.
      ux.doneMs ??= ux.sw.elapsedMilliseconds;
    } catch (_) {
      // Transport failure. Retry ONCE with the SAME idem_key (§3.3c) — the
      // server either never saw the turn (it runs) or already ran it (it
      // replays the stored response). Both outcomes are correct; a new key
      // would make the second one wrong.
      if (attempt < 2 && mounted) {
        Analytics.capture('compose_turn_retried', {
          'session_id': sid,
          'turn_seq': seq,
          'idem_key_reused': true,
        });
        await Future<void>.delayed(const Duration(milliseconds: 700));
        if (!mounted) return;
        return _runTurn(sid, seq, idem, text, media,
            attempt: attempt + 1, ux: ux, fromChip: fromChip);
      }
      failed = true;
      ux.error ??= 'network';
      if (mounted) {
        setState(() => _msgs.add(const _Msg(
            _Role.notice, "I couldn't reach Ava just then. Try that again?")));
      }
    }

    if (!mounted) return;
    // Advance ONLY on a turn the server applied. A refused or lost turn leaves
    // the sequence where it was, so the next send is still `server + 1`.
    if (applied && !failed) _turnSeq = seq;
    setState(() {
      _busy = false;
      _finalizeStream();
    });
    _emitTurnUx(ux, seq, attempt);
    _jumpToEnd();
  }

  void _onTurnError(String code, String? message) {
    Analytics.capture('compose_turn_error', {
      'session_id': _sessionId ?? '',
      'error': code,
    });
    switch (code) {
      case 'flag_off':
        setState(() => _fatal = message ?? "Listing with Ava isn't switched on yet.");
        break;
      case 'stale_session':
      case 'not_found':
        // §3.3c — converge, never clobber. The server sends no draft with this,
        // so there is nothing to re-render onto; a fresh session is the only
        // honest offer.
        setState(() {
          _chips = const [];
          _msgs.add(_Msg(
              _Role.notice, message ?? 'That draft has moved on somewhere else.'));
          _msgs.add(const _Msg(_Role.restart, ''));
        });
        break;
      case 'model_unavailable':
      case 'internal':
        // The draft is untouched — the server holds it, so a failed turn costs
        // a turn, not the seller's work (§3.3).
        setState(() => _msgs.add(_Msg(_Role.ava,
            message ?? "I lost my train of thought there — say that again?")));
        break;
      default:
        setState(() => _msgs.add(
            _Msg(_Role.notice, message ?? 'Something went wrong — try again?')));
    }
    _jumpToEnd();
  }

  // ── Publish (§3.3) ────────────────────────────────────────────────────────

  Future<void> _publish() async {
    final sid = _sessionId;
    if (sid == null || _publishing || _busy) return;

    setState(() => _publishing = true);
    Analytics.capture('compose_publish_tapped', {
      'session_id': sid,
      'category': _card?['category']?.toString() ?? '',
    });
    Analytics.capture('listing_submitted', {
      'via': 'compose',
      'session_id': sid,
      'category': _card?['category']?.toString() ?? '',
      'turns': _turnSeq,
    });

    var res = await MarketplaceApi.composePublish(sessionId: sid, rev: _rev);
    if (!mounted) return;

    // 403 identity_required → run the gate INLINE and retry once (§3.1).
    // Matched via isIdentityRequired, NOT the dead 'phone_required' /
    // 'liveness_required' strings (P3): phone verification was removed app-wide
    // on 2026-07-10 and the server has said `identity_required` ever since —
    // matching the old strings is why the friendly path never fired in the form.
    if (isIdentityRequired(_statusOf(res), jsonEncode(res))) {
      Analytics.capture('compose_publish_gated', {'session_id': sid});
      final passed = await ensurePublicActionAllowed(context, PublicAction.listing);
      if (!mounted) return;
      if (!passed) {
        setState(() {
          _publishing = false;
          _identityOk = false;
          _msgs.add(const _Msg(
            _Role.identity,
            "I can't put this live until I've checked there's a real person "
            "behind it. Nothing's lost — your listing is saved.",
          ));
        });
        _jumpToEnd();
        return;
      }
      setState(() => _identityOk = true);
      res = await MarketplaceApi.composePublish(sessionId: sid, rev: _rev);
      if (!mounted) return;
    }

    setState(() => _publishing = false);

    if (res['ok'] == true) {
      final id = res['listing_id']?.toString() ?? '';
      _published = true;
      Analytics.capture('listing_published', {
        'via': 'compose',
        'listing_id': id,
        'session_id': sid,
        'turns': _turnSeq,
        'lang': _lang,
        'vertical': widget.vertical,
        'compose_ms': DateTime.now().difference(_openedAt).inMilliseconds,
      });
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Your listing is live.')));
      Navigator.of(context).maybePop(id);
      return;
    }
    _onPublishFailure(_statusOf(res), res);
  }

  int _statusOf(Map<String, dynamic> res) => (res['status'] as num?)?.toInt() ?? 0;

  void _onPublishFailure(int status, Map<String, dynamic> res) {
    final err = res['error']?.toString();
    final msg = res['message']?.toString();

    if (err == 'moderation_unavailable') {
      // §7.1 — moderation fails CLOSED here, deliberately. Nothing is lost: the
      // draft is the server's and it is untouched. Say exactly that, because a
      // seller who thinks their work vanished does not come back.
      Analytics.capture('compose_publish_deferred', {
        'session_id': _sessionId ?? '',
        'reason': 'moderation_unavailable',
      });
      _add(_Msg(
          _Role.ava,
          msg ??
              "I can't run the safety check right now, so I won't publish yet. "
                  "Try again in a minute — your listing is safe."));
      return;
    }

    if (err == 'flag_off') {
      setState(() => _fatal = msg ?? "Listing with Ava isn't switched on yet.");
      return;
    }

    if (status == 409) {
      final lid = res['listing_id']?.toString();
      Analytics.capture('compose_publish_stale', {
        'session_id': _sessionId ?? '',
        'already_published': lid != null && lid.isNotEmpty,
      });
      if (lid != null && lid.isNotEmpty) {
        // Atomic publish did its job — a double tap published exactly once.
        _published = true;
        _add(const _Msg(_Role.ava, "That's already live — you're done."));
        return;
      }
      // §3.3c — the rev moved under us. Adopt the SERVER's rev rather than
      // re-asserting ours: converge, don't clobber.
      final srev = (res['rev'] as num?)?.toInt();
      setState(() {
        if (srev != null) _rev = srev;
        _msgs.add(const _Msg(
            _Role.notice,
            'This draft moved on somewhere else. Tap publish again to use the '
            'latest version.'));
      });
      _jumpToEnd();
      return;
    }

    if (status == 422) {
      final field = res['field']?.toString() ?? '';
      Analytics.capture('listing_rejected', {
        'via': 'compose',
        'session_id': _sessionId ?? '',
        'field': field,
        'reason': res['reason']?.toString() ?? '',
      });
      _add(_Msg(_Role.ava, msg ?? 'That still needs a $field before it can go live.'));
      return;
    }

    Analytics.capture('compose_publish_failed', {
      'session_id': _sessionId ?? '',
      'status': status,
      'error': err ?? '',
    });
    _add(_Msg(_Role.notice, msg ?? err ?? 'I could not publish that — try again?'));
  }

  // ── UI ────────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: AppBar(
        backgroundColor: AD.headerFooter,
        surfaceTintColor: Colors.transparent,
        foregroundColor: AD.textPrimary,
        elevation: 0,
        shape: const Border(bottom: BorderSide(color: AD.borderHairline, width: 1)),
        title: Row(children: [
          _sparkleBadge(30),
          const SizedBox(width: 10),
          Text('List with Ava', style: ADText.appTitle()),
        ]),
        bottom: _progress > 0
            ? PreferredSize(
                preferredSize: const Size.fromHeight(2),
                child: LinearProgressIndicator(
                  value: _progress.clamp(0, 1),
                  minHeight: 2,
                  backgroundColor: AD.borderHairline,
                  valueColor: const AlwaysStoppedAnimation<Color>(_avaGreen),
                ),
              )
            : null,
      ),
      body: SafeArea(
        top: false,
        child: _fatal != null
            ? _fatalState(_fatal!)
            : _opening
                ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
                : Column(children: [
                    Expanded(
                      child: ListView.builder(
                        controller: _scroll,
                        padding: const EdgeInsets.fromLTRB(16, 16, 16, 12),
                        // The live Ava bubble now carries the "thinking" state
                        // itself, so the standalone typing row only shows in the
                        // gap before that bubble exists.
                        itemCount:
                            _msgs.length + ((_busy && _streamIdx == null) ? 1 : 0),
                        itemBuilder: (_, i) =>
                            i >= _msgs.length ? _typing() : _row(_msgs[i]),
                      ),
                    ),
                    if (_chips.isNotEmpty && !_busy) _chipBar(),
                    if (_pending.isNotEmpty || _uploading) _pendingStrip(),
                    _composer(),
                  ]),
      ),
    );
  }

  Widget _fatalState(String message) => Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 36),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            _sparkleBadge(54),
            const SizedBox(height: 14),
            Text(message,
                textAlign: TextAlign.center,
                style: ADText.preview(c: AD.textSecondary)),
            const SizedBox(height: 16),
            _pill('Try again', _avaGreen, const Color(0xFF10361C), _open),
          ]),
        ),
      );

  Widget _sparkleBadge(double size) => Container(
        width: size,
        height: size,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: _avaGreen,
          borderRadius: BorderRadius.circular(size * 0.28),
        ),
        child: PhosphorIcon(PhosphorIcons.sparkle(PhosphorIconsStyle.fill),
            size: size * 0.55, color: const Color(0xFF10361C)),
      );

  Widget _row(_Msg m) => switch (m.role) {
        _Role.user || _Role.ava => _bubble(m),
        _Role.notice => _notice(m.text),
        _Role.identity => _identityCard(m.text),
        _Role.resume => _resumeCard(m),
        _Role.review => _reviewCard(m.card ?? const {}),
        _Role.restart => _restartCard(),
      };

  Widget _bubble(_Msg m) {
    final mine = m.role == _Role.user;
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 5),
        constraints:
            BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.82),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: mine ? AD.bubbleOutBg : AD.card,
          borderRadius: mine ? AD.bubbleOutRadius : AD.bubbleInRadius,
          border: mine ? null : Border.all(color: AD.borderControl, width: 1),
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          if (m.photoUrls.isNotEmpty) ...[
            Wrap(spacing: 6, runSpacing: 6, children: [
              for (final u in m.photoUrls)
                CachedImage(u,
                    width: 78,
                    height: 78,
                    radius: BorderRadius.circular(8),
                    cachePx: 200),
            ]),
            if (m.text.isNotEmpty) const SizedBox(height: 8),
          ],
          // A streaming Ava bubble that has no text yet shows the "thinking"
          // placeholder; once deltas arrive it types out with a trailing cursor
          // until the final `say` reconciles it and drops the streaming flag.
          if (m.text.isEmpty && m.streaming)
            Text('Ava is thinking…', style: ADText.preview(c: AD.textSecondary))
          else if (m.text.isNotEmpty)
            Text(m.streaming ? '${m.text}▌' : m.text,
                style: ADText.bubbleBody(
                    c: mine ? AD.bubbleOutInk : AD.textPrimary)),
        ]),
      ),
    );
  }

  Widget _typing() => Align(
        alignment: Alignment.centerLeft,
        child: Container(
          margin: const EdgeInsets.symmetric(vertical: 5),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          decoration: BoxDecoration(
            color: AD.card,
            borderRadius: AD.bubbleInRadius,
            border: Border.all(color: AD.borderControl, width: 1),
          ),
          child: Text('Ava is thinking…', style: ADText.preview(c: AD.textSecondary)),
        ),
      );

  Widget _notice(String text) => Container(
        margin: const EdgeInsets.symmetric(vertical: 6),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
        decoration: BoxDecoration(
          color: AD.card,
          borderRadius: BorderRadius.circular(AD.rListCard),
          border: Border.all(color: AD.danger, width: 1),
        ),
        child: Row(children: [
          PhosphorIcon(PhosphorIcons.warningCircle(PhosphorIconsStyle.bold),
              size: 16, color: AD.danger),
          const SizedBox(width: 8),
          Expanded(child: Text(text, style: ADText.preview(c: AD.textSecondary))),
        ]),
      );

  /// §3.1 — the gate, done conversationally. The button runs the flow INLINE
  /// and returns here; the link out is the fallback, deliberately secondary.
  Widget _identityCard(String text) => _panel(
        border: _avaGreen,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(text, style: ADText.bubbleBody()),
          const SizedBox(height: 12),
          Row(children: [
            _pill('Verify now', _avaGreen, const Color(0xFF10361C), _runIdentityFlow),
            const SizedBox(width: 10),
            GestureDetector(
              onTap: _openIdentityHelp,
              child: Text('How do I do this?',
                  style: ADText.preview(c: AD.iconSearch)),
            ),
          ]),
        ]),
      );

  Widget _resumeCard(_Msg m) {
    final r = m.resume;
    return _panel(
      border: AD.borderControl,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(m.text, style: ADText.bubbleBody()),
        const SizedBox(height: 12),
        Row(children: [
          if (r != null)
            _pill('Carry on', _avaGreen, const Color(0xFF10361C), () => _carryOn(r)),
          const SizedBox(width: 10),
          GestureDetector(
            onTap: _declineResume,
            child: Text('Start fresh', style: ADText.preview(c: AD.textSecondary)),
          ),
        ]),
      ]),
    );
  }

  Widget _restartCard() => _panel(
        border: AD.borderControl,
        child: Row(children: [
          Expanded(
              child: Text('Start a new listing?',
                  style: ADText.preview(c: AD.textSecondary))),
          _pill('New listing', _avaGreen, const Color(0xFF10361C), _open),
        ]),
      );

  /// §3.3 — the model OFFERED; the seller decides. This button is the only
  /// route to a live listing.
  Widget _reviewCard(Map<String, dynamic> card) {
    final title = card['title']?.toString() ?? '';
    final price = card['price'];
    final currency = card['currency']?.toString() ?? '';
    final location = card['location']?.toString() ?? '';
    final photos = (card['photo_count'] as num?)?.toInt() ?? 0;
    final cover = card['cover_media']?.toString();
    final tags = [for (final t in (card['tags'] as List? ?? const [])) t.toString()];
    final mandate = card['mandate'];
    final floor = mandate is Map ? mandate['floor_price'] : null;
    // The seller's kept-back note is shown as a FACT, never as content: it is
    // their secret and this card is screenshot bait (§3.6b).
    final hasPrivate = mandate is Map && mandate['has_private_note'] == true;

    return _panel(
      border: _avaGreen,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          PhosphorIcon(PhosphorIcons.checkCircle(PhosphorIconsStyle.fill),
              size: 16, color: _avaGreen),
          const SizedBox(width: 6),
          Text('Ready to publish', style: ADText.rowName()),
        ]),
        const SizedBox(height: 10),
        if (cover != null && cover.isNotEmpty) ...[
          CachedImage(cover,
              width: double.infinity,
              height: 140,
              radius: BorderRadius.circular(10),
              cachePx: 700),
          const SizedBox(height: 10),
        ],
        if (title.isNotEmpty)
          Text(title, style: ADText.threadName().copyWith(fontSize: 16)),
        if (price != null)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text('$currency $price'.trim(),
                style: ADText.rowName(c: _avaGreen)),
          ),
        if (location.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Text(location, style: ADText.preview(c: AD.textSecondary)),
          ),
        const SizedBox(height: 8),
        Wrap(spacing: 6, runSpacing: 6, children: [
          if (photos > 0) _fact('$photos photo${photos == 1 ? '' : 's'}'),
          if (card['video'] != null) _fact('Video'),
          for (final t in tags.take(4)) _fact(t),
          if (floor != null) _fact('Floor $currency $floor'),
          if (hasPrivate) _fact('1 note kept back'),
        ]),
        if (_missing.isNotEmpty) ...[
          const SizedBox(height: 10),
          Text('Still needed: ${_missing.join(', ')}',
              style: ADText.preview(c: AD.danger)),
        ],
        const SizedBox(height: 12),
        _pill(
          _publishing ? 'Publishing…' : 'Publish it',
          _publishing ? AD.card : _avaGreen,
          _publishing ? AD.textTertiary : const Color(0xFF10361C),
          _publishing ? null : _publish,
        ),
      ]),
    );
  }

  Widget _fact(String text) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
        decoration: BoxDecoration(
          color: AD.bg,
          borderRadius: BorderRadius.circular(100),
          border: Border.all(color: AD.borderControl, width: 1),
        ),
        child: Text(text, style: ADText.statCaption(c: AD.textSecondary)),
      );

  Widget _panel({required Color border, required Widget child}) => Container(
        margin: const EdgeInsets.symmetric(vertical: 7),
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: AD.card,
          borderRadius: BorderRadius.circular(AD.rListCard),
          border: Border.all(color: border, width: 1),
        ),
        child: child,
      );

  Widget _pill(String label, Color bg, Color fg, VoidCallback? onTap) =>
      GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 9),
          decoration: BoxDecoration(
            color: bg,
            borderRadius: BorderRadius.circular(100),
          ),
          child: Text(label,
              style: TextStyle(
                  fontFamily: ADText.family,
                  fontWeight: FontWeight.w800,
                  fontSize: 13.5,
                  color: fg)),
        ),
      );

  /// Chips are the model's suggested replies, and turn 0's category list. Both
  /// are just text the seller could have typed — tapping sends it as a turn.
  Widget _chipBar() => Container(
        width: double.infinity,
        padding: const EdgeInsets.fromLTRB(14, 4, 14, 8),
        child: Wrap(spacing: 8, runSpacing: 8, children: [
          for (final c in _chips)
            GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: () => _send(c, fromChip: true),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 8),
                decoration: BoxDecoration(
                  color: AD.card,
                  borderRadius: BorderRadius.circular(100),
                  border: Border.all(color: AD.borderControl, width: 1),
                ),
                child: Text(c, style: ADText.statCaption(c: AD.textPrimary)),
              ),
            ),
        ]),
      );

  /// §3.4 — thumbnails appear as they land; the hashes ride the next turn.
  Widget _pendingStrip() => Container(
        height: 66,
        width: double.infinity,
        padding: const EdgeInsets.fromLTRB(14, 0, 14, 8),
        child: ListView(scrollDirection: Axis.horizontal, children: [
          for (var i = 0; i < _pending.length; i++)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: Stack(children: [
                _pending[i].url != null
                    ? CachedImage(_pending[i].url!,
                        width: 58,
                        height: 58,
                        radius: BorderRadius.circular(8),
                        cachePx: 150)
                    : Container(
                        width: 58,
                        height: 58,
                        decoration: BoxDecoration(
                          color: AD.card,
                          borderRadius: BorderRadius.circular(8),
                          border: Border.all(color: AD.borderControl, width: 1),
                        ),
                        child: PhosphorIcon(
                            PhosphorIcons.image(PhosphorIconsStyle.bold),
                            size: 16,
                            color: AD.textTertiary),
                      ),
                // Inside the 58×58 box, not hanging off it: a Stack clips to
                // its non-positioned child, so a negative offset would slice
                // the tap target in half.
                Positioned(
                  top: 0,
                  right: 0,
                  child: GestureDetector(
                    behavior: HitTestBehavior.opaque,
                    onTap: () => setState(() => _pending.removeAt(i)),
                    child: Padding(
                      padding: const EdgeInsets.all(3),
                      child: PhosphorIcon(
                          PhosphorIcons.xCircle(PhosphorIconsStyle.fill),
                          size: 17,
                          color: AD.textPrimary),
                    ),
                  ),
                ),
              ]),
            ),
          if (_uploading)
            Container(
              width: 58,
              height: 58,
              decoration: BoxDecoration(
                color: AD.card,
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: AD.borderControl, width: 1),
              ),
              child: const Center(
                  child: SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2))),
            ),
        ]),
      );

  Widget _composer() {
    final canSend = !_busy && (_pending.isNotEmpty || _input.text.trim().isNotEmpty);
    return Container(
      decoration: const BoxDecoration(
        border: Border(top: BorderSide(color: AD.borderHairline, width: 1)),
        color: AD.headerFooter,
      ),
      padding: const EdgeInsets.fromLTRB(14, 10, 14, 12),
      child: Row(children: [
        GestureDetector(
          onTap: _uploading || _busy ? null : _pickPhoto,
          child: Container(
            width: 42,
            height: 46,
            alignment: Alignment.center,
            child: PhosphorIcon(PhosphorIcons.image(PhosphorIconsStyle.bold),
                size: 22,
                color: _uploading || _busy ? AD.textTertiary : AD.textSecondary),
          ),
        ),
        Expanded(
          child: Container(
            decoration: BoxDecoration(
              color: AD.inputField,
              borderRadius: BorderRadius.circular(AD.rInput),
              border: Border.all(color: AD.borderControl, width: 1),
            ),
            padding: const EdgeInsets.symmetric(horizontal: 14),
            child: TextField(
              controller: _input,
              minLines: 1,
              maxLines: 4,
              enabled: !_busy,
              textInputAction: TextInputAction.send,
              onChanged: (_) => setState(() {}),
              onSubmitted: (v) => _send(v),
              cursorColor: AD.iconSearch,
              style: const TextStyle(
                  fontFamily: ADText.family,
                  fontWeight: FontWeight.w600,
                  fontSize: 15,
                  color: AD.textOnInput),
              decoration: const InputDecoration(
                border: InputBorder.none,
                hintText: 'Tell Ava about it…',
                hintStyle: TextStyle(
                    fontFamily: ADText.family,
                    fontWeight: FontWeight.w600,
                    fontSize: 15,
                    color: AD.placeholderOnWhite),
                isDense: true,
                contentPadding: EdgeInsets.symmetric(vertical: 12),
              ),
            ),
          ),
        ),
        const SizedBox(width: 10),
        GestureDetector(
          onTap: canSend ? () => _send(_input.text) : null,
          child: Container(
            width: 46,
            height: 46,
            decoration: BoxDecoration(
              color: canSend ? _avaGreen : AD.card,
              borderRadius: BorderRadius.circular(AD.rInput),
            ),
            child: PhosphorIcon(
                PhosphorIcons.paperPlaneRight(PhosphorIconsStyle.fill),
                color: canSend ? const Color(0xFF10361C) : AD.textTertiary,
                size: 20),
          ),
        ),
      ]),
    );
  }
}
