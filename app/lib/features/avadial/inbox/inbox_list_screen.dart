import 'dart:async';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/analytics.dart';
import '../../../core/campaigns_api.dart';
import '../../../core/ui/avatok_dark.dart';
import '../../../core/ui/zine_widgets.dart';
import '../../../shell/v2/shell_chrome.dart';
import '../../../sync/sync_hub.dart';
import '../../avatok/contacts.dart';
import '../avadial_theme.dart';
import '../block_list.dart';
import '../contact_overrides.dart';
import '../device_contacts.dart';
import 'inbox_api.dart';
import 'inbox_caller_name.dart';
import 'inbox_heard_store.dart';
import 'inbox_thread_cache.dart';
import 'inbox_thread_screen.dart';

/// AvaDial Inbox — the Ava Receptionist / voicemail thread list (Specs/PLAN-
/// 2026-07-16-ava-receptionist-guardian-FINAL.md, Owner-locked scope item 2,
/// Phase 3 AVA-RCPT-8). One row per caller number: contact-matched display
/// name (falls back to a formatted number, or "Hidden number" for an
/// anonymous-caller thread), last-message time, and an unread dot. Entry
/// point wired in shell/v2/avadial_root.dart, gated on
/// RemoteConfig.pstnVoicemail — this screen itself has no flag check because
/// the tab that pushes it already does.
class InboxListScreen extends StatefulWidget {
  /// True (the default) when this screen is hosted as a TAB BODY inside
  /// another Scaffold — e.g. AvaDial root's own IndexedStack (exactly like
  /// `_LogsTab`/`_BlockTab`) — so it renders no Scaffold/AppBar of its own.
  /// Pass `false` when this screen IS the top-level surface — the main-shell
  /// footer's own "Inbox" slot (shell/v2/app_switcher_bar.dart) pushes it as a
  /// full-screen route with no parent AvaDial Scaffold around it, so it needs
  /// to own its own Scaffold + AppBar in that case.
  final bool embedded;
  const InboxListScreen({super.key, this.embedded = true});

  @override
  State<InboxListScreen> createState() => _InboxListScreenState();
}

class _InboxListScreenState extends State<InboxListScreen> {
  // [AVA-INBOX-READSTATE] Cache-first rendering. `_threads` is the currently
  // painted list (seeded from the on-disk per-account cache the instant the
  // screen opens, then replaced by the network result). A full-screen spinner
  // shows ONLY while `_threads == null` — i.e. the very first load on a device
  // with no cache yet. Every subsequent open / the 176-times-in-3-days
  // resume-reconnect refresh paints the cached list immediately and refreshes
  // silently underneath, so the Inbox never blanks or spins on reconnect.
  List<InboxThread>? _threads;
  bool _hasError = false; // last network fetch failed AND there's nothing to show

  // [INBOX-SEARCH-1] Client-side filter over the already-loaded threads —
  // matches caller display name, PSTN number, and transcript text. Instant
  // (no debounce), same idiom as AdSearchDock's other call sites.
  final _searchCtrl = TextEditingController();
  String _query = '';

  // [AVA-CAMP-Q-INBOX] Campaign filter bar — lets the owner separate campaign
  // result threads (conv = `campaign_<uid>__<campaignId>`, see
  // `InboxThread.isCampaignThread`) from ordinary voicemail/receptionist
  // threads, and narrow further to one specific campaign by name. `null` =
  // "All" (today's unfiltered view — the default, unchanged). The sentinel
  // string below stands for "Campaigns" (every campaign thread, any id) —
  // a real campaign id can never collide with it since ids come straight off
  // the backend's own id scheme.
  static const _kCampaignsAll = '__all_campaigns__';
  String? _campaignFilter;

  /// [AVA-CAMP-Q-INBOX] Best-effort campaign id -> name map, used to label a
  /// campaign thread's chip/row when the message envelope itself didn't carry
  /// a `campaign_name` (see `InboxCard.campaignName`'s TODO). Populated once
  /// per load in [_loadThreads]; a failure just leaves ids showing as their
  /// raw id instead of a friendly name — never blocks the list.
  Map<String, String> _campaignNames = {};

  StreamSubscription<HubEvent>? _liveSub;
  Timer? _liveDebounce;

  // [INBOX-HEARD-1] Heard-card ids (per-account, see inbox_heard_store.dart)
  // and rename overrides (contact_overrides.dart), side-loaded alongside the
  // thread fetch so `_row`/`_labelFor` can read them synchronously at build
  // time. Populated by [_loadThreads]; best-effort — an empty map/set just
  // means every card reads as unheard / unrenamed, never a crash.
  Set<String> _heardIds = {};
  Map<String, String> _overrideNames = {}; // normalized phone → display name

