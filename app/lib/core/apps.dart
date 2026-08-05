import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// One AvaVerse app. `built` apps have real screens; others show a styled
/// "coming soon" placeholder for now. `defaultOn` controls onboarding toggle.
class AppDef {
  final String key;
  final String name;
  final String tagline;
  final IconData icon;
  final Color color;
  final bool built;
  final bool defaultOn;
  const AppDef(this.key, this.name, this.tagline, this.icon, this.color,
      {this.built = false, this.defaultOn = true});
}

/// All apps shown in onboarding "Set up your apps" + the sidebar.
///
/// [UI-ICONS-1 2026-08-05] Phosphor glyphs. `PhosphorIcons.x(...)` is a function
/// call, so this list is `final`, not `const`; `PhosphorIconData extends IconData`
/// so every consumer of [AppDef.icon] is unchanged.
final kApps = <AppDef>[
  AppDef('avatok', 'AvaTOK', 'Messages & calls', PhosphorIcons.chatCircle(PhosphorIconsStyle.regular), const Color(0xFF08C4C4), built: true),
  AppDef('avalive', 'AvaLive', 'Live streaming', PhosphorIcons.broadcast(PhosphorIconsStyle.regular), const Color(0xFFFF3B30), built: true),
  AppDef('avalibrary', 'AvaLibrary', 'Your files, everywhere', PhosphorIcons.folderOpen(PhosphorIconsStyle.regular), const Color(0xFF8B5CF6), built: true),
  AppDef('avastorage', 'AvaStorage', 'Storage & usage', PhosphorIcons.chartPie(PhosphorIconsStyle.regular), const Color(0xFF0EA5E9), built: true),
  AppDef('avaai', 'AvaAI', 'AI assistant', PhosphorIcons.sparkle(PhosphorIconsStyle.regular), const Color(0xFF22C9C0)),
  AppDef('avaagent', 'AvaAgent', 'Build AI agents', PhosphorIcons.lightning(PhosphorIconsStyle.regular), const Color(0xFF6C5CE7)),
  AppDef('avavoice', 'AvaVoice', 'AI voice agents', PhosphorIcons.microphone(PhosphorIconsStyle.regular), const Color(0xFFA06AF0)),
  AppDef('avavision', 'AvaVision', 'AI vision coaches', PhosphorIcons.eye(PhosphorIconsStyle.regular), const Color(0xFFA06AF0)),
  AppDef('avaaffiliate', 'AvaAffiliate', 'Earn 10% for life', PhosphorIcons.megaphone(PhosphorIconsStyle.regular), const Color(0xFFF97316), built: true),
  AppDef('avatweet', 'AvaTweet', 'Microblog & timeline', PhosphorIcons.hash(PhosphorIconsStyle.regular), const Color(0xFF1DA1F2)),
  AppDef('avabook', 'AvaBook', 'Friends & feed', PhosphorIcons.usersThree(PhosphorIconsStyle.regular), const Color(0xFF7C5CFC)),
  AppDef('avagram', 'AvaGram', 'Photos & stories', PhosphorIcons.camera(PhosphorIconsStyle.regular), const Color(0xFFE1306C)),
  AppDef('avaweb', 'AvaWeb', 'AI website builder', PhosphorIcons.globe(PhosphorIconsStyle.regular), const Color(0xFF10B981)),
  AppDef('avanote', 'AvaNote', 'Notes & ideas', PhosphorIcons.note(PhosphorIconsStyle.regular), const Color(0xFFEAB308)),
  AppDef('avatube', 'AvaTube', 'Long-form video', PhosphorIcons.monitorPlay(PhosphorIconsStyle.regular), const Color(0xFFFF0000)),
  AppDef('avaads', 'AvaAds', 'Promote & advertise', PhosphorIcons.tag(PhosphorIconsStyle.regular), const Color(0xFFFF5864)),
  AppDef('avalinked', 'AvaLinked', 'Jobs & network', PhosphorIcons.briefcase(PhosphorIconsStyle.regular), const Color(0xFF0A66C2)),
  AppDef('avatind', 'AvaTind', 'Meet & match', PhosphorIcons.fire(PhosphorIconsStyle.regular), const Color(0xFFFF6036)),
  AppDef('avamatri', 'AvaMatri', 'Find your partner', PhosphorIcons.heart(PhosphorIconsStyle.regular), const Color(0xFFB91C4B)),
];

AppDef appByKey(String key) => kApps.firstWhere((a) => a.key == key, orElse: () => kApps.first);
