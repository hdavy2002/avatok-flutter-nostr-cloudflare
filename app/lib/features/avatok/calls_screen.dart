import 'dart:async';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/avatar.dart';
import '../../core/call_log_store.dart';
import '../../core/ice_cache.dart';
import '../../core/ui/zine_widgets.dart';
import '../../core/ui/avatok_dark.dart';
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
    Navigator.push(context, MaterialPageRoute(
      builder: (_) => CallScreen(room: 'avatok-${c.seed}', title: c.name, seed: c.seed, video: c.video, avatarUrl: _avatars[c.seed] ?? ''),
    )).then((_) => _load());
  }

  @override
  Widget build(BuildContext context) {
    // [ISSUE-CALLS-SEARCH-1] Derived view of the log. Cheap enough to recompute
    // per build; the call log is a short, already-in-memory list.
    final visible = _query.isEmpty
        ? _calls
        : _calls.where((c) => _matches(c, _query)).toList();
    return SafeArea(
      bottom: false,
      child: Column(children: [
        // Appbar band (§8): paper-2 fill, ink bottom border, Nunito title.
        Container(
          height: 60,
          padding: const EdgeInsets.symmetric(horizontal: 18),
          decoration: const BoxDecoration(
            color: AD.headerFooter,
            border: Border(bottom: BorderSide(color: AD.borderHairline, width: 1)),
          ),
          child: Row(children: [
            Expanded(
              child: Text('Calls', style: ADText.appTitle()),
            ),
            if (_calls.isNotEmpty)
              ZinePressable(
                onTap: _confirmClearAll,
                color: AD.card,
                pressedColor: AD.destructiveBg,
                radius: BorderRadius.circular(100),
                boxShadow: const [],
                child: SizedBox(
                  width: 40, height: 40,
                  child: Center(child: PhosphorIcon(
                      PhosphorIcons.trash(PhosphorIconsStyle.bold),
                      size: 19, color: AD.textPrimary)),
                ),
              ),
          ]),
        ),
        // [ISSUE-CALLS-SEARCH-1] Search dock, pinned directly under the tabs and
        // OUTSIDE the scrollable so it never scrolls away. Hidden while the log is
        // empty (nothing to search) and never autofocused — opening the tab must
        // not pop the keyboard.
        if (_loaded && _calls.isNotEmpty)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 2),
            child: AdSearchDock(
              controller: _searchCtl,
              hint: 'Search name or number',
              onChanged: (v) => setState(() => _query = v),
            ),
          ),
        Expanded(
          child: !_loaded
              ? const Center(child: CircularProgressIndicator(color: AD.iconSearch))
              : _calls.isEmpty
                  ? Center(child: Padding(
                      padding: const EdgeInsets.all(24),
                      child: Column(mainAxisSize: MainAxisSize.min, children: [
                        PhosphorIcon(PhosphorIcons.phone(PhosphorIconsStyle.bold),
                            size: 40, color: AD.textFaint),
                        const SizedBox(height: 14),
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
                                const SizedBox(height: 14),
                                Text('No calls match "$_query"',
                                    textAlign: TextAlign.center,
                                    style: ADText.preview(c: AD.textTertiary)),
                              ],
                            )
                          : ListView.separated(
                              padding: const EdgeInsets.fromLTRB(16, 14, 16, 24),
                              itemCount: visible.length,
                              separatorBuilder: (_, __) => const SizedBox(height: 10),
                              // [ISSUE-CALLS-SEARCH-1] _row no longer takes an
                              // index: deletion is by STABLE ID, so a filtered
                              // view can't misaddress the backing log.
                              itemBuilder: (_, i) => _row(visible[i]),
                            ),
                    ),
        ),
      ]),
    );
  }

  // Call-history row — zine card: ink border, bordered avatar, mono timestamp,
  // coral for missed, mint for incoming, call-back circle button.
  Widget _row(CallEntry c) {
    final missed = c.dir == CallDir.missed;
    final dirColor = switch (c.dir) {
      CallDir.missed => AD.missedCall,
      CallDir.incoming => AD.incomingCall,
      CallDir.outgoing => AD.outgoingCall,
    };
    return GestureDetector(
      onLongPress: () => _confirmDelete(c),
      onSecondaryTap: () => _confirmDelete(c), // desktop right-click
      child: Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
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
            const SizedBox(height: 3),
            Row(children: [
              PhosphorIcon(_dirIcon(c.dir), size: 14, color: dirColor),
              const SizedBox(width: 5),
              Flexible(child: Text('${_dirLabel(c.dir)} · ${c.timeLabel}'.toUpperCase(),
                  maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: ADText.sectionLabel(c: AD.textTertiary))),
            ]),
          ]),
        ),
        const SizedBox(width: 8),
        ZinePressable(
          onTap: () => _callBack(c),
          color: AD.card,
          pressedColor: AD.primaryBadge,
          radius: BorderRadius.circular(100),
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
  String _dirLabel(CallDir d) => switch (d) {
        CallDir.incoming => 'Incoming',
        CallDir.outgoing => 'Outgoing',
        CallDir.missed => 'Missed',
      };
}
