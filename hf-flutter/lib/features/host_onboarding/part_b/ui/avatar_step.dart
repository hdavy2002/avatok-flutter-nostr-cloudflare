import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/api_error.dart';
import '../../../../core/theme/hf_tokens.dart';
import '../../../../core/widgets/widgets.dart';
import '../../../host_profile/ui/widgets/net_image.dart';
import '../../../kyc/kyc.dart';
import '../../flow/onboarding_context.dart';
import '../data/edit_lock.dart';
import '../data/host_setup_api.dart';
import '../data/part_b_telemetry.dart';
import 'part_b_copy.dart';
import 'part_b_widgets.dart';

/// Draws an avatar picture. The default uses `cached_network_image` with a small memory cache (a grid shows many
/// pictures at once). Widget tests override it with a plain box, so no test needs the network.
final avatarImageBuilderProvider = Provider<HostImageBuilder>((ref) => _thumb);

Widget _thumb(BuildContext context, String url, {BoxFit fit = BoxFit.cover}) {
  return CachedNetworkImage(
    imageUrl: url,
    fit: fit,
    memCacheWidth: 420,
    fadeInDuration: const Duration(milliseconds: 150),
    placeholder: (_, __) => const PicturePlaceholder(),
    errorWidget: (_, __, ___) => const PicturePlaceholder(),
  );
}

/// Step `avatar`: pick one exclusive AI avatar from the catalogue (`GET /api/hosts/avatars`), filtered by gender,
/// age and look on the phone. Tapping a picture takes it at once (`POST /api/hosts/avatars/:id/claim`); if someone
/// was faster (`409 avatar_taken`) the grid reloads and says so. Every picture is labelled "AI avatar".
class AvatarStep extends ConsumerStatefulWidget {
  const AvatarStep({super.key, required this.ctx});

  final OnboardingStepContext ctx;

  @override
  ConsumerState<AvatarStep> createState() => _AvatarStepState();
}

class _AvatarStepState extends ConsumerState<AvatarStep> {
  String _gender = 'all';
  String _age = 'all';
  String _look = 'all';
  String? _selected;
  String? _claiming;
  String? _message;
  bool _busy = false;

  OnboardingStepContext get ctx => widget.ctx;

  String? get _chosen => _selected ?? ctx.state.hostString('avatarId');

  Future<void> _pick(AvatarChoice a) async {
    if (_claiming != null || a.taken || a.id == _chosen) return;
    setState(() {
      _claiming = a.id;
      _message = null;
    });
    try {
      await ref.read(hostSetupApiProvider).claimAvatar(a.id);
      if (!mounted) return;
      setState(() {
        _selected = a.id;
        _claiming = null;
      });
      OnboardingTelemetry.step('avatar', 'claimed');
    } on ApiError catch (e) {
      if (!mounted) return;
      final taken = e.code == 'avatar_taken';
      OnboardingTelemetry.step('avatar', taken ? 'taken' : 'error', reason: e.code, status: e.status);
      setState(() {
        _claiming = null;
        _message = e.message ?? (taken ? PartBCopy.avatarClaimFailed : e.userMessage);
      });
      if (taken) ref.invalidate(avatarCatalogProvider);
    }
  }

  Future<void> _continue() async {
    if (_busy) return;
    setState(() => _busy = true);
    OnboardingTelemetry.step('avatar', 'ok');
    await ctx.next();
    if (mounted) setState(() => _busy = false);
  }

