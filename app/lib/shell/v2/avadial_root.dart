import 'dart:async';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/analytics.dart';
import '../../core/remote_config.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../../features/avadial/avadial_channel.dart';
import '../../features/avadial/block_list.dart';
import '../../features/avadial/device_call_log.dart';
import '../../features/avadial/device_contacts.dart';
import '../../features/avadial/pstn_call_screen.dart';
import '../../features/avadial/sms/sms_threads_screen.dart';
import '../../features/avaphone/ava_phone_screen.dart';
import '../shell_v2.dart';
import 'shell_chrome.dart';

/// AvaDial root — the PSTN phone world (plan §4). The five footer tabs are always
/// present. When the `avaDialer` remote flag is OFF (default) the Contacts/Logs/
/// Block tabs render the Phase-1 placeholder empty states and NO telecom role is
/// ever requested. When the flag is ON, they render the live device phone book,
/// device call log and account-scoped block list, backed by the native telecom
/// layer (Specs/SPIKE-2026-07-12-avadial-telecom.md). Messages stays a placeholder
/// until the SMS role lands (Phase 3).
class AvaDialRoot extends StatefulWidget {
  const AvaDialRoot({super.key});

  @override
  State<AvaDialRoot> createState() => _AvaDialRootState();
}

class _AvaDialRootState extends State<AvaDialRoot> {
  int _tab = 0;
  StreamSubscription<AvaCallEvent>? _callSub;
  bool _screenOpen = false;

  static const _items = [
    ShellNavItem(Icons.dialpad_outlined, Icons.dialpad, 'Dialpad'),
    ShellNavItem(Icons.person_outline, Icons.person, 'Contacts'),
    ShellNavItem(Icons.history_outlined, Icons.history, 'Logs'),
    ShellNavItem(Icons.sms_outlined, Icons.sms, 'Messages'),
    ShellNavItem(Icons.block_outlined, Icons.block, 'Block'),
  ];

  @override
  void initState() {
    super.initState();
    // Wire the native → Dart event bridge only when the feature is live, so the
    // channel handler is never installed on a dark build.
    if (RemoteConfig.avaDialer) {
      AvaDialChannel.I.ensureWired();
      // Foreground incoming-call route. (Background/cold-start uses the native
      // full-screen-intent notification, whose MainActivity route extra is wired by
      // the shell's notification handler — TODO(phase2) in shell_v2.dart.)
      _callSub = AvaDialChannel.I.calls.listen(_onCall);
    }
  }

  @override
  void dispose() {
    _callSub?.cancel();
    super.dispose();
  }

