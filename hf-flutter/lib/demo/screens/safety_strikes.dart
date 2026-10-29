import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../data/api_exception.dart';
import '../../data/call_safety_store.dart';
import '../../data/repos/call_safety_repo.dart';
import '../../data/services.dart';
import '../../data/telemetry.dart';
import '../../ui/async_view.dart';
import '../call_safety_kit.dart';
import '../desi.dart';
import '../theme.dart';
import '../widgets.dart';
import 'settings_real.dart' show openSupportMail;

/// Days a strike counts for, as the copy says it (the server's default `hfStrikeExpiryDays`; each strike also carries its own end date).
const int kStrikeDays = 90;

// =========================================================================================================== Safety

/// [HF-CALL-SAFETY-APP] "Safety, my strikes" (artboard AppStrikes): gold hero "1 of 3 strikes", one card per active strike with the
/// person's own words on bahi paper and an appeal box, then the strikes that ended. `GET /api/hf/safety/me`, appeal = POST.
class SafetyScreen extends StatefulWidget {
  const SafetyScreen({super.key, this.repo});

  final CallSafetyRepo? repo;

  @override
  State<SafetyScreen> createState() => _SafetyScreenState();
}

class _SafetyScreenState extends State<SafetyScreen> {
  AsyncState<SafetyMe> _state = const AsyncLoading<SafetyMe>();
  final Map<String, TextEditingController> _ctl = <String, TextEditingController>{};
  final Set<String> _sending = <String>{};
  final Set<String> _sent = <String>{};
  final Map<String, String> _err = <String, String>{};

