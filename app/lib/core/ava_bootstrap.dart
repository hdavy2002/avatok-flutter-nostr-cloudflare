/// AvaBootstrap (Phase 0 — Foundations). The single startup hook for the Ava
/// in-chat layer, called once from main.dart. Today it is intentionally empty:
/// it exists so later phases can register their tools / memory lanes / settings
/// sections from their OWN files without editing main.dart (which is frozen
/// after Phase 0).
///
/// How later phases plug in (none of this edits this file's body — they call
/// the extension points from their own bootstrap code, invoked via AvaBootstrap
/// or a registry):
///   • P4 (memory): register the on-device FTS5/vector lane + embedder download.
///   • P5 (tools):  register core AvaTools + Strata/MCP brokers into a ToolRegistry.
///   • P3/P6/P8/P9: register their settings sections via SettingsSectionRegistry
///     (see features/settings/settings_registry.dart).
library;

import '../features/settings/sections/backup_sync_section.dart';
import '../features/settings/sections/delegate_section.dart';
import '../features/settings/sections/focus_section.dart';
import '../features/settings/sections/guardian_section.dart';
import '../features/settings/sections/receptionist_section.dart';
import '../features/settings/sections/ringtone_section.dart';
import '../features/settings/sections/tools_section.dart';
import '../features/settings/sections/voice_section.dart';
import '../features/ava_generative/image_tool.dart';
import 'ava_memory/ava_memory.dart';
import 'ava_tools/core_tools.dart';

class AvaBootstrap {
  AvaBootstrap._();

  static bool _done = false;

  /// Idempotent one-time init. Safe to call before any account scope exists —
  /// per-account state must be (re)bound on scope change by the owning phase,
  /// not here. Keep this non-throwing: a failure here must never block app boot.
  static Future<void> init() async {
    if (_done) return;
    _done = true;
    // Phase 4 fills: memory-lane registration + embedder download hook.
    // Phase 5 fills: tool-registry population (core tools, Strata, MCP).
    // Phases 3/6/8/9 fill: SettingsSectionRegistry.register(...) from their files.
    // Phase 1: Focus mode settings section (menu show/hide toggle).
    registerFocusSection();
    // Phase 4: two-lane memory — construct the router + wake the embedder
    // availability check (download-on-first-use is lazy; non-blocking).
    // ignore: unawaited_futures
    registerAvaMemory();
    // Phase 5: populate the small always-on core ToolRegistry (brain.search,
    // translate, schedule, send_to, image.generate-shim) + register the
    // "Tools & connectors" settings section (opens the MCP connect screen).
    registerCoreTools();
    registerToolsSection();
    // Phase 9: the REAL image.generate tool. Registered AFTER registerCoreTools()
    // so it SUPERSEDES P5's coming-soon shim (ToolRegistry.register replaces by
    // name). Calls POST /api/ava/image → async in-thread Nano Banana 2 generation.
    registerImageTool();
    // Phase 6: "Ava voice" settings section — premium (paid) toggle that lets
    // Ava voice her companion replies on demand. The companion text chat itself
    // is free (CompanionHome/CompanionThreadScreen via the existing
    // /api/ava/gemini proxy); only synthesis is gated. Synthesis wiring is
    // deferred (no new worker route) — see voice_section.dart's AvaVoice.
    registerVoiceSection();
    // Ava Receptionist: "Ava answers after 5 rings" — premium section with the
    // "Leave Instructions for Ava" box. First real AvaVoice deployment.
    // Spec: Specs/PROPOSAL-AI-RECEPTIONIST.md.
    registerReceptionistSection();
    // AI Ringback Tones — free "Ringback tone" settings section: generate tones
    // with MiniMax Music 2.6, keep up to 5, set the default callers hear, delete.
    // Spec: Specs/proposals/PROPOSAL-AI-RINGBACK-TONES.md.
    registerRingtoneSection();
    // Phase 10: "Backup & sync" settings section — free Google Drive backup +
    // premium R2 cross-device sync (R2 wrapped in PaidFeature). The on-device
    // SQLite is the source of truth and is client-side encrypted before any
    // backup. Does NOT touch the existing email-export backup in settings_screen.
    registerBackupSyncSection();
    // Phase 7: "Ava delegate" settings section — explains monitor + auto-reply
    // and holds the account-wide DEFAULTS new chats inherit (free alert-on-
    // mention default ON; premium reply-on-my-behalf default OFF). The actual
    // switches are PER-CHAT (DelegateSettingsSheet) and authoritative server-side
    // (/api/ava/delegate, a Phase-11 hook). Idempotent (registry keys by id).
    registerDelegateSection();
    // Phase 8: "Guardian / safety" settings section — free scam/spam shield +
    // warning-display prefs, premium always-on deep-monitoring default (wrapped in
    // PaidFeature), and a weekly parent-digest opt-in shown only for parent
    // accounts. The per-chat secure-chat toggle lives in GuardianSettingsSheet
    // (opened from a chat's Ava menu) and is authoritative server-side via the
    // Phase-0-wired POST /api/ava/guardian/scan. Idempotent (registry keys by id).
    registerGuardianSection();
  }
}
