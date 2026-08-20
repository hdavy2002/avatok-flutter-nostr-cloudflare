import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/avatar.dart';
import '../../core/call_log_store.dart';
import '../../core/calls/call_room_id.dart'; // [CALL-ROOM-ID-1]
import '../../core/ice_cache.dart';
import '../../core/ui/call_failure_copy.dart'; // [CALL-HONEST-FAIL-1] shared copy
import '../../core/ui/call_log_format.dart'; // [CALL-LOG-TIME-1] shared subtitle
import '../../core/ui/zine_widgets.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/illustrations.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/rajasthani_motifs.dart';
import 'call_screen.dart';
import 'contacts.dart';

/// AvaTok Calls tab — real 1:1 call history; tap to call back.
class CallsScreen extends StatefulWidget {
  const CallsScreen({super.key});
  @override
  State<CallsScreen> createState() => _CallsScreenState();
}

class _CallsScreenState extends State<CallsScreen> {
  final _store = CallLogStore();
  List<CallEntry> _calls = [];
  Map<String, String> _avatars = {}; // uid → photo URL (from contacts)
  // [ISSUE-CALLS-SEARCH-1] uid → digits of that contact's AvaTOK number + phone.
  // CallEntry itself stores NO number (only name/seed/dir/ts), so number search
  // is resolved through the contact book, which _load() already reads for avatars.
  Map<String, String> _numberDigits = {};
  bool _loaded = false;
  StreamSubscription<void>? _changeSub;

  // [ISSUE-CALLS-SEARCH-1] Instant call-log filter (no debounce, filters from
  // the very first character typed).
  final _searchCtl = TextEditingController();
  String _query = '';

  @override
  void initState() {
    super.initState();
    _load();
    // Repaint live when the log changes on THIS device or syncs from another one
    // (live socket frame, FCM wake, or /sync snapshot) — all flow through here.
    _changeSub = CallLogStore.changes.listen((_) => _load());
  }

  @override
  void dispose() {
    _changeSub?.cancel();
    _searchCtl.dispose(); // [ISSUE-CALLS-SEARCH-1]
    super.dispose();
  }

  Future<void> _load() async {
    final c = await _store.load();
    final contacts = await ContactsStore().load();
    final avatars = {for (final x in contacts) if (x.avatarUrl.isNotEmpty) x.uid: x.avatarUrl};
    // [ISSUE-CALLS-SEARCH-1] Pre-digest each contact's number+phone to digits once
    // per load, so typing stays O(rows) with no per-keystroke string scrubbing.
    final numbers = {
      for (final x in contacts)
        if (x.number.isNotEmpty || x.phone.isNotEmpty)
          x.uid: _digits('${x.number} ${x.phone}'),
    };
    if (mounted) {
      setState(() { _calls = c; _avatars = avatars; _numberDigits = numbers; _loaded = true; });
    }
  }

  /// [ISSUE-CALLS-SEARCH-1] Strip every non-digit so a typed "4042" matches a
  /// stored "+1 404 269 4747" regardless of spacing/punctuation.
  static String _digits(String s) => s.replaceAll(RegExp(r'[^0-9]'), '');

  /// [ISSUE-CALLS-SEARCH-1] Case-insensitive match on contact NAME, plus a
  /// digits-only substring match on their number. Substring (not prefix) so a
  /// middle fragment of a number still hits.
  bool _matches(CallEntry c, String q) {
    if (q.isEmpty) return true;
    if (c.name.toLowerCase().contains(q.toLowerCase())) return true;
    final qd = _digits(q);
    if (qd.isEmpty) return false;
    // The seed doubles as the contact uid; fall back to it ONLY when the caller
    // is phone-only ('tel:+1404…'), where the number IS the identity.
    //
    // [ISSUE-CALLS-SEARCH-1] The fallback is gated on the `tel:` prefix on
    // purpose. A Clerk uid like `user_2xK4fQ8` contains digits ("248"), so an
    // ungated fallback made typing "2" surface unrelated rows — a number search
    // matching on the noise in an opaque account id.
    final nd = _numberDigits[c.seed] ??
        (c.seed.startsWith('tel:') ? _digits(c.seed) : '');
    return nd.isNotEmpty && nd.contains(qd);
  }

