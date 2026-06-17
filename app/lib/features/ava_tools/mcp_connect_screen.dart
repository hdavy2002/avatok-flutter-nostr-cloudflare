import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/paid_feature.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import '../../core/ava_tools/strata_client.dart';

/// McpConnectScreen (Phase 5 — Tool Layer).
///
/// Lets the user connect their OWN external accounts (Gmail, Drive, …) so Ava
/// can act on their behalf through the self-hosted Strata MCP gateway. Tokens
/// are user-scoped and stored encrypted server-side (worker/src/routes/
/// ava_tools.ts) — never shared across accounts.
///
/// Connecting kicks per-user OAuth via Strata `handle_auth_failure`, which
/// returns an auth URL the app opens in a browser. After the user authorises,
/// the provider shows as connected (the worker records the token from the OAuth
/// callback). FREE-BUNDLED connectors connect ungated; SUBSCRIPTION connectors
/// are wrapped in [PaidFeature] + carry a [PaidBadge].
///
/// While the tool layer is unconfigured (Worker 503 — STRATA_URL empty) the
/// screen shows a friendly "coming soon" state instead of an error.

/// A connectable provider shown in the list. The catalog is intentionally a
/// SMALL curated set of connect targets — Ava discovers individual ACTIONS on
/// demand via Strata, so this list is just "what can I link my account to".
class McpProvider {
  final String id; // strata connector id, lowercase (e.g. 'gmail')
  final String title;
  final String subtitle;
  final IconData icon;
  final Color accent;

  /// Free-bundled connectors connect without a wallet check; subscription
  /// connectors are gated (PaidBadge + PaidFeature). Mirrors the worker's
  /// FREE_BUNDLED list.
  final bool subscription;

  const McpProvider({
    required this.id,
    required this.title,
    required this.subtitle,
    required this.icon,
    this.accent = Zine.blue,
    this.subscription = true,
  });
}

/// The curated connect catalog. Tune as the self-hosted Strata registry grows.
const List<McpProvider> kMcpProviders = [
  McpProvider(
    id: 'gmail',
    title: 'Gmail',
    subtitle: 'Let Ava read & send email on your behalf',
    icon: PhosphorIconsRegular.envelopeSimple,
    accent: Zine.coral,
  ),
  McpProvider(
    id: 'gdrive',
    title: 'Google Drive',
    subtitle: 'Search and fetch your files',
    icon: PhosphorIconsRegular.cloud,
    accent: Zine.blue,
  ),
  McpProvider(
    id: 'gcalendar',
    title: 'Google Calendar',
    subtitle: 'Read your schedule and create events',
    icon: PhosphorIconsRegular.calendarBlank,
    accent: Zine.mint,
  ),
  McpProvider(
    id: 'github',
    title: 'GitHub',
    subtitle: 'Issues, PRs and repo search',
    icon: PhosphorIconsRegular.gitBranch,
    accent: Zine.ink,
  ),
  McpProvider(
    id: 'notion',
    title: 'Notion',
    subtitle: 'Search and update your workspace',
    icon: PhosphorIconsRegular.files,
    accent: Zine.lilac,
  ),
];

class McpConnectScreen extends StatefulWidget {
  const McpConnectScreen({super.key});
  @override
  State<McpConnectScreen> createState() => _McpConnectScreenState();
}

