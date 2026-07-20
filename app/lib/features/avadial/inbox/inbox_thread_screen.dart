import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:share_plus/share_plus.dart';

import '../../../core/active_thread.dart';
import '../../../core/analytics.dart';
import '../../../core/api_auth.dart';
import '../../../core/audio_playback_service.dart';
import '../../../core/brain_consent.dart';
import '../../../core/config.dart';
import '../../../core/local_brain/local_brain.dart';
import '../../../core/ui/avatok_dark.dart';
// [AVAINBOX-3] `show` is REQUIRED, not tidiness: contacts.dart declares its own
// `Directory` (the AvaTOK user directory), which collides with dart:io's
// `Directory` used by the download fallback below. An unqualified import here
// breaks the build.
import '../../avatok/contacts.dart' show Contact, ContactsStore;
import '../../avatok/media.dart' show MediaService;
import '../../campaigns/campaign_detail_screen.dart';
import '../../campaigns/campaign_inbox_cards.dart' show buildCampaignCard;
import '../avadial_channel.dart';
import '../avadial_theme.dart';
import '../block_list.dart';
import '../contact_edit_screen.dart';
import '../contact_overrides.dart';
import '../device_contacts.dart';
import 'inbox_api.dart';
import 'inbox_caller_name.dart';
import 'inbox_card_meta.dart';
import 'inbox_forward.dart';
import 'inbox_heard_store.dart';
import 'inbox_send_to_chat.dart';

/// AvaDial Inbox thread — one caller's voicemail/Ava-Receptionist history,
/// chat-thread style (Specs/PLAN-2026-07-16-ava-receptionist-guardian-FINAL.md
/// AVA-RCPT-9): each screened call is a card (audio player + transcript
/// underneath + timestamp), newest at the BOTTOM, a back button at the top,
/// and every future call from the same number appends to this same thread.
///
/// Reuses the pattern already proven by `_ReceptionistCard` /
/// `VoicemailCard` in app/lib/features/avatok/ (audio fetched owner-authed and
/// cached per-account via `MediaService.cachedBlob`/`writeBlob`) WITHOUT
/// importing those private/feature-coupled widgets — this is a fresh,
/// self-contained card for the standalone Inbox surface, per the lane's hard
/// rule to leave chat_thread.dart untouched.

/// [INBOX-LISTMENU-1] The "Rename caller" dialog UI, extracted so the
/// thread-list screen's long-press menu (inbox_list_screen.dart) can show the
/// EXACT same dialog as this screen's card menu without duplicating markup.
/// Pure UI — it does NOT write [ContactOverrides] itself; the caller does
/// that (see `_renameCaller` above / `_renameThreadCaller` in
/// inbox_list_screen.dart), matching the pre-existing save semantics: null =
/// cancelled, empty string = "clear the override".
Future<String?> promptRenameCaller(BuildContext context, {String? currentName}) {
  final ctrl = TextEditingController(text: currentName ?? '');
  return showDialog<String>(
    context: context,
    builder: (ctx) => AlertDialog(
      backgroundColor: AvaDialTheme.surface2,
      shape: RoundedRectangleBorder(
        side: const BorderSide(color: AvaDialTheme.border, width: 1),
        borderRadius: BorderRadius.circular(AD.rListCard),
      ),
      title: Text('Rename caller', style: ADText.threadName(c: AvaDialTheme.text)),
      content: TextField(
        controller: ctrl,
        autofocus: true,
        style: ADText.rowName(c: AvaDialTheme.text),
        decoration: InputDecoration(
          hintText: 'Display name',
          hintStyle: ADText.preview(c: AvaDialTheme.textMute),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(ctx),
          child: Text('Cancel', style: ADText.preview(c: AvaDialTheme.textSoft)),
        ),
        TextButton(
          onPressed: () => Navigator.pop(ctx, ctrl.text.trim()),
          child: Text('Save', style: ADText.preview(c: AvaDialTheme.accent)),
        ),
      ],
    ),
  );
}

/// [AVAINBOX-1] Mirrors `ChatThreadRegistry` (audio_playback_service.dart /
/// chat_thread.dart) so the app-wide [MiniAudioPlayerBar] can reopen the right
/// Inbox thread when its "now playing" bar is tapped for a voicemail whose
/// `AudioTrack.originRoute` is `'inbox:<conv>'` — this lane's own route
/// namespace, distinct from chat's `convKey` scheme so the two never collide.
///
/// COMPOSES rather than clobbers: it captures whatever [AudioPlaybackService
/// .onTapOrigin] was already installed (e.g. `ChatThreadRegistry`'s hook, if a
/// chat thread was opened earlier this session) and falls through to it for
/// any track whose `originRoute` isn't one of this lane's `inbox:` keys.
///
/// KNOWN LIMITATION (documented, not silently swallowed): `ChatThreadRegistry
/// ._ensureNavHook()` does NOT compose — it only guards on its OWN internal
/// `_installed` flag and unconditionally overwrites `onTapOrigin` the first
/// time ANY chat thread opens, with no read of the previous hook. So if a
/// chat thread is opened for the first time AFTER this registry has already
/// installed itself, chat's hook silently replaces ours and inbox-track taps
/// stop navigating (they just no-op past that point). This registry protects
/// the OTHER ordering (inbox installs after chat) perfectly; the reverse
/// requires a change on chat's side, which is outside this lane's file
/// ownership (chat_thread.dart is AVAVM-PLAYER-1's) — flagged in the handover
/// report rather than worked around here.
abstract class InboxThreadRegistry {
  static final Map<String, InboxThread> _byRoute = {};
  static bool _installed = false;

  static void remember(String route, InboxThread thread) {
    _byRoute[route] = thread;
    _ensureHook();
  }

  static void _ensureHook() {
    if (_installed) return;
    _installed = true;
    final previous = AudioPlaybackService.onTapOrigin;
    AudioPlaybackService.onTapOrigin = (context, track) async {
      final route = track.originRoute;
      final thread = route != null ? _byRoute[route] : null;
      if (thread != null) {
        await Navigator.of(context, rootNavigator: true).push(
          MaterialPageRoute(builder: (_) => InboxThreadScreen(thread: thread)),
        );
        return;
      }
      await previous?.call(context, track);
    };
  }
}

class InboxThreadScreen extends StatefulWidget {
  final InboxThread thread;
  const InboxThreadScreen({super.key, required this.thread});

  @override
  State<InboxThreadScreen> createState() => _InboxThreadScreenState();
}

class _InboxThreadScreenState extends State<InboxThreadScreen> {
  late Future<List<InboxCard>> _future;
  final _scroll = ScrollController();

  /// [AVAINBOX-1] This lane's `AudioTrack.originRoute` / `ActiveThread` key —
  /// distinct namespace from chat's plain `convKey` so the shared
  /// MiniAudioPlayerBar/registry can tell the two apart (see
  /// `InboxThreadRegistry` above).
  String get _routeKey => 'inbox:${widget.thread.conv}';