  void _onCall(AvaCallEvent e) {
    if (!mounted || _screenOpen || AvaDialChannel.I.incomingScreenOpen) return;
    if (e.state != 'ringing' || e.direction != 'incoming') return;
    final number = e.number;
    if (number == null || number.isEmpty) return;
    _screenOpen = true;
    AvaDialChannel.I.incomingScreenOpen = true; // shared guard vs. the shell path
    Navigator.of(context)
        .push(MaterialPageRoute<void>(
          fullscreenDialog: true,
          builder: (_) => PstnCallScreen(callId: e.id, number: number),
        ))
        .whenComplete(() {
      _screenOpen = false;
      AvaDialChannel.I.incomingScreenOpen = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Zine.paper,
      drawer: const ShellSidebar(current: RootId.avaDial),
      appBar: _bar(context),
      bottomNavigationBar: shellNavBar(
        selectedIndex: _tab,
        items: _items,
        onSelected: (i) => setState(() => _tab = i),
      ),
      body: SafeArea(
        top: false,
        // Rebuild when a config fetch lands so flipping `avaDialer` in KV surfaces
        // the live tabs without an app restart.
        child: ValueListenableBuilder<int>(
          valueListenable: RemoteConfig.revision,
          builder: (context, _, __) {
            final on = RemoteConfig.avaDialer;
            if (on) AvaDialChannel.I.ensureWired();
            return IndexedStack(index: _tab, children: [
              // Dialpad — reuses the existing dialer, unchanged (plan §4.1).
              const AvaPhoneScreen(),
              on
                  ? const _ContactsTab()
                  : const ShellEmptyState(
                      icon: Icons.person_outline,
                      title: 'Contacts',
                      subtitle: 'Your phone book, spam-labelled — coming with AvaDial.',
                      color: Zine.blue,
                    ),
              on
                  ? const _LogsTab()
                  : const ShellEmptyState(
                      icon: Icons.history_outlined,
                      title: 'Call logs',
                      subtitle:
                          'Your device call history with friend/spam labels — coming with AvaDial.',
                      color: Zine.mint,
                    ),
              // Messages tab — gated INDEPENDENTLY on `avaSms` (the SMS role is
              // separate from the dialer role). While the flag is off it keeps the
              // Phase-1 placeholder; when on it shows the role banner until ROLE_SMS
              // is held, then the live SMS threads + AI Inbox/Spam filter.
              RemoteConfig.avaSms
                  ? const _MessagesTab()
                  : const ShellEmptyState(
                      icon: Icons.sms_outlined,
                      title: 'Messages',
                      subtitle: 'Carrier SMS lands here once Ava is your SMS app — coming with AvaDial.',
                      color: Zine.lilac,
                    ),
              on
                  ? const _BlockTab()
                  : const ShellEmptyState(
                      icon: Icons.block_outlined,
                      title: 'Block list',
                      subtitle: 'Blocked numbers and one-tap spam reports — coming with AvaDial.',
                      color: Zine.coral,
                    ),
            ]);
          },
        ),
      ),
    );
  }

  PreferredSizeWidget _bar(BuildContext context) => AppBar(
        backgroundColor: Zine.paper2,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        shape: const Border(bottom: BorderSide(color: Zine.ink, width: Zine.bw)),
        leading: Builder(
          builder: (ctx) => IconButton(
            icon: PhosphorIcon(PhosphorIcons.list(PhosphorIconsStyle.bold), color: Zine.ink),
            onPressed: () => Scaffold.of(ctx).openDrawer(),
          ),
        ),
        title: Text('AvaDial', style: ZineText.appbar()),
      );
}

/// Onboarding hook (plan §4.2): "Make Ava your phone app" → ROLE_DIALER request.
/// Shown at the top of the device tabs until AvaDial holds the dialer role. Only
/// ever built when the `avaDialer` flag is on.
class _RoleBanner extends StatefulWidget {
  const _RoleBanner();

  @override
  State<_RoleBanner> createState() => _RoleBannerState();
}

class _RoleBannerState extends State<_RoleBanner> {
  bool _held = true; // assume held → banner hidden until we learn otherwise
  bool _busy = false;
  StreamSubscription<AvaRoleResult>? _sub;

  @override
  void initState() {
    super.initState();
    _refresh();
    // The verdict arrives asynchronously after the system prompt.
    _sub = AvaDialChannel.I.roleResults.listen((r) {
      if (!mounted) return;
      if (r.role.contains('DIALER')) {
        Analytics.capture(
            r.granted ? 'avadial_role_granted' : 'avadial_role_denied', {'role': 'dialer'});
        _refresh();
      }
    });
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  Future<void> _refresh() async {
    final held = await AvaDialChannel.I.isDialerRoleHeld();
    if (mounted) setState(() => _held = held);
  }

  Future<void> _request() async {
    if (_busy) return;
    setState(() => _busy = true);
    final immediate = await AvaDialChannel.I.requestDialerRole();
    if (immediate == true) {
      Analytics.capture('avadial_role_granted', {'role': 'dialer', 'via': 'already_held'});
      await _refresh();
    }
    // Otherwise the verdict comes via roleResults; capture there.
    if (mounted) setState(() => _busy = false);
  }

  @override
  Widget build(BuildContext context) {
    if (_held) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 4),
      child: ZineCard(
        color: Zine.blueMark,
        child: Row(children: [
          ZineIconBadge(icon: PhosphorIcons.shieldCheck(PhosphorIconsStyle.bold), color: Zine.blue),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Make Ava your phone app', style: ZineText.cardTitle(size: 15)),
              const SizedBox(height: 2),
              Text('Screen spam, see your call log and block numbers.',
                  style: ZineText.sub(size: 12.5)),
            ]),
          ),
          const SizedBox(width: 10),
          ZineButton(
            label: 'Enable',
            variant: ZineButtonVariant.blue,
            fontSize: 14,
            trailingIcon: false,
            loading: _busy,
            onPressed: _request,
          ),
        ]),
      ),
    );
  }
}

