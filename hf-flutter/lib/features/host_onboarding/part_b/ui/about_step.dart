import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/theme/hf_tokens.dart';
import '../../../../core/widgets/widgets.dart';
import '../../../kyc/kyc.dart';
import '../../flow/onboarding_context.dart';
import '../data/edit_lock.dart';
import '../data/part_b_rules.dart';
import '../data/part_b_telemetry.dart';
import '../data/profile_saver.dart';
import 'part_b_copy.dart';
import 'part_b_widgets.dart';

/// Step `about`: first name and "tell callers about yourself" (40 to 500 characters).
///
/// Both fields save by themselves 800 ms after the last key (`PUT /api/hosts/me`, one field per request).
/// The phone checks the rules first (name letters only, no phone numbers, links or app names in the text); the
/// worker checks again and its message (`invalid_field` with a `field`) shows under that field.
class AboutStep extends ConsumerStatefulWidget {
  const AboutStep({super.key, required this.ctx});

  final OnboardingStepContext ctx;

  @override
  ConsumerState<AboutStep> createState() => _AboutStepState();
}

class _AboutStepState extends ConsumerState<AboutStep> {
  late final ProfileSaver _saver;
  late final TextEditingController _name;
  late final TextEditingController _about;
  bool _busy = false;

  OnboardingStepContext get ctx => widget.ctx;

  @override
  void initState() {
    super.initState();
    _saver = ref.read(profileSaverProvider);
    final s = ctx.state;
    _saver.seed('displayName', s.hostString('displayName'));
    _saver.seed('about', s.hostString('about'));
    _name = TextEditingController(text: '${_saver.valueOf('displayName', s.hostString('displayName')) ?? ''}');
    _about = TextEditingController(text: '${_saver.valueOf('about', s.hostString('about')) ?? ''}');
    _saver.addListener(_changed);
  }

  @override
  void dispose() {
    _saver.removeListener(_changed);
    // Anything still waiting is sent now, so going Back never loses what was typed.
    unawaited(_saver.flush());
    _name.dispose();
    _about.dispose();
    super.dispose();
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  String get _nameText => _name.text.trim();
  String get _aboutText => _about.text.trim();

  bool get _nameOk => isValidFirstName(_nameText) && contactLeakMessage(_nameText) == null;
  bool get _aboutOk =>
      _aboutText.length >= kAboutMin && _aboutText.length <= kAboutMax && contactLeakMessage(_aboutText) == null;

  String? get _nameError {
    if (_nameText.isEmpty) return null;
    return _saver.errorOf('displayName') ??
        contactLeakMessage(_nameText) ??
        (isValidFirstName(_nameText) ? null : PartBCopy.nameFormat);
  }

  String? get _aboutError {
    if (_aboutText.isEmpty) return _saver.errorOf('about');
    return _saver.errorOf('about') ?? contactLeakMessage(_aboutText);
  }

  bool get _valid =>
      _nameOk && _aboutOk && _saver.errorOf('displayName') == null && _saver.errorOf('about') == null;

  void _nameChanged(String v) {
    final t = v.trim();
    if (isValidFirstName(t)) _saver.set('displayName', t);
    setState(() {});
  }

  void _aboutChanged(String v) {
    final t = v.trim();
    if (t.isNotEmpty && t.length <= 600) _saver.set('about', t);
    setState(() {});
  }

  void _addIdea(String idea) {
    final cur = _about.text.trim();
    final next = (cur.isEmpty ? idea : '$cur $idea');
    final cut = next.length > kAboutMax ? next.substring(0, kAboutMax) : next;
    _about.text = cut;
    _about.selection = TextSelection.collapsed(offset: cut.length);
    _aboutChanged(cut);
  }

  Future<void> _continue() async {
    if (_busy) return;
    final lock = EditLock.of(ctx.state.hostStatus);
    if (lock.profileLocked) {
      await ctx.next();
      return;
    }
    if (!_valid) return;
    setState(() => _busy = true);
    final ok = await _saver.flush(fields: const <String>['displayName', 'about']);
    if (!mounted) return;
    setState(() => _busy = false);
    if (!ok) {
      OnboardingTelemetry.step('about', 'error', reason: _saver.saveProblem == null ? 'invalid_field' : 'save_failed');
      return;
    }
    OnboardingTelemetry.step('about', 'ok');
    await ctx.next();
  }

  @override
  Widget build(BuildContext context) {
    final lock = EditLock.of(ctx.state.hostStatus);
    final banner = lock.banner();
    final locked = lock.profileLocked;
    final len = _aboutText.length;
    final problem = _saver.saveProblem;
    return PartBStep(
      scene: HfSceneKind.profile,
      title: PartBCopy.aboutTitle,
      lead: PartBCopy.aboutLead,
      bottom: [
        if (problem != null) InlineError(problem),
        const SizedBox(height: 4),
        HfButton(
          key: const ValueKey<String>('about-continue'),
          label: PartBCopy.continueLabel,
          loading: _busy,
          onPressed: (locked || _valid) ? _continue : null,
        ),
      ],
      children: [
        if (banner != null) LockBanner(banner),
        TextField(
          key: const ValueKey<String>('about-name'),
          controller: _name,
          enabled: !locked,
          autocorrect: false,
          textCapitalization: TextCapitalization.words,
          textInputAction: TextInputAction.next,
          inputFormatters: [LengthLimitingTextInputFormatter(20)],
          decoration: InputDecoration(
            prefixIcon: const Icon(Icons.badge_outlined),
            labelText: PartBCopy.nameLabel,
            hintText: PartBCopy.nameHint,
            helperText: PartBCopy.nameHelp,
            helperMaxLines: 5,
            errorText: _nameError,
            errorMaxLines: 3,
          ),
          onChanged: _nameChanged,
        ),
        const SizedBox(height: 20),
        TextField(
          key: const ValueKey<String>('about-text'),
          controller: _about,
          enabled: !locked,
          minLines: 5,
          maxLines: 8,
          maxLength: kAboutMax,
          keyboardType: TextInputType.multiline,
          textCapitalization: TextCapitalization.sentences,
          decoration: InputDecoration(
            labelText: PartBCopy.aboutLabel,
            hintText: PartBCopy.aboutHint,
            alignLabelWithHint: true,
            counterText: '',
            errorText: _aboutError,
            errorMaxLines: 3,
          ),
          onChanged: _aboutChanged,
        ),
        const SizedBox(height: 6),
        Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('$len / $kAboutMax', key: const ValueKey<String>('about-count'),
            style: HfText.note.copyWith(color: len > 0 && len < kAboutMin ? HfColors.accent : HfColors.mauve)),
          const SizedBox(height: 8),
          const Text(PartBCopy.aboutHelp, style: HfText.note),
        ]),
        if (len > 0 && len < kAboutMin)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text(PartBCopy.aboutMore(kAboutMin - len), key: const ValueKey<String>('about-more'), style: HfText.note),
          ),
        if (!locked) ...[
          const SizedBox(height: 20),
          const Text(PartBCopy.ideasTitle, style: HfText.bodyStrong),
          const SizedBox(height: 8),
          for (var i = 0; i < PartBCopy.ideas.length; i++)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: HfButton(
                key: ValueKey<String>('about-idea-$i'),
                label: '+ ${PartBCopy.ideas[i]}',
                kind: HfButtonKind.secondary,
                onPressed: () => _addIdea(PartBCopy.ideas[i]),
              ),
            ),
        ],
      ],
    );
  }
}