  // [AVAINBOX-1] ONE canonical resolver (inbox_caller_name.dart) replaces the
  // old phone-only override/DeviceContacts duplication — see inbox_list_
  // screen.dart's `_labelFor` for the twin fix and why it was needed.
  ResolvedCallerName? _resolved;
  StreamSubscription<List<Contact>>? _contactsSub;

  String? get _phone => widget.thread.telPhone ??
      (widget.thread.cards.isNotEmpty ? widget.thread.cards.last.callerPhone : null);

  String get _title {
    if (widget.thread.isAnonymous) return 'Hidden number';
    final r = _resolved;
    if (r != null) return r.name;
    // Resolution hasn't landed yet — fast synchronous guess (same fallback
    // chain as the list screen) so the app bar never flashes empty.
    final name = widget.thread.latest.callerName;
    if (name != null && name.isNotEmpty) return name;
    return _phone ?? 'Unknown caller';
  }

  bool get _isSavedContact {
    final phone = _phone;
    if (phone == null) return true; // no number to save → hide the action
    final tier = _resolved?.tier;
    if (tier != null) {
      return tier == 'override' || tier == 'contacts_uid' || tier == 'contacts_phone' || tier == 'device_contacts';
    }
    final name = DeviceContacts.I.lookup(phone)?.name;
    return name != null && name.trim().isNotEmpty;
  }

  @override
  void initState() {
    super.initState();
    DeviceContacts.I.load();
    // [AVAVM-PLAYER-1 integration] Mark this thread "on screen" so the shared
    // MiniAudioPlayerBar hides while the user is looking at it, and register
    // it so a mini-player tap can navigate back here — see InboxThreadRegistry
    // above. Both MUST happen (per lane brief: "it is not automatic").
    ActiveThread.enter(_routeKey);
    InboxThreadRegistry.remember(_routeKey, widget.thread);
    _future = InboxApi.cardsFor(widget.thread.conv);
    Analytics.capture('inbox_thread_opened', {
      'conv_hash': widget.thread.conv.hashCode,
      'anonymous': widget.thread.isAnonymous,
      'cards': widget.thread.cards.length,
    });
    // Mark read immediately — matches every other AvaTOK thread's open-to-read
    // behaviour so the list's unread dot clears on return.
    unawaited(InboxApi.markRead(widget.thread.conv));
    unawaited(_loadResolvedName());
    _contactsSub = ContactsStore.changes.listen((_) => _loadResolvedName());
    _future.then((cards) => unawaited(_ingestToBrain(cards)));
    WidgetsBinding.instance.addPostFrameCallback((_) => _jumpToEnd());
  }

  Future<void> _loadResolvedName() async {
    try {
      final r = await InboxCallerName.resolve(thread: widget.thread);
      if (mounted) setState(() => _resolved = r);
      Analytics.capture('inbox_name_resolution', {'tier': r.tier, 'via': 'thread_screen'});
    } catch (_) {/* keep the fast synchronous guess */}
  }

  /// [AVAINBOX-1] Feed voicemail transcripts to AvaBrain (owner spec: "find me
  /// the voicemail from Sonal 3 days ago"). Gated on the 'receptionist'
  /// guardrail already registered in the main Settings AvaBrain card
  /// (core/brain_consent.dart's `kBrainCapabilities` — "Let AvaBrain use your
  /// call notes and voicemails to answer for you"); this lane does NOT
  /// register a new toggle, it checks the existing one, exactly per the
  /// rulebook ("find how an existing app registers its guardrail toggle and
  /// follow that exact pattern; do not invent a parallel one"). Text +
  /// metadata only — never raw audio bytes. De-duped per card via
  /// [InboxBrainIngestStore] so reopening the same thread doesn't re-ingest
  /// the same transcript every time. [ONEBRAIN-B3-APP] The transcript now goes
  /// to the on-device brain (AvaLocalBrain) instead of the user's Gemini File
  /// Search store (RagService, CUT under B-D2); the server-readable voicemail
  /// domain is ingested server-side (brain.ts), so nothing chat/voicemail
  /// content leaves the device from here.
  Future<void> _ingestToBrain(List<InboxCard> cards) async {
    bool allowed;
    try {
      allowed = await BrainConsent.isOn('receptionist');
    } catch (_) {
      allowed = true; // default ON (opt-out model) if the consent read fails
    }
    if (!allowed) {
      Analytics.capture('inbox_brain_ingest', {'ok': false, 'reason': 'guardrail_off', 'cards': cards.length});
      return;
    }
    var attempted = 0, ingested = 0;
    for (final c in cards) {
      final transcript = c.transcript?.trim();
      if (transcript == null || transcript.isEmpty) continue;
      try {
        if (await InboxBrainIngestStore.I.isIngested(c.stableId)) continue;
      } catch (_) {/* best-effort — worst case a card is ingested twice */}
      attempted++;
      try {
        final meta = await InboxCardMetaStore.I.forCard(c.stableId);
        final dt = c.createdAtMs > 0 ? DateTime.fromMillisecondsSinceEpoch(c.createdAtMs) : DateTime.now();
        final dateStr = '${dt.year}-${dt.month.toString().padLeft(2, '0')}-${dt.day.toString().padLeft(2, '0')}';
        final descr = StringBuffer()
          ..writeln('Voicemail from $_title')
          ..writeln('Date: $dateStr')
          ..writeln('Duration: ${c.durationSec}s');
        if (meta != null && meta.tags.isNotEmpty) descr.writeln('Tags: ${meta.tags.join(', ')}');
        if (meta?.title != null && meta!.title!.isNotEmpty) descr.writeln('Title: ${meta.title}');
        descr.writeln('Transcript: $transcript');
        await AvaLocalBrain.I.ingest(
          domain: 'voicemail',
          kind: 'voicemail_transcript',
          text: descr.toString(),
          meta: {'convKey': 'voicemail:$_title'},
          ts: c.createdAtMs > 0
              ? c.createdAtMs ~/ 1000
              : DateTime.now().millisecondsSinceEpoch ~/ 1000,
          sourceId: 'vm:${c.stableId}',
        );
        await InboxBrainIngestStore.I.markIngested(c.stableId);
        ingested++;
      } catch (_) {/* best-effort — never blocks the thread from rendering */}
    }
    if (attempted > 0) {
      Analytics.capture('inbox_brain_ingest', {
        'ok': ingested > 0, 'attempted': attempted, 'ingested': ingested, 'cards': cards.length,
      });
    }
  }

