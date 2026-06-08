import 'package:flutter/material.dart';

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
const kApps = <AppDef>[
  AppDef('avatok', 'AvaTOK', 'Messages & calls', Icons.chat_bubble, Color(0xFF08C4C4), built: true),
  AppDef('avalive', 'AvaLive', 'Live streaming', Icons.sensors, Color(0xFFFF3B30), built: true),
  AppDef('avalibrary', 'AvaLibrary', 'Your files, everywhere', Icons.folder_open, Color(0xFF8B5CF6), built: true),
  AppDef('avastorage', 'AvaStorage', 'Storage & usage', Icons.pie_chart, Color(0xFF0EA5E9), built: true),
  AppDef('avaai', 'AvaAI', 'AI assistant', Icons.auto_awesome, Color(0xFF22C9C0)),
  AppDef('avaagent', 'AvaAgent', 'Build AI agents', Icons.bolt, Color(0xFF6C5CE7)),
  AppDef('avavoice', 'AvaVoice', 'AI voice agents', Icons.mic, Color(0xFFA06AF0)),
  AppDef('avatweet', 'AvaTweet', 'Microblog & timeline', Icons.tag, Color(0xFF1DA1F2)),
  AppDef('avabook', 'AvaBook', 'Friends & feed', Icons.groups, Color(0xFF7C5CFC)),
  AppDef('avagram', 'AvaGram', 'Photos & stories', Icons.photo_camera, Color(0xFFE1306C)),
  AppDef('avaweb', 'AvaWeb', 'AI website builder', Icons.language, Color(0xFF10B981)),
  AppDef('avanote', 'AvaNote', 'Notes & ideas', Icons.description, Color(0xFFEAB308)),
  AppDef('avatube', 'AvaTube', 'Long-form video', Icons.smart_display, Color(0xFFFF0000)),
  AppDef('avaads', 'AvaAds', 'Promote & advertise', Icons.sell, Color(0xFFFF5864)),
  AppDef('avalinked', 'AvaLinked', 'Jobs & network', Icons.business_center, Color(0xFF0A66C2)),
  AppDef('avatind', 'AvaTind', 'Meet & match', Icons.local_fire_department, Color(0xFFFF6036)),
  AppDef('avamatri', 'AvaMatri', 'Find your partner', Icons.favorite, Color(0xFFB91C4B)),
];

AppDef appByKey(String key) => kApps.firstWhere((a) => a.key == key, orElse: () => kApps.first);
