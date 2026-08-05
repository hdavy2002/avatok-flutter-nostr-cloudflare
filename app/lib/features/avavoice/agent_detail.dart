import 'dart:async';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/analytics.dart';
import '../../core/avatar.dart';
import '../../core/avavoice_api.dart';
import '../../core/ui/zine_widgets.dart';
import '../explore/widgets.dart' show CoverImage;
import '../wallet/wallet_screen.dart';
import 'booking_sheet.dart';
import 'call_screen.dart';
import 'widgets.dart';

/// Agent detail — role, pricing, knowledge, live availability, Call Now / Book.
class AgentDetailScreen extends StatefulWidget {
  final String agentId;
  final String? bookingId; // set when joining an existing booking
  const AgentDetailScreen({super.key, required this.agentId, this.bookingId});
  @override
  State<AgentDetailScreen> createState() => _AgentDetailScreenState();
}

class _AgentDetailScreenState extends State<AgentDetailScreen> {
  VoiceAgent? _agent;
  AgentAvailability? _avail;
  bool _loading = true;
  bool _working = false;
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    Analytics.screenViewed('avavoice', 'agent_detail',
        from: widget.bookingId != null ? 'booking' : null);
    _load();
    // Live availability: poll every 10 s so "Agent busy" flips back to
    // "Call now" the moment a slot frees (spec §3.1b).
    _poll = Timer.periodic(const Duration(seconds: 10), (_) => _refreshAvailability());
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    final a = await AvaVoiceApi.agent(widget.agentId);
    final av = await AvaVoiceApi.availability(widget.agentId);
    if (!mounted) return;
    setState(() { _agent = a; _avail = av; _loading = false; });
  }

  Future<void> _refreshAvailability() async {
    final av = await AvaVoiceApi.availability(widget.agentId);
    if (mounted) setState(() => _avail = av);
  }

  void _snack(String msg, {bool topUp = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(msg),
      action: topUp
          ? SnackBarAction(label: 'Top up', onPressed: () => Navigator.push(
              context, MaterialPageRoute(builder: (_) => const WalletScreen())))
          : null,
    ));
  }

  Future<void> _callNow() async {
    final a = _agent;
    if (a == null || _working) return;
    Analytics.capture('avavoice_call_now_tapped',
        {'agent': a.id, 'payer_mode': a.payerMode, 'vision': a.visionEnabled});
    final lang = await pickLanguage(context);
    if (lang == null || !mounted) return;
    Analytics.capture('avavoice_language_selected', {'agent': a.id, 'language': lang, 'where': 'call_now'});
    setState(() => _working = true);
    final r = await AvaVoiceApi.callNow(a.id, language: lang);
    if (!mounted) return;
    setState(() => _working = false);
    Analytics.capture('avavoice_call_now_result',
        {'agent': a.id, 'status': (r['status'] as num?)?.toInt() ?? 0});
    switch (r['status']) {
      case 200:
        Navigator.push(context, MaterialPageRoute(builder: (_) => VoiceCallScreen(
          agent: a, language: lang, callId: r['call_id']?.toString(),
        ))).then((_) { _load(); });
      case 402:
        final needed = (r['needed'] as num?)?.toInt();
        Analytics.capture('avavoice_topup_prompted', {'agent': a.id, 'where': 'call_now'});
        _snack('Not enough Tokens in your wallet'
            '${needed != null ? ' — you need ${fmtCoins(needed)}' : ''}.', topUp: true);
      case 409:
        _snack('${a.name} is busy on all lines right now — try again in a moment.');
        _refreshAvailability();
      default:
        _snack(r['detail']?.toString() ?? r['error']?.toString() ?? 'Could not start the call.');
    }
  }

  Future<void> _book() async {
    final a = _agent;
    if (a == null) return;
    Analytics.capture('avavoice_book_tapped', {'agent': a.id, 'payer_mode': a.payerMode});
    final booked = await showBookingSheet(context, a);
    if (booked == true && mounted) {
      _snack('Booked! Find it under "My bookings".');
      _load();
    }
  }

  Future<void> _joinBooking() async {
    final a = _agent;
    if (a == null || !mounted) return;
    final lang = await pickLanguage(context);
    if (lang == null || !mounted) return;
    Navigator.push(context, MaterialPageRoute(builder: (_) => VoiceCallScreen(
      agent: a, language: lang, bookingId: widget.bookingId,
    )));
  }

  @override
  Widget build(BuildContext context) {
    final a = _agent;
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: ZineAppBar(title: a?.name ?? 'Voice agent', tag: 'ai voice agent'),
      body: ZinePaper(
        child: _loading
            ? const Center(child: CircularProgressIndicator(color: AD.tabGroups))
            : a == null
                ? Center(
                    child: ZineEmptyState(
                        icon: PhosphorIcons.robot(PhosphorIconsStyle.bold),
                        text: 'Agent not found'))
                : _body(a),
      ),
      bottomNavigationBar: a == null ? null : _actions(a),
    );
  }

  Widget _body(VoiceAgent a) {
    final busy = _avail?.busy ?? a.busy;
    return ListView(
      padding: const EdgeInsets.fromLTRB(Msg.s5, Msg.s4, Msg.s5, Msg.s5),
      children: [
        // Listing photos (1–5) — swipeable strip, ink-framed.
        if (a.images.isNotEmpty) ...[
          SizedBox(
            height: 180,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              itemCount: a.images.length,
              separatorBuilder: (_, __) => const SizedBox(width: Msg.s2),
              itemBuilder: (_, i) => Container(
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(Msg.rLg),
                  border: Border.all(color: AD.borderControl, width: 1),
                ),
                clipBehavior: Clip.antiAlias,
                child: CoverImage(
                    url: a.images[i], seed: i,
                    width: a.images.length == 1 ? MediaQuery.of(context).size.width - 36 : 260,
                    height: 180),
              ),
            ),
          ),
          const SizedBox(height: 16),
        ],
        Row(children: [
          Container(
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              border: Border.all(color: AD.borderControl, width: 1),
              boxShadow: Msg.none,
            ),
            child: Avatar(seed: a.id, name: a.name, size: 72, avatarUrl: a.avatarUrl),
          ),
          const SizedBox(width: 16),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(a.name, style: ADText.threadName().copyWith(fontSize: 20, height: 1.1, letterSpacing: -0.2)),
            const SizedBox(height: 4),
            Text(a.role, style: ADText.preview().copyWith(fontSize: 14, height: 1.42)),
            const SizedBox(height: 8),
            Wrap(spacing: Msg.s1, runSpacing: Msg.s1, children: [
              busy
                  ? _sticker('agent busy', AD.danger, Colors.white)
                  : _sticker('call now', AD.online, Colors.white),
              if (a.visionEnabled) _sticker('vision', AD.tabCalls, Colors.white),
            ]),
          ])),
        ]),
        const SizedBox(height: Msg.s4),
        _infoTile(PhosphorIcons.coins(PhosphorIconsStyle.bold), AD.online, 'Price',
            a.isFreeForCallers
                ? 'Free — the creator covers this agent\'s calls'
                : '${a.rateLabel}\nBilled per minute (rounded up). Held in escrow; unused minutes refunded.'),
        _infoTile(PhosphorIcons.timer(PhosphorIconsStyle.bold), AD.tabGroups, 'Session length',
            'Up to ${a.sessionLimitMin} minutes. The agent wraps up politely before time runs out.'),
        _infoTile(PhosphorIcons.translate(PhosphorIconsStyle.bold), AD.tabCalls, 'Languages',
            'Choose the language the agent speaks when you start the call — ${kVoiceLanguages.length}+ available.'),
        if (a.visionEnabled)
          _infoTile(PhosphorIcons.eye(PhosphorIconsStyle.bold), AD.danger, 'Vision',
              'This agent can see your screen or camera (with your permission) and help with what it sees.'),
        if (a.files.isNotEmpty)
          _infoTile(PhosphorIcons.brain(PhosphorIconsStyle.bold), AD.tabCalls, 'Knowledge',
              'Trained on ${a.files.length} document${a.files.length == 1 ? '' : 's'} provided by the creator.'),
        if (a.creatorName != null)
          _infoTile(PhosphorIcons.user(PhosphorIconsStyle.bold), AD.tabGroups, 'Creator', a.creatorName!),
        const SizedBox(height: 8),
        if (a.systemProfile.isNotEmpty)
          ZineCard(
            padding: const EdgeInsets.all(16),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              ZineCardHead(
                  icon: PhosphorIcons.robot(PhosphorIconsStyle.bold),
                  accent: AD.tabCalls,
                  title: 'About this agent'),
              const SizedBox(height: Msg.s2),
              Text(a.systemProfile, style: ADText.preview(c: AD.textPrimary).copyWith(fontSize: 14, height: 1.42)),
            ]),
          ),
      ],
    );
  }

  Widget _sticker(String text, Color fill, Color fg) => Container(
        padding: const EdgeInsets.symmetric(horizontal: Msg.s3, vertical: Msg.s1),
        decoration: BoxDecoration(
          color: fill,
          borderRadius: BorderRadius.circular(Msg.rPill),
          border: Border.all(color: AD.borderControl, width: 1),
          boxShadow: Msg.none,
        ),
        child: Text(_sentence(text), style: ADText.tabLabel(c: fg).copyWith(fontSize: 11, letterSpacing: 0.44)),
      );

  Widget _infoTile(IconData icon, Color accent, String title, String body) => Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: ZineCard(
          padding: const EdgeInsets.all(Msg.s4),
          radius: Msg.rLg,
          boxShadow: Msg.none,
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            ZineIconBadge(icon: icon, color: accent, size: 32),
            const SizedBox(width: 12),
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: ADText.sectionLabel(c: AD.textSecondary).copyWith(fontSize: 11, letterSpacing: 0.88)),
              const SizedBox(height: Msg.s1),
              Text(body, style: ADText.preview().copyWith(fontSize: 13, height: 1.42)),
            ])),
          ]),
        ),
      );

  Widget _actions(VoiceAgent a) {
    final busy = _avail?.busy ?? a.busy;
    return Container(
      decoration: const BoxDecoration(
        color: AD.card,
        border: Border(top: BorderSide(color: AD.borderControl, width: 1)),
      ),
      child: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
          child: widget.bookingId != null
              ? ZineButton(
                  label: 'Join your booked session',
                  icon: PhosphorIcons.phone(PhosphorIconsStyle.bold),
                  trailingIcon: false,
                  fullWidth: true,
                  fontSize: 17,
                  onPressed: _joinBooking,
                )
              : Row(children: [
                  Expanded(
                    child: ZineButton(
                      label: 'Book a time',
                      variant: ZineButtonVariant.blue,
                      icon: PhosphorIcons.calendarBlank(PhosphorIconsStyle.bold),
                      trailingIcon: false,
                      fullWidth: true,
                      fontSize: 16,
                      onPressed: _book,
                    ),
                  ),
                  const SizedBox(width: Msg.s2),
                  Expanded(
                    child: ZineButton(
                      label: busy ? 'Agent busy' : 'Call now',
                      icon: busy
                          ? PhosphorIcons.phoneSlash(PhosphorIconsStyle.bold)
                          : PhosphorIcons.phone(PhosphorIconsStyle.bold),
                      trailingIcon: false,
                      fullWidth: true,
                      fontSize: 16,
                      loading: _working,
                      onPressed: busy || _working ? null : _callNow,
                    ),
                  ),
                ]),
        ),
      ),
    );
  }
}

/// Sentence case for a display label. Replaces the `.toUpperCase()` the legacy
/// zine stickers applied to everything; call sites pass lowercase strings, so
/// simply dropping the transform would render them lowercase.
String _sentence(String s) =>
    s.isEmpty ? s : '${s[0].toUpperCase()}${s.substring(1)}';