// ── Contacts tab ─────────────────────────────────────────────────────────────
class _ContactsTab extends StatefulWidget {
  const _ContactsTab();

  @override
  State<_ContactsTab> createState() => _ContactsTabState();
}

class _ContactsTabState extends State<_ContactsTab> {
  late Future<List<DeviceContact>> _future;

  @override
  void initState() {
    super.initState();
    _future = DeviceContacts.I.load();
  }

  Future<void> _reload() async {
    setState(() => _future = DeviceContacts.I.load(force: true));
  }

  @override
  Widget build(BuildContext context) {
    return Column(children: [
      const _RoleBanner(),
      Expanded(
        child: FutureBuilder<List<DeviceContact>>(
          future: _future,
          builder: (context, snap) {
            if (snap.connectionState != ConnectionState.done) {
              return const Center(child: CircularProgressIndicator(color: Zine.ink));
            }
            final contacts = snap.data ?? const [];
            if (contacts.isEmpty) {
              return _PermState(
                icon: Icons.person_outline,
                title: 'No contacts yet',
                subtitle: 'Grant contacts access to see your phone book here.',
                color: Zine.blue,
                onRetry: _reload,
              );
            }
            return RefreshIndicator(
              onRefresh: _reload,
              child: ListView.builder(
                padding: const EdgeInsets.fromLTRB(14, 8, 14, 24),
                itemCount: contacts.length,
                itemBuilder: (context, i) {
                  final c = contacts[i];
                  return Padding(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    child: ZineCard(
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                      child: Row(children: [
                        ZineIconBadge(
                            icon: PhosphorIcons.user(PhosphorIconsStyle.bold), color: Zine.blue),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            Text(c.name ?? c.number, style: ZineText.cardTitle(size: 15.5)),
                            if (c.name != null)
                              Text(c.number, style: ZineText.sub(size: 12.5)),
                          ]),
                        ),
                      ]),
                    ),
                  );
                },
              ),
            );
          },
        ),
      ),
    ]);
  }
}

// ── Logs tab ─────────────────────────────────────────────────────────────────
class _LogsTab extends StatefulWidget {
  const _LogsTab();

  @override
  State<_LogsTab> createState() => _LogsTabState();
}

class _LogsTabState extends State<_LogsTab> {
  late Future<List<DeviceCall>> _future;

  @override
  void initState() {
    super.initState();
    _future = DeviceCallLog.I.load();
  }

  Future<void> _reload() async {
    setState(() => _future = DeviceCallLog.I.load(force: true));
  }

  IconData _iconFor(DeviceCallType t) => switch (t) {
        DeviceCallType.outgoing => Icons.call_made,
        DeviceCallType.missed => Icons.call_missed,
        DeviceCallType.rejected => Icons.call_end,
        DeviceCallType.blocked => Icons.block,
        _ => Icons.call_received,
      };

  Color _colorFor(DeviceCallType t) => switch (t) {
        DeviceCallType.missed || DeviceCallType.rejected || DeviceCallType.blocked => Zine.coral,
        DeviceCallType.outgoing => Zine.mint,
        _ => Zine.blue,
      };

