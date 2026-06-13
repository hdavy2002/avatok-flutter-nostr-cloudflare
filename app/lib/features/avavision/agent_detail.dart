import 'dart:async';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/avatar.dart';
import '../../core/avavision_api.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../explore/widgets.dart' show CoverImage;
import '../wallet/wallet_screen.dart';
import 'booking_sheet.dart';
import 'widgets.dart';
import 'session/vision_session_screen.dart';

// The live split-screen session `VisionSessionScreen(agent:, language:, bookingId:,
// callId:)` is owned by Phase 3 (app/lib/features/avavision/session/**) and wired
// here at Phase Z. It consumes the canonical core `VisionAgent`.

/// Agent detail — role, pricing, vision setup, live availability, Call Now/Book.
class AgentDetailScreen extends StatefulWidget {
  final String agentId;
  final String? bookingId; // set when joining an existing booking
  const AgentDetailScreen({super.key, required this.agentId, this.bookingId});
  @override
  State<AgentDetailScreen> createState() => _AgentDetailScreenState();
}

class _AgentDetailScreenState extends State<AgentDetailScreen> {
  VisionAgent? _agent;
  AgentAvailability? _avail;
  bool _loading = true;
  bool _working = false;
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    Analytics.screenViewed('avavision', 'agent_detail', from: widget.bookingId != null ? 'booking' : null);
    _load();
    _poll = Timer.periodic(const Duration(seconds: 10), (_) => _refreshAvailability());
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    final a = await AvaVisionApi.agent(widget.agentId);
    final av = await AvaVisionApi.availability(widget.agentId);
    if (!mounted) return;
    setState(() {
      _agent = a;
      _avail = av;
      _loading = false;
    });
  }

  Future<void> _refreshAvailability() async {
    final av = await AvaVisionApi.availability(widget.agentId);
    if (mounted) setState(() => _avail = av);
  }

  void _snack(String msg, {bool topUp = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(msg),
      action: topUp
          ? SnackBarAction(
              label: 'Top up',
              onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const WalletScreen())))
          : null,
    ));
  }

  // Launches Phase 3's session screen. See the file-top note: `VisionSessionScreen`
  // is provided by Phase 3 and wired by Phase Z.
  void _openSession(VisionAgent a, String language, {String? bookingId, String? callId}) {
    Navigator.push(
        context,
        MaterialPageRoute(
            builder: (_) => VisionSessionScreen(
                  agent: a,
                  language: language,
                  bookingId: bookingId,
                  callId: callId,
                ))).then((_) => _load());
  }

  Future<void> _callNow() async {
    final a = _agent;
    if (a == null || _working) return;
    Analytics.capture('avavision_call_now_tapped', {'agent': a.id, 'payer_mode': a.payerMode, 'capability': a.capability});
    final lang = await pickLanguage(context);
    if (lang == null || !mounted) return;
    Analytics.capture('avavision_language_selected', {'agent': a.id, 'language': lang, 'where': 'call_now'});
    setState(() => _working = true);
    final r = await AvaVisionApi.callNow(a.id, language: lang);
    if (!mounted) return;
    setState(() => _working = false);
    Analytics.capture('avavision_call_now_result', {'agent': a.id, 'status': (r['status'] as num?)?.toInt() ?? 0});
    switch (r['status']) {
      case 200:
        _openSession(a, lang, callId: r['call_id']?.toString());
      case 402:
        final needed = (r['needed'] as num?)?.toInt();
        Analytics.capture('avavision_topup_prompted', {'agent': a.id, 'where': 'call_now'});
        _snack('Not enough AvaCoins in your wallet${needed != null ? ' — you need ${fmtCoins(needed)}' : ''}.', topUp: true);
      case 409:
        _snack('${a.name} is busy on all lines right now — try again in a moment.');
        _refreshAvailability();
      default:
        _snack(r['detail']?.toString() ?? r['error']?.toString() ?? 'Could not start the session.');
    }
  }

  Future<void> _book() async {
    final a = _agent;
    if (a == null) return;
    Analytics.capture('avavision_book_tapped', {'agent': a.id, 'payer_mode': a.payerMode});
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
    _openSession(a, lang, bookingId: widget.bookingId);
  }

  @override
  Widget build(BuildContext context) {
    final a = _agent;
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: ZineAppBar(title: a?.name ?? 'Vision agent', tag: 'ai vision coach'),
      body: ZinePaper(
        child: _loading
            ? const Center(child: CircularProgressIndicator(color: Zine.blueInk))
            : a == null
                ? Center(child: ZineEmptyState(icon: PhosphorIcons.eye(PhosphorIconsStyle.bold), text: 'Agent not found'))
                : _body(a),
      ),
      bottomNavigationBar: a == null ? null : _actions(a),
    );
  }

  Widget _body(VisionAgent a) {
    final busy = _avail?.busy ?? a.busy;
    return ListView(
      padding: const EdgeInsets.fromLTRB(18, 16, 18, 24),
      children: [
        if (a.images.isNotEmpty) ...[
          SizedBox(
            height: 180,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              itemCount: a.images.length,
              separatorBuilder: (_, __) => const SizedBox(width: 10),
              itemBuilder: (_, i) => Container(
                decoration: BoxDecoration(borderRadius: BorderRadius.circular(Zine.rSm), border: Zine.border),
                clipBehavior: Clip.antiAlias,
                child: CoverImage(
                    url: a.images[i],
                    seed: i,
                    width: a.images.length == 1 ? MediaQuery.of(context).size.width - 36 : 260,
                    height: 180),
              ),
            ),
          ),
          const SizedBox(height: 16),
        ],
        Row(children: [
          Container(
            decoration: BoxDecoration(shape: BoxShape.circle, border: Zine.border, boxShadow: Zine.shadowXs),
            child: Avatar(seed: a.id, name: a.name, size: 72, avatarUrl: a.avatarUrl),
          ),
          const SizedBox(width: 16),
          Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(a.name, style: ZineText.cardTitle(size: 20)),
            const SizedBox(height: 4),
            Text(a.role, style: ZineText.sub(size: 13.5)),
            const SizedBox(height: 8),
            Wrap(spacing: 6, runSpacing: 6, children: [
              busy ? const MiniPill('agent busy', fill: Zine.coral, fg: Colors.white) : const MiniPill('call now', fill: Zine.mint, fg: Zine.ink),
              CapabilityBadge(a.capability),
            ]),
          ])),
        ]),
        const SizedBox(height: 20),
        _infoTile(
            PhosphorIcons.coins(PhosphorIconsStyle.bold),
            Zine.mint,
            'Price',
            a.isFreeForCallers
                ? 'Free — the creator covers this agent\'s sessions'
                : '${a.rateLabel}\nBilled per minute (rounded up). Held in escrow; unused minutes refunded.'),
        _infoTile(PhosphorIcons.timer(PhosphorIconsStyle.bold), Zine.blue, 'Session length',
            'Up to ${a.sessionLimitMin} minutes. The agent wraps up politely before time runs out.'),
        // Vision setup tile.
        _infoTile(
            PhosphorIcons.eye(PhosphorIconsStyle.bold),
            Zine.lilac,
            'Vision',
            'Tracks ${capabilityLabel(a.capability).toLowerCase()} via your camera (on-device, with your permission).'
                '${a.hasOverlay ? ' Draws a live ${overlayLabel(a.overlayStyle).toLowerCase()} overlay.' : ''}'
                '${a.hasScore && a.scoreLabel != null ? ' Shows a live ${a.scoreLabel} score.' : ''}'),
        if (a.agenticSnapshotEnabled)
          _infoTile(PhosphorIcons.camera(PhosphorIconsStyle.bold), Zine.coral, 'Analyze my form',
              'Tap once for a precise, annotated breakdown of a single frame — ${a.freeSnapshotsPerSession} free per session.'),
        _infoTile(PhosphorIcons.monitor(PhosphorIconsStyle.bold), Zine.blue, 'Runs on', a.platforms.labels.join(' · ')),
        _infoTile(PhosphorIcons.translate(PhosphorIconsStyle.bold), Zine.lilac, 'Languages',
            'Choose the language the agent speaks when you start — ${kVoiceLanguages.length}+ available.'),
        if (a.files.isNotEmpty)
          _infoTile(PhosphorIcons.brain(PhosphorIconsStyle.bold), Zine.lilac, 'Knowledge',
              'Trained on ${a.files.length} document${a.files.length == 1 ? '' : 's'} provided by the creator.'),
        if (a.creatorName != null)
          _infoTile(PhosphorIcons.user(PhosphorIconsStyle.bold), Zine.blue, 'Creator', a.creatorName!),
        // Safety note — platform-enforced (master §10).
        _infoTile(PhosphorIcons.shieldCheck(PhosphorIconsStyle.bold), Zine.mint, 'Safe by design',
            'Coaches technique only — never rates appearance, never identifies people, not medical advice. Camera consent is asked each session.'),
        const SizedBox(height: 8),
        if (a.systemProfile.isNotEmpty)
          ZineCard(
            padding: const EdgeInsets.all(16),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              ZineCardHead(icon: PhosphorIcons.eye(PhosphorIconsStyle.bold), accent: Zine.lilac, title: 'About this agent'),
              const SizedBox(height: 10),
              Text(a.systemProfile, style: ZineText.sub(size: 13.5, color: Zine.ink)),
            ]),
          ),
      ],
    );
  }

  Widget _infoTile(IconData icon, Color accent, String title, String body) => Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: ZineCard(
          padding: const EdgeInsets.all(14),
          radius: Zine.rSm,
          boxShadow: Zine.shadowXs,
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            ZineIconBadge(icon: icon, color: accent, size: 32),
            const SizedBox(width: 12),
            Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title.toUpperCase(), style: ZineText.kicker()),
              const SizedBox(height: 3),
              Text(body, style: ZineText.sub(size: 12.5)),
            ])),
          ]),
        ),
      );

  Widget _actions(VisionAgent a) {
    final busy = _avail?.busy ?? a.busy;
    return Container(
      decoration: const BoxDecoration(
        color: Zine.paper2,
        border: Border(top: BorderSide(color: Zine.ink, width: Zine.bw)),
      ),
      child: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
          child: widget.bookingId != null
              ? ZineButton(
                  label: 'Join your booked session',
                  icon: PhosphorIcons.videoCamera(PhosphorIconsStyle.bold),
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
                  const SizedBox(width: 10),
                  Expanded(
                    child: ZineButton(
                      label: busy ? 'Agent busy' : 'Call now',
                      icon: busy ? PhosphorIcons.videoCameraSlash(PhosphorIconsStyle.bold) : PhosphorIcons.videoCamera(PhosphorIconsStyle.bold),
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
