// [CALL-HONEST-FAIL-1] THE one place that turns a terminal call reason into a
// sentence a human can read.
//
// WHY THIS EXISTS. On 2026-08-07 a real user made ten call attempts and had one
// conversation. Every failure looked identical to him: some beeps, then nothing.
// He sat through 38 s, then 90 s, then 49 s with no idea what was happening, and
// described the app as making calls that "just cut off".
//
// The system knew why, every single time. `call_ended.reason` in prod carries
// twenty-one distinct terminal values — `decline-explicit-ws`, `timeout-ringing`,
// `connect-timeout-fast`, `place-call-failed`, `relay_migration_timeout`,
// `owner-accepted-other-call`, `glare-superseded` … — and not one of them was
// ever rendered to the person who was waiting. This file is that knowledge,
// written out in English.
//
// THREE RULES, in priority order:
//
//  1. NEVER INVENT A REASON. A wrong explanation is worse than none. Anything
//     not in [_kExplained] returns null and the UI says nothing. See the
//     "deliberately silent" list below — it is as important as the table.
//  2. A NORMAL ENDING IS NOT A FAILURE. `local-hangup`, `accept`, `remote-bye`
//     and the `menu-*` reasons are what a call that WORKED looks like. Printing
//     "the call failed" after a good conversation is worse than printing nothing,
//     so those are silent by construction, not by omission.
//  3. ONE PLACE. Both call surfaces (the live call screen and the two call-log
//     lists) resolve their copy here. Do not write a call-outcome string into a
//     widget; add a key to the table instead.
//
// The keys are stable — they ship as `message_key` on the `call_failure_shown`
// event, which is how we verify users are actually being told.

import '../analytics.dart';
import '../call_log_store.dart' show CallEntry, CallOutcome;

/// A resolved explanation: a stable [key] for telemetry and the [text] a person
/// reads. Never constructed for a normal ending.
class CallFailureMessage {
  /// Stable identifier, e.g. `declined`, `no_answer`, `connection_dropped`.
  final String key;

  /// The sentence. Already personalised with the callee's first name when one
  /// was available.
  final String text;

  const CallFailureMessage(this.key, this.text);

  @override
  String toString() => 'CallFailureMessage($key)';
}

/// First name for the copy, or '' when we genuinely don't have one. Mirrors
/// `CallSession._peerFirst` ("Amy" from "Amy Williams") but returns EMPTY rather
/// than the pronoun 'them', because each sentence below needs a different
/// nameless rewrite ("They declined the call.", not "them declined the call.").
String callPeerFirstName(String name) {
  final t = name.trim();
  if (t.isEmpty) return '';
  final first = t.split(RegExp(r'\s+')).first;
  // A bare uid / `tel:+14042694747` is not a name — printing it reads like a
  // bug, so treat it as nameless and use the neutral phrasing.
  if (first.startsWith('tel:') || first.startsWith('user_')) return '';
  return first;
}

// ─────────────────────────────────────────────────────────────────────────────
//  DELIBERATELY SILENT
//
//  Every one of these is either a normal ending or a reason whose true meaning
//  the user already knows because they caused it. Listed EXPLICITLY (rather than
//  falling through the default) so that a future reader can see the decision was
//  made, and so the ship-readiness reviewer can audit it.
// ─────────────────────────────────────────────────────────────────────────────

/// Terminal reasons that must NEVER produce a message.
const Set<String> kCallSilentReasons = <String>{
  // — the call worked —
  'local-hangup', // the user pressed the red button
  'hangup',
  'ended',
  'accept',
  'remote-bye', // the other side pressed the red button
  'peer-left',
  'receptionist-done', // Ava finished and hung up normally

  // — the user's own action —
  'decline', // I declined an INCOMING call
  'menu-dismissed',
  'menu-call-again',
  'menu-timeout',
  'note-sent',
  'call-again',
  'back-nav',
  'outcome-close',
  'no-answer-close',
  'paid-busy-close',
  'busy-card-cancel',
  'busy-card-leave-video',
  'busy-card-timeout',
  'identity-gate', // the verification sheet is already on screen saying why

  // — already explained by a dedicated, deliberately-vague surface —
  // [CALL-ADMISSION-1] `unavailable` is a UNIFORM pre-ring denial: blocked,
  // offline, privacy mode and rate-limited all arrive identically, on purpose,
  // so the timing can't be used as a blocked-status oracle. It has its own
  // full-screen card ("This person can't take calls right now."). Adding a
  // second, more specific sentence here would be the leak that design avoids.
  'unavailable',
  'recipient_unavailable',

  // — housekeeping the user never asked about and cannot act on —
  'glare-yield', // we deterministically lost a mutual dial; the winner is open
  'remote-ended-push',
  'remote-cancelled-preaccept', // caller gave up before I answered → a MISSED
  // call, which the log already labels. On the callee's ring screen there is
  // nothing to explain: they didn't try to do anything.
  'recept-reattach-noop',
  'drain-on-subscribe',
  'sfu-reconnect', // transient, the ladder is still climbing
};

