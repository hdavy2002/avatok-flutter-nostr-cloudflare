import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/api_error.dart';
import '../../../../core/links.dart';
import '../../../../core/theme/hf_tokens.dart';
import '../../../../core/widgets/widgets.dart';
import '../../../explore/data/host_options.dart';
import '../../../host_profile/ui/widgets/net_image.dart';
import '../../../kyc/kyc.dart';
import '../../flow/onboarding_context.dart';
import '../../flow/onboarding_steps.dart';
import '../data/edit_lock.dart';
import '../data/host_setup_api.dart';
import '../data/part_b_rules.dart';
import '../data/part_b_telemetry.dart';
import 'part_b_copy.dart';
import 'part_b_widgets.dart';

/// Step `review`: everything the host entered, with an Edit button per part that opens that step, then the three
/// agreements (host rules, host agreement, welfare and crisis guide). "Create my profile" saves the agreements
/// (`PUT /api/hosts/me {agreements: true}`) and opens the generating step.
///
/// A part that is not finished is listed at the top with a button to fix it, and the main button stays off.
class ReviewStep extends ConsumerStatefulWidget {
  const ReviewStep({super.key, required this.ctx});

  final OnboardingStepContext ctx;

  @override
  ConsumerState<ReviewStep> createState() => _ReviewStepState();
}

class _ReviewStepState extends ConsumerState<ReviewStep> {
  late bool _rules;
  late bool _agreement;
  late bool _welfare;
  bool _busy = false;
  String? _error;

  OnboardingStepContext get ctx => widget.ctx;

  @override
  void initState() {
    super.initState();
    final done = ctx.state.hostNum('agreementsAt') != null || ctx.state.generated;
    _rules = done;
    _agreement = done;
    _welfare = done;
  }

  bool get _allTicked => _rules && _agreement && _welfare;

  /// Steps of the profile that the server does not have yet (hours are optional).
  List<OnboardingStepDef> _missing() => [
        for (final def in kOnboardingSteps)
          if (_isProfilePart(def.key) && !def.isDone(ctx.state)) def,
      ];

  static bool _isProfilePart(String key) =>
      key == OnboardingKeys.avatar ||
      key == OnboardingKeys.about ||
      key == OnboardingKeys.languages ||
      key == OnboardingKeys.topics ||
      key == OnboardingKeys.price ||
      key == OnboardingKeys.voice;

  Future<void> _create() async {
    if (_busy) return;
    final status = ctx.state.hostStatus;
    if (status == 'generating') {
      ctx.goTo(OnboardingKeys.generating);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(hostSetupApiProvider).acceptAgreements();
    } on ApiError catch (e) {
      if (e.code != 'locked') {
        OnboardingTelemetry.step('review', 'error', reason: e.code, status: e.status);
        if (!mounted) return;
        setState(() {
          _busy = false;
          _error = e.userMessage;
        });
        return;
      }
    }
    OnboardingTelemetry.step('review', 'ok');
    await ctx.next();
    if (mounted) setState(() => _busy = false);
  }

