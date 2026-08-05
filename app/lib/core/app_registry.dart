import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import 'remote_config.dart';

/// Creator-marketplace Phase 1: ONE registry of every AvaVerse app. The sidebar
/// renders `tier == standard` only; hidden apps stay registered so a later
/// phase can flip them back without re-plumbing. Route values are the
/// destination keys AvaShell._openDest understands.
enum AppTier { standard, hidden }

class AppEntry {
  final String id;
  final String title;
  final String tagline;
  final IconData icon;
  final Color color;
  final String route;
  final AppTier tier;
  const AppEntry(this.id, this.title, this.tagline, this.icon, this.color,
      {String? route, this.tier = AppTier.standard})
      : route = route ?? id;
}

/// The standard set (00-UNIVERSAL-PROPOSAL §2) + everything currently hidden.
///
/// [UI-ICONS-1 2026-08-05] Glyphs are Phosphor, not Material. `PhosphorIcons.x(...)`
/// is a FUNCTION CALL, so this list can no longer be `const` — it is `final`
/// instead. `PhosphorIconData` extends `IconData`, so every existing consumer
/// (`Icon(entry.icon)` in the sidebar etc.) is unaffected.
final kAppRegistry = <AppEntry>[
  // ---- standard ----
  AppEntry('avatok', 'AvaTOK', 'Messages & calls', PhosphorIcons.chatCircle(PhosphorIconsStyle.regular), const Color(0xFF08C4C4)),
  AppEntry('avalibrary', 'Library', 'Your files, everywhere', PhosphorIcons.folderOpen(PhosphorIconsStyle.regular), const Color(0xFF8B5CF6)),
  // "App" (formerly "Connectors") — connect Gmail/Outlook so Ava can act on your
  // mail. Placed ABOVE Marketplace (owner decision 2026-07-01, pro/live launch).
  AppEntry('avaapps', 'App', 'Connect Gmail & Outlook', PhosphorIcons.squaresFour(PhosphorIconsStyle.regular), const Color(0xFF4F8DFD)),
  // AvaMarketplace (P1): buy/sell/social + agent negotiation. Routes to
  // MarketplaceHub via AvaShell._openDest('marketplace'); the destination itself
  // is gated by RemoteConfig.marketplaceEnabled so this stays dark until rollout.
  AppEntry('marketplace', 'Marketplace', 'Buy, sell & social', PhosphorIcons.storefront(PhosphorIconsStyle.regular), const Color(0xFFFF6036)),
  AppEntry('avastorage', 'View Storage', 'Storage & usage', PhosphorIcons.chartPie(PhosphorIconsStyle.regular), const Color(0xFF0EA5E9)),
  // AvaChat — direct AI chat with Ava (memory-aware, talks to your brain). Visible
  // sidebar item (owner decision 2026-06-18). Routes to CompanionHome.
  AppEntry('avachat', 'AvaChat', 'Chat with Ava — your AI', PhosphorIcons.sparkle(PhosphorIconsStyle.regular), const Color(0xFFA06AF0)),
  // AvaWallet — HIDDEN for the pro/live launch (owner decision 2026-07-01):
  // tier=hidden AND removed from _focusIds below, so it never shows in either the
  // focus menu or the full standard menu. Kept registered so routes/deep-links
  // still resolve. To restore: set tier back to standard + re-add to _focusIds.
  AppEntry('avawallet', 'Wallet', 'Tokens & top-ups', PhosphorIcons.wallet(PhosphorIconsStyle.regular), const Color(0xFF10B981), tier: AppTier.hidden),
  // ---- hidden from the sidebar menu (owner decision 2026-06-17) ----
  AppEntry('explore', 'AvaExplore', 'Marketplace', PhosphorIcons.storefront(PhosphorIconsStyle.regular), const Color(0xFFFF6036), tier: AppTier.hidden),
  AppEntry('verse', 'AvaVerse', 'Your dashboard', PhosphorIcons.gauge(PhosphorIconsStyle.regular), const Color(0xFF6C5CE7), tier: AppTier.hidden),
  AppEntry('avapayout', 'AvaPayout', 'Withdraw your earnings', PhosphorIcons.money(PhosphorIconsStyle.regular), const Color(0xFF0A66C2), tier: AppTier.hidden),
  // Unhidden (AvaMarketplace P1, owner decision 2026-06-30): Identity is the
  // single source of truth for marketplace listing eligibility (video ID + email
  // + phone OTP), so it must be reachable from the sidebar. Routes to
  // IdentityScreen via AvaShell._openDest('avaidentity').
  AppEntry('avaidentity', 'AvaIdentity', 'Verify your identity', PhosphorIcons.identificationCard(PhosphorIconsStyle.regular), const Color(0xFF7C5CFC)),
  AppEntry('avabooking', 'AvaBooking', 'Your bookings', PhosphorIcons.calendarCheck(PhosphorIconsStyle.regular), const Color(0xFFE1306C), tier: AppTier.hidden),
  AppEntry('avacalendar', 'AvaCalendar', 'Availability & sync', PhosphorIcons.calendar(PhosphorIconsStyle.regular), const Color(0xFFEAB308), tier: AppTier.hidden),
  AppEntry('avalive', 'AvaLive', 'Live streaming', PhosphorIcons.broadcast(PhosphorIconsStyle.regular), const Color(0xFFFF3B30), tier: AppTier.hidden),
  AppEntry('avaconsult', 'AvaConsult', 'Paid sessions', PhosphorIcons.videoCamera(PhosphorIconsStyle.regular), const Color(0xFF22C9C0), tier: AppTier.hidden),
  AppEntry('avavoice', 'AvaVoice', 'AI voice agents', PhosphorIcons.microphone(PhosphorIconsStyle.regular), const Color(0xFFA06AF0), tier: AppTier.hidden),
  AppEntry('avavision', 'AvaVision', 'AI vision coaches', PhosphorIcons.eye(PhosphorIconsStyle.regular), const Color(0xFFA06AF0), tier: AppTier.hidden),
  AppEntry('avainbox', 'AvaInbox', 'All messages, one inbox', PhosphorIcons.tray(PhosphorIconsStyle.regular), const Color(0xFF4F8DFD), tier: AppTier.hidden),
  AppEntry('avaaffiliate', 'AvaAffiliate', 'Earn 10% for life', PhosphorIcons.megaphone(PhosphorIconsStyle.regular), const Color(0xFFF97316), tier: AppTier.hidden),
  // ---- hidden until a later phase flips them ----
  AppEntry('avaai', 'AvaAI', 'AI assistant', PhosphorIcons.sparkle(PhosphorIconsStyle.regular), const Color(0xFF22C9C0), tier: AppTier.hidden),
  AppEntry('avaagent', 'AvaAgent', 'Build AI agents', PhosphorIcons.lightning(PhosphorIconsStyle.regular), const Color(0xFF6C5CE7), tier: AppTier.hidden),
  AppEntry('avatweet', 'AvaTweet', 'Microblog & timeline', PhosphorIcons.hash(PhosphorIconsStyle.regular), const Color(0xFF1DA1F2), tier: AppTier.hidden),
  AppEntry('avabook', 'AvaBook', 'Friends & feed', PhosphorIcons.usersThree(PhosphorIconsStyle.regular), const Color(0xFF7C5CFC), tier: AppTier.hidden),
  AppEntry('avagram', 'AvaGram', 'Photos & stories', PhosphorIcons.camera(PhosphorIconsStyle.regular), const Color(0xFFE1306C), tier: AppTier.hidden),
  AppEntry('avaweb', 'AvaWeb', 'AI website builder', PhosphorIcons.globe(PhosphorIconsStyle.regular), const Color(0xFF10B981), tier: AppTier.hidden),
  AppEntry('avanote', 'AvaNote', 'Notes & ideas', PhosphorIcons.note(PhosphorIconsStyle.regular), const Color(0xFFEAB308), tier: AppTier.hidden),
  AppEntry('avatube', 'AvaTube', 'Long-form video', PhosphorIcons.monitorPlay(PhosphorIconsStyle.regular), const Color(0xFFFF0000), tier: AppTier.hidden),
  AppEntry('avaads', 'AvaAds', 'Promote & advertise', PhosphorIcons.tag(PhosphorIconsStyle.regular), const Color(0xFFFF5864), tier: AppTier.hidden),
  AppEntry('avalinked', 'AvaLinked', 'Jobs & network', PhosphorIcons.briefcase(PhosphorIconsStyle.regular), const Color(0xFF0A66C2), tier: AppTier.hidden),
  AppEntry('avatind', 'AvaTind', 'Meet & match', PhosphorIcons.fire(PhosphorIconsStyle.regular), const Color(0xFFFF6036), tier: AppTier.hidden),
  AppEntry('avamatri', 'AvaMatri', 'Find your partner', PhosphorIcons.heart(PhosphorIconsStyle.regular), const Color(0xFFB91C4B), tier: AppTier.hidden),
];

