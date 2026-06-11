import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/avatar.dart';
import '../../core/call_log_store.dart';
import '../../core/ice_cache.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import 'call_screen.dart';
import 'contacts.dart';

/// AvaTok Calls tab — real 1:1 call history; tap to call back.
class CallsScreen extends StatefulWidget {
  const CallsScreen({super.key});
  @override
  State<CallsScreen> createState() => _CallsScreenState();
}

class _CallsScreenState extends State<CallsScreen> {
  final _store = CallLogStore();
  List<CallEntry> _calls = [];
  Map<String, String> _avatars = {}; // npub → photo URL (from contacts)
  bool _loaded = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final c = await _store.load();
    final contacts = await ContactsStore().load();
    final avatars = {for (final x in contacts) if (x.avatarUrl.isNotEmpty) x.npub: x.avatarUrl};
    if (mounted) setState(() { _calls = c; _avatars = avatars; _loaded = true; });
  }

  void _callBack(CallEntry c) {
    IceCache.prefetch(); // warm TURN creds before the call screen opens
    Navigator.push(context, MaterialPageRoute(
      builder: (_) => CallScreen(room: 'avatok-${c.seed}', title: c.name, seed: c.seed, video: c.video, avatarUrl: _avatars[c.seed] ?? ''),
    )).then((_) => _load());
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      bottom: false,
      child: Column(children: [
        // Appbar band (§8): paper-2 fill, ink bottom border, Fredoka title.
        Container(
          height: 60,
          alignment: Alignment.centerLeft,
          padding: const EdgeInsets.symmetric(horizontal: 18),
          decoration: const BoxDecoration(
            color: Zine.paper2,
            border: Border(bottom: BorderSide(color: Zine.ink, width: Zine.bw)),
          ),
          child: const ZineMarkTitle(pre: '', mark: 'Calls', fontSize: 24, textAlign: TextAlign.left),
        ),
        Expanded(
          child: !_loaded
              ? const Center(child: CircularProgressIndicator(color: Zine.blueInk))
              : _calls.isEmpty
                  ? Center(child: Padding(
                      padding: const EdgeInsets.all(24),
                      child: ZineEmptyState(
                          icon: PhosphorIcons.phone(PhosphorIconsStyle.bold),
                          text: 'No calls yet — start one from a chat'),
                    ))
                  : RefreshIndicator(
                      onRefresh: _load,
                      color: Zine.blueInk,
                      child: ListView.separated(
                        padding: const EdgeInsets.fromLTRB(16, 14, 16, 24),
                        itemCount: _calls.length,
                        separatorBuilder: (_, __) => const SizedBox(height: 10),
                        itemBuilder: (_, i) => _row(_calls[i]),
                      ),
                    ),
        ),
      ]),
    );
  }

  // Call-history row — zine card: ink border, bordered avatar, mono timestamp,
  // coral for missed, mint for incoming, call-back circle button.
  Widget _row(CallEntry c) {
    final missed = c.dir == CallDir.missed;
    final dirColor = switch (c.dir) {
      CallDir.missed => Zine.coral,
      CallDir.incoming => Zine.mintInk,
      CallDir.outgoing => Zine.inkSoft,
    };
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(
        color: Zine.card,
        borderRadius: BorderRadius.circular(Zine.rSm),
        border: Zine.border,
        boxShadow: Zine.shadowXs,
      ),
      child: Row(children: [
        Container(
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            border: Border.all(color: Zine.ink, width: 2),
          ),
          child: Avatar(seed: c.seed, name: c.name, size: 44, avatarUrl: _avatars[c.seed]),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(c.name,
                maxLines: 1, overflow: TextOverflow.ellipsis,
                style: ZineText.value(size: 15, color: missed ? Zine.coral : Zine.ink)),
            const SizedBox(height: 3),
            Row(children: [
              PhosphorIcon(_dirIcon(c.dir), size: 14, color: dirColor),
              const SizedBox(width: 5),
              Flexible(child: Text('${_dirLabel(c.dir)} · ${c.timeLabel}'.toUpperCase(),
                  maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: ZineText.tag(size: 10, color: Zine.inkSoft))),
            ]),
          ]),
        ),
        const SizedBox(width: 8),
        ZinePressable(
          onTap: () => _callBack(c),
          color: Zine.card,
          pressedColor: Zine.lime,
          radius: BorderRadius.circular(100),
          boxShadow: Zine.shadowXs,
          child: SizedBox(
            width: 40, height: 40,
            child: Center(child: PhosphorIcon(
                c.video
                    ? PhosphorIcons.videoCamera(PhosphorIconsStyle.bold)
                    : PhosphorIcons.phone(PhosphorIconsStyle.bold),
                size: 19, color: Zine.ink)),
          ),
        ),
      ]),
    );
  }

  PhosphorIconData _dirIcon(CallDir d) => switch (d) {
        CallDir.incoming => PhosphorIcons.phoneIncoming(PhosphorIconsStyle.bold),
        CallDir.outgoing => PhosphorIcons.phoneOutgoing(PhosphorIconsStyle.bold),
        CallDir.missed => PhosphorIcons.phoneX(PhosphorIconsStyle.bold),
      };
  String _dirLabel(CallDir d) => switch (d) {
        CallDir.incoming => 'Incoming',
        CallDir.outgoing => 'Outgoing',
        CallDir.missed => 'Missed',
      };
}