  void _callBack(CallEntry c) {
    IceCache.prefetch(); // warm TURN creds before the call screen opens
    // [CALL-ROOM-ID-1 2026-07-14] Was `'avatok-${c.seed}'` — the call-log seed
    // is the PEER's id, so calling the same person back twice from Recents
    // reused one call id and the callee's untimed dedup cache silently swallowed
    // the second one. `seed:` still carries the peer id; the room must not.
    Navigator.push(context, MaterialPageRoute(
      builder: (_) => CallScreen(room: CallRoomId.newRoomId(), title: c.name, seed: c.seed, video: c.video, avatarUrl: _avatars[c.seed] ?? ''),
    )).then((_) => _load());
  }

  @override
  Widget build(BuildContext context) {
    // [ISSUE-CALLS-SEARCH-1] Derived view of the log. Cheap enough to recompute
    // per build; the call log is a short, already-in-memory list.
    final visible = _query.isEmpty
        ? _calls
        : _calls.where((c) => _matches(c, _query)).toList();
    // [RAJ-SINGLEWAVE-1 2026-08-21] THE "Calls" HEADER BAND AND ITS WAVE ARE
    // GONE. Owner, pic 3/4: "same issue we have in the call section — remove
    // the call area like in pic 4 and move the trash bin next to the search
    // bar and reclaim the above space."
    //
    // What used to be here: a 60px indigo Container titled "Calls" with the
    // clear-log trash button, followed by its own `DoubleWaveSeam`. Like
    // GroupsTab, CallsScreen is ONLY ever a tab body inside `chat_list.dart`'s
    // IndexedStack (verified: one construction site, chat_list.dart:2595, never
    // pushed as a route), so that band sat directly beneath chat_list's own
    // header + tab strip + seam — a second title under a second wave, on a
    // screen whose selected tab already says "Calls".
    //
    // Roughly 96px of vertical chrome comes back (60 band + 36 seam), which
    // matters twice: it is what the owner asked for, and it is a third of the
    // chrome on the small-screen device from [RESP-SMALL-1].
    //
    // The outer `SafeArea` goes with it. The top inset belongs to chat_list's
    // header, which paints its band behind the status bar; chat_list already
    // wraps its tab bodies in `MediaQuery.removePadding(removeTop: true)`, so
    // a SafeArea here would be a no-op at best and a duplicated inset if that
    // ever changed.
    return Column(children: [
        // [ISSUE-CALLS-SEARCH-1] Search dock, pinned directly under the tabs and
        // OUTSIDE the scrollable so it never scrolls away. Hidden while the log is
        // empty (nothing to search) and never autofocused — opening the tab must
        // not pop the keyboard.
        //
        // [RAJ-SINGLEWAVE-1] The clear-log trash button now rides in this row
        // instead of the deleted band. Note this TIGHTENS its condition: the
        // button used to appear on `_calls.isNotEmpty` alone and now also waits
        // for `_loaded`, because it shares the dock's guard. That is correct —
        // "clear the whole log" should not be offerable before the log has
        // finished loading, or a mistimed tap clears a list the user cannot
        // see yet.
        if (_loaded && _calls.isNotEmpty)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 2),
            child: Row(children: [
              Expanded(
                child: AdSearchDock(
                  controller: _searchCtl,
                  hint: 'Search name or number',
                  onChanged: (v) => setState(() => _query = v),
                ),
              ),
              const SizedBox(width: Msg.s3),
              ZinePressable(
                onTap: _confirmClearAll,
                // Paper fill, ink glyph. It sits on the cream page now rather
                // than on a dark band, so the old contrast note about AD.onBand
                // no longer applies — ink on paper is the default and correct.
                color: AD.card,
                pressedColor: AD.destructiveBg,
                radius: Msg.brPill,
                boxShadow: const [],
                child: SizedBox(
                  width: 44, height: 44,
                  child: Center(child: PhosphorIcon(
                      PhosphorIcons.trash(PhosphorIconsStyle.bold),
                      size: 19, color: AD.textPrimary)),
                ),
              ),
            ]),
          ),
        Expanded(
          child: !_loaded
              ? const Center(child: CircularProgressIndicator(color: AD.iconSearch))
              : _calls.isEmpty
                  ? Center(child: Padding(
                      padding: const EdgeInsets.all(24),
                      child: Column(mainAxisSize: MainAxisSize.min, children: [
                        SvgPicture.asset(Illustrations.callsListEmpty,
                            height: 120, fit: BoxFit.contain, excludeFromSemantics: true),
                        const SizedBox(height: Msg.s3),
                        Text('No calls yet — start one from a chat',
                            textAlign: TextAlign.center,
                            style: ADText.preview(c: AD.textTertiary)),
                      ]),
                    ))
                  : RefreshIndicator(
                      onRefresh: _load,
                      color: AD.iconSearch,
                      // [ISSUE-CALLS-SEARCH-1] Distinct "no results" state, kept
                      // scrollable so pull-to-refresh still works while filtered.
                      child: visible.isEmpty
                          ? ListView(
                              padding: const EdgeInsets.fromLTRB(24, 60, 24, 24),
                              children: [
                                PhosphorIcon(
                                    PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold),
                                    size: 40, color: AD.textFaint),
                                const SizedBox(height: Msg.s3),
                                Text('No calls match "$_query"',
                                    textAlign: TextAlign.center,
                                    style: ADText.preview(c: AD.textTertiary)),
                              ],
                            )
                          : ListView.separated(
                              padding: const EdgeInsets.fromLTRB(Msg.s4, Msg.s4, Msg.s4, Msg.s5),
                              itemCount: visible.length,
                              // [RAJ-SEAMS-1] Bead-stud row rule (patches.md
                              // §6) replaces the plain gap — this is a
                              // ListView.separated (no fixed itemExtent), so
                              // the rule can freely add its own height.
                              separatorBuilder: (_, __) => const Padding(
                                padding: EdgeInsets.symmetric(vertical: Msg.s1),
                                child: BeadStudRule(),
                              ),
                              // [ISSUE-CALLS-SEARCH-1] _row no longer takes an
                              // index: deletion is by STABLE ID, so a filtered
                              // view can't misaddress the backing log.
                              itemBuilder: (_, i) => _row(visible[i]),
                            ),
                    ),
        ),
      ]);
  }

  // Call-history row — zine card: ink border, bordered avatar, mono timestamp,
  // coral for missed, mint for incoming, call-back circle button.
  Widget _row(CallEntry c) {
    final missed = c.dir == CallDir.missed;
    // [CALL-HONEST-FAIL-1] The honest sentence for a call that never became a
    // conversation. Null for a real call, a call the user cancelled, or a legacy
    // row — in every one of those cases the row says nothing extra rather than
    // guessing. Resolved from the ONE shared table in call_failure_copy.dart.
    final failure = callLogFailure(c);
    if (failure != null) {
      CallFailureTelemetry.shown(
        surface: 'log_row',
        message: failure,
        entryId: c.id,
        reason: c.outcome,
        peerUid: c.seed,
        entryTs: c.ts, // [CALL-FAILURE-SHOWN-HISTORICAL-1]
      );
    }
    final dirColor = switch (c.dir) {
      CallDir.missed => AD.missedCall,
      CallDir.incoming => AD.incomingCall,
      CallDir.outgoing => AD.outgoingCall,
    };
    return GestureDetector(
      onLongPress: () => _confirmDelete(c),
      onSecondaryTap: () => _confirmDelete(c), // desktop right-click
      child: Container(
      padding: const EdgeInsets.fromLTRB(Msg.s3, Msg.s3, Msg.s3, Msg.s3),
      decoration: BoxDecoration(
        color: AD.card,
        borderRadius: BorderRadius.circular(AD.rListCard),
        border: Border.all(color: AD.borderControl, width: 1),
        boxShadow: const [],
      ),
      child: Row(children: [
        Container(
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            border: Border.all(color: AD.borderAvatar, width: 2),
          ),
          child: Avatar(seed: c.seed, name: c.name, size: 44, avatarUrl: _avatars[c.seed]),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(c.name,
                maxLines: 1, overflow: TextOverflow.ellipsis,
                style: ADText.rowName(c: missed ? AD.missedCall : AD.textPrimary)),
            const SizedBox(height: Msg.s1),
            Row(children: [
              PhosphorIcon(_dirIcon(c.dir), size: 14, color: dirColor),
              const SizedBox(width: Msg.s1),
              // [CALL-LOG-TIME-1] date + time + duration, shared with AvaDialer.
              // [CALL-HONEST-FAIL-1] `withOutcome: false` when the sentence
              // below is showing, so the row doesn't say "Declined" and
              // "Arti declined the call." on two consecutive lines.
              Flexible(child: Text(
                  callLogSubtitle(c, context: context, withOutcome: failure == null),
                  maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: ADText.sectionLabel(c: AD.textTertiary))),
            ]),
            // [CALL-HONEST-FAIL-1] Why it never became a conversation, in words.
            if (failure != null) ...[
              const SizedBox(height: Msg.s1),
              Text(failure.text,
                  maxLines: 2, overflow: TextOverflow.ellipsis,
                  style: ADText.preview(c: AD.textTertiary)),
            ],
          ]),
        ),
        const SizedBox(width: 8),
        ZinePressable(
          onTap: () => _callBack(c),
          color: AD.card,
          pressedColor: AD.primaryBadge,
          radius: Msg.brPill,
          boxShadow: const [],
          child: SizedBox(
            width: 40, height: 40,
            child: Center(child: PhosphorIcon(
                c.video
                    ? PhosphorIcons.videoCamera(PhosphorIconsStyle.bold)
                    : PhosphorIcons.phone(PhosphorIconsStyle.bold),
                size: 19, color: c.video ? AD.iconVideo : AD.iconPhone)),
          ),
        ),
      ]),
      ),
    );
  }

  // Confirm + delete a single call-log entry (long-press / right-click).
  //
  // [ISSUE-CALLS-SEARCH-1] Deletes by STABLE ID, not by list position. The old
  // `removeAt(index)` re-`load()`ed the log from disk and sliced THAT list, so
  // any drift between the widget's `_calls` and disk (a call landing, a server
  // sync merging) deleted the wrong entry — and once the list was filtered by a
  // search query, a view index would have been wrong every time. `removeById`
  // is addressed by content, so neither can happen.
  Future<void> _confirmDelete(CallEntry c) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AD.popover,
        title: Text('Delete call', style: ADText.threadName()),
        content: Text('Remove the call with ${c.name} from your history?',
            style: ADText.preview(c: AD.textSecondary)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: AD.destructiveBg),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (ok == true) {
      // Legacy entries written before CallEntry.id existed have an empty id —
      // fall back to the positional delete for those, resolving the index
      // against the backing list (never the filtered view).
      if (c.id.isNotEmpty) {
        await _store.removeById(c.id);
      } else {
        final i = _calls.indexOf(c);
        if (i >= 0) await _store.removeAt(i);
      }
      await _load();
    }
  }

  // Confirm + clear the entire call log.
  Future<void> _confirmClearAll() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AD.popover,
        title: Text('Clear call logs', style: ADText.threadName()),
        content: Text('Delete your entire call history? This cannot be undone.',
            style: ADText.preview(c: AD.textSecondary)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: AD.destructiveBg),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Clear all'),
          ),
        ],
      ),
    );
    if (ok == true) {
      await _store.clear();
      await _load();
    }
  }

  PhosphorIconData _dirIcon(CallDir d) => switch (d) {
        CallDir.incoming => PhosphorIcons.phoneIncoming(PhosphorIconsStyle.bold),
        CallDir.outgoing => PhosphorIcons.phoneOutgoing(PhosphorIconsStyle.bold),
        CallDir.missed => PhosphorIcons.phoneX(PhosphorIconsStyle.bold),
      };
  // [CALL-LOG-TIME-1] `_dirLabel` moved to core/ui/call_log_format.dart
  // (`callLogDirectionLabel`) so AvaTalk and AvaDialer cannot drift again.
}