/// The table. Keys are terminal `reason` strings exactly as they are passed to
/// `CallSession._endWith(..., reason:)` / `hangup(reason)` and as they land in
/// `call_ended.reason` in PostHog.
///
/// The value builds the sentence from the callee's first name; `n` is EMPTY when
/// we have no name, and every entry must read correctly either way.
final Map<String, _Entry> _kExplained = <String, _Entry>{
  // ── the callee made a decision ──────────────────────────────────────────
  'decline-explicit': _Entry('declined', _declined),
  'decline-explicit-ws': _Entry('declined', _declined),
  'declined': _Entry('declined', _declined),

  // ── the callee never made one ───────────────────────────────────────────
  'timeout-ringing': _Entry('no_answer', _noAnswer),
  'no-answer': _Entry('no_answer', _noAnswer),
  'ring-timeout': _Entry('no_answer', _noAnswer),

  // ── the callee was already occupied ─────────────────────────────────────
  'busy': _Entry('peer_busy', _peerBusy),
  'busy-receptionist-unavailable': _Entry('peer_busy', _peerBusy),

  // ── setup never completed ───────────────────────────────────────────────
  'connect-timeout': _Entry('connect_timeout', _connectTimeout),
  'connect-timeout-fast': _Entry('connect_timeout', _connectTimeout),

  // ── the dial itself never left this phone ───────────────────────────────
  'place-call-failed': _Entry('place_failed', _placeFailed),
  'place-call-timeout': _Entry('place_failed', _placeFailed),
  'network-error': _Entry('place_failed', _placeFailed),

  // ── a live connection died ──────────────────────────────────────────────
  'relay_migration_timeout': _Entry('connection_dropped', _dropped),
  'socket-lost': _Entry('connection_dropped', _dropped),
  'rtc-failed': _Entry('connection_dropped', _dropped),
  'rtc-disconnected': _Entry('connection_dropped', _dropped),
  'reconnect_failed': _Entry('connection_dropped', _dropped),
  'sfu-reconnect-failed': _Entry('connection_dropped', _dropped),
  'media-stalled': _Entry('connection_dropped', _dropped),
  'server-unavailable': _Entry('connection_dropped', _dropped),

  // ── both sides dialled at once ──────────────────────────────────────────
  'glare-superseded': _Entry('glare', _glare),

  // ── THIS device answered a different call ───────────────────────────────
  //
  // NOTE ON DIRECTION, because it is easy to get backwards and the brief for
  // this issue had it the wrong way round: `owner-accepted-other-call` is
  // emitted by `CallSessionManager.prepareForAccept` on the device whose OWNER
  // just accepted another call. It says nothing whatsoever about the callee.
  // "They're on another call" would be a fabrication — exactly the failure mode
  // rule 1 exists to prevent.
  'owner-accepted-other-call': _Entry('answered_elsewhere', _answeredElsewhere),

  // ── this phone can't do it ──────────────────────────────────────────────
  'media-denied': _Entry('media_denied', _mediaDenied),

  // ── Ava never came on the line ──────────────────────────────────────────
  // [AVA-VM-FALLBACK-1] When the degrade-to-recorder fallback stored something,
  // this is overridden by `voicemailStored` in [callFailureMessage] below and
  // becomes the much better "Left a message for Arti."
  'ava-live-timeout': _Entry('ava_unavailable', _avaUnavailable),
  'receptionist-unavailable': _Entry('ava_unavailable', _avaUnavailable),
  'receptionist_failed': _Entry('ava_unavailable', _avaUnavailable),
};

/// Server pre-ring routing reasons (`routed:'receptionist'` + `routing_reason`
/// on the POST /api/call response, [CALL-PRESENCE-1]). These fire BEFORE any
/// ring, so they are the only honest thing to say about a call that never rang.
final Map<String, _Entry> _kRoutingReasons = <String, _Entry>{
  'offline': _Entry('routed_offline', _routedOffline),
  'unknown_caller': _Entry('routed_unknown_caller', _routedUnknownCaller),
};