  // [AVAINBOX-1] conv → resolved display name (ContactOverrides → ContactsStore
  // by uid/phone → DeviceContacts → server callerName → formatted number →
  // "Unknown caller"; see inbox_caller_name.dart). Side-loaded in
  // [_loadThreads] alongside [_overrideNames] so `_labelFor` stays a
  // synchronous read at build time (the same idiom the heard-ids/overrides
  // side-load already uses here).
  Map<String, ResolvedCallerName> _resolvedNames = {};
  StreamSubscription<List<Contact>>? _contactsSub;

  @override
  void initState() {
    super.initState();
    // Best-effort warm of the contact-name index so the FIRST paint already
    // resolves known callers instead of flashing raw numbers then relabeling.
    DeviceContacts.I.load();
    _bootstrap();
    // [AVAINBOX-1] A contact renamed/added/removed elsewhere (chat list, the
    // Calls Contacts tab) should immediately re-resolve every row here — this
    // is the "Rebuild on ContactsStore.changes" requirement, so a save in the
    // AvaTOK contact book fixes "Unknown caller" without the user having to
    // leave and reopen the Inbox tab.
    _contactsSub = ContactsStore.changes.listen((_) => _reload());
    // [INBOX-LIVE-1, owner bug 2026-07-16] Voicemails only appeared after a
    // manual pull-to-refresh. InboxDO broadcasts every append over the live
    // sync WS, and SyncHub surfaces it on `incoming` — subscribe to voicemail/
    // receptionist convs and reload. Debounced: a burst (initial sync replay,
    // multi-card delivery) collapses into one fetch.
    // NOTE convKey shape: SyncHub._ingestMsg maps non-dm_ convs to 'g:<conv>'
    // (sync_hub.dart ~line 729), so a voicemail row for conv
    // `voicemail_<owner>__<caller>` arrives here as `g:voicemail_…`.
    _liveSub = SyncHub.I.incoming
        .where((e) =>
            e.convKey.startsWith('g:voicemail_') ||
            e.convKey.startsWith('g:recept_'))
        .listen((_) {
      _liveDebounce?.cancel();
      _liveDebounce = Timer(const Duration(milliseconds: 400), () {
        if (mounted) _reload();
      });
    });
  }

  @override
  void dispose() {
    _liveDebounce?.cancel();
    _liveSub?.cancel();
    _contactsSub?.cancel();
    _searchCtrl.dispose();
    super.dispose();
  }

  /// [AVA-INBOX-READSTATE] Cache-first open: paint the last-persisted thread
  /// list from disk immediately (no spinner), then refresh from the network in
  /// the background. The cached paint also warms [_heardIds] so the read/unread
  /// colouring is right on the very first frame, not only after the refresh.
  Future<void> _bootstrap() async {
    final t0 = DateTime.now().millisecondsSinceEpoch;
    List<InboxThread>? cached;
    try {
      cached = await InboxThreadCache.I.load();
    } catch (_) {/* fall through to a normal network-first load */}
    Analytics.capture('inbox_cache_hit', {
      'hit': cached != null && cached.isNotEmpty,
      'threads': cached?.length ?? 0,
    });
    if (cached != null && cached.isNotEmpty && mounted && _threads == null) {
      try {
        _heardIds = await InboxHeardStore.I.loadAll();
      } catch (_) {/* every card just reads as unheard until the refresh */}
      setState(() {
        _threads = cached;
        _hasError = false;
      });
      Analytics.capture('inbox_rendered_from_cache', {
        'threads': cached.length,
        'ms': DateTime.now().millisecondsSinceEpoch - t0,
      });
    }
    await _loadThreads();
  }

  Future<void> _reload() => _loadThreads();