  /// "Rename caller / Edit name" — reuses [ContactOverrides.setName], the
  /// SAME override store the Calls app's Contacts tab already writes
  /// (contact_edit_screen.dart / contact_row_menu.dart), so a rename here
  /// also shows up there and vice versa. Number-only (this dialog is not
  /// offered for [InboxThread.isAnonymous] threads — see the card menu).
  /// The dialog itself is [promptRenameCaller] (extracted top-level function
  /// below) so the thread-LIST screen's long-press menu can reuse the exact
  /// same UI/flow (inbox_list_screen.dart `_renameThreadCaller`).
  Future<void> _renameCaller() async {
    final phone = _phone;
    if (phone == null) return;
    final result = await promptRenameCaller(
        context, currentName: _resolved?.tier == 'override' ? _resolved!.name : null);
    if (result == null) return; // cancelled
    final newName = result.isEmpty ? null : result;
    await ContactOverrides.I.setName(phone, newName);
    Analytics.capture('inbox_rename_caller', {'has_number': true, 'cleared': newName == null});
    // Re-resolve rather than hand-patching local state — the override just
    // written may not even win anymore once the OTHER tiers (ContactsStore/
    // DeviceContacts) are consulted, and this keeps ONE source of truth
    // (inbox_caller_name.dart) instead of two ways to compute the title.
    unawaited(_loadResolvedName());
  }

  /// Owner soft-delete for one card — confirm, call [InboxApi.hideCard] (the
  /// same server RPC chat_thread.dart's "delete for me" uses), then drop it
  /// from the in-memory list immediately so the card disappears without
  /// waiting on a full refetch. The next `cardsFor()` read (e.g. re-opening
  /// this thread) already excludes it server-side via the `hidden` filter in
  /// `InboxApi._fetchAll()`.
  Future<void> _deleteCard(InboxCard card) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AvaDialTheme.surface2,
        shape: RoundedRectangleBorder(
          side: const BorderSide(color: AvaDialTheme.border, width: 1),
          borderRadius: BorderRadius.circular(AD.rListCard),
        ),
        title: Text('Delete this voicemail?', style: ADText.threadName(c: AvaDialTheme.text)),
        content: Text(
          'The recording will be removed from your inbox.',
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
    final done = await InboxApi.hideCard(widget.thread.conv, card.stableId);
    Analytics.capture('inbox_voicemail_deleted', {'ok': done});
    if (!mounted) return;
    if (done) {
      setState(() {
        _future = _future.then((list) => list.where((c) => c.stableId != card.stableId).toList());
      });
    } else {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('Couldn’t delete — try again.')));
    }
  }

  @override
  void dispose() {
    ActiveThread.leave(_routeKey);
    _contactsSub?.cancel();
    _scroll.dispose();
    super.dispose();
  }

  void _jumpToEnd() {
    if (_scroll.hasClients) _scroll.jumpTo(_scroll.position.maxScrollExtent);
  }

  /// [INBOX-DAYGROUP-1] Splits [cards] (already oldest-first) into a flat
  /// header+card list with a date separator inserted before the first card of
  /// each calendar day, so the thread reads like a chat log grouped by day as
  /// the user scrolls — "Today" / "Yesterday" / "Mon, 14 Jul 2026".
  List<_ThreadItem> _dayGrouped(List<InboxCard> cards) {
    final out = <_ThreadItem>[];
    String? lastDayKey;
    for (final c in cards) {
      final dt = c.createdAtMs > 0
          ? DateTime.fromMillisecondsSinceEpoch(c.createdAtMs)
          : DateTime.now();
      final dayKey = '${dt.year}-${dt.month}-${dt.day}';
      if (dayKey != lastDayKey) {
        out.add(_ThreadItem.header(_dayLabel(dt)));
        lastDayKey = dayKey;
      }
      out.add(_ThreadItem.card(c));
    }
    return out;
  }

  String _dayLabel(DateTime dt) {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final that = DateTime(dt.year, dt.month, dt.day);
    final diffDays = today.difference(that).inDays;
    if (diffDays == 0) return 'Today';
    if (diffDays == 1) return 'Yesterday';
    const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    final wd = weekdays[dt.weekday - 1];
    final mo = months[dt.month - 1];
    return '$wd, ${dt.day} $mo ${dt.year}';
  }

  Future<void> _addToContacts() async {
    final phone = _phone;
    if (phone == null) return;
    Analytics.capture('inbox_add_to_contacts_tapped', {'has_number': true});
    await Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => ContactEditScreen(number: phone, create: true),
    ));
    if (mounted) setState(() {}); // re-check _isSavedContact after return
  }

  Future<void> _block({required bool reportSpam}) async {
    final phone = _phone;
    if (phone == null) return;
    if (reportSpam) {
      await BlockList.I.reportSpam(phone, label: 'Reported from Inbox');
    } else {
      await BlockList.I.block(phone);
    }
    Analytics.capture('inbox_block_tapped', {'report_spam': reportSpam});
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(reportSpam ? 'Blocked and reported as spam.' : 'Number blocked.'),
    ));
  }

  @override
  Widget build(BuildContext context) {
    final phone = _phone;
    return Scaffold(
      backgroundColor: AvaDialTheme.bg,
      appBar: AppBar(
        backgroundColor: AvaDialTheme.surface,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        foregroundColor: AvaDialTheme.text,
        leading: AdBackButton(),
        shape: const Border(bottom: BorderSide(color: AvaDialTheme.border, width: 1)),
        title: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(_title, style: ADText.threadName(c: AvaDialTheme.text)),
          if (phone != null && _title != phone)
            Text(phone, style: ADText.statCaption(c: AvaDialTheme.textMute)),
        ]),
        actions: [
          if (phone != null)
            PopupMenuButton<String>(
              icon: Icon(Icons.more_vert, color: AvaDialTheme.text),
              color: AvaDialTheme.surface,
              onSelected: (v) {
                switch (v) {
                  case 'add': _addToContacts(); break;
                  case 'spam': _block(reportSpam: true); break;
                  case 'block': _block(reportSpam: false); break;
                }
              },
              itemBuilder: (context) => [
                if (!_isSavedContact)
                  PopupMenuItem(
                    value: 'add',
                    child: Text('Add to contacts', style: ADText.preview(c: AvaDialTheme.text)),
                  ),
                PopupMenuItem(
                  value: 'spam',
                  child: Text('Block & report spam', style: ADText.preview(c: AvaDialTheme.text)),
                ),
                PopupMenuItem(
                  value: 'block',
                  child: Text('Block', style: ADText.preview(c: AvaDialTheme.text)),
                ),
              ],
            ),
        ],
      ),
      body: SafeArea(
        child: FutureBuilder<List<InboxCard>>(
          future: _future,
          builder: (context, snap) {
            if (snap.connectionState != ConnectionState.done) {
              return const Center(child: CircularProgressIndicator(color: AvaDialTheme.accent));
            }
            final cards = snap.data ?? widget.thread.cards;
            if (cards.isEmpty) {
              return Center(
                child: Text('No messages in this thread yet',
                    style: ADText.preview(c: AvaDialTheme.textSoft)),
              );
            }
            WidgetsBinding.instance.addPostFrameCallback((_) => _jumpToEnd());
            final items = _dayGrouped(cards);
            return ListView.builder(
              controller: _scroll,
              padding: const EdgeInsets.fromLTRB(14, 12, 14, 16),
              itemCount: items.length,
              itemBuilder: (context, i) {
                final item = items[i];
                if (item.isHeader) {
                  return Padding(
                    padding: const EdgeInsets.only(top: 4, bottom: 10),
                    child: _DateSeparator(label: item.dayLabel!),
                  );
                }
                final card = item.card!;
                // [AVA-CAMP-FL-NAV] ADDITIVE ONLY: a campaign row (sender ==
                // 'ava_campaign', see InboxCard.isCampaign/inbox_api.dart)
                // renders via buildCampaignCard instead of the default
                // _VoicemailCard. Every non-campaign card falls straight
                // through to the unchanged path below — card.rawBody is only
                // ever non-null for a campaign row, so this branch is a no-op
                // for every voicemail/recept card.
                if (card.isCampaign && card.rawBody != null) {
                  final campaignWidget = buildCampaignCard(
                    card.rawBody!,
                    onRetryMissed: () {
                      final id = _campaignIdFrom(card.rawBody!, card.conv);
                      if (id == null || id.isEmpty) return;
                      Navigator.of(context).push(MaterialPageRoute<void>(
                        builder: (_) => CampaignDetailScreen(campaignId: id),
                      ));
                    },
                    onOpenDashboard: () {
                      final id = _campaignIdFrom(card.rawBody!, card.conv);
                      if (id == null || id.isEmpty) return;
                      Navigator.of(context).push(MaterialPageRoute<void>(
                        builder: (_) => CampaignDetailScreen(campaignId: id),
                      ));
                    },
                  );
                  if (campaignWidget != null) {
                    return Padding(
                      padding: const EdgeInsets.only(bottom: 10),
                      child: campaignWidget,
                    );
                  }
                  // buildCampaignCard returned null (unrecognized envelope
                  // `t`) — fall through to the default rendering below.
                }
                return Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: _VoicemailCard(
                    card: card,
                    callerName: _title,
                    callerNumber: card.callerPhone ?? _phone,
                    isTel: widget.thread.isTel,
                    originRoute: _routeKey,
                    onBlock: () => _block(reportSpam: false),
                    onRename: _renameCaller,
                    onDelete: () => _deleteCard(card),
                  ),
                );
              },
            );
          },
        ),
      ),
    );
  }
}