/// Outcome-menu scenarios (`CallSession.menuScenario`). Coarser than a reason,
/// but it is what the menu surface has, and it is never a guess — the session
/// only ever sets these four from a terminal decision it actually observed.
final Map<String, _Entry> _kMenuScenarios = <String, _Entry>{
  'declined': _Entry('declined', _declined),
  'no-answer': _Entry('no_answer', _noAnswer),
  'busy': _Entry('peer_busy', _peerBusy),
  'unreachable': _Entry('unreachable', _unreachable),
  // 'voicemail' is deliberately absent: it means the flow moved ON to Ava, not
  // that anything failed.
};

/// Coarse [CallOutcome] tokens, for the call-log rows — the only thing a history
/// row actually knows. `connected`, `cancelled` and `missed` are absent on
/// purpose: a finished conversation, a call the user themselves abandoned, and a
/// missed incoming call are all normal, and the row's own label already says so.
final Map<String, _Entry> _kOutcomes = <String, _Entry>{
  CallOutcome.declined: _Entry('declined', _declined),
  CallOutcome.noAnswer: _Entry('no_answer', _noAnswer),
  CallOutcome.busy: _Entry('peer_busy', _peerBusy),
  CallOutcome.failed: _Entry('failed_generic', _failedGeneric),
};

// ── the sentences ───────────────────────────────────────────────────────────
//
// `n` is the callee's first name, or '' when unknown. Every builder must read
// naturally in both cases — an "Arti" that silently becomes an empty string is
// how you ship "  declined the call."

String _declined(String n) =>
    n.isEmpty ? 'They declined the call.' : '$n declined the call.';

String _noAnswer(String n) => n.isEmpty ? 'No answer.' : "$n didn't answer.";

String _peerBusy(String n) =>
    n.isEmpty ? "They're on another call." : '$n is on another call.';

String _connectTimeout(String n) =>
    n.isEmpty ? "Couldn't connect." : "Couldn't connect to $n.";

String _placeFailed(String n) => "Couldn't start the call. Check your connection.";

String _dropped(String n) => 'The connection dropped.';

String _glare(String n) => n.isEmpty
    ? 'They were calling you at the same time.'
    : '$n was calling you at the same time.';

String _answeredElsewhere(String n) => 'You answered another call.';

String _mediaDenied(String n) =>
    'AvaTOK needs microphone access to make a call.';

String _avaUnavailable(String n) =>
    n.isEmpty ? "Couldn't reach them." : "Couldn't reach $n.";

String _voicemailLeft(String n) =>
    n.isEmpty ? 'Message left.' : 'Left a message for $n.';

/// The heartbeat lapsed AND there is no wakeable device — the server answered
/// with Ava rather than ring into twenty seconds of silence.
///
/// Wording note: the brief asked for "Arti's phone is switched off." The server
/// cannot distinguish a powered-off phone from one with no data and no push
/// token, so the copy covers both. Stating "switched off" as fact would be an
/// invented reason (rule 1) roughly half the time.
String _routedOffline(String n) => n.isEmpty
    ? 'Their phone is switched off or offline.'
    : "$n's phone is switched off or offline.";

String _routedUnknownCaller(String n) => n.isEmpty
    ? 'Ava took the call — you are not in their contacts.'
    : "Ava took the call — you're not in $n's contacts.";

/// The ring went out and nothing on the far end ever acknowledged it.
String _unreachable(String n) => n.isEmpty
    ? "Their phone didn't respond — it may be off or offline."
    : "$n's phone didn't respond — it may be off or offline.";

String _failedGeneric(String n) => "The call didn't connect.";

class _Entry {
  final String key;
  final String Function(String firstName) build;
  const _Entry(this.key, this.build);
  CallFailureMessage call(String first) => CallFailureMessage(key, build(first));
}

// ─────────────────────────────────────────────────────────────────────────────
//  RESOLUTION
// ─────────────────────────────────────────────────────────────────────────────