  @override
  Widget build(BuildContext context) {
    final catalog = ref.watch(avatarCatalogProvider);
    final lock = EditLock.of(ctx.state.hostStatus);
    final chosen = _chosen;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(
          child: AsyncValueView<List<AvatarChoice>>(
            value: catalog,
            loadingMessage: PartBCopy.avatarsLoading,
            onRetry: () => ref.invalidate(avatarCatalogProvider),
            data: (list) => _grid(list, lock),
          ),
        ),
        PinnedBar(
          children: [
            if (_message != null) InlineError(_message!),
            const SizedBox(height: 4),
            HfButton(
              key: const ValueKey<String>('avatar-continue'),
              label: PartBCopy.continueLabel,
              loading: _busy,
              onPressed: (chosen != null || lock.avatarLocked) ? _continue : null,
            ),
          ],
        ),
      ],
    );
  }

  Widget _grid(List<AvatarChoice> all, EditLock lock) {
    final shown = [
      for (final a in all)
        if ((_gender == 'all' || a.gender == _gender) && (_age == 'all' || a.age == _age) && (_look == 'all' || a.look == _look)) a,
    ];
    final banner = lock.banner();
    final locked = lock.avatarLocked;
    final image = ref.watch(avatarImageBuilderProvider);
    return CustomScrollView(
      slivers: [
        SliverPadding(
          padding: const EdgeInsets.fromLTRB(HfSpacing.page, 8, HfSpacing.page, 8),
          sliver: SliverToBoxAdapter(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text(PartBCopy.avatarTitle, style: HfText.title),
                const SizedBox(height: 8),
                const Text(PartBCopy.avatarLead, style: HfText.bodyText),
                const SizedBox(height: 16),
                if (banner != null) LockBanner(banner),
                _FilterRow(
                  legend: PartBCopy.filterGender,
                  keyPrefix: 'avatar-filter-gender',
                  value: _gender,
                  options: const <MapEntry<String, String>>[
                    MapEntry('all', PartBCopy.all),
                    MapEntry('woman', PartBCopy.women),
                    MapEntry('man', PartBCopy.men),
                  ],
                  onChanged: (v) => setState(() => _gender = v),
                ),
                _FilterRow(
                  legend: PartBCopy.filterAge,
                  keyPrefix: 'avatar-filter-age',
                  value: _age,
                  options: const <MapEntry<String, String>>[
                    MapEntry('all', PartBCopy.all),
                    MapEntry('20s', '20s'),
                    MapEntry('30s', '30s'),
                    MapEntry('40s', '40s'),
                    MapEntry('50s+', '50s+'),
                  ],
                  onChanged: (v) => setState(() => _age = v),
                ),
                _FilterRow(
                  legend: PartBCopy.filterLook,
                  keyPrefix: 'avatar-filter-look',
                  value: _look,
                  options: const <MapEntry<String, String>>[
                    MapEntry('all', PartBCopy.all),
                    MapEntry('traditional', PartBCopy.traditional),
                    MapEntry('casual', PartBCopy.casual),
                    MapEntry('office', PartBCopy.office),
                  ],
                  onChanged: (v) => setState(() => _look = v),
                ),
              ],
            ),
          ),
        ),
        if (shown.isEmpty)
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: HfSpacing.page),
              child: HfCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const Text(PartBCopy.avatarNone, style: HfText.bodyStrong, textAlign: TextAlign.center),
                    const SizedBox(height: 12),
                    HfButton(
                      key: const ValueKey<String>('avatar-show-all'),
                      label: PartBCopy.avatarShowAll,
                      kind: HfButtonKind.secondary,
                      onPressed: () => setState(() {
                        _gender = 'all';
                        _age = 'all';
                        _look = 'all';
                      }),
                    ),
                  ],
                ),
              ),
            ),
          )
        else
          SliverPadding(
            padding: const EdgeInsets.symmetric(horizontal: HfSpacing.page),
            sliver: SliverGrid(
              gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                crossAxisCount: 2,
                mainAxisSpacing: 12,
                crossAxisSpacing: 12,
                childAspectRatio: 0.82,
              ),
              delegate: SliverChildBuilderDelegate(
                (context, i) => _AvatarTile(
                  avatar: shown[i],
                  selected: shown[i].id == _chosen,
                  claiming: _claiming == shown[i].id,
                  image: image,
                  onTap: locked ? null : () => _pick(shown[i]),
                ),
                childCount: shown.length,
              ),
            ),
          ),
        const SliverPadding(
          padding: EdgeInsets.fromLTRB(HfSpacing.page, 16, HfSpacing.page, 24),
          sliver: SliverToBoxAdapter(child: Text(PartBCopy.avatarNote, style: HfText.note)),
        ),
      ],
    );
  }
}

class _FilterRow extends StatelessWidget {
  const _FilterRow({
    required this.legend,
    required this.keyPrefix,
    required this.value,
    required this.options,
    required this.onChanged,
  });

  final String legend;
  final String keyPrefix;
  final String value;
  final List<MapEntry<String, String>> options;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(top: 4, bottom: 2),
          child: Semantics(header: true, child: Text(legend, style: HfText.label)),
        ),
        Wrap(
          spacing: 8,
          runSpacing: 0,
          children: [
            for (final o in options)
              HfChip(
                key: ValueKey<String>('$keyPrefix-${o.key}'),
                label: o.value,
                selected: value == o.key,
                onTap: () => onChanged(o.key),
              ),
          ],
        ),
      ],
    );
  }
}

class _AvatarTile extends StatelessWidget {
  const _AvatarTile({
    required this.avatar,
    required this.selected,
    required this.claiming,
    required this.image,
    required this.onTap,
  });

  final AvatarChoice avatar;
  final bool selected;
  final bool claiming;
  final HostImageBuilder image;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final radius = BorderRadius.circular(HfRadius.card);
    final enabled = onTap != null && !avatar.taken;
    return Semantics(
      button: true,
      selected: selected,
      enabled: enabled,
      label: avatar.spoken,
      excludeSemantics: true,
      child: InkWell(
        key: ValueKey<String>('avatar-${avatar.id}'),
        borderRadius: radius,
        onTap: enabled ? onTap : null,
        child: Container(
          decoration: BoxDecoration(
            borderRadius: radius,
            border: Border.all(color: selected ? HfColors.orchid : HfColors.line, width: selected ? 3 : 1.5),
          ),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(HfRadius.card - 2),
            child: Stack(
              fit: StackFit.expand,
              children: [
                Opacity(opacity: avatar.taken ? 0.45 : 1, child: image(context, avatar.url, fit: BoxFit.cover)),
                const Positioned(left: 8, bottom: 8, child: AiLabel(text: PartBCopy.avatarAiLabel)),
                if (avatar.taken)
                  Positioned(
                    top: 8,
                    left: 8,
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                      decoration: BoxDecoration(color: HfColors.butter, borderRadius: BorderRadius.circular(HfRadius.pill)),
                      child: const Text(PartBCopy.avatarTaken, style: HfText.badge),
                    ),
                  ),
                if (selected)
                  const Positioned(
                    top: 8,
                    right: 8,
                    child: CircleAvatar(
                      radius: 16,
                      backgroundColor: HfColors.orchid,
                      child: Icon(Icons.check_rounded, size: 20, color: HfColors.white),
                    ),
                  ),
                if (claiming)
                  Container(
                    color: const Color(0x66FFFDF7),
                    alignment: Alignment.center,
                    child: const CircularProgressIndicator(),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