  CallSafetyRepo get _repo => widget.repo ?? Services.instance.callSafetyRepo;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  @override
  void dispose() {
    for (final c in _ctl.values) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _load({bool quiet = false}) async {
    if (!quiet && _state is! AsyncLoading<SafetyMe>) setState(() => _state = const AsyncLoading<SafetyMe>());
    try {
      final m = await _repo.me();
      if (!mounted) return;
      setState(() => _state = AsyncData<SafetyMe>(m));
      CallSafetyStore.instance.accept(m);
      if (!quiet) Telemetry.event('hf_safety_view', {'surface': 'strikes', 'status': m.status, 'strikes': m.activeStrikes});
    } catch (e) {
      if (!mounted || quiet) return;
      setState(() => _state = AsyncFailure<SafetyMe>(e));
    }
  }

  Future<void> _appeal(SafetyStrike s) async {
    if (_sending.contains(s.id)) return;
    final text = (_ctl[s.id]?.text ?? '').trim();
    if (text.length < 3) {
      setState(() => _err[s.id] = 'Please write a few words about why this is wrong.');
      return;
    }
    setState(() {
      _sending.add(s.id);
      _err.remove(s.id);
    });
    try {
      await _repo.appeal(s.id, text);
      Telemetry.event('hf_safety_appeal', {'outcome': 'ok'});
      if (!mounted) return;
      setState(() {
        _sending.remove(s.id);
        _sent.add(s.id);
      });
      toast(context, 'Appeal sent. We will reply on WhatsApp.');
      unawaited(_load(quiet: true));
    } on ApiException catch (e) {
      Telemetry.event('hf_safety_appeal', {'outcome': 'failed', 'reason': e.code});
      if (!mounted) return;
      setState(() {
        _sending.remove(s.id);
        if (e.status == 409) {
          _sent.add(s.id); // already appealed: show it as sent
        } else {
          _err[s.id] = e.userMessage;
        }
      });
      if (e.status == 409) unawaited(_load(quiet: true));
    } catch (_) {
      Telemetry.event('hf_safety_appeal', {'outcome': 'failed', 'reason': 'error'});
      if (!mounted) return;
      setState(() {
        _sending.remove(s.id);
        _err[s.id] = ApiException.genericText;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: C.page,
      body: SafeArea(
        child: Column(children: [
          const SafetyHeader(title: 'Safety'),
          Expanded(
            child: AsyncView<SafetyMe>(
              state: _state,
              onRetry: () => unawaited(_load()),
              isEmpty: (_) => false,
              loadingLabel: 'Loading your safety page…',
              builder: _content,
            ),
          ),
        ]),
      ),
    );
  }

  Widget _content(BuildContext context, SafetyMe m) {
    final now = DateTime.now().millisecondsSinceEpoch;
    final active = [for (final s in m.strikes) if (s.isActiveAt(now)) s];
    final ended = [for (final s in m.strikes) if (!s.isActiveAt(now)) s];
    return ListView(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 24),
      children: [
        DesiHero(
          eyebrow: 'Your safety',
          title: m.activeStrikes == 0 ? 'No strikes' : '${m.activeStrikes} of ${m.strikesToPause} strikes',
          sub: '${m.strikesToPause} active strikes pause your account. Each one ends after $kStrikeDays days.',
          ghost: 'Niyam',
          tone: DesiTone.gold,
          minHeight: 150,
        ),
        if (m.isPaused || m.isBanned) ...[
          const SizedBox(height: 12),
          DesiCard(
            tone: DesiTone.rani,
            title: m.isBanned ? 'Account closed' : 'Account paused',
            note: m.isBanned ? 'See what this means' : 'A person is checking your calls',
            onTap: () => unawaited(context.push('/safety/paused')),
            child: const Align(alignment: Alignment.centerLeft, child: DesiChip('Open', tone: DesiTone.rani, icon: Icons.arrow_forward_rounded)),
          ),
        ],
        if (m.strikes.isEmpty) ...[
          const SizedBox(height: 12),
          DesiCard(
            tone: DesiTone.tea,
            child: const DesiEmpty(text: 'No strikes. Keep your calls friendly and this stays clear.'),
          ),
        ],
        for (final s in active) ...[const SizedBox(height: 12), _strikeCard(s)],
        for (final s in ended) ...[const SizedBox(height: 12), _endedCard(s)],
        const SizedBox(height: 8),
        const DesiMogra(),
      ],
    );
  }

  Widget _strikeCard(SafetyStrike s) {
    final ctl = _ctl.putIfAbsent(s.id, () => TextEditingController());
    final sent = s.appealStatus == 'open' || _sent.contains(s.id);
    final sub = [
      if (s.callAt != null) 'Call on ${safetyDate(s.callAt!)}',
      if (s.quote != null) 'what you said',
    ].join(' · ');
    final err = _err[s.id];
    return DesiCard(
      corner: DesiCorner.hibiscus,
      padding: const EdgeInsets.fromLTRB(18, 16, 18, 16),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        DesiChip(s.expiresAt == null ? 'Active' : 'Active · ends ${safetyDate(s.expiresAt!)}', tone: DesiTone.gold),
        const SizedBox(height: 10),
        DesiTitle(s.reasonText),
        if (sub.isNotEmpty)
          Padding(padding: const EdgeInsets.only(left: 29, top: 2), child: Text(sub, style: t(14, color: C.muted, w: FontWeight.w600))),
        if (s.quote != null) ...[
          const SizedBox(height: 10),
          DesiCard(
            tone: DesiTone.cream,
            pattern: DesiPattern.bahi,
            radius: 14,
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: Text('“${s.quote}”', style: t(15, w: FontWeight.w700, h: 38 / 15)),
          ),
        ],
        ..._appealPart(s, ctl, sent, err),
      ]),
    );
  }