class AppRegistry {
  static AppEntry? byId(String id) {
    for (final a in kAppRegistry) {
      if (a.id == id) return a;
    }
    return null;
  }

  /// The Marketplace is ADMIN-ONLY during the pro/live launch (owner decision
  /// 2026-07-04): keep its registry tile out of any derived menu unless the
  /// current account may see it (global flag on OR admin). See
  /// [RemoteConfig.marketplaceVisible].
  static bool _visible(AppEntry a) =>
      a.id != 'marketplace' || RemoteConfig.marketplaceVisible;

  static List<AppEntry> get standard =>
      kAppRegistry.where((a) => a.tier == AppTier.standard && _visible(a)).toList();

  /// Apps not in the registry (legacy keys) count as hidden.
  static bool isStandard(String id) => byId(id)?.tier == AppTier.standard;

  /// Ava in-chat "focus mode" (proposal §10): AvaTOK + account essentials only.
  /// When focus mode is on (see `kFocusModeDefault`), the sidebar renders THIS
  /// set instead of `standard`, hiding non-AvaTOK apps. Fully reversible — no
  /// registry mutation. Order follows the registry's declaration order. P1
  /// consumes it. AvaLibrary and AvaStorage are shown in the menu. Wallet was
  /// REMOVED for the pro/live launch (owner decision 2026-07-01) — re-add
  /// 'avawallet' here (and restore its tier) to bring the menu tile back.
  static const Set<String> _focusIds = {
    'avatok',
    'avachat',
    'avalibrary',
    'avastorage',
    'avaapps',
    // AvaMarketplace shows even in focus mode (owner decision 2026-06-30) so it's
    // reachable without turning focus mode off; the destination is still gated by
    // RemoteConfig.marketplaceEnabled.
    'marketplace',
  };

  static List<AppEntry> get focusMode =>
      kAppRegistry.where((a) => _focusIds.contains(a.id) && _visible(a)).toList();
}