/// Resolve the honest sentence for a call that has ended, or null to say nothing.
///
/// Inputs are ordered most-specific first and every one of them is optional, so
/// a caller passes whatever it happens to know:
///
///  * [reason]        — the terminal `reason` (`CallSession._endWith`). Best.
///  * [menuScenario]  — `CallSession.menuScenario` on the outcome-menu surface.
///  * [phase]         — the terminal ui phase, weakest, used only as a fallback.
///  * [routingReason] — the server's pre-ring `routing_reason`, when the call
///                      was answered by Ava before it ever rang.
///  * [voicemailStored] — [AVA-VM-FALLBACK-1] a recording actually landed, which
///                      upgrades an Ava timeout from a failure to a success.
///
/// Returns null for every normal ending and for anything unrecognised.
CallFailureMessage? callFailureMessage({
  String reason = '',
  String menuScenario = '',
  String phase = '',
  String routingReason = '',
  bool voicemailStored = false,
  String peerName = '',
}) {
  final n = callPeerFirstName(peerName);

  // [AVA-VM-FALLBACK-1] A stored recording beats every failure sentence below —
  // the caller did get their message across, which is what they wanted.
  if (voicemailStored) return CallFailureMessage('ava_voicemail_left', _voicemailLeft(n));

  final r = reason.trim();
  if (r.isNotEmpty) {
    if (kCallSilentReasons.contains(r)) return null;
    final hit = _kExplained[r];
    if (hit != null) return hit(n);
    // An unknown reason is NOT an error to report at the user; it is a reason
    // nobody has written copy for yet. Fall through to the coarser signals
    // rather than guessing, and keep falling through to null.
  }

  final m = menuScenario.trim();
  if (m.isNotEmpty) {
    final hit = _kMenuScenarios[m];
    if (hit != null) return hit(n);
  }

  final rr = routingReason.trim();
  if (rr.isNotEmpty) {
    final hit = _kRoutingReasons[rr];
    if (hit != null) return hit(n);
  }

  final p = phase.trim();
  if (p.isNotEmpty) {
    if (kCallSilentReasons.contains(p)) return null;
    final hit = _kExplained[p];
    if (hit != null) return hit(n);
  }

  return null;
}

/// The call-log row's sentence — resolved from the coarse [CallOutcome] token,
/// which is all a history row stores. Null for connected / cancelled / missed
/// and for legacy rows written before outcomes existed.
///
/// [nameOverride] lets a list that resolves a better display name than the one
/// frozen into the row at call time (AvaDialer looks the peer up in the contact
/// book) personalise the sentence with the name the user is actually looking at.
CallFailureMessage? callLogFailureMessage(CallEntry e, {String nameOverride = ''}) {
  if (e.connected) return null;
  final hit = _kOutcomes[e.outcome];
  if (hit == null) return null;
  return hit(callPeerFirstName(nameOverride.isNotEmpty ? nameOverride : e.name));
}

// ─────────────────────────────────────────────────────────────────────────────
//  TELEMETRY
// ─────────────────────────────────────────────────────────────────────────────

/// Emits `call_failure_shown` — the proof that a user was actually TOLD.
///
/// Success value to assert (ship-gate rule 3): `call_failure_shown` present with
/// `message_key` NOT empty, on the same `call_id` as a `call_ended` whose reason
/// is one of the explained set. An absent event on a failed call means the user
/// sat through another silent one.
///
/// `Analytics.capture` stamps the user's email (and the trace id) for us, which
/// is what makes a per-tester pull possible later.
class CallFailureTelemetry {
  CallFailureTelemetry._();

  /// De-dup keys already emitted this app run. A call log can hold 100 rows and
  /// is scrolled repeatedly; one event per (surface, id) is enough to answer
  /// "are users being told", and the cap stops a pathological scroll session
  /// from turning into thousands of events.
  static final Set<String> _seen = <String>{};
  static const int _kCap = 300;

  static void shown({
    required String surface, // 'call_screen' | 'log_row'
    required CallFailureMessage message,
    String callId = '',
    String entryId = '',
    String reason = '',
    String peerUid = '',
    // [CALL-FAILURE-SHOWN-HISTORICAL-1] Epoch SECONDS the underlying call
    // started (CallEntry.ts). Log rows re-emit on every app run, so a
    // `no_answer` from last week reappears in telemetry looking exactly like a
    // live failure — on 2026-08-16 that cost an audit a detour into "failed
    // calls" that were one old missed call being re-shown. `entry_age_ms` +
    // `historical` make the replay self-evident without changing what is
    // emitted or when.
    int entryTs = 0,
  }) {
    final dedup = '$surface:${callId.isNotEmpty ? callId : entryId}:${message.key}';
    if (_seen.contains(dedup)) return;
    if (_seen.length < _kCap) _seen.add(dedup);
    final ageMs = entryTs > 0
        ? DateTime.now().millisecondsSinceEpoch - entryTs * 1000
        : -1;
    try {
      Analytics.capture('call_failure_shown', {
        'call_id': callId,
        // A history row has no room id — this is the call-log entry uuid, so the
        // two surfaces stay joinable on `peer_uid` + time rather than on call_id.
        'entry_id': entryId,
        'reason': reason,
        'message_key': message.key,
        'surface': surface,
        'peer_uid': peerUid,
        // -1 = unknown (live call screen, or a legacy row without a timestamp).
        'entry_age_ms': ageMs,
        // True when the failure being shown happened over an hour ago — a
        // history replay, never this session's call.
        'historical': ageMs > 3600 * 1000,
      });
    } catch (_) {/* telemetry must never break a call surface */}
  }
}