  @override
  Widget build(BuildContext context) {
    return Column(children: [
      const _RoleBanner(),
      Expanded(
        child: FutureBuilder<List<DeviceCall>>(
          future: _future,
          builder: (context, snap) {
            if (snap.connectionState != ConnectionState.done) {
              return const Center(child: CircularProgressIndicator(color: Zine.ink));
            }
            final logs = snap.data ?? const [];
            if (logs.isEmpty) {
              return _PermState(
                icon: Icons.history_outlined,
                title: 'No call history',
                subtitle:
                    'Make Ava your phone app to see and label your device call log.',
                color: Zine.mint,
                onRetry: _reload,
              );
            }
            return RefreshIndicator(
              onRefresh: _reload,
              child: ListView.builder(
                padding: const EdgeInsets.fromLTRB(14, 8, 14, 24),
                itemCount: logs.length,
                itemBuilder: (context, i) {
                  final e = logs[i];
                  return Padding(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    child: ZineCard(
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                      child: Row(children: [
                        ZineIconBadge(icon: _iconFor(e.type), color: _colorFor(e.type)),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            Text(e.cachedName ?? e.number, style: ZineText.cardTitle(size: 15)),
                            Text(_subtitle(e), style: ZineText.sub(size: 12)),
                          ]),
                        ),
                      ]),
                    ),
                  );
                },
              ),
            );
          },
        ),
      ),
    ]);
  }

  String _subtitle(DeviceCall e) {
    final d = e.date;
    final when = '${d.day}/${d.month} ${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
    return '${e.type.name} · $when';
  }
}

// ── Block tab ────────────────────────────────────────────────────────────────
class _BlockTab extends StatefulWidget {
  const _BlockTab();

  @override
  State<_BlockTab> createState() => _BlockTabState();
}

class _BlockTabState extends State<_BlockTab> {
  late Future<List<BlockEntry>> _future;

  @override
  void initState() {
    super.initState();
    _future = BlockList.I.load();
  }

  void _reload() => setState(() => _future = BlockList.I.load());

  Future<void> _unblock(String number) async {
    await BlockList.I.unblock(number);
    _reload();
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<List<BlockEntry>>(
      future: _future,
      builder: (context, snap) {
        if (snap.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator(color: Zine.ink));
        }
        final entries = snap.data ?? const [];
        if (entries.isEmpty) {
          return const ShellEmptyState(
            icon: Icons.block_outlined,
            title: 'Nothing blocked',
            subtitle: 'Numbers you block or report as spam show up here.',
            color: Zine.coral,
          );
        }
        return ListView.builder(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 24),
          itemCount: entries.length,
          itemBuilder: (context, i) {
            final e = entries[i];
            return Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: ZineCard(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                child: Row(children: [
                  ZineIconBadge(
                      icon: e.reportedSpam
                          ? PhosphorIcons.shieldWarning(PhosphorIconsStyle.bold)
                          : PhosphorIcons.prohibit(PhosphorIconsStyle.bold),
                      color: Zine.coral),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(e.number, style: ZineText.cardTitle(size: 15)),
                      Text(
                        e.reportedSpam ? 'Reported as spam${e.label != null ? ' · ${e.label}' : ''}' : 'Blocked',
                        style: ZineText.sub(size: 12),
                      ),
                    ]),
                  ),
                  ZineButton(
                    label: 'Unblock',
                    variant: ZineButtonVariant.ghost,
                    fontSize: 13,
                    trailingIcon: false,
                    onPressed: () => _unblock(e.number),
                  ),
                ]),
              ),
            );
          },
        );
      },
    );
  }
}

// ── Messages tab (SMS) ───────────────────────────────────────────────────────
/// Fills the Messages tab when `avaSms` is on. Until AvaTOK holds ROLE_SMS it shows
/// the "Make AvaTOK your messages app" banner over an explainer; once the role is
/// held it renders the live SMS conversation list + AI Inbox/Spam filter
/// ([SmsThreadsScreen]). The SMS role is independent of the dialer role.
class _MessagesTab extends StatefulWidget {
  const _MessagesTab();

  @override
  State<_MessagesTab> createState() => _MessagesTabState();
}