  List<Widget> _appealPart(SafetyStrike s, TextEditingController ctl, bool sent, String? err) {
    if (sent) {
      return [
        const SizedBox(height: 12),
        const Align(alignment: Alignment.centerLeft, child: DesiChip('Appeal sent', tone: DesiTone.lav, icon: Icons.check_rounded)),
        const SizedBox(height: 6),
        Text('We will look at it and reply on WhatsApp.', style: t(14, color: C.muted, w: FontWeight.w600)),
      ];
    }
    if (s.appealStatus == 'rejected') {
      return [
        const SizedBox(height: 12),
        const Align(alignment: Alignment.centerLeft, child: DesiChip('Appeal reviewed', tone: DesiTone.rani)),
        const SizedBox(height: 6),
        Text('We looked at your appeal and this strike stays.', style: t(14, color: C.muted, w: FontWeight.w600)),
      ];
    }
    if (!s.canAppeal) return const <Widget>[];
    return [
      const SizedBox(height: 14),
      Text('Think this is wrong? Tell us why', style: t(15, w: FontWeight.w800)),
      const SizedBox(height: 8),
      TextField(
        controller: ctl,
        minLines: 2,
        maxLines: 4,
        maxLength: 500,
        textCapitalization: TextCapitalization.sentences,
        style: t(15, w: FontWeight.w600),
        decoration: InputDecoration(
          hintText: 'Write a few words',
          counterText: '',
          filled: true,
          fillColor: C.cream,
          contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          border: OutlineInputBorder(borderRadius: BorderRadius.circular(16), borderSide: const BorderSide(color: C.line, width: 1.5)),
          enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(16), borderSide: const BorderSide(color: C.line, width: 1.5)),
          focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(16), borderSide: const BorderSide(color: C.maroon, width: 2)),
        ),
      ),
      if (err != null) ...[
        const SizedBox(height: 8),
        Semantics(liveRegion: true, child: Text(err, style: t(14, color: C.ruby, w: FontWeight.w800, h: 1.35))),
      ],
      const SizedBox(height: 12),
      SafetyButton('Send appeal', busy: _sending.contains(s.id), onTap: () => unawaited(_appeal(s))),
      const SizedBox(height: 10),
      Text('One appeal per strike · reply on WhatsApp in 3 working days', textAlign: TextAlign.center, style: t(14, color: C.muted, w: FontWeight.w600)),
    ];
  }

  String _endedText(SafetyStrike s) {
    if (s.removed) {
      final why = s.removedWhy;
      if (why != null && why.toLowerCase().contains('appeal')) return 'Removed after your appeal';
      if (why != null && why.contains(' ')) return why;
      return 'Removed by our team';
    }
    return s.expiresAt == null ? 'Ended' : 'Ended on ${safetyDate(s.expiresAt!)}';
  }

  Widget _endedCard(SafetyStrike s) {
    final title = s.callAt == null ? s.reasonText : '${s.reasonText} · ${safetyDate(s.callAt!)}';
    return DesiCard(
      tone: DesiTone.tea,
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
      child: Row(children: [
        Container(
          width: 44,
          height: 44,
          decoration: BoxDecoration(color: C.white, borderRadius: BorderRadius.circular(13)),
          child: const Icon(Icons.check_rounded, size: 22, color: C.peacock),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: t(16, w: FontWeight.w800, h: 1.25)),
            Text(_endedText(s), style: t(14, color: C.muted, w: FontWeight.w600)),
          ]),
        ),
      ]),
    );
  }
}

// =========================================================================================================== Paused

/// [HF-CALL-SAFETY-APP] "Account paused" (artboard AppPaused): plum hero, what is off and what still works, the held earnings as a bank
/// slip, "See my strikes" and "Contact support". Also opened by a 403 `account_paused` from going Online, a call or a booking.
/// A paused fan sees the same screen without the influencer-only lines.
class AccountPausedScreen extends StatefulWidget {
  const AccountPausedScreen({super.key, this.repo});

  final CallSafetyRepo? repo;

  @override
  State<AccountPausedScreen> createState() => _AccountPausedScreenState();
}

class _AccountPausedScreenState extends State<AccountPausedScreen> {
  AsyncState<SafetyMe> _state = const AsyncLoading<SafetyMe>();