class _McpConnectScreenState extends State<McpConnectScreen> {
  Set<String> _connected = <String>{};
  bool _loading = true;
  bool _unavailable = false;
  String? _busy; // provider id currently connecting

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    setState(() => _loading = true);
    // Probe with a discovery call to detect the 503 (unconfigured) state.
    final probe = await StrataClient.I.discoverCategories();
    // connections() returns [] both when empty and when unavailable; we treat
    // the discovery probe as the availability signal.
    final connected = await StrataClient.I.connections();
    if (!mounted) return;
    setState(() {
      _connected = connected.toSet();
      // If discovery returned nothing AND there are no connections, we can't be
      // sure it's configured — but the worker 503s on every op while STRATA_URL
      // is empty, so an empty probe with no connections is the "coming soon"
      // state. (A configured-but-empty Strata still returns a 200 with [].)
      _unavailable = probe.isEmpty && connected.isEmpty;
      _loading = false;
    });
  }

  Future<void> _connect(McpProvider p) async {
    setState(() => _busy = p.id);
    try {
      final auth = await StrataClient.I.handleAuthFailure(p.id);
      if (auth == null) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Connector not available yet. Try again later.')),
          );
        }
        return;
      }
      final ok = await launchUrl(Uri.parse(auth.authUrl), mode: LaunchMode.externalApplication);
      if (mounted && !ok) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Could not open the connect page.')),
        );
      }
      // The OAuth callback (server-side) records the token; refresh to reflect
      // the new connection when the user returns to the app.
    } finally {
      if (mounted) setState(() => _busy = null);
      // Best-effort: re-read connections after a short delay would also work;
      // here we refresh immediately and rely on a pull-to-refresh otherwise.
      await _refresh();
    }
  }

  Future<void> _disconnect(McpProvider p) async {
    await StrataClient.I.disconnect(p.id);
    await _refresh();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: AppBar(
        backgroundColor: Zine.paper,
        elevation: 0,
        title: Text('Tools & connectors', style: ZineText.cardTitle(size: 18)),
      ),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 28),
          children: [
            _intro(),
            const SizedBox(height: 16),
            if (_loading)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 40),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (_unavailable)
              _comingSoon()
            else
              ...kMcpProviders.map(_providerCard),
          ],
        ),
      ),
    );
  }

  Widget _intro() => ZineCard(
        radius: Zine.rSm,
        padding: const EdgeInsets.all(14),
        boxShadow: Zine.shadowXs,
        child: Row(children: [
          ZineIconBadge(icon: PhosphorIcons.plugs(PhosphorIconsStyle.fill), color: Zine.lilac, size: 36),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              'Connect your own accounts so Ava can act for you. Ava only loads '
              'the one action she needs, when she needs it — your tokens stay '
              'private to this account.',
              style: ZineText.sub(size: 12.5),
            ),
          ),
        ]),
      );

  Widget _comingSoon() => ZineCard(
        radius: Zine.rSm,
        padding: const EdgeInsets.all(18),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Connectors coming soon', style: ZineText.value(size: 15)),
          const SizedBox(height: 6),
          Text(
            'The tool gateway isn’t switched on yet. You’ll be able to '
            'connect Gmail, Drive and more here shortly.',
            style: ZineText.sub(size: 12.5),
          ),
        ]),
      );

  Widget _providerCard(McpProvider p) {
    final connected = _connected.contains(p.id);
    final busy = _busy == p.id;

    final card = ZineCard(
      radius: Zine.rSm,
      padding: const EdgeInsets.all(14),
      boxShadow: Zine.shadowXs,
      child: Row(children: [
        ZineIconBadge(icon: p.icon, color: p.accent, size: 36),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Flexible(child: Text(p.title, style: ZineText.value(size: 14.5))),
              if (p.subscription) ...[
                const SizedBox(width: 8),
                const PaidBadge(),
              ],
            ]),
            const SizedBox(height: 2),
            Text(p.subtitle, style: ZineText.sub(size: 12)),
          ]),
        ),
        const SizedBox(width: 10),
        if (connected)
          TextButton(
            onPressed: busy ? null : () => _disconnect(p),
            child: Text('Disconnect', style: ZineText.link(size: 13, color: Zine.coral)),
          )
        else
          ZineButton(
            label: busy ? 'Opening…' : 'Connect',
            variant: ZineButtonVariant.blue,
            fontSize: 13,
            loading: busy,
            icon: PhosphorIcons.arrowSquareOut(PhosphorIconsStyle.bold),
            // For free-bundled connectors, tapping connects directly. For
            // subscription connectors, the actual connect is wrapped in
            // PaidFeature below so an empty wallet routes to the top-up sheet.
            onPressed: p.subscription ? null : () => _connect(p),
          ),
      ]),
    );

    // Subscription connectors: gate the CONNECT action behind PaidFeature so
    // the wallet check + top-up sheet fires before we kick OAuth. Free-bundled
    // connectors render the plain card (their button connects directly).
    if (!connected && p.subscription) {
      return Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: PaidFeature(
          actionLabel: 'Connect ${p.title}',
          onRun: () => _connect(p),
          child: AbsorbPointer(child: card), // PaidFeature owns the tap
        ),
      );
    }
    return Padding(padding: const EdgeInsets.only(bottom: 10), child: card);
  }
}