class _MessagesTabState extends State<_MessagesTab> {
  bool _held = false;
  bool _resolved = false;
  StreamSubscription<AvaRoleResult>? _sub;

  @override
  void initState() {
    super.initState();
    AvaDialChannel.I.ensureWired();
    _refresh();
    _sub = AvaDialChannel.I.roleResults.listen((r) {
      if (!mounted) return;
      // Android role name for ROLE_SMS is `android.app.role.SMS`.
      if (r.role.contains('SMS')) {
        Analytics.capture(
            r.granted ? 'avadial_sms_role_granted' : 'avadial_sms_role_denied', const {});
        _refresh();
      }
    });
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  Future<void> _refresh() async {
    final held = await AvaDialChannel.I.isSmsRoleHeld();
    if (mounted) setState(() {
      _held = held;
      _resolved = true;
    });
  }

  @override
  Widget build(BuildContext context) {
    if (!_resolved) {
      return const Center(child: CircularProgressIndicator(color: Zine.ink));
    }
    if (_held) return const SmsThreadsScreen();
    return Column(children: [
      const _SmsRoleBanner(),
      const Expanded(
        child: ShellEmptyState(
          icon: Icons.sms_outlined,
          title: 'Make AvaTOK your messages app',
          subtitle:
              'Set AvaTOK as your default SMS app to read your texts here with AI spam filtering.',
          color: Zine.lilac,
        ),
      ),
    ]);
  }
}

/// "Make AvaTOK your messages app" → ROLE_SMS request. Mirrors [_RoleBanner].
class _SmsRoleBanner extends StatefulWidget {
  const _SmsRoleBanner();

  @override
  State<_SmsRoleBanner> createState() => _SmsRoleBannerState();
}

class _SmsRoleBannerState extends State<_SmsRoleBanner> {
  bool _busy = false;

  Future<void> _request() async {
    if (_busy) return;
    setState(() => _busy = true);
    final immediate = await AvaDialChannel.I.requestSmsRole();
    if (immediate == true) {
      Analytics.capture('avadial_sms_role_granted', {'via': 'already_held'});
    }
    // Otherwise the verdict comes via roleResults (handled by _MessagesTab).
    if (mounted) setState(() => _busy = false);
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 4),
      child: ZineCard(
        color: Zine.blueMark,
        child: Row(children: [
          ZineIconBadge(icon: PhosphorIcons.chatCircle(PhosphorIconsStyle.bold), color: Zine.lilac),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Make AvaTOK your messages app', style: ZineText.cardTitle(size: 15)),
              const SizedBox(height: 2),
              Text('Read texts here with AI spam filtering.', style: ZineText.sub(size: 12.5)),
            ]),
          ),
          const SizedBox(width: 10),
          ZineButton(
            label: 'Enable',
            variant: ZineButtonVariant.blue,
            fontSize: 14,
            trailingIcon: false,
            loading: _busy,
            onPressed: _request,
          ),
        ]),
      ),
    );
  }
}

/// Empty/permission-denied state with a retry (used by the Contacts + Logs tabs).
class _PermState extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;
  final Color color;
  final Future<void> Function() onRetry;
  const _PermState({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.color,
    required this.onRetry,
  });

  @override
  Widget build(BuildContext context) {
    return ListView(
      // ListView so RefreshIndicator/scroll works even in the empty state.
      padding: const EdgeInsets.symmetric(horizontal: 24),
      children: [
        const SizedBox(height: 72),
        ZineIconBadge(icon: icon, color: color, size: 56),
        const SizedBox(height: 16),
        Text(title, textAlign: TextAlign.center, style: ZineText.cardTitle(size: 18)),
        const SizedBox(height: 8),
        Text(subtitle, textAlign: TextAlign.center, style: ZineText.sub(size: 14)),
        const SizedBox(height: 20),
        Center(
          child: ZineButton(
            label: 'Try again',
            variant: ZineButtonVariant.ghost,
            trailingIcon: false,
            onPressed: onRetry,
          ),
        ),
      ],
    );
  }
}