  /// Fetches threads from the network, then side-loads [_heardIds] (heard-card
  /// store) and [_overrideNames] (rename-caller overrides, contact_overrides
  /// .dart) for every `tel:` thread, and persists the result to the per-account
  /// cache for the next instant open. Both side-loads are best-effort — a
  /// failure just leaves the prior/default state, it never blocks the list. A
  /// network failure keeps whatever is already on screen (the cached list),
  /// surfacing an error state ONLY when there was nothing cached to show.
  Future<void> _loadThreads() async {
    final t0 = DateTime.now().millisecondsSinceEpoch;
    final List<InboxThread> threads;
    try {
      threads = await InboxApi.threads();
    } catch (_) {
      if (mounted && _threads == null) setState(() => _hasError = true);
      Analytics.capture('inbox_network_refresh', {
        'ok': false,
        'had_cache': _threads != null,
        'ms': DateTime.now().millisecondsSinceEpoch - t0,
      });
      return;
    }
    try {
      _heardIds = await InboxHeardStore.I.loadAll();
    } catch (_) {/* keep prior state */}
    final overrides = <String, String>{};
    for (final t in threads) {
      final phone = t.telPhone;
      if (phone == null || overrides.containsKey(phone)) continue;
      try {
        final o = await ContactOverrides.I.forNumber(phone);
        final name = o?.displayName;
        if (name != null && name.trim().isNotEmpty) overrides[phone] = name;
      } catch (_) {/* leave unrenamed */}
    }
    _overrideNames = overrides;
    // [AVAINBOX-1] One shared ContactsStore load for every thread in this
    // batch (not one load per thread — that's O(n) disk reads for a screen
    // that can hold hundreds of rows).
    List<Contact> contacts = const [];
    try {
      contacts = await ContactsStore().load();
    } catch (_) {/* resolver falls back gracefully with an empty list */}
    final resolved = <String, ResolvedCallerName>{};
    final tierCounts = <String, int>{};
    for (final t in threads) {
      final r = await InboxCallerName.resolve(thread: t, contactsCache: contacts);
      resolved[t.conv] = r;
      tierCounts[r.tier] = (tierCounts[r.tier] ?? 0) + 1;
    }
    _resolvedNames = resolved;
    // [AVA-CAMP-Q-INBOX] Best-effort campaign id -> name resolution for the
    // filter chip labels (and the campaign-thread row label below). Only
    // fired when there's actually a campaign thread in this batch, and never
    // blocks/fails the rest of the load — an empty/failed lookup just leaves
    // those chips/rows showing the raw campaign id instead of its name.
    if (threads.any((t) => t.isCampaignThread)) {
      try {
        final campaigns = await CampaignsApi.listCampaigns();
        _campaignNames = {for (final c in campaigns) c.id: c.name};
      } catch (_) {/* chips/rows fall back to raw campaign id */}
    }
    if (threads.isNotEmpty) {
      // [AVAINBOX-1] Proves the "Unknown caller" fix landed in PRODUCTION
      // (CLAUDE.md Rule 1: never just read the code, go check telemetry) —
      // which tier wins for how many threads, so a regression that pushes
      // everything back to 'unknown'/'server' is visible in PostHog rather
      // than only found by eyeballing a screenshot.
      Analytics.capture('inbox_name_resolution_summary', {
        'threads': threads.length,
        ...tierCounts.map((k, v) => MapEntry('tier_$k', v)),
      });
    }
    // Persist for the next instant (cache-first) open — best-effort.
    unawaited(InboxThreadCache.I.save(threads));
    Analytics.capture('inbox_network_refresh', {
      'ok': true,
      'threads': threads.length,
      'had_cache': _threads != null,
      'ms': DateTime.now().millisecondsSinceEpoch - t0,
    });
    if (mounted) {
      setState(() {
        _threads = threads;
        _hasError = false;
      });
    }
  }

  /// Filters [threads] by caller display name, PSTN number, or any card's
  /// transcript text (case-insensitive substring match).
  List<InboxThread> _filtered(List<InboxThread> threads) {
    final q = _query.trim().toLowerCase();
    if (q.isEmpty) return threads;
    return threads.where((t) {
      final label = _labelFor(t);
      if (label.title.toLowerCase().contains(q)) return true;
      if (label.subtitleNumber != null && label.subtitleNumber!.toLowerCase().contains(q)) {
        return true;
      }
      final phone = t.telPhone;
      if (phone != null && phone.toLowerCase().contains(q)) return true;
      for (final c in t.cards) {
        if ((c.transcript ?? '').toLowerCase().contains(q)) return true;
        if ((c.summaryText ?? '').toLowerCase().contains(q)) return true;
        if ((c.callerPhone ?? '').toLowerCase().contains(q)) return true;
        if ((c.callerName ?? '').toLowerCase().contains(q)) return true;
      }
      return false;
    }).toList();
  }

