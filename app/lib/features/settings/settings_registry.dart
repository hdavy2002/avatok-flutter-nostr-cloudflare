/// SettingsSectionRegistry (Phase 0 — Foundations). Lets feature phases add a
/// Settings section from their OWN file under features/settings/sections/
/// WITHOUT editing settings_screen.dart (which is frozen after Phase 0).
///
/// A phase registers a [SettingsSection] (typically from its bootstrap/init,
/// invoked via AvaBootstrap.init or a top-level call), and settings_screen.dart
/// renders the ordered list AFTER its existing inline sections.
library;

import 'package:flutter/material.dart';

/// One pluggable Settings section. [order] sorts sections (lower = higher up);
/// the built-in inline sections render first, then these by [order].
class SettingsSection {
  final String id;
  final String title; // shown as the SECTION kicker (uppercased by the screen)
  final WidgetBuilder builder; // builds the section's body card(s)
  final int order;
  const SettingsSection({
    required this.id,
    required this.title,
    required this.builder,
    this.order = 100,
  });
}

/// Global ordered registry. Idempotent by [SettingsSection.id] so a phase that
/// registers twice (hot reload, double init) does not duplicate its section.
class SettingsSectionRegistry {
  SettingsSectionRegistry._();

  static final List<SettingsSection> _sections = <SettingsSection>[];

  /// Register (or replace, by id) a section.
  static void register(SettingsSection section) {
    _sections.removeWhere((s) => s.id == section.id);
    _sections.add(section);
  }

  static void unregister(String id) => _sections.removeWhere((s) => s.id == id);

  /// Sections in render order (by [SettingsSection.order], then insertion).
  static List<SettingsSection> get sections {
    final list = List<SettingsSection>.from(_sections);
    list.sort((a, b) => a.order.compareTo(b.order));
    return list;
  }
}