/// [AVA-CAMP-FL-NAV] Best-effort campaign-id lookup for a campaign card's
/// dashboard shortcuts (`onRetryMissed`/`onOpenDashboard` above). Prefers an
/// explicit id in the envelope (no fixed key name is pinned by the campaign
/// card's own file — both `campaign_id` and `campaignId` are checked
/// defensively, same pattern as `campaign_inbox_cards.dart`'s ASSUMPTIONS
/// note). Falls back to the conv id, in case the backend threads campaign
/// messages one-conv-per-campaign the same way `voicemail_<owner>__<caller>`
/// / `recept_<owner>__<caller>` are namespaced (see InboxApi._callerKeyOf).
String? _campaignIdFrom(Map<String, dynamic> body, String conv) {
  final v = body['campaign_id'] ?? body['campaignId'];
  if (v != null && v.toString().trim().isNotEmpty) return v.toString();
  const prefix = 'campaign_';
  if (conv.startsWith(prefix)) {
    final rest = conv.substring(prefix.length);
    final sep = rest.lastIndexOf('__');
    if (sep >= 0) return rest.substring(sep + 2);
  }
  return null;
}

/// A flat-list entry for the day-grouped thread view: either a date-separator
/// header or one voicemail card. Kept as a tiny sum type rather than two
/// parallel lists so `ListView.builder` can address both by a single index.
class _ThreadItem {
  final String? dayLabel;
  final InboxCard? card;
  const _ThreadItem._(this.dayLabel, this.card);
  factory _ThreadItem.header(String label) => _ThreadItem._(label, null);
  factory _ThreadItem.card(InboxCard c) => _ThreadItem._(null, c);
  bool get isHeader => dayLabel != null;
}

/// Centered day-separator pill ("Today" / "Yesterday" / "Mon, 14 Jul 2026").
class _DateSeparator extends StatelessWidget {
  final String label;
  const _DateSeparator({required this.label});
  @override
  Widget build(BuildContext context) {
    return Center(
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
        decoration: BoxDecoration(
          color: AvaDialTheme.surface2,
          borderRadius: BorderRadius.circular(100),
          border: Border.all(color: AvaDialTheme.border, width: 1),
        ),
        child: Text(label, style: ADText.statCaption(c: AvaDialTheme.textMute)),
      ),
    );
  }
}

/// One voicemail/receptionist message: caller name + number, audio player +
/// transcript underneath + time/date. Mirrors `_ReceptionistCard`'s
/// cache-first playback (chat_thread.dart) but is its own widget so this lane
/// never imports that file.
class _VoicemailCard extends StatefulWidget {
  final InboxCard card;
  /// Thread-level caller display name (resolved contact name, or a formatted
  /// number/"Hidden number"/"Unknown caller" fallback) — shown on every card
  /// so the metadata reads correctly even scrolled far from the header.
  final String callerName;
  /// The PSTN number for this specific card, if any (falls back to the
  /// thread's number when the card itself doesn't carry one).
  final String? callerNumber;
  /// True when the parent thread is a `tel:` (PSTN) thread — gates the
  /// "Block caller" long-press action (owner spec: only for tel: threads).
  final bool isTel;
  /// This thread's `AudioTrack.originRoute` / `ActiveThread` key
  /// (`'inbox:<conv>'`) — lets the shared MiniAudioPlayerBar hide while this
  /// thread is open and navigate back here on tap (see InboxThreadRegistry).
  final String originRoute;
  final VoidCallback? onBlock;
  final Future<void> Function()? onRename;
  final Future<void> Function()? onDelete;
  const _VoicemailCard({
    required this.card,
    required this.callerName,
    required this.originRoute,
    this.callerNumber,
    this.isTel = false,
    this.onBlock,
    this.onRename,
    this.onDelete,
  });

  @override
  State<_VoicemailCard> createState() => _VoicemailCardState();
}

class _VoicemailCardState extends State<_VoicemailCard> {
  bool _loading = false;
  bool _expanded = true; // transcript shown by default, per the product spec
  bool _heard = false;
  InboxCardMeta? _meta;

  InboxCard get _c => widget.card;

