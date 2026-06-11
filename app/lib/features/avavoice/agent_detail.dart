import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/analytics.dart';
import '../../core/avatar.dart';
import '../../core/avavoice_api.dart';
import '../../core/theme.dart';
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
        _snack('Not enough AvaCoins in your wallet'
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
      backgroundColor: Colors.white,
      appBar: AppBar(backgroundColor: Colors.white, elevation: 0,
          foregroundColor: AvaColors.ink, title: Text(a?.name ?? 'Voice agent')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : a == null
              ? const Center(child: Text('Agent not found', style: TextStyle(color: AvaColors.sub)))
              : _body(a),
      bottomNavigationBar: a == null ? null : _actions(a),
    );
  }

  Widget _body(VoiceAgent a) {
    final busy = _avail?.busy ?? a.busy;
    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 16, 20, 24),
      children: [
        Row(children: [
          Avatar(seed: a.id, name: a.name, size: 72, avatarUrl: a.avatarUrl),
          const SizedBox(width: 16),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(a.name, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 20)),
            const SizedBox(height: 4),
            Text(a.role, style: const TextStyle(color: AvaColors.sub, fontSize: 13.5)),
            const SizedBox(height: 8),
            Row(children: [
              AvailabilityChip(busy: busy),
              const SizedBox(width: 8),
              if (a.visionEnabled) const VisionBadge(),
            ]),
          ])),
        ]),
        const SizedBox(height: 20),
        _infoTile(Icons.payments_outlined, 'Price',
            a.isFreeForCallers
                ? 'Free — the creator covers this agent\'s calls'
                : '${a.rateLabel}\nBilled per minute (rounded up). Held in escrow; unused minutes refunded.'),
        _infoTile(Icons.timer_outlined, 'Session length',
            'Up to ${a.sessionLimitMin} minutes. The agent wraps up politely before time runs out.'),
        _infoTile(Icons.translate, 'Languages',
            'Choose the language the agent speaks when you start the call — ${kVoiceLanguages.length}+ available.'),
        if (a.visionEnabled)
          _infoTile(Icons.visibility_outlined, 'Vision',
              'This agent can see your screen or camera (with your permission) and help with what it sees.'),
        if (a.files.isNotEmpty)
          _infoTile(Icons.psychology_outlined, 'Knowledge',
              'Trained on ${a.files.length} document${a.files.length == 1 ? '' : 's'} provided by the creator.'),
        if (a.creatorName != null)
          _infoTile(Icons.person_outline, 'Creator', a.creatorName!),
        const SizedBox(height: 8),
        if (a.systemProfile.isNotEmpty) ...[
          const Text('About this agent', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
          const SizedBox(height: 6),
          Text(a.systemProfile, style: const TextStyle(color: AvaColors.ink, fontSize: 13.5, height: 1.45)),
        ],
      ],
    );
  }

  Widget _infoTile(IconData icon, String title, String body) => Padding(
        padding: const EdgeInsets.only(bottom: 14),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Container(
            width: 36, height: 36,
            decoration: BoxDecoration(
                color: kAvaVoicePurple.withValues(alpha: .1),
                borderRadius: BorderRadius.circular(10)),
            child: Icon(icon, size: 18, color: kAvaVoicePurple),
          ),
          const SizedBox(width: 12),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 13)),
            const SizedBox(height: 2),
            Text(body, style: const TextStyle(color: AvaColors.sub, fontSize: 12.5, height: 1.4)),
          ])),
        ]),
      );

  Widget _actions(VoiceAgent a) {
    final busy = _avail?.busy ?? a.busy;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
        child: widget.bookingId != null
            ? FilledButton.icon(
                style: FilledButton.styleFrom(backgroundColor: kAvaVoicePurple),
                onPressed: _joinBooking,
                icon: const Icon(Icons.call),
                label: const Text('Join your booked session'),
              )
            : Row(children: [
                Expanded(child: OutlinedButton.icon(
                  style: OutlinedButton.styleFrom(
                    foregroundColor: kAvaVoicePurple,
                    side: const BorderSide(color: kAvaVoicePurple),
                    padding: const EdgeInsets.symmetric(vertical: 14),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                  ),
                  onPressed: _book,
                  icon: const Icon(Icons.event_outlined),
                  label: const Text('Book a time', style: TextStyle(fontWeight: FontWeight.w800)),
                )),
                const SizedBox(width: 10),
                Expanded(child: FilledButton.icon(
                  style: FilledButton.styleFrom(
                    backgroundColor: busy ? AvaColors.sub : AvaColors.success,
                    padding: const EdgeInsets.symmetric(vertical: 14),
                  ),
                  onPressed: busy || _working ? null : _callNow,
                  icon: _working
                      ? const SizedBox(width: 16, height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                      : Icon(busy ? Icons.phone_disabled : Icons.call),
                  label: Text(busy ? 'Agent busy' : 'Call now',
                      style: const TextStyle(fontWeight: FontWeight.w800)),
                )),
              ]),
      ),
    );
  }
}
