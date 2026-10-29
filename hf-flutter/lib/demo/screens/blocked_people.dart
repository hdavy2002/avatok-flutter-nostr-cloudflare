import 'dart:async';

import 'package:flutter/material.dart';

import '../../data/api_exception.dart';
import '../../data/repos/safety_repo.dart';
import '../../data/services.dart';
import '../../ui/async_view.dart';
import '../booking_kit.dart';
import '../desi.dart';
import '../person_avatar.dart'; // [HF-ME-SETTINGS-MOVE]
import '../settings_kit.dart';
import '../theme.dart';
import '../widgets.dart';

/// [HF-BLOCK-PROFILE-1] "Blocked people": everyone you blocked, with Unblock (asks first). Opened from Settings.
///   GET /api/hf/blocks -> items [{key, name, slug, at}]      DELETE /api/hf/blocks/:key
class BlockedPeopleScreen extends StatefulWidget {
  const BlockedPeopleScreen({super.key, this.repo});

  /// Tests pass a repo on a fake API; the app uses [Services].
  final SafetyRepo? repo;

  @override
  State<BlockedPeopleScreen> createState() => _BlockedPeopleScreenState();
}

class _BlockedPeopleScreenState extends State<BlockedPeopleScreen> {
  AsyncState<List<BlockedPerson>> _state = const AsyncLoading();
  String? _busyKey;

  SafetyRepo get _repo => widget.repo ?? Services.instance.safetyRepo;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    setState(() => _state = const AsyncLoading());
    try {
      final list = await _repo.blocks();
      if (mounted) setState(() => _state = AsyncData(list));
    } catch (e) {
      if (mounted) setState(() => _state = AsyncFailure(e));
    }
  }

  Future<void> _unblock(BlockedPerson p) async {
    if (_busyKey != null) return;
    final yes = await hfConfirm(
      context,
      title: 'Unblock ${p.name}?',
      body: 'They will be able to call and book you again.',
      confirmLabel: 'Unblock',
      cancelLabel: 'Cancel',
    );
    if (!yes || !mounted) return;
    setState(() => _busyKey = p.key);
    final messenger = ScaffoldMessenger.of(context);
    try {
      await _repo.unblock(p.key);
      if (!mounted) return;
      final s = _state;
      if (s is AsyncData<List<BlockedPerson>>) {
        setState(() => _state = AsyncData([for (final b in s.value) if (b.key != p.key) b]));
      }
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text('${p.name} is unblocked.')));
    } catch (e) {
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text(e is ApiException ? e.userMessage : ApiException.genericText)));
    } finally {
      if (mounted) setState(() => _busyKey = null);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        backgroundColor: C.page,
        body: SafeArea(
          child: Column(children: [
            const BookHeader('Blocked people'),
            Expanded(
              child: AsyncView<List<BlockedPerson>>(
                state: _state,
                onRetry: _load,
                emptyTitle: 'You haven\'t blocked anyone',
                emptyMessage: 'People you block can\'t call or book you. You can block someone from their profile or a call record.',
                builder: (context, list) => ListView(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
                  children: [
                    SettingsCard(title: 'Blocked', tone: DesiTone.rani, children: [
                      for (var i = 0; i < list.length; i++) _row(list[i], last: i == list.length - 1),
                    ]),
                    const SizedBox(height: 14),
                    const DesiMogra(),
                  ],
                ),
              ),
            ),
          ]),
        ),
      );

  Widget _row(BlockedPerson p, {required bool last}) {
    final busy = _busyKey == p.key;
    return Container(
      constraints: const BoxConstraints(minHeight: 64),
      padding: const EdgeInsets.symmetric(vertical: 6),
      decoration: BoxDecoration(border: last ? null : const Border(bottom: BorderSide(color: C.line))),
      child: Row(children: [
        PersonAvatar(key: Key('blocked-avatar-${p.key}'), name: p.name, url: p.avatarUrl, size: 44), // [HF-ME-SETTINGS-MOVE]
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(p.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: t(16, w: FontWeight.w800)),
            if (p.shownHandle != null) Text('@${p.shownHandle}', maxLines: 1, overflow: TextOverflow.ellipsis, style: t(14, color: C.muted, w: FontWeight.w700)),
          ]),
        ),
        const SizedBox(width: 8),
        DesiButton(busy ? 'Unblocking…' : 'Unblock', kind: DesiButtonKind.ghost, onTap: _busyKey != null ? null : () => unawaited(_unblock(p))),
      ]),
    );
  }
}