  /// [AVA-CAMP-Q-INBOX] Narrows [threads] per [_campaignFilter]: `null` (the
  /// default "All") is a no-op — every existing thread still shows exactly
  /// as before this lane. `_kCampaignsAll` keeps every campaign thread. A
  /// specific campaign id keeps only that campaign's thread(s).
  List<InboxThread> _applyCampaignFilter(List<InboxThread> threads) {
    final f = _campaignFilter;
    if (f == null) return threads;
    if (f == _kCampaignsAll) return threads.where((t) => t.isCampaignThread).toList();
    return threads.where((t) => t.isCampaignThread && t.campaignId == f).toList();
  }

  /// True as soon as ANY loaded thread is a campaign thread — gates whether
  /// the filter bar renders at all, so an owner with no campaigns ever sees
  /// no new UI (fully additive).
  bool get _hasCampaigns => (_threads ?? const <InboxThread>[]).any((t) => t.isCampaignThread);

  /// Distinct campaign chips to render, sorted by label. Label prefers the
  /// envelope's own `campaign_name` ([InboxThread.campaignEnvelopeName]),
  /// then the `CampaignsApi.listCampaigns()` id->name lookup ([_campaignNames]),
  /// then falls back to the raw campaign id so a chip never renders blank.
  List<({String id, String label})> get _campaignOptions {
    final byId = <String, String>{};
    for (final t in (_threads ?? const <InboxThread>[])) {
      if (!t.isCampaignThread) continue;
      final id = t.campaignId;
      if (id == null || byId.containsKey(id)) continue;
      byId[id] = t.campaignEnvelopeName ?? _campaignNames[id] ?? id;
    }
    final options = byId.entries.map((e) => (id: e.key, label: e.value)).toList();
    options.sort((a, b) => a.label.toLowerCase().compareTo(b.label.toLowerCase()));
    return options;
  }