  /// [AVAINBOX-1] CONTENT-ADDRESSED cache key — the true root-cause fix for
  /// the owner's "it keeps redownloading" report. `_c.mediaRef` is the R2
  /// recording key (`voicemail/<owner>/<callerKey>/<callId>.wav` /
  /// `pstn:<CallUUID>` etc. — see worker/src/do/voicemail_room.ts,
  /// worker/src/routes/pstn.ts) and is the ONE identifier that means "this
  /// exact recording" regardless of which client-side surface is reading it.
  /// The previous key, `'inbox_${sessionId ?? id}'`, was a SECOND, INDEPENDENT
  /// cache namespace from the one `chat_thread.dart`'s `_ReceptionistCard`
  /// already uses for the SAME kind of recording (`'recept_$sessionId'`,
  /// chat_thread.dart ~L10142/10185/10237) — confirmed by grep, not assumed.
  /// Two lanes, two keys, for what can be the identical R2 object: every time
  /// a recording was viewed through whichever surface DIDN'T already have it
  /// cached under ITS key, it re-downloaded — even though the bytes were
  /// sitting on disk under the other lane's name. Falls back to the old
  /// session/id scheme only for the rare legacy card with no `media_ref` at
  /// all (nothing to play, so this only matters for the has_recording==false
  /// case, which never calls `_fetchBytes`/`_prefetch` anyway).
  String get _cacheKey {
    final ref = _c.mediaRef;
    if (ref != null && ref.isNotEmpty) {
      return 'vm_${ref.replaceAll(RegExp(r'[^a-zA-Z0-9_.-]'), '_')}';
    }
    return 'inbox_${_c.sessionId ?? _c.id}';
  }

  /// [AVAVM-PLAYER-1 integration] Stable, globally-unique track id for the
  /// shared [AudioPlaybackService] — namespaced `ibx:` so it can never collide
  /// with a chat-thread voice-note's own trackId scheme.
  String get _trackId => 'ibx:$_cacheKey';

  String? get _recordingUrl {
    final key = _c.mediaRef;
    if (key == null || key.isEmpty) return null;
    // Explicit endpoint per this lane's brief: GET /api/voicemail/recording?key=<r2key>.
    return '$kApiBase/voicemail/recording?key=${Uri.encodeQueryComponent(key)}';
  }

  @override
  void initState() {
    super.initState();
    _prefetch();
    _loadHeard();
    _loadMeta();
  }

  Future<void> _loadHeard() async {
    try {
      final h = await InboxHeardStore.I.isHeard(_c.stableId);
      if (mounted) setState(() => _heard = h);
    } catch (_) {/* leave unheard */}
  }

  /// [AVA-INBOX-READSTATE] Persist the "heard" marker the FIRST time playback
  /// starts (never on thread open) and fire telemetry. Idempotent — a card
  /// already heard is a no-op. The store is per-account (DiskCache scoped to
  /// AccountScope.id), so a shared phone keeps each account's heard-state
  /// separate. Email rides the event automatically (Analytics._base).
  void _markHeardOnce() {
    if (_heard) return;
    unawaited(InboxHeardStore.I.markHeard(_c.stableId));
    Analytics.capture('voicemail_heard_marked', {
      'conv_hash': _c.conv.hashCode,
      'duration_s': _c.durationSec,
      'has_recording': _c.hasRecording,
    });
  }

  Future<void> _loadMeta() async {
    try {
      final m = await InboxCardMetaStore.I.forCard(_c.stableId);
      if (mounted && m != null) setState(() => _meta = m);
    } catch (_) {/* leave untagged/untitled */}
  }

  Future<void> _prefetch() async {
    if (!_c.hasRecording) return;
    try {
      final cached = await MediaService.cachedBlob(_cacheKey);
      final t0 = DateTime.now().millisecondsSinceEpoch;
      if (cached != null && cached.isNotEmpty) {
        Analytics.capture('inbox_voicemail_cache', {'hit': true, 'stage': 'prefetch'});
        return;
      }
      final url = _recordingUrl;
      if (url == null) return;
      final r = await ApiAuth.getBytes(url);
      if (r.statusCode == 200 && r.bodyBytes.isNotEmpty) {
        await MediaService.writeBlob(_cacheKey, r.bodyBytes);
        Analytics.capture('inbox_voicemail_cache', {
          'hit': false, 'stage': 'prefetch', 'bytes': r.bodyBytes.length,
          'load_ms': DateTime.now().millisecondsSinceEpoch - t0,
        });
      }
    } catch (_) {
      // Best-effort — _togglePlay() fetches on demand if this misses.
    }
  }

  Future<void> _togglePlay() async {
    final cur = AudioPlaybackService.I.state.value;
    final isThisTrack = AudioPlaybackService.I.isCurrent(_trackId);
    if (isThisTrack && cur != null && cur.playing) {
      await AudioPlaybackService.I.pause();
      return;
    }
    if (isThisTrack && cur != null && !cur.playing) {
      // Paused on THIS track — resume in place rather than re-fetching bytes.
      await AudioPlaybackService.I.resume();
      _markHeardOnce();
      if (mounted) setState(() => _heard = true);
      return;
    }
    if (!_c.hasRecording) return;
    setState(() => _loading = true);
    final t0 = DateTime.now().millisecondsSinceEpoch;
    try {
      Uint8List? bytes = await MediaService.cachedBlob(_cacheKey);
      final fromCache = bytes != null && bytes.isNotEmpty;
      if (!fromCache) {
        final url = _recordingUrl;
        if (url == null) {
          if (mounted) setState(() => _loading = false);
          return;
        }
        final r = await ApiAuth.getBytes(url);
        if (r.statusCode != 200 || r.bodyBytes.isEmpty) {
          Analytics.capture('inbox_voicemail_playback', {
            'ok': false, 'cached': false, 'status': r.statusCode,
          });
          if (mounted) setState(() => _loading = false);
          return;
        }
        bytes = r.bodyBytes;
        await MediaService.writeBlob(_cacheKey, bytes);
      }
      // [AVAINBOX-1] Proves the caching fix in production: cache-hit vs miss
      // on every actual play tap (not just the silent background prefetch).
      Analytics.capture('inbox_voicemail_cache', {'hit': fromCache, 'stage': 'play'});
      await AudioPlaybackService.I.play(
        track: AudioTrack(
          trackId: _trackId,
          title: widget.callerName,
          subtitle: 'Voicemail',
          originRoute: widget.originRoute,
        ),
        bytes: bytes,
      );
      Analytics.capture('inbox_voicemail_playback', {
        'ok': true, 'cached': fromCache, 'bytes': bytes.length,
        'load_ms': DateTime.now().millisecondsSinceEpoch - t0,
      });
      // [INBOX-HEARD-1] Mark heard the first time PLAY is pressed — NOT on
      // thread open (owner spec). Best-effort; a write failure just leaves
      // the card looking unheard next time, which is safe (never loses data).
      _markHeardOnce();
      if (mounted) setState(() { _loading = false; _heard = true; });
    } catch (e) {
      Analytics.capture('inbox_voicemail_playback', {'ok': false, 'cached': false});
      if (mounted) setState(() => _loading = false);
    }
  }

