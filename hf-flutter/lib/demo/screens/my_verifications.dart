import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../data/api_exception.dart';
import '../../data/models/spaces.dart';
import '../../data/services.dart';
import '../../data/telemetry.dart';
import '../booking_kit.dart';
import '../call_kit.dart';
import '../channel_kit.dart';
import '../space_kit.dart';
import '../theme.dart';
import '../widgets.dart';

/// [HF-CREATOR-BADGES-1] "My verifications": the creator's stacked badges (Phone, Channel, Video KYC, Space), whether she can go
/// live, and "Who can call you". Route `/inf/verifications`. Reads `GET /api/hf/spaces/me`; a missing field is "not yet".
class MyVerificationsScreen extends StatefulWidget {
  const MyVerificationsScreen({super.key});

  @override
  State<MyVerificationsScreen> createState() => _MyVerificationsScreenState();
}

class _MyVerificationsScreenState extends State<MyVerificationsScreen> {
  SpaceStatus? _st;
  CreatorBadges? _prev;
  Object? _loadError;
  bool _loading = true;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    setState(() {
      _loading = _st == null;
      _loadError = null;
    });
    try {
      final st = await Services.instance.spacesRepo.creatorStatus();
      if (!mounted) return;
      final prev = _prev;
      if (prev != null) {
        if (st.badges.phone && !prev.phone) Telemetry.event('hf_verify_badge_added', {'badge': 'phone'});
        if (st.badges.channel && !prev.channel) Telemetry.event('hf_verify_badge_added', {'badge': 'channel'});
      }
      setState(() {
        _st = st;
        _prev = st.badges;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loadError = e;
        _loading = false;
      });
    }
  }

  static String _missingText(String m) => switch (m) {
        'channel_or_video_kyc' => 'An approved channel or video KYC',
        'space_video_kyc' => 'Video KYC for your space',
        'phone' => 'A verified WhatsApp number',
        _ => m.replaceAll('_', ' '),
      };

  Future<void> _startKyc(SpaceStatus st) async {
    await openSpaceVerify(context, st.badges.space, creator: true);
    if (mounted) await _load();
  }

  Future<bool> _askLgbtqConsent() async {
    var tag = false;
    var declare = false;
    var terms = false;
    final ok = await showDialog<bool>(
      context: context,
      builder: (dialog) => StatefulBuilder(
        builder: (_, setLocal) => AlertDialog(
          backgroundColor: C.white,
          title: Text('Join the LGBTQ+ space', style: t(20, color: C.maroon, w: FontWeight.w900)),
          content: SingleChildScrollView(
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              _consentRow(tag, 'I am happy for the "LGBTQ+ channel" tag to be public on my profile, in search and on Google.', (v) => setLocal(() => tag = v)),
              _consentRow(declare, 'This space is right for me. This stays private.', (v) => setLocal(() => declare = v)),
              _consentRow(terms, 'I accept the LGBTQ+ space terms.', (v) => setLocal(() => terms = v)),
            ]),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.of(dialog).pop(false), child: Text('Cancel', style: t(16, color: C.muted, w: FontWeight.w900))),
            TextButton(
              onPressed: tag && declare && terms ? () => Navigator.of(dialog).pop(true) : null,
              child: Text('Join', style: t(16, color: tag && declare && terms ? C.maroon : C.muted, w: FontWeight.w900)),
            ),
          ],
        ),
      ),
    );
    return ok == true;
  }

  Widget _consentRow(bool value, String text, ValueChanged<bool> onChanged) => Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Checkbox(value: value, activeColor: C.maroon, onChanged: (v) => onChanged(v == true)),
        Expanded(child: Padding(padding: const EdgeInsets.only(top: 12), child: Text(text, style: t(15, w: FontWeight.w700, h: 1.35)))),
      ]);

  Future<SpaceLane?> _pickSpaceSheet() => showModalBottomSheet<SpaceLane>(
        context: context,
        isScrollControlled: true,
        backgroundColor: C.clear,
        builder: (sheet) => CallSheetFrame(
          child: Padding(
            padding: EdgeInsets.fromLTRB(20, 0, 20, MediaQuery.paddingOf(sheet).bottom + 20),
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Text('Join a special space', textAlign: TextAlign.center, style: t(22, color: C.maroon, w: FontWeight.w900)),
              const SizedBox(height: 6),
              Text('One space at a time. It needs video KYC, and only video-KYC customers can call you.', textAlign: TextAlign.center, style: t(16, color: C.muted, w: FontWeight.w700, h: 1.4)),
              const SizedBox(height: 14),
              BookBottomButton(label: 'WOMEN-ONLY', plum: true, icon: Icons.female_rounded, padding: EdgeInsets.zero, onTap: () => Navigator.of(sheet).pop(SpaceLane.women)),
              const SizedBox(height: 10),
              BookBottomButton(label: 'LGBTQ+', plum: true, icon: Icons.groups_rounded, padding: EdgeInsets.zero, onTap: () => Navigator.of(sheet).pop(SpaceLane.lgbtq)),
              TextButton(onPressed: () => Navigator.of(sheet).pop(), child: Text('Not now', style: t(16, color: C.maroon, w: FontWeight.w900))),
            ]),
          ),
        ),
      );

  Future<void> _joinSpace() async {
    if (_busy) return;
    final lane = await _pickSpaceSheet();
    if (lane == null || !mounted) return;
    final lgbtq = lane == SpaceLane.lgbtq;
    if (lgbtq && !await _askLgbtqConsent()) return;
    if (!mounted) return;
    setState(() => _busy = true);
    try {
      await Services.instance.spacesRepo.setSpace(lane, declare: lgbtq, acceptTerms: lgbtq, publicTagConsent: lgbtq);
      Telemetry.event('hf_space_joined', {'space': lane.name});
    } catch (e) {
      if (mounted) toast(context, e is ApiException ? e.userMessage : ApiException.genericText);
    }
    if (!mounted) return;
    setState(() => _busy = false);
    await _load();
  }

  Future<void> _leaveSpace() async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await Services.instance.spacesRepo.setSpace(null);
      Telemetry.event('hf_space_left');
    } catch (e) {
      if (mounted) toast(context, e is ApiException ? e.userMessage : ApiException.genericText);
    }
    if (!mounted) return;
    setState(() => _busy = false);
    await _load();
  }

  Future<void> _setLevel(String level) async {
    final st = _st;
    if (_busy || st == null || st.callerLevelLocked || st.callerLevel == level) return;
    setState(() => _busy = true);
    try {
      final saved = await Services.instance.spacesRepo.setCallerLevel(level);
      Telemetry.event('hf_caller_level_set', {'level': saved});
    } catch (e) {
      if (mounted) toast(context, e is ApiException ? e.userMessage : ApiException.genericText);
    }
    if (!mounted) return;
    setState(() => _busy = false);
    await _load();
  }

  Widget _card(List<Widget> children) => Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(color: C.white, borderRadius: BorderRadius.circular(24), border: Border.all(color: C.line, width: 1.5)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children),
      );

  Widget _heading(String text) => Padding(padding: const EdgeInsets.only(top: 18, bottom: 8), child: Text(text, style: t(20, color: C.maroon, w: FontWeight.w900)));

  Widget _status(bool done, String yes, String no) => Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(done ? Icons.check_circle_rounded : Icons.radio_button_unchecked_rounded, size: 20, color: done ? C.maroon : C.muted),
        const SizedBox(width: 6),
        Text(done ? yes : no, style: t(15, color: done ? C.maroon : C.muted, w: FontWeight.w800)),
      ]);

  /// One badge row: title, status, and an optional action button.
  Widget _row(String title, Widget status, {String? action, VoidCallback? onTap, bool last = false}) => Container(
        constraints: const BoxConstraints(minHeight: 56),
        padding: const EdgeInsets.symmetric(vertical: 10),
        decoration: BoxDecoration(border: last ? null : const Border(bottom: BorderSide(color: C.line))),
        child: Row(children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: t(17, color: C.maroon, w: FontWeight.w900)),
              const SizedBox(height: 4),
              status,
            ]),
          ),
          if (action != null)
            TextButton(
              onPressed: _busy ? null : onTap,
              style: TextButton.styleFrom(minimumSize: const Size(64, 48)),
              child: Text(action, style: t(16, color: C.maroon, w: FontWeight.w900)),
            ),
        ]),
      );

  Widget _levelCard({required bool selected, required bool locked, required IconData icon, required String title, required String level}) => Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: Semantics(
          button: true,
          selected: selected,
          child: InkWell(
            borderRadius: BorderRadius.circular(22),
            onTap: locked ? null : () => unawaited(_setLevel(level)),
            child: Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: selected ? C.lavtint : C.white,
                borderRadius: BorderRadius.circular(22),
                border: Border.all(color: selected ? C.maroon : C.line, width: selected ? 2.5 : 1.5),
              ),
              child: Row(children: [
                Icon(selected ? Icons.check_circle_rounded : icon, color: selected ? C.maroon : C.muted, size: 26),
                const SizedBox(width: 12),
                Expanded(child: Text(title, style: t(17, color: C.maroon, w: FontWeight.w900, h: 1.2))),
                if (locked && selected) const Icon(Icons.lock_rounded, size: 20, color: C.muted),
              ]),
            ),
          ),
        ),
      );

  List<Widget> _body(SpaceStatus st) {
    final b = st.badges;
    final space = b.space;
    return [
      _card([
        Row(children: [
          Icon(st.canGoLive ? Icons.check_circle_rounded : Icons.info_outline_rounded, color: st.canGoLive ? C.maroon : C.muted, size: 30),
          const SizedBox(width: 10),
          Expanded(child: Text(st.canGoLive ? 'You can go live' : 'Not ready to go live yet', style: t(22, color: C.maroon, w: FontWeight.w900, h: 1.2))),
        ]),
        if (!st.canGoLive && st.missing.isNotEmpty) ...[
          const SizedBox(height: 8),
          Text('Still needed:', style: t(16, color: C.muted, w: FontWeight.w800)),
          for (final m in st.missing) Padding(padding: const EdgeInsets.only(top: 4), child: Text('• ${_missingText(m)}', style: t(16, w: FontWeight.w700, h: 1.35))),
        ],
      ]),
      _heading('Your badges'),
      _card([
        _row('Phone', _status(b.phone, 'WhatsApp verified', 'Not verified')),
        _row('Channel', _status(b.channel, 'Channel verified', 'No approved channel'), action: b.channel ? 'Manage' : 'Connect', onTap: () => unawaited(context.push('/inf/channels'))),
        _row('Video KYC', _status(b.videoKyc, 'Video KYC verified', 'Not done'), action: b.videoKyc ? null : 'Start', onTap: () => unawaited(_startKyc(st))),
        _row(
          'Space',
          _status(space != null, space?.tagText ?? '', 'No special space'),
          action: space != null ? 'Leave' : 'Join',
          onTap: () => unawaited(space != null ? _leaveSpace() : _joinSpace()),
          last: true,
        ),
      ]),
      _heading('Who can call you?'),
      _levelCard(selected: st.callerLevel == 'everyone', locked: st.callerLevelLocked, icon: Icons.phone_in_talk_rounded, title: 'Everyone with a verified phone', level: 'everyone'),
      _levelCard(selected: st.callerLevel == 'video_kyc', locked: st.callerLevelLocked, icon: Icons.lock_rounded, title: 'Only video-KYC customers', level: 'video_kyc'),
      if (st.callerLevelLocked) Padding(padding: const EdgeInsets.only(bottom: 6), child: Text('Locked: a space only takes video-KYC callers.', style: t(15, color: C.muted, w: FontWeight.w700, h: 1.35))),
      Text(kNeverShareText, style: t(15, color: C.muted, w: FontWeight.w800, h: 1.35)),
    ];
  }

  @override
  Widget build(BuildContext context) {
    final st = _st;
    final Widget content;
    if (_loading && st == null) {
      content = const Center(child: CircularProgressIndicator(color: C.maroon));
    } else if (st == null) {
      final e = _loadError;
      content = ListView(padding: const EdgeInsets.all(16), children: [
        _card([
          Text(e is ApiException ? e.failureTitle : 'That did not work', style: t(22, color: C.maroon, w: FontWeight.w900)),
          const SizedBox(height: 8),
          Text(e is ApiException ? e.failureMessage : ApiException.genericText, style: t(16, color: C.muted, w: FontWeight.w700, h: 1.4)),
          const SizedBox(height: 14),
          BookBottomButton(label: 'TRY AGAIN', plum: true, icon: Icons.refresh_rounded, padding: EdgeInsets.zero, onTap: () => unawaited(_load())),
        ]),
      ]);
    } else {
      content = RefreshIndicator(
        color: C.maroon,
        onRefresh: _load,
        child: ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 28), children: _body(st)),
      );
    }
    return Scaffold(
      backgroundColor: C.page,
      body: SafeArea(
        child: Column(children: [
          const ChannelHeader('My verifications'),
          Expanded(child: content),
        ]),
      ),
    );
  }
}

/// [HF-CREATOR-BADGES-1] A card on the influencer dashboard that opens "My verifications".
class VerificationsCard extends StatelessWidget {
  const VerificationsCard({super.key});

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 12),
        child: Semantics(
          button: true,
          child: InkWell(
            borderRadius: BorderRadius.circular(24),
            onTap: () => unawaited(context.push('/inf/verifications')),
            child: Container(
              constraints: const BoxConstraints(minHeight: 64),
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(color: C.white, borderRadius: BorderRadius.circular(24), border: Border.all(color: C.line, width: 1.5)),
              child: Row(children: [
                const Icon(Icons.verified_user_rounded, color: C.maroon, size: 28),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text('My verifications', style: t(18, color: C.maroon, w: FontWeight.w900)),
                    Text('Badges, space and who can call you', style: t(15, color: C.muted, w: FontWeight.w700)),
                  ]),
                ),
                const Icon(Icons.chevron_right_rounded, color: C.muted),
              ]),
            ),
          ),
        ),
      );
}
