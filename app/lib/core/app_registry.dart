import 'package:flutter/material.dart';

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
const kAppRegistry = <AppEntry>[
  // ---- standard ----
  AppEntry('avatok', 'AvaTOK', 'Messages & calls', Icons.chat_bubble, Color(0xFF08C4C4)),
  AppEntry('avalibrary', 'Library', 'Your files, everywhere', Icons.folder_open, Color(0xFF8B5CF6)),
  AppEntry('avastorage', 'View Storage', 'Storage & usage', Icons.pie_chart, Color(0xFF0EA5E9)),
  AppEntry('avaapps', 'Connectors', 'Gmail, Docs, Drive & more', Icons.grid_view, Color(0xFF4F8DFD)),
  // AvaChat — direct AI chat with Ava (memory-aware, talks to your brain). Visible
  // sidebar item (owner decision 2026-06-18). Routes to CompanionHome.
  AppEntry('avachat', 'AvaChat', 'Chat with Ava — your AI', Icons.auto_awesome, Color(0xFFA06AF0)),
  // AvaWallet visible — users need it to top up Tokens (owner decision 2026-06-18).
  AppEntry('avawallet', 'Wallet', 'Tokens & top-ups', Icons.account_balance_wallet, Color(0xFF10B981)),
  // ---- hidden from the sidebar menu (owner decision 2026-06-17) ----
  AppEntry('explore', 'AvaExplore', 'Marketplace', Icons.storefront, Color(0xFFFF6036), tier: AppTier.hidden),
  AppEntry('verse', 'AvaVerse', 'Your dashboard', Icons.dashboard, Color(0xFF6C5CE7), tier: AppTier.hidden),
  AppEntry('avapayout', 'AvaPayout', 'Withdraw your earnings', Icons.payments, Color(0xFF0A66C2), tier: AppTier.hidden),
  // Unhidden (AvaMarketplace P1, owner decision 2026-06-30): Identity is the
  // single source of truth for marketplace listing eligibility (video ID + email
  // + phone OTP), so it must be reachable from the sidebar. Routes to
  // IdentityScreen via AvaShell._openDest('avaidentity').
  AppEntry('avaidentity', 'AvaIdentity', 'Verify your identity', Icons.verified_user, Color(0xFF7C5CFC)),
  AppEntry('avabooking', 'AvaBooking', 'Your bookings', Icons.event_available, Color(0xFFE1306C), tier: AppTier.hidden),
  AppEntry('avacalendar', 'AvaCalendar', 'Availability & sync', Icons.calendar_month, Color(0xFFEAB308), tier: AppTier.hidden),
  AppEntry('avalive', 'AvaLive', 'Live streaming', Icons.sensors, Color(0xFFFF3B30), tier: AppTier.hidden),
  AppEntry('avaconsult', 'AvaConsult', 'Paid sessions', Icons.video_camera_front, Color(0xFF22C9C0), tier: AppTier.hidden),
  AppEntry('avavoice', 'AvaVoice', 'AI voice agents', Icons.mic, Color(0xFFA06AF0), tier: AppTier.hidden),
  AppEntry('avavision', 'AvaVision', 'AI vision coaches', Icons.visibility, Color(0xFFA06AF0), tier: AppTier.hidden),
  AppEntry('avainbox', 'AvaInbox', 'All messages, one inbox', Icons.inbox, Color(0xFF4F8DFD), tier: AppTier.hidden),
  AppEntry('avaaffiliate', 'AvaAffiliate', 'Earn 10% for life', Icons.campaign, Color(0xFFF97316), tier: AppTier.hidden),
  // ---- hidden until a later phase flips them ----
  AppEntry('avaai', 'AvaAI', 'AI assistant', Icons.auto_awesome, Color(0xFF22C9C0), tier: AppTier.hidden),
  AppEntry('avaagent', 'AvaAgent', 'Build AI agents', Icons.bolt, Color(0xFF6C5CE7), tier: AppTier.hidden),
  AppEntry('avatweet', 'AvaTweet', 'Microblog & timeline', Icons.tag, Color(0xFF1DA1F2), tier: AppTier.hidden),
  AppEntry('avabook', 'AvaBook', 'Friends & feed', Icons.groups, Color(0xFF7C5CFC), tier: AppTier.hidden),
  AppEntry('avagram', 'AvaGram', 'Photos & stories', Icons.photo_camera, Color(0xFFE1306C), tier: AppTier.hidden),
  AppEntry('avaweb', 'AvaWeb', 'AI website builder', Icons.language, Color(0xFF10B981), tier: AppTier.hidden),
  AppEntry('avanote', 'AvaNote', 'Notes & ideas', Icons.description, Color(0xFFEAB308), tier: AppTier.hidden),
  AppEntry('avatube', 'AvaTube', 'Long-form video', Icons.smart_display, Color(0xFFFF0000), tier: AppTier.hidden),
  AppEntry('avaads', 'AvaAds', 'Promote & advertise', Icons.sell, Color(0xFFFF5864), tier: AppTier.hidden),
  AppEntry('avalinked', 'AvaLinked', 'Jobs & network', Icons.business_center, Color(0xFF0A66C2), tier: AppTier.hidden),
  AppEntry('avatind', 'AvaTind', 'Meet & match', Icons.local_fire_department, Color(0xFFFF6036), tier: AppTier.hidden),
  AppEntry('avamatri', 'AvaMatri', 'Find your partner', Icons.favorite, Color(0xFFB91C4B), tier: AppTier.hidden),
];

class AppRegistry {
  static AppEntry? byId(String id) {
    for (final a in kAppRegistry) {
      if (a.id == id) return a;
    }
    return null;
  }

  static List<AppEntry> get standard =>
      kAppRegistry.where((a) => a.tier == AppTier.standard).toList();

  /// Apps not in the registry (legacy keys) count as hidden.
  static bool isStandard(String id) => byId(id)?.tier == AppTier.standard;

  /// Ava in-chat "focus mode" (proposal §10): AvaTOK + account essentials only.
  /// When focus mode is on (see `kFocusModeDefault`), the sidebar renders THIS
  /// set instead of `standard`, hiding non-AvaTOK apps. Fully reversible — no
  /// registry mutation. Order follows the registry's declaration order. P1
  /// consumes it. AvaLibrary, AvaStorage and AvaWallet are shown in the menu —
  /// the wallet is needed for Token top-ups (owner decision 2026-06-18).
  static const Set<String> _focusIds = {
    'avatok',
    'avachat',
    'avalibrary',
    'avastorage',
    'avaapps',
    'avawallet',
  };

  static List<AppEntry> get focusMode =>
      kAppRegistry.where((a) => _focusIds.contains(a.id)).toList();
}