  /// Prefers the shared player's live/known duration for THIS track (accurate
  /// once decoded) and falls back to the server-reported `duration_s` — see
  /// `AudioPlaybackService.knownDuration`.
  String _durationLabel(Duration? liveDuration) {
    if (liveDuration != null && liveDuration.inSeconds > 0) {
      final m = liveDuration.inMinutes, sec = liveDuration.inSeconds % 60;
      return '$m:${sec.toString().padLeft(2, '0')}';
    }
    final s = _c.durationSec;
    if (s <= 0) return '';
    final m = s ~/ 60, sec = s % 60;
    return '$m:${sec.toString().padLeft(2, '0')}';
  }

  /// "14:32 · 16 Jul 2026" — owner spec (JOB 2 item 4): time + date together
  /// on every card, distinct from the day-separator header above it.
  String get _timeLabel {
    if (_c.createdAtMs <= 0) return '';
    final dt = DateTime.fromMillisecondsSinceEpoch(_c.createdAtMs);
    final hh = dt.hour.toString().padLeft(2, '0');
    final mm = dt.minute.toString().padLeft(2, '0');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return '$hh:$mm · ${dt.day} ${months[dt.month - 1]} ${dt.year}';
  }

  /// "Voicemail from <caller> <yyyy-MM-dd>.wav" — readable filename per the
  /// lane brief (it becomes the share/download filename). Sanitized against
  /// filesystem-illegal characters.
  String get _fileName {
    final caller = widget.callerName.replaceAll(RegExp(r'[\\/:*?"<>|]'), '_').trim();
    final dt = _c.createdAtMs > 0
        ? DateTime.fromMillisecondsSinceEpoch(_c.createdAtMs)
        : DateTime.now();
    final date =
        '${dt.year}-${dt.month.toString().padLeft(2, '0')}-${dt.day.toString().padLeft(2, '0')}';
    return 'Voicemail from ${caller.isEmpty ? 'Unknown' : caller} $date.wav';
  }

  /// Cache-first bytes fetch shared by play/share/download — mirrors
  /// `_togglePlay`'s own fetch path but returns the bytes instead of playing
  /// them, so Share/Download reuse the exact same cache (`MediaService
  /// .cachedBlob`/`writeBlob` + `ApiAuth.getBytes`) rather than re-downloading.
  Future<Uint8List?> _fetchBytes() async {
    if (!_c.hasRecording) return null;
    try {
      final cached = await MediaService.cachedBlob(_cacheKey);
      if (cached != null && cached.isNotEmpty) return cached;
      final url = _recordingUrl;
      if (url == null) return null;
      final r = await ApiAuth.getBytes(url);
      if (r.statusCode == 200 && r.bodyBytes.isNotEmpty) {
        await MediaService.writeBlob(_cacheKey, r.bodyBytes);
        return r.bodyBytes;
      }
    } catch (_) {/* caller shows the failure snackbar */}
    return null;
  }

