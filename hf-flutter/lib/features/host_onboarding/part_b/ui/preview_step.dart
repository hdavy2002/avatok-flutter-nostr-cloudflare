import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/api_error.dart';
import '../../../../core/theme/hf_tokens.dart';
import '../../../../core/widgets/widgets.dart';
import '../../../explore/data/host_options.dart';
import '../../../host_profile/data/host_profile.dart';
import '../../../host_profile/ui/widgets/gallery_pager.dart';
import '../../../host_profile/ui/widgets/net_image.dart';
import '../../../kyc/kyc.dart';
import '../../flow/onboarding_context.dart';
import '../../flow/onboarding_steps.dart';
import '../data/edit_lock.dart';
import '../data/host_setup_api.dart';
import '../data/part_b_rules.dart';
import '../data/part_b_telemetry.dart';
import '../data/voice_audio.dart';
import 'part_b_copy.dart';
import 'part_b_widgets.dart';

/// Step `preview`: the profile as callers will see it (picture, name, tagline, quote, topics, about, voice
/// introduction, AI image gallery), with edit links for the tagline, the quote and the about text
/// (`PUT /api/hosts/me/generated`, limits 120 / 240 / 900), a "Change something" button back to the review step
/// and "Looks good. Send for review" (`POST /api/hosts/submit`).
///
/// Locked: with the team (`pending_review`) or live, nothing can be edited or sent again and the page says so.
/// A rejected or paused profile shows the team's note ("Changes needed") on top.
class PreviewStep extends ConsumerStatefulWidget {
  const PreviewStep({super.key, required this.ctx});

  final OnboardingStepContext ctx;

  @override
  ConsumerState<PreviewStep> createState() => _PreviewStepState();
}

class _PreviewStepState extends ConsumerState<PreviewStep> {
  String? _editing; // tagline | quote | aboutPolished
  final TextEditingController _text = TextEditingController();
  String? _editError;
  bool _savingEdit = false;
  bool _submitting = false;
  String? _submitError;
  List<String> _fixSteps = const <String>[];

  OnboardingStepContext get ctx => widget.ctx;

  static const Map<String, int> _limits = <String, int>{'tagline': 120, 'quote': 240, 'aboutPolished': 900};

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  String _value(String key) {
    final s = ctx.state;
    if (key == 'aboutPolished') return s.hostString('aboutPolished') ?? s.hostString('about') ?? '';
    return s.hostString(key) ?? '';
  }

  void _startEdit(String key) {
    setState(() {
      _editing = key;
      _text.text = _value(key);
      _editError = null;
    });
  }

  void _cancelEdit() => setState(() {
        _editing = null;
        _editError = null;
      });

  Future<void> _saveEdit() async {
    final key = _editing;
    if (key == null || _savingEdit) return;
    final v = _text.text.trim();
    final max = _limits[key] ?? 900;
    if (v.isEmpty || v.length > max) {
      setState(() => _editError = 'Use 1 to $max characters.');
      return;
    }
    final leak = contactLeakMessage(v);
    if (leak != null) {
      setState(() => _editError = leak);
      return;
    }
    setState(() {
      _savingEdit = true;
      _editError = null;
    });
    try {
      await ref.read(hostSetupApiProvider).saveGenerated(<String, String>{key: v});
      OnboardingTelemetry.step('preview', 'saved');
      await ctx.refresh();
      if (!mounted) return;
      setState(() {
        _savingEdit = false;
        _editing = null;
      });
    } on ApiError catch (e) {
      OnboardingTelemetry.step('preview', 'error', reason: e.code, status: e.status);
      if (!mounted) return;
      setState(() {
        _savingEdit = false;
        _editError = e.userMessage;
      });
    }
  }

  Future<void> _submit() async {
    if (_submitting) return;
    setState(() {
      _submitting = true;
      _submitError = null;
      _fixSteps = const <String>[];
    });
    try {
      await ref.read(hostSetupApiProvider).submit();
      OnboardingTelemetry.step('preview', 'submitted');
      OnboardingTelemetry.hostSubmitted();
      await ctx.next();
      if (mounted) setState(() => _submitting = false);
    } on ApiError catch (e) {
      OnboardingTelemetry.step('preview', 'error', reason: e.code, status: e.status);
      if (!mounted) return;
      if (e.code == 'bad_status' && ctx.state.hostStatus == 'pending_review') {
        await ctx.next();
        return;
      }
      setState(() {
        _submitting = false;
        _submitError = e.userMessage;
        _fixSteps = e.code == 'incomplete' ? missingSteps(e) : const <String>[];
      });
    }
  }