  CallSafetyRepo get _repo => widget.repo ?? Services.instance.callSafetyRepo;
  bool get _influencer => Services.instance.me?.isHost == true;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    if (_state is! AsyncLoading<SafetyMe>) setState(() => _state = const AsyncLoading<SafetyMe>());
    try {
      final m = await _repo.me();
      if (!mounted) return;
      setState(() => _state = AsyncData<SafetyMe>(m));
      CallSafetyStore.instance.accept(m);
      Telemetry.event('hf_safety_view', {'surface': 'paused', 'status': m.status, 'strikes': m.activeStrikes});
    } catch (e) {
      if (!mounted) return;
      setState(() => _state = AsyncFailure<SafetyMe>(e));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: C.page,
      body: SafeArea(
        child: Column(children: [
          const SafetyHeader(title: 'Account'),
          Expanded(
            child: AsyncView<SafetyMe>(
              state: _state,
              onRetry: () => unawaited(_load()),
              isEmpty: (_) => false,
              builder: _content,
            ),
          ),
        ]),
      ),
    );
  }

  Widget _list(String title, List<String> lines, DesiTone tone) => Expanded(
        child: DesiCard(
          tone: tone,
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            DesiTitle(title, size: 17),
            const SizedBox(height: 6),
            Text(lines.join('\n'), style: t(15, w: FontWeight.w700, h: 1.75)),
          ]),
        ),
      );

  Widget _content(BuildContext context, SafetyMe m) {
    final banned = m.isBanned;
    final host = _influencer;
    final due = m.reviewDueAt;
    final strikes = m.activeStrikes;
    final base = t(15, color: C.white, w: FontWeight.w600, h: 1.4);
    final reply = banned
        ? 'If you think this is a mistake, write to us and a person will look at it.'
        : (due == null ? 'A person will reply on WhatsApp soon.' : 'A person will reply on WhatsApp by ');
    final lead = (!banned && strikes > 0) ? 'You have $strikes active ${strikes == 1 ? 'strike' : 'strikes'}. ' : '';
    return ListView(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 24),
      children: [
        Semantics(
          container: true,
          liveRegion: true,
          child: DesiHero(
            eyebrow: banned ? 'Account closed' : 'Account paused',
            title: banned ? 'Your account is closed' : "We're checking your calls",
            ghost: banned ? 'Band' : 'Ruko',
            tone: DesiTone.plum,
            child: Text.rich(TextSpan(style: base, children: [
              TextSpan(text: '$lead$reply'),
              if (!banned && due != null) ...[
                TextSpan(text: safetyDate(due), style: t(15, color: C.lemon, w: FontWeight.w800, h: 1.4)),
                const TextSpan(text: '.'),
              ],
            ])),
          ),
        ),
        if (!banned) ...[
          const SizedBox(height: 12),
          IntrinsicHeight(
            child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              _list('Off for now', host ? const ['Calls', 'Queue', 'New bookings', 'Your reel'] : const ['Calls', 'New bookings'], DesiTone.rani),
              const SizedBox(width: 10),
              _list('Still works', host ? const ['Log in', 'Call history', 'Your strikes', 'Earnings'] : const ['Log in', 'Call history', 'Your strikes', 'Withdraw money'], DesiTone.tea),
            ]),
          ),
        ],
        if (host && m.heldPaise > 0) ...[
          const SizedBox(height: 12),
          DesiSlip(
            strip: 'Earnings held',
            tone: DesiTone.rani,
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(inr(m.heldPaise / 100, paise: false), style: t(24, color: C.maroon, w: FontWeight.w800)),
              const SizedBox(height: 4),
              Text('Held during the review. Your bookings were cancelled and fans got a full refund.', style: t(14, color: C.muted, w: FontWeight.w600, h: 1.45)),
            ]),
          ),
        ],
        const SizedBox(height: 16),
        if (!banned) ...[
          SafetyButton('See my strikes', onTap: () => unawaited(context.push('/safety'))),
          const SizedBox(height: 10),
        ],
        SafetyButton('Contact support', ghost: true, onTap: () => unawaited(openSupportMail(context))),
        const SizedBox(height: 8),
        const DesiMogra(),
      ],
    );
  }
}