  /// System share sheet with the audio file (WhatsApp/email/Messenger/etc via
  /// the OS chooser) — same pattern as `chat_thread.dart`'s receptionist-card
  /// share (`_ReceptionistCard._shareRecording`, not imported/modified here,
  /// just mirrored): write the cached bytes to a temp file with a readable
  /// name, then `Share.shareXFiles`.
  Future<void> _shareRecording() async {
    final bytes = await _fetchBytes();
    if (bytes == null) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Couldn’t load the recording to share.')));
      }
      return;
    }
    try {
      final dir = await getTemporaryDirectory();
      final f = File('${dir.path}/$_fileName');
      await f.writeAsBytes(bytes, flush: true);
      await Share.shareXFiles([XFile(f.path, mimeType: 'audio/wav')],
          subject: 'Voicemail from ${widget.callerName}');
      Analytics.capture('inbox_voicemail_shared', {'ok': true});
    } catch (e) {
      Analytics.capture('inbox_voicemail_shared', {'ok': false});
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('Couldn’t share the recording.')));
      }
    }
  }

  /// [INBOX-DOWNLOAD-2] Real "save to Downloads" — writes the cached bytes to
  /// a private temp file, then hands it to
  /// `AvaDialChannel.I.saveToDownloads` (new native `saveToDownloads` method,
  /// AvaDialPlugin.kt), which inserts into `MediaStore.Downloads` on API 29+
  /// (needs NO extra permission) or falls back to the legacy public Downloads
  /// dir on older Android IF `WRITE_EXTERNAL_STORAGE` is already granted.
  /// Falls back to the old app-scoped-directory save (Lane D's original gap
  /// fallback) on any channel failure or non-Android platform, so the file is
  /// never lost even when the MediaStore path can't be used.
  Future<void> _downloadRecording() async {
    final bytes = await _fetchBytes();
    if (bytes == null) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Couldn’t load the recording to download.')));
      }
      return;
    }
    try {
      final tmpDir = await getTemporaryDirectory();
      final tmp = File('${tmpDir.path}/$_fileName');
      await tmp.writeAsBytes(bytes, flush: true);
      await AvaDialChannel.I.saveToDownloads(
        path: tmp.path,
        filename: _fileName,
        mime: 'audio/wav',
      );
      Analytics.capture('inbox_voicemail_downloaded', {'ok': true, 'via': 'mediastore'});
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Saved to Downloads/AvaTok/$_fileName')));
      }
    } catch (e) {
      // Non-Android platform, or the native write failed (e.g. legacy Android
      // without WRITE_EXTERNAL_STORAGE) — fall back to the app-scoped dir so
      // the recording is still saved SOMEWHERE rather than lost.
      try {
        Directory? dir;
        try { dir = await getExternalStorageDirectory(); } catch (_) {/* not on this platform */}
        dir ??= await getApplicationDocumentsDirectory();
        final f = File('${dir.path}/$_fileName');
        await f.writeAsBytes(bytes, flush: true);
        Analytics.capture('inbox_voicemail_downloaded', {'ok': true, 'via': 'fallback'});
        if (mounted) {
          ScaffoldMessenger.of(context)
              .showSnackBar(SnackBar(content: Text('Saved to ${f.path}')));
        }
      } catch (e2) {
        Analytics.capture('inbox_voicemail_downloaded', {'ok': false});
        if (mounted) {
          ScaffoldMessenger.of(context)
              .showSnackBar(const SnackBar(content: Text('Couldn’t save the recording.')));
        }
      }
    }
  }

  /// [AVAINBOX-1] Renames the RECORDING itself (a title/note on the card) —
  /// distinct from "Rename caller" (`widget.onRename`, which renames the
  /// PERSON via `ContactOverrides`). Labelled "Edit voicemail title" in the
  /// menu specifically so the two are never confused.
  Future<void> _editTitle() async {
    final ctrl = TextEditingController(text: _meta?.title ?? '');
    final result = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AvaDialTheme.surface2,
        shape: RoundedRectangleBorder(
          side: const BorderSide(color: AvaDialTheme.border, width: 1),
          borderRadius: BorderRadius.circular(AD.rListCard),
        ),
        title: Text('Edit voicemail title', style: ADText.threadName(c: AvaDialTheme.text)),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          style: ADText.rowName(c: AvaDialTheme.text),
          decoration: InputDecoration(
            hintText: 'e.g. "Follow up with Sonal"',
            hintStyle: ADText.preview(c: AvaDialTheme.textMute),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: Text('Cancel', style: ADText.preview(c: AvaDialTheme.textSoft)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, ctrl.text.trim()),
            child: Text('Save', style: ADText.preview(c: AvaDialTheme.accent)),
          ),
        ],
      ),
    );
    if (result == null) return; // cancelled
    final title = result.isEmpty ? null : result;
    await InboxCardMetaStore.I.setTitle(_c.stableId, title);
    Analytics.capture('inbox_voicemail_title_edited', {'cleared': title == null});
    if (mounted) setState(() => _meta = (_meta ?? const InboxCardMeta()).copyWith(title: title, clearTitle: title == null));
  }

  /// [AVAINBOX-1] Free-text tags on ONE voicemail (owner spec: "tag" menu
  /// item) — comma-separated input, stored via [InboxCardMetaStore] and fed
  /// into the AvaBrain descriptor (`_ingestToBrain` in the parent State) so
  /// "find the voicemail I tagged X" can work.
  Future<void> _editTags() async {
    final ctrl = TextEditingController(text: (_meta?.tags ?? const []).join(', '));
    final result = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AvaDialTheme.surface2,
        shape: RoundedRectangleBorder(
          side: const BorderSide(color: AvaDialTheme.border, width: 1),
          borderRadius: BorderRadius.circular(AD.rListCard),
        ),
        title: Text('Tag this voicemail', style: ADText.threadName(c: AvaDialTheme.text)),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          style: ADText.rowName(c: AvaDialTheme.text),
          decoration: InputDecoration(
            hintText: 'Comma-separated, e.g. "urgent, follow-up"',
            hintStyle: ADText.preview(c: AvaDialTheme.textMute),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: Text('Cancel', style: ADText.preview(c: AvaDialTheme.textSoft)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, ctrl.text.trim()),
            child: Text('Save', style: ADText.preview(c: AvaDialTheme.accent)),
          ),
        ],
      ),
    );
    if (result == null) return; // cancelled
    final tags = result.split(',').map((t) => t.trim()).where((t) => t.isNotEmpty).toList();
    await InboxCardMetaStore.I.setTags(_c.stableId, tags);
    Analytics.capture('inbox_voicemail_tagged', {'tag_count': tags.length});
    if (mounted) setState(() => _meta = (_meta ?? const InboxCardMeta()).copyWith(tags: tags));
  }

  /// Long-press bottom sheet — same idiom as `contact_row_menu.dart`'s
  /// `showAvaDialRowMenu` (grab handle, `isScrollControlled`, PhosphorIcon
  /// leading rows). Share/Download/Forward/"Send to AvaTOK chat" only offered
  /// when there's a recording. Block only offered on a `tel:` thread (owner
  /// spec). [INBOX-SENDCHAT-1] "Send to AvaTOK chat" (single-contact picker,
  /// inbox_send_to_chat.dart) and [AVAINBOX-1] "Forward" (multi-select
  /// DM+group picker, inbox_forward.dart, `/api/msg/forward`) are DELIBERATELY
  /// both kept — they're genuinely different actions (one recipient vs many,
  /// groups included) sharing the same upload/envelope plumbing. Every item
  /// here is wired to real, working code — no stubs.
  Future<void> _showCardMenu(BuildContext context) async {
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
          if (_c.hasRecording)
            _CardMenuRow(
              icon: PhosphorIcons.shareNetwork(PhosphorIconsStyle.bold),
              color: AD.iconVideo,
              label: 'Share',
              onTap: () { Navigator.pop(sheetCtx); _shareRecording(); },
            ),
          if (_c.hasRecording)
            _CardMenuRow(
              icon: PhosphorIcons.arrowBendUpRight(PhosphorIconsStyle.bold),
              color: AD.iconVideo,
              label: 'Forward',
              onTap: () {
                Navigator.pop(sheetCtx);
                forwardVoicemail(context, card: _c, callerName: widget.callerName, fetchBytes: _fetchBytes);
              },
            ),
          if (_c.hasRecording)
            _CardMenuRow(
              icon: PhosphorIcons.downloadSimple(PhosphorIconsStyle.bold),
              color: AD.iconSearch,
              label: 'Download',
              onTap: () { Navigator.pop(sheetCtx); _downloadRecording(); },
            ),
          if (_c.hasRecording)
            _CardMenuRow(
              icon: PhosphorIcons.paperPlaneRight(PhosphorIconsStyle.bold),
              color: AD.iconVideo,
              label: 'Send to AvaTOK chat',
              onTap: () {
                Navigator.pop(sheetCtx);
                sendVoicemailToChat(context, card: _c, callerName: widget.callerName);
              },
            ),
          _CardMenuRow(
            icon: PhosphorIcons.textAa(PhosphorIconsStyle.bold),
            color: AD.iconSearch,
            label: 'Edit voicemail title',
            onTap: () { Navigator.pop(sheetCtx); _editTitle(); },
          ),
          _CardMenuRow(
            icon: PhosphorIcons.tag(PhosphorIconsStyle.bold),
            color: AD.iconSearch,
            label: 'Tag',
            onTap: () { Navigator.pop(sheetCtx); _editTags(); },
          ),
          _CardMenuRow(
            icon: PhosphorIcons.pencilSimple(PhosphorIconsStyle.bold),
            color: AD.iconSearch,
            label: 'Rename caller',
            onTap: () { Navigator.pop(sheetCtx); widget.onRename?.call(); },
          ),
          if (widget.isTel)
            _CardMenuRow(
              icon: PhosphorIcons.prohibit(PhosphorIconsStyle.bold),
              color: AD.danger,
              label: 'Block caller',
              onTap: () { Navigator.pop(sheetCtx); widget.onBlock?.call(); },
            ),
          _CardMenuRow(
            icon: PhosphorIcons.trash(PhosphorIconsStyle.bold),
            color: AD.danger,
            label: 'Delete',
            danger: true,
            onTap: () { Navigator.pop(sheetCtx); widget.onDelete?.call(); },
          ),
          const SizedBox(height: 8),
        ]),
      ),
    );
  }

  // [AVA-INBOX-READSTATE] Owner-spec bubble states (2026-07-17), replacing the
  // earlier dark-tint + opacity treatment:
  //   • NEW / unheard → PALE-GREEN bubble, dark ink, 1 BLUE tick + "Not heard yet".
  //   • Heard/read    → very-light-GREY bubble, near-black ink, 2 PALE-GREEN
  //                     ticks + "Heard".
  // Bubbles are now LIGHT (like the list cards), so every child text is given
  // an explicit dark-on-light colour below instead of the dark-theme
  // AvaDialTheme.text/textMute/textSoft (near-white, invisible on a light
  // bubble). The play control uses AD.bubbleOutPlay — the deep-green "play on a
  // light bubble" token — so it reads on both surfaces. The old Opacity(0.5)
  // dimming is gone: on a light bubble it just muddied the colour; the grey vs
  // green surface already tells the two states apart at a glance.
  static const _newBubbleBg = Color(0xFFCDEBD3); // pale green (unheard)
  static const _newBubbleBorder = Color(0xFF3E8E5A); // deeper green edge
  static const _readBubbleBg = Color(0xFFE7E8EB); // very light grey (heard)
  static const _readBubbleBorder = Color(0xFFCED0D6); // slightly darker grey edge
  static const _heardTick = Color(0xFF3E8E5A); // pale/mid green — the 2 heard ticks
  static const _unheardTick = AD.iconSearch; // 0xFF6FA8E8 — the 1 "not heard" blue tick

  @override
  Widget build(BuildContext context) {
    final unheard = _c.hasRecording && !_heard;
    // Dark-on-light ink pair for whichever surface is showing.
    final ink = unheard ? const Color(0xFF1C3324) : const Color(0xFF14161A);
    final subInk = unheard ? const Color(0xFF2A4436) : const Color(0xFF3B3D45);
    return GestureDetector(
      onLongPress: () => _showCardMenu(context),
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: unheard ? _newBubbleBg : _readBubbleBg,
          borderRadius: BorderRadius.circular(AD.rListCard),
          border: Border.all(
            color: unheard ? _newBubbleBorder : _readBubbleBorder,
            width: unheard ? 1.5 : 1,
          ),
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            // ---- Caller metadata + heard/not-heard tick indicator ----
            Row(children: [
              Expanded(
                child: Text(widget.callerName, style: ADText.threadName(c: ink)),
              ),
              // [AVA-INBOX-READSTATE] Heard state (only for cards with a
              // recording): 2 pale-green ticks + "Heard" once played; 1 blue
              // tick + "Not heard yet" before that.
              if (_c.hasRecording)
                Row(mainAxisSize: MainAxisSize.min, children: [
                  Icon(_heard ? Icons.done_all : Icons.check,
                      size: 15, color: _heard ? _heardTick : _unheardTick),
                  const SizedBox(width: 3),
                  Text(
                    _heard ? 'Heard' : 'Not heard yet',
                    style: ADText.statCaption(c: _heard ? _heardTick : _unheardTick)
                        .copyWith(fontWeight: FontWeight.w700),
                  ),
                ]),
            ]),
            if (widget.callerNumber != null && widget.callerNumber != widget.callerName) ...[
              const SizedBox(height: 1),
              Text(widget.callerNumber!, style: ADText.statCaption(c: subInk)),
            ],
            // [AVAINBOX-1] User-set voicemail title ("Edit voicemail title")
            // — distinct row so it's never confused with the caller name.
            if (_meta?.title != null && _meta!.title!.isNotEmpty) ...[
              const SizedBox(height: 3),
              Text('“${_meta!.title}”',
                  style: ADText.preview(c: ink).copyWith(fontStyle: FontStyle.italic)),
            ],
            const SizedBox(height: 6),
            if (_c.summaryText != null) ...[
              Text(_c.summaryText!, style: ADText.bubbleBody(c: ink)),
              const SizedBox(height: 8),
            ],
            // ---- Audio player — driven by the SHARED AudioPlaybackService
            // (AVAVM-PLAYER-1) so playback survives navigating away from this
            // thread and resumes where the user left off, instead of a
            // per-card AudioPlayer that died the instant this widget was
            // disposed. ----
            if (_c.hasRecording)
              ValueListenableBuilder<PlaybackState?>(
                valueListenable: AudioPlaybackService.I.state,
                builder: (context, st, _) {
                  final isThis = st != null && st.track.trackId == _trackId;
                  final playing = isThis && st.playing;
                  final dur = (isThis ? st.duration : null) ?? AudioPlaybackService.I.knownDuration(_trackId);
                  return GestureDetector(
                    onTap: _togglePlay,
                    child: Row(mainAxisSize: MainAxisSize.min, children: [
                      _loading
                          ? const SizedBox(width: 22, height: 22,
                              child: CircularProgressIndicator(strokeWidth: 2, color: AD.bubbleOutPlay))
                          : Icon(
                              playing
                                  ? PhosphorIcons.pauseCircle(PhosphorIconsStyle.fill)
                                  : PhosphorIcons.playCircle(PhosphorIconsStyle.fill),
                              size: 30, color: AD.bubbleOutPlay,
                            ),
                      const SizedBox(width: 8),
                      Text(
                        _durationLabel(dur).isNotEmpty
                            ? 'Voicemail · ${_durationLabel(dur)}'
                            : 'Play voicemail',
                        style: ADText.rowName(c: AD.bubbleOutPlay),
                      ),
                    ]),
                  );
                },
              ),
            // ---- Transcript underneath ----
            if (_c.transcript != null) ...[
              const SizedBox(height: 8),
              GestureDetector(
                onTap: () => setState(() => _expanded = !_expanded),
                child: Text(_expanded ? 'Hide transcript ▲' : 'Show transcript ▼',
                    style: ADText.statCaption(c: subInk)),
              ),
              if (_expanded)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Text(_c.transcript!, style: ADText.preview(c: subInk)),
                ),
            ],
            // ---- Tags ("Tag" menu item) ----
            if (_meta?.tags.isNotEmpty ?? false) ...[
              const SizedBox(height: 8),
              Wrap(spacing: 6, runSpacing: 4, children: [
                for (final tag in _meta!.tags)
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                    decoration: BoxDecoration(
                      color: AD.bubbleInPlay.withValues(alpha: 0.14),
                      borderRadius: BorderRadius.circular(100),
                      border: Border.all(color: AD.bubbleInPlay.withValues(alpha: 0.55), width: 1),
                    ),
                    child: Text(tag, style: ADText.statCaption(c: AD.bubbleInPlay)),
                  ),
              ]),
            ],
            const SizedBox(height: 8),
            Align(
              alignment: Alignment.centerRight,
              child: Text(_timeLabel, style: ADText.statCaption(c: subInk)),
            ),
          ]),
        ),
      );
  }
}

/// One long-press menu row — mirrors `contact_row_menu.dart`'s private `_row`
/// helper (same leading/label/onTap shape) but kept local to this file since
/// this lane only touches `app/lib/features/avadial/inbox/*`.
class _CardMenuRow extends StatelessWidget {
  final IconData icon;
  final Color color;
  final String label;
  final VoidCallback onTap;
  final bool danger;
  const _CardMenuRow({
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