  String? get _profileImageUrl {
    for (final m in ctx.state.media) {
      if (m['kind'] == 'profile' && '${m['url'] ?? ''}'.isNotEmpty) return '${m['url']}';
    }
    return ctx.state.hostString('avatarUrl');
  }

  List<GalleryImage> get _gallery {
    final items = <Map<String, dynamic>>[
      for (final m in ctx.state.media)
        if (m['kind'] == 'gallery' && '${m['url'] ?? ''}'.isNotEmpty) m,
    ];
    items.sort((a, b) => ((a['sort'] as num?) ?? 0).compareTo((b['sort'] as num?) ?? 0));
    return [for (final m in items) GalleryImage.fromJson(m)];
  }

  @override
  Widget build(BuildContext context) {
    final s = ctx.state;
    final lock = EditLock.of(s.hostStatus);
    final locked = lock.inReview || lock.live;
    final status = s.hostStatus;
    final options = optionsOf(ref.watch(hostOptionsProvider));
    final image = ref.watch(hostImageBuilderProvider);
    final hero = _profileImageUrl;
    final gallery = _gallery;
    final voiceSeconds = (s.hostMap('voice')['seconds'] as num?)?.toInt() ?? 0;
    final note = s.hostString('reviewNote');
    final price = s.hostNum('pricePerMin')?.toInt();

    return PartBStep(
      title: PartBCopy.previewTitle,
      lead: locked ? null : PartBCopy.previewLead,
      bottom: [
        if (_submitError != null) InlineError(_submitError!),
        for (final key in _fixSteps)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: HfButton(
              key: ValueKey<String>('preview-fix-$key'),
              label: '${PartBCopy.fixThis}: ${_titleOf(key)}',
              kind: HfButtonKind.secondary,
              onPressed: () => ctx.goTo(key),
            ),
          ),
        const SizedBox(height: 4),
        if (locked)
          HfButton(
            key: const ValueKey<String>('preview-next'),
            label: PartBCopy.continueLabel,
            onPressed: () => ctx.goTo(OnboardingKeys.done),
          )
        else ...[
          HfButton(
            key: const ValueKey<String>('preview-submit'),
            label: PartBCopy.sendForReview,
            loading: _submitting,
            onPressed: _editing == null ? _submit : null,
          ),
          HfButton(
            key: const ValueKey<String>('preview-change'),
            label: PartBCopy.changeSomething,
            kind: HfButtonKind.text,
            onPressed: () => ctx.goTo(OnboardingKeys.review),
          ),
        ],
      ],
      children: [
        if (status == 'pending_review') const LockBanner(PartBCopy.previewLockedPending),
        if (status == 'live') const LockBanner(PartBCopy.previewLockedLive),
        if ((status == 'rejected' || status == 'paused'))
          Padding(
            padding: const EdgeInsets.only(bottom: 16),
            child: Container(
              key: const ValueKey<String>('preview-changes'),
              width: double.infinity,
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(color: HfColors.blush, borderRadius: BorderRadius.circular(HfRadius.card)),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(PartBCopy.previewChangesTitle, style: HfText.subtitle),
                  const SizedBox(height: 4),
                  Text(note ?? PartBCopy.previewChangesFallback, style: HfText.bodyText),
                ],
              ),
            ),
          ),
        if (hero != null)
          ClipRRect(
            borderRadius: BorderRadius.circular(HfRadius.card),
            child: AspectRatio(aspectRatio: 1, child: image(context, hero, fit: BoxFit.cover)),
          ),
        const SizedBox(height: 8),
        const Align(alignment: Alignment.centerLeft, child: AiLabel(text: PartBCopy.avatarAiLabel)),
        const SizedBox(height: 12),
        Semantics(
          header: true,
          child: Text(s.hostString('displayName') ?? '', key: const ValueKey<String>('preview-name'), style: HfText.title),
        ),
        if (price != null) Text('${rupeesText(price)}${PartBCopy.previewPerMin}', style: HfText.bodyStrong),
        const SizedBox(height: 12),
        _editable(
          field: 'tagline',
          label: PartBCopy.taglineLabel,
          editLabel: PartBCopy.previewEditTagline,
          style: HfText.bodyStrong,
          maxLines: 2,
          locked: locked,
        ),
        _editable(
          field: 'quote',
          label: PartBCopy.quoteLabel,
          editLabel: PartBCopy.previewEditQuote,
          style: HfText.bodyText.copyWith(fontStyle: FontStyle.italic),
          maxLines: 3,
          locked: locked,
          quoted: true,
        ),
        if (s.hostStrings('topics').isNotEmpty) ...[
          const SizedBox(height: 4),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final t in s.hostStrings('topics'))
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                  decoration: BoxDecoration(color: HfColors.lilac, borderRadius: BorderRadius.circular(HfRadius.pill)),
                  child: Text(options?.topicLabel(t) ?? t.replaceAll('-', ' '), style: HfText.badge),
                ),
            ],
          ),
        ],
        const GroupLegend(PartBCopy.previewAbout),
        _editable(
          field: 'aboutPolished',
          label: PartBCopy.aboutEditLabel,
          editLabel: PartBCopy.previewEditAbout,
          style: HfText.bodyText,
          maxLines: 12,
          locked: locked,
          multiline: true,
        ),
        const GroupLegend(PartBCopy.previewVoice),
        HfCard(
          key: const ValueKey<String>('preview-voice'),
          child: voiceSeconds > 0
              ? ClipPlayerBar(
                  loadPath: ref.read(ownVoiceFetcherProvider).fetchToFile,
                  knownSeconds: voiceSeconds,
                )
              : Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(PartBCopy.previewNoVoice, style: HfText.bodyText),
                    HfButton(
                      key: const ValueKey<String>('preview-record'),
                      label: PartBCopy.previewRecordNow,
                      kind: HfButtonKind.text,
                      onPressed: () => ctx.goTo(OnboardingKeys.voice),
                    ),
                  ],
                ),
        ),
        if (gallery.isNotEmpty) ...[
          const SizedBox(height: 16),
          GalleryPager(items: gallery),
        ],
        const SizedBox(height: 16),
        const HfCard(
          color: HfColors.lilac,
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(Icons.shield_outlined, size: 24, color: HfColors.orchid),
              SizedBox(width: 10),
              Expanded(child: Text(PartBCopy.previewPrivacy, style: HfText.note)),
            ],
          ),
        ),
      ],
    );
  }

  static String _titleOf(String key) {
    for (final d in kOnboardingSteps) {
      if (d.key == key) return d.title;
    }
    return key;
  }

  Widget _editable({
    required String field,
    required String label,
    required String editLabel,
    required TextStyle style,
    required int maxLines,
    required bool locked,
    bool quoted = false,
    bool multiline = false,
  }) {
    final value = _value(field);
    if (_editing == field) {
      return Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TextField(
              key: ValueKey<String>('preview-field-$field'),
              controller: _text,
              autofocus: true,
              minLines: multiline ? 5 : 1,
              maxLines: multiline ? 10 : 3,
              maxLength: _limits[field],
              textCapitalization: TextCapitalization.sentences,
              decoration: InputDecoration(labelText: label, errorText: _editError, errorMaxLines: 3),
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: HfButton(
                    key: const ValueKey<String>('preview-save'),
                    label: PartBCopy.save,
                    loading: _savingEdit,
                    onPressed: _saveEdit,
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: HfButton(
                    key: const ValueKey<String>('preview-cancel'),
                    label: PartBCopy.cancel,
                    kind: HfButtonKind.secondary,
                    onPressed: _savingEdit ? null : _cancelEdit,
                  ),
                ),
              ],
            ),
          ],
        ),
      );
    }
    if (value.isEmpty && locked) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (value.isNotEmpty)
            Text(quoted ? '“$value”' : value, key: ValueKey<String>('preview-text-$field'), style: style),
          if (!locked)
            TextButton(
              key: ValueKey<String>('preview-edit-$field'),
              onPressed: () => _startEdit(field),
              child: Text(editLabel),
            ),
        ],
      ),
    );
  }
}