  @override
  Widget build(BuildContext context) {
    final s = ctx.state;
    final options = optionsOf(ref.watch(hostOptionsProvider));
    final lock = EditLock.of(s.hostStatus);
    final missing = _missing();
    final generating = s.hostStatus == 'generating';
    final canCreate = generating || (!lock.inReview && missing.isEmpty && _allTicked);
    final banner = lock.inReview && !generating ? lock.banner() : null;

    return PartBStep(
      title: PartBCopy.reviewTitle,
      lead: PartBCopy.reviewLead,
      bottom: [
        if (_error != null) InlineError(_error!),
        const SizedBox(height: 4),
        HfButton(
          key: const ValueKey<String>('review-create'),
          label: generating ? PartBCopy.seeProgress : PartBCopy.createProfile,
          loading: _busy,
          onPressed: canCreate ? _create : null,
        ),
      ],
      children: [
        if (banner != null) LockBanner(banner),
        if (generating) LockBanner(lock.banner() ?? ''),
        if (missing.isNotEmpty && !lock.inReview) _MissingBox(missing: missing, onFix: ctx.goTo),
        _verified(s),
        _section(PartBCopy.reviewAvatar, OnboardingKeys.avatar, [_avatar(s)]),
        _section(PartBCopy.reviewNameAbout, OnboardingKeys.about, [
          Text(s.hostString('displayName') ?? '-', style: HfText.bodyStrong),
          const SizedBox(height: 4),
          Text(s.hostString('about') ?? '', style: HfText.bodyText),
        ]),
        _section(PartBCopy.reviewLanguages, OnboardingKeys.languages, [
          Text(s.hostStrings('languages').join(', '), style: HfText.bodyText),
          const SizedBox(height: 4),
          Text(_styleLabel(s.hostString('style')), style: HfText.note),
        ]),
        _section(PartBCopy.reviewTopics, OnboardingKeys.topics, [
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final t in s.hostStrings('topics')) _Pill(options?.topicLabel(t) ?? t.replaceAll('-', ' ')),
            ],
          ),
        ]),
        _section(PartBCopy.reviewPrice, OnboardingKeys.price, [_price(s)]),
        _section(PartBCopy.reviewHours, OnboardingKeys.hours, _hours(s)),
        _section(PartBCopy.reviewVoice, OnboardingKeys.voice, [_voice(s)]),
        const SizedBox(height: 8),
        ConsentRow(
          key: const ValueKey<String>('review-agree-rules'),
          value: _rules,
          text: PartBCopy.agreeRules,
          onChanged: (v) => setState(() => _rules = v),
        ),
        ConsentRow(
          key: const ValueKey<String>('review-agree-agreement'),
          value: _agreement,
          text: PartBCopy.agreeAgreement,
          onChanged: (v) => setState(() => _agreement = v),
        ),
        ConsentRow(
          key: const ValueKey<String>('review-agree-welfare'),
          value: _welfare,
          text: PartBCopy.agreeWelfare,
          onChanged: (v) => setState(() => _welfare = v),
        ),
        const SizedBox(height: 4),
        _linkButton('review-read-rules', PartBCopy.readRules, '/hosts/rules'),
        _linkButton('review-read-agreement', PartBCopy.readAgreement, '/hosts/agreement'),
        _linkButton('review-read-welfare', PartBCopy.readWelfare, '/hosts/crisis-script'),
      ],
    );
  }

  Widget _linkButton(String key, String label, String path) => HfButton(
        key: ValueKey<String>(key),
        label: label,
        kind: HfButtonKind.text,
        onPressed: () => unawaited(LinkOpener.instance.site(path)),
      );

  static String _styleLabel(String? slug) {
    for (final c in kStyleChoices) {
      if (c.slug == slug) return c.label;
    }
    return slug ?? '';
  }

  Widget _section(String title, String step, List<Widget> body) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: HfCard(
        key: ValueKey<String>('review-section-$step'),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Expanded(child: Semantics(header: true, child: Text(title, style: HfText.subtitle))),
                TextButton(
                  key: ValueKey<String>('review-edit-$step'),
                  onPressed: () => ctx.goTo(step),
                  child: Semantics(label: '${PartBCopy.edit} $title', excludeSemantics: true, child: const Text(PartBCopy.edit)),
                ),
              ],
            ),
            const SizedBox(height: 4),
            ...body,
          ],
        ),
      ),
    );
  }

  Widget _tickRow(bool ok, String text) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(ok ? Icons.check_circle_rounded : Icons.error_outline_rounded, size: 22, color: ok ? HfColors.orchid : HfColors.accent),
          const SizedBox(width: 10),
          Expanded(child: Text(text, style: HfText.bodyText)),
        ],
      ),
    );
  }

  Widget _verified(OnboardingServerState s) {
    final k = s.kyc;
    final selfieOk = k.selfieStatus == 'pending' || k.selfieStatus == 'approved';
    return _section(PartBCopy.reviewVerified, OnboardingKeys.phone, [
      _tickRow(s.phoneVerified, 'WhatsApp +91 •••• ${s.phoneLast4 ?? '----'}'),
      _tickRow(k.aadhaarDone, '${KycCopy.aadhaarEnding} ${k.last4 ?? '----'}'),
      _tickRow(selfieOk, selfieOk ? 'Selfie video sent' : 'Selfie video not done'),
      _tickRow(k.payoutDone, k.payoutDone ? 'Payout account ending ${k.payoutLast4 ?? '----'} (name matched)' : 'Payout account not done'),
    ]);
  }

  Widget _avatar(OnboardingServerState s) {
    final url = s.hostString('avatarUrl');
    if (url == null) return const Text(PartBCopy.reviewNoAvatar, style: HfText.bodyText);
    final image = ref.watch(hostImageBuilderProvider);
    return Row(
      children: [
        ClipRRect(
          borderRadius: BorderRadius.circular(HfRadius.control),
          child: SizedBox(width: 96, height: 96, child: image(context, url, fit: BoxFit.cover)),
        ),
        const SizedBox(width: 12),
        const Flexible(child: AiLabel(text: PartBCopy.avatarAiLabel)),
      ],
    );
  }

  Widget _price(OnboardingServerState s) {
    final p = s.hostNum('pricePerMin')?.toInt();
    if (p == null) return const Text('-', style: HfText.bodyText);
    return Text(
      '${rupeesText(p)} per minute. You get ${rupeesFromPaise(hostSharePaise(p))}.',
      style: HfText.bodyText,
    );
  }

  List<Widget> _hours(OnboardingServerState s) {
    final h = s.hostMap('hours');
    final days = <String>[
      if (h['days'] is List)
        for (final d in h['days'] as List)
          if (d is num && d >= 0 && d < kDayLabels.length) kDayLabels[d.toInt()],
    ];
    final lgbtq = s.host?['lgbtqLane'] == true;
    final lgbtqPublic = s.host?['lgbtqPublic'] == true;
    return [
      Text(
        days.isEmpty ? PartBCopy.reviewNoDays : '${days.join(', ')}, ${validHhmm(h['from'], '19:00')} to ${validHhmm(h['to'], '22:00')}',
        style: HfText.bodyText,
      ),
      const SizedBox(height: 4),
      Text(s.host?['womenLane'] == true ? PartBCopy.reviewWomenOnly : PartBCopy.reviewAllCallers, style: HfText.note),
      Text(lgbtq ? (lgbtqPublic ? PartBCopy.reviewLgbtqPublic : PartBCopy.reviewLgbtqOn) : PartBCopy.reviewLgbtqOff, style: HfText.note),
    ];
  }

  Widget _voice(OnboardingServerState s) {
    final v = s.hostMap('voice');
    final secs = v['seconds'];
    if (secs is! num || secs <= 0) return const Text(PartBCopy.reviewNoVoice, style: HfText.bodyText);
    final status = (v['status'] ?? '').toString();
    final text = status == 'approved'
        ? PartBCopy.voiceStatusApproved
        : (status == 'rejected' ? PartBCopy.voiceStatusRejected : PartBCopy.voiceStatusPending);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(PartBCopy.voiceLength(mmss(secs.toInt())), style: HfText.bodyText),
        const SizedBox(height: 4),
        Text(text, style: HfText.note),
      ],
    );
  }
}

class _Pill extends StatelessWidget {
  const _Pill(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return ConstrainedBox(
      constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width - 2 * HfSpacing.page - 32),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        decoration: BoxDecoration(color: HfColors.lilac, borderRadius: BorderRadius.circular(HfRadius.pill)),
        child: Text(text, style: HfText.badge),
      ),
    );
  }
}

class _MissingBox extends StatelessWidget {
  const _MissingBox({required this.missing, required this.onFix});

  final List<OnboardingStepDef> missing;
  final void Function(String key) onFix;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Container(
        key: const ValueKey<String>('review-missing'),
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(color: HfColors.blush, borderRadius: BorderRadius.circular(HfRadius.card)),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text(PartBCopy.generatingMissing, style: HfText.subtitle),
            const SizedBox(height: 6),
            for (final m in missing)
              Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: HfButton(
                  key: ValueKey<String>('review-fix-${m.key}'),
                  label: m.title,
                  kind: HfButtonKind.secondary,
                  onPressed: () => onFix(m.key),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