  /// Horizontally-scrollable "All / Campaigns / <campaign name>…" chip row —
  /// same [AdChip] + horizontal-[ListView] idiom `avalibrary_screen.dart`'s
  /// type-filter row already uses. Renders nothing when there are no campaign
  /// threads loaded, so the default (non-campaign) Inbox view is pixel-identical
  /// to before this lane.
  Widget _campaignFilterBar() {
    if (!_hasCampaigns) return const SizedBox.shrink();
    final options = _campaignOptions;
    return SizedBox(
      height: 40,
      child: ListView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.fromLTRB(14, 0, 14, 8),
        children: [
          Padding(
            padding: const EdgeInsets.only(right: 8),
            child: AdChip(
              label: 'All',
              active: _campaignFilter == null,
              onTap: () {
                setState(() => _campaignFilter = null);
                Analytics.capture('inbox_campaign_filter', {'filter': 'all'});
              },
            ),
          ),
          Padding(
            padding: const EdgeInsets.only(right: 8),
            child: AdChip(
              label: 'Campaigns',
              icon: PhosphorIcons.megaphone(PhosphorIconsStyle.bold),
              active: _campaignFilter == _kCampaignsAll,
              onTap: () {
                setState(() => _campaignFilter = _kCampaignsAll);
                Analytics.capture('inbox_campaign_filter', {'filter': 'campaigns_all'});
              },
            ),
          ),
          for (final c in options)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: AdChip(
                label: c.label,
                active: _campaignFilter == c.id,
                onTap: () {
                  setState(() => _campaignFilter = c.id);
                  Analytics.capture('inbox_campaign_filter', {'filter': 'campaign_id', 'campaign_id': c.id});
                },
              ),
            ),
        ],
      ),
    );
  }

  void _open(InboxThread t) {
    Navigator.of(context)
        .push(MaterialPageRoute<void>(builder: (_) => InboxThreadScreen(thread: t)))
        .then((_) => _reload()); // pick up the read-state flip on return
  }

  // NOTE: when `embedded` (the default), this widget renders as ONE tab body
  // inside AvaDialRoot's own Scaffold/AppBar/tab-strip (shell/v2/avadial_root
  // .dart's IndexedStack) — exactly like `_LogsTab`/`_BlockTab` — so it has NO
  // Scaffold or AppBar of its own there (that would double the toolbar); the
  // tab strip already labels that section "Inbox". When NOT embedded (the
  // main-shell footer's own Inbox slot — shell/v2/app_switcher_bar.dart), this
  // screen is the top-level route and owns its own Scaffold + AppBar below.
  @override
  Widget build(BuildContext context) {
    final content = Column(children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(14, 10, 14, 4),
        child: AdSearchDock(
          controller: _searchCtrl,
          hint: 'Search calls, numbers, transcripts',
          onChanged: (v) => setState(() => _query = v),
        ),
      ),
      _campaignFilterBar(),
      Expanded(child: _list(context)),
    ]);
    if (!widget.embedded) {
      return Scaffold(
        backgroundColor: AvaDialTheme.bg,
        appBar: AppBar(
          backgroundColor: AvaDialTheme.surface,
          surfaceTintColor: Colors.transparent,
          elevation: 0,
          foregroundColor: AvaDialTheme.text,
          title: Text('Inbox', style: ADText.threadName(c: AvaDialTheme.text)),
          shape: const Border(bottom: BorderSide(color: AvaDialTheme.border, width: 1)),
        ),
        body: SafeArea(child: content),
      );
    }
    return content;
  }

  Widget _list(BuildContext context) {
    // [AVA-INBOX-READSTATE] `_threads == null` ONLY on the very first load of a
    // device with no cache — that's the one time a spinner is acceptable. Once
    // the cache (or a network result) has seeded `_threads`, every reconnect/
    // refresh keeps the existing list painted and refreshes underneath.
    final allThreads = _threads;
    if (allThreads == null) {
      if (_hasError) return _errorState();
      return const Center(child: CircularProgressIndicator(color: AvaDialTheme.accent));
    }
    // [AVA-CAMP-Q-INBOX] Campaign chip filter applied first, then the
    // existing search-text filter narrows further — default `_campaignFilter
    // == null` is a no-op, so this is exactly `_filtered(allThreads)` as
    // before this lane whenever no chip is selected.
    final threads = _filtered(_applyCampaignFilter(allThreads));
    if (allThreads.isEmpty) {
      // Nothing at all — if the (only) network attempt errored with no cache,
      // show the retry error; otherwise the genuine "no messages" empty state.
      if (_hasError) return _errorState();
      return RefreshIndicator(
        onRefresh: _reload,
        child: ListView(children: const [
          SizedBox(height: 100),
          ShellEmptyState(
            icon: Icons.voicemail_outlined,
            title: 'No messages yet',
            subtitle: 'Missed calls Ava answers for you will show up here.',
            color: AD.iconShield,
          ),
        ]),
      );
    }
    if (threads.isEmpty) {
      return RefreshIndicator(
        onRefresh: _reload,
        child: ListView(children: const [
          SizedBox(height: 100),
          ShellEmptyState(
            icon: Icons.search_off,
            title: 'No matches',
            subtitle: 'No calls match your search.',
            color: AD.iconSearch,
          ),
        ]),
      );
    }
    return RefreshIndicator(
      onRefresh: _reload,
      child: ListView.builder(
        padding: const EdgeInsets.fromLTRB(14, 10, 14, 24),
        itemCount: threads.length,
        itemBuilder: (context, i) => Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: _row(threads[i]),
        ),
      ),
    );
  }

  Widget _errorState() => RefreshIndicator(
        onRefresh: _reload,
        child: ListView(children: const [
          SizedBox(height: 100),
          ShellEmptyState(
            icon: Icons.error_outline,
            title: 'Couldn’t load your Inbox',
            subtitle: 'Pull down to try again.',
            color: AD.danger,
          ),
        ]),
      );

  /// "Missed call from <name/number>" row content. [AVAINBOX-1]: now backed by
  /// the ONE canonical resolver (inbox_caller_name.dart) side-loaded into
  /// [_resolvedNames] by [_loadThreads] — replaces the old phone-only
  /// override/DeviceContacts duplication that never consulted the AvaTOK
  /// contact book and always said "Unknown caller" for a bare-uid business-
  /// voicemail thread from a saved contact.
  ({String title, String? subtitleNumber}) _labelFor(InboxThread t) {
    // [AVA-CAMP-Q-INBOX] A campaign thread has no "caller" — labelling it
    // "Unknown caller" (the resolver's fallback, since it has no phone/uid to
    // key off) read as broken once the campaign filter made these threads
    // visible on their own. Show the campaign name/id instead — same
    // id->name preference order as the filter chips.
    if (t.isCampaignThread) {
      final id = t.campaignId;
      final name = t.campaignEnvelopeName ?? (id != null ? _campaignNames[id] : null) ?? id;
      return (title: name ?? 'Campaign', subtitleNumber: null);
    }
    if (t.isAnonymous) return (title: 'Hidden number', subtitleNumber: null);
    final resolved = _resolvedNames[t.conv];
    final phone = t.telPhone ?? t.latest.callerPhone;
    if (resolved == null) {
      // Resolution hasn't landed yet (first frame before _loadThreads'
      // side-load completes) — a fast synchronous guess so the row never
      // flashes empty; _reload()'s setState repaints with the real result.
      final name = t.latest.callerName;
      return (
        title: (name != null && name.isNotEmpty) ? name : (phone ?? 'Unknown caller'),
        subtitleNumber: null,
      );
    }
    // Show the raw number as a subtitle only when the title ISN'T already the
    // number itself (formatted_number tier) — avoids "+1555…" / "+1555…"
    // duplicated on two lines.
    final subtitle = (phone != null && resolved.tier != 'formatted_number' && resolved.tier != 'anonymous')
        ? phone
        : null;
    return (title: resolved.name, subtitleNumber: subtitle);
  }

  /// How many cards in [t] are unread-or-unplayed — owner spec pic3: "make
  /// the color light green with red numbers to indicate how many unread or
  /// unplayed VM you have inside it." Prefers the count of cards with a
  /// recording that haven't been marked heard yet; falls back to 1 when the
  /// SERVER says the thread is unread but has no (recording) cards to count
  /// (e.g. a text-only missed-call-fallback card) so the badge never reads 0
  /// on a thread the list still flags unread.
  int _unreadCount(InboxThread t) {
    final unheard = t.cards.where((c) => c.hasRecording && !_heardIds.contains(c.stableId)).length;
    if (unheard > 0) return unheard;
    return t.unread ? 1 : 0;
  }

  String _formatTel(String e164) => e164; // kept simple; the number is already E.164

  // [AVA-INBOX-READSTATE] Owner-spec read/unread card states (2026-07-17),
  // superseding the earlier "light green + red count" AVAINBOX-2 treatment:
  //   • NEW / unread  → pale-green card + a LARGE orange dot indicator.
  //   • Fully read    → light-grey card, BLACK font, 2 blue tick marks.
  // Both surfaces are deliberately LIGHT (dark ink) so they pop out of the
  // near-black list — the owner has repeatedly asked for genuinely light cards
  // here, not a desaturated dark wash. `ZineIconBadge` is unaffected: it paints
  // its own coloured fill + near-black glyph, so it reads on both states.
  //
  // Every child (title/preview/timestamp) is given an explicit dark-on-light
  // colour below instead of the dark-theme AvaDialTheme.text/textSoft/textMute
  // (near-white, which would vanish on these light cards).
  static const _unreadCardBg = AD.bubbleOutBg; // 0xFFCDEBD3 — pale mint-green
  static const _unreadCardBorder = AD.bubbleOutPlay; // 0xFF3E8E5A — deeper green edge
  static const _unreadTitleInk = AD.bubbleOutInk; // 0xFF1C3324 — dark ink on green
  static const _unreadSecondaryInk = Color(0xFF2A4436); // dark forest green
  static const _readCardBg = Color(0xFFE7E8EB); // light grey (read cards)
  static const _readCardBorder = Color(0xFFCED0D6); // slightly darker grey edge
  static const _readTitleInk = Color(0xFF000000); // BLACK font — owner spec
  static const _readSecondaryInk = Color(0xFF3B3D45); // dark grey preview/timestamp
  static const _unreadDot = AD.unreadAccent; // 0xFFF2A65A — the LARGE orange dot
  static const _readTick = AD.iconSearch; // 0xFF6FA8E8 — the 2 blue read ticks

  // [AVA-CAMP-Q-INBOX] Campaign row tint — the SAME pale-lavender family as
  // `campaign_inbox_cards.dart`'s card shell (AD.bubbleInBg/bubbleInInk/
  // bubbleInMeta + AD.iconVideo accent), so a campaign thread reads as the
  // same "kind of thing" in the list as it does once opened.
  static const _campaignCardBg = AD.bubbleInBg; // 0xFFE6E3F6
  static const _campaignCardBorder = Color(0xFFC7BEEA);
  static const _campaignTitleInk = AD.bubbleInInk; // 0xFF2A2640
  static const _campaignSecondaryInk = AD.bubbleInMeta; // 0xFF7B76A0

  Widget _row(InboxThread t) {
    final label = _labelFor(t);
    final isCampaign = t.isCampaignThread;
    final hasUnread = _unreadCount(t) > 0;
    final titleInk = isCampaign ? _campaignTitleInk : (hasUnread ? _unreadTitleInk : _readTitleInk);
    final secondaryInk =
        isCampaign ? _campaignSecondaryInk : (hasUnread ? _unreadSecondaryInk : _readSecondaryInk);
    final preview = t.latest.summaryText ??
        (t.latest.transcript != null && t.latest.transcript!.length > 60
            ? '${t.latest.transcript!.substring(0, 60)}…'
            : t.latest.transcript) ??
        'Left a message';
    // A campaign thread has no "caller" to have missed — this row is a
    // campaign result, not a missed call, so skip that copy for it.
    final titleText = isCampaign ? label.title : 'Missed call from ${label.title}';
    return GestureDetector(
      onTap: () => _open(t),
      onLongPress: () => _showThreadMenu(t),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(
          color: isCampaign ? _campaignCardBg : (hasUnread ? _unreadCardBg : _readCardBg),
          borderRadius: BorderRadius.circular(AD.rListCard),
          border: Border.all(
            color: isCampaign ? _campaignCardBorder : (hasUnread ? _unreadCardBorder : _readCardBorder),
            width: (isCampaign || hasUnread) ? 1.5 : 1,
          ),
        ),
        child: Row(children: [
          ZineIconBadge(
            icon: isCampaign
                ? PhosphorIcons.megaphone(PhosphorIconsStyle.fill)
                : PhosphorIcons.phoneIncoming(PhosphorIconsStyle.fill),
            color: isCampaign ? AD.iconVideo : AD.iconShield,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(titleText,
                  style: ADText.threadName(c: titleInk),
                  maxLines: 1, overflow: TextOverflow.ellipsis),
              const SizedBox(height: 2),
              Text(preview,
                  style: ADText.preview(c: secondaryInk),
                  maxLines: 1, overflow: TextOverflow.ellipsis),
            ]),
          ),
          const SizedBox(width: 8),
          Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
            Text(_relativeTime(t.latest.createdAtMs),
                style: ADText.statCaption(c: secondaryInk)),
            const SizedBox(height: 8),
            if (hasUnread)
              // LARGE orange dot — the single unread indicator (owner spec).
              Container(
                width: 16,
                height: 16,
                decoration: const BoxDecoration(
                  color: _unreadDot,
                  shape: BoxShape.circle,
                ),
              )
            else
              // 2 blue tick marks — read.
              const Icon(Icons.done_all, size: 18, color: _readTick),
          ]),
        ]),
      ),
    );
  }

  // ── [INBOX-LISTMENU-1] Long-press thread-row menu ─────────────────────────
  // Same idiom as `_VoicemailCardState._showCardMenu` (thread screen): grab
  // handle, isScrollControlled, PhosphorIcon leading rows. Rename reuses the
  // EXACT dialog/[ContactOverrides] flow the thread screen's card menu uses
  // (see `promptRenameCaller` in inbox_thread_screen.dart). Block/Delete/Mark-
  // heard act on every card in the thread at once, since this is the row for
  // the WHOLE conversation, not one voicemail.
  Future<void> _showThreadMenu(InboxThread t) async {
    final phone = t.telPhone;
    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: AvaDialTheme.surface,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        side: BorderSide(color: AvaDialTheme.border, width: 1),
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (sheetCtx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const SizedBox(height: 10),
          Container(
            width: 40, height: 4,
            decoration:
                BoxDecoration(color: AvaDialTheme.textMute, borderRadius: BorderRadius.circular(100)),
          ),
          const SizedBox(height: 6),
          if (phone != null)
            _ThreadMenuRow(
              icon: PhosphorIcons.pencilSimple(PhosphorIconsStyle.bold),
              color: AD.iconSearch,
              label: 'Rename caller',
              onTap: () { Navigator.pop(sheetCtx); _renameThreadCaller(t, phone); },
            ),
          if (phone != null)
            _ThreadMenuRow(
              icon: PhosphorIcons.prohibit(PhosphorIconsStyle.bold),
              color: AD.danger,
              label: 'Block caller',
              onTap: () { Navigator.pop(sheetCtx); _blockThreadCaller(t, phone); },
            ),
          _ThreadMenuRow(
            icon: PhosphorIcons.checkCircle(PhosphorIconsStyle.bold),
            color: AD.iconShield,
            label: 'Mark all as heard',
            onTap: () { Navigator.pop(sheetCtx); _markThreadHeard(t); },
          ),
          _ThreadMenuRow(
            icon: PhosphorIcons.trash(PhosphorIconsStyle.bold),
            color: AD.danger,
            label: 'Delete thread',
            danger: true,
            onTap: () { Navigator.pop(sheetCtx); _deleteThread(t); },
          ),
          const SizedBox(height: 8),
        ]),
      ),
    );
  }

  /// [INBOX-RENAME-1] Same override flow the thread screen's "Rename caller"
  /// card-menu action uses — `promptRenameCaller` is the extracted dialog UI,
  /// this call site does the exact same save + refresh dance
  /// `_InboxThreadScreenState._renameCaller` does.
  Future<void> _renameThreadCaller(InboxThread t, String phone) async {
    final result = await promptRenameCaller(context, currentName: _overrideNames[phone]);
    if (result == null) return; // cancelled
    final newName = result.isEmpty ? null : result;
    await ContactOverrides.I.setName(phone, newName);
    Analytics.capture('inbox_rename_caller', {'has_number': true, 'cleared': newName == null, 'via': 'list'});
    await _reload();
  }

  Future<void> _blockThreadCaller(InboxThread t, String phone) async {
    await BlockList.I.block(phone);
    Analytics.capture('inbox_block_tapped', {'report_spam': false, 'via': 'list'});
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: Text('Number blocked.')));
  }

  /// Deletes EVERY card in [t] — `InboxApi.hideCard` per card (the same
  /// soft-delete RPC the thread screen's single-card delete uses), then drops
  /// the row from the list optimistically rather than waiting on a refetch.
  Future<void> _deleteThread(InboxThread t) async {
    final label = _labelFor(t).title;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AvaDialTheme.surface2,
        shape: RoundedRectangleBorder(
          side: const BorderSide(color: AvaDialTheme.border, width: 1),
          borderRadius: BorderRadius.circular(AD.rListCard),
        ),
        title: Text('Delete all voicemails from $label?', style: ADText.threadName(c: AvaDialTheme.text)),
        content: Text(
          'Every recording in this thread will be removed from your inbox.',
          style: ADText.preview(c: AvaDialTheme.textSoft),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text('Cancel', style: ADText.preview(c: AvaDialTheme.textSoft)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text('Delete', style: ADText.preview(c: AD.danger)),
          ),
        ],
      ),
    );
    if (ok != true) return;
    var allOk = true;
    for (final c in t.cards) {
      final done = await InboxApi.hideCard(t.conv, c.stableId);
      if (!done) allOk = false;
    }
    Analytics.capture('inbox_thread_deleted', {'ok': allOk, 'cards': t.cards.length});
    if (!mounted) return;
    if (allOk) {
      final next = (_threads ?? const <InboxThread>[]).where((x) => x.conv != t.conv).toList();
      setState(() => _threads = next);
      unawaited(InboxThreadCache.I.save(next)); // keep the cache in step
    } else {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('Some voicemails couldn’t be deleted — try again.')));
      await _reload();
    }
  }

  /// Marks every card in [t] that has a recording as heard (clears the
  /// accent/dot even for cards the owner never actually pressed play on).
  Future<void> _markThreadHeard(InboxThread t) async {
    for (final c in t.cards) {
      if (c.hasRecording) await InboxHeardStore.I.markHeard(c.stableId);
    }
    Analytics.capture('inbox_thread_marked_heard', {'cards': t.cards.length});
    if (!mounted) return;
    setState(() {
      _heardIds = {..._heardIds, ...t.cards.where((c) => c.hasRecording).map((c) => c.stableId)};
    });
  }

  String _relativeTime(int ms) {
    if (ms <= 0) return '';
    final dt = DateTime.fromMillisecondsSinceEpoch(ms);
    final diff = DateTime.now().difference(dt);
    if (diff.inMinutes < 1) return 'now';
    if (diff.inMinutes < 60) return '${diff.inMinutes}m';
    if (diff.inHours < 24) return '${diff.inHours}h';
    if (diff.inDays < 7) return '${diff.inDays}d';
    return '${dt.month}/${dt.day}/${dt.year % 100}';
  }
}

/// One long-press menu row for the thread-list sheet — mirrors
/// `_CardMenuRow` in inbox_thread_screen.dart (same leading/label/onTap
/// shape), kept as its own private copy since that class is file-private.
class _ThreadMenuRow extends StatelessWidget {
  final IconData icon;
  final Color color;
  final String label;
  final VoidCallback onTap;
  final bool danger;
  const _ThreadMenuRow({
    required this.icon,
    required this.color,
    required this.label,
    required this.onTap,
    this.danger = false,
  });

  @override
  Widget build(BuildContext context) {
    return ListTile(
      leading: PhosphorIcon(icon, color: color),
      title: Text(label,
          style: ADText.rowName(c: danger ? AD.danger : AvaDialTheme.text)),
      onTap: onTap,
    );
  }
}
