/// Core AvaTools (Phase 5 — Tool Layer).
///
/// The SMALL always-on toolset Ava carries everywhere. Per the proposal §3.3,
/// the surfaced set is ~5–7 tools; everything else (connected Google apps) runs
/// server-side via the AvaApps Composio path. Registered into [ToolRegistry]
/// from [AvaBootstrap.init] via [registerCoreTools].
///
/// What's real vs stubbed (see INTEGRATION-NOTES Phase 5):
///   • brain.search  — REAL. Wired to Phase 4's on-device + server memory
///                     ([AvaMemory.I.search]); passes `onDeviceOnly` for private
///                     conversations so private content never leaves the device.
///   • image.generate— SHIM → P9. Returns "coming soon" + the documented route
///                     ([AvaApi.image]); P9 owns the actual generation.
///   • translate     — STUB. No standalone translate service exists in the app
///                     today (only the live voice-translation overlay). Returns
///                     a clear TODO result; the model can still answer inline.
///   • schedule      — STUB. AvaCalendar/AvaBooking exist server-side but expose
///                     no single client "create a slot" call; returns a TODO.
///   • send_to       — STUB. Posting into a conversation is owned by the spine
///                     ([AvaTurnController]/postAvaMessage server-side); this
///                     tool documents the contract and returns a TODO.
///
/// All core tools here are FREE-BUNDLED (paid:false) — they run without a wallet
/// check. Connected-app actions (Gmail, Drive, Calendar, …) are NOT core tools:
/// they run server-side via the AvaApps Composio path and are coin-metered there.
library;

import '../ava_memory/ava_memory.dart';
import '../ava_contracts.dart';
import 'ava_tool.dart';

/// Register the small core toolset. Idempotent (ToolRegistry keys by name).
/// Called once from AvaBootstrap.init().
void registerCoreTools() {
  ToolRegistry.register(BrainSearchTool());
  ToolRegistry.register(TranslateTool());
  ToolRegistry.register(ScheduleTool());
  ToolRegistry.register(SendToTool());
  ToolRegistry.register(ImageGenerateTool());
}

// ─────────────────────────────────────────────────────────────────────────────
// brain.search — REAL (Phase 4).
// ─────────────────────────────────────────────────────────────────────────────
class BrainSearchTool implements AvaTool {
  @override
  String get name => 'brain.search';
  @override
  String get description => "Search the user's own messages and memory for relevant context.";
  @override
  String get whenToUse =>
      'When answering needs something the user said before, or a fact from their history.';
  @override
  bool get paid => false;
  @override
  Map<String, Object?> get parameters => {
        'query': {'type': 'string', 'description': 'What to look for', 'required': true},
        'topK': {'type': 'integer', 'description': 'Max results (default 5)'},
      };

  @override
  Future<Map<String, Object?>> invoke(Map<String, Object?> args, {required AvaToolContext ctx}) async {
    final query = (args['query'] ?? '').toString().trim();
    if (query.isEmpty) return {'error': 'query required'};
    final topK = (args['topK'] is num) ? (args['topK'] as num).toInt() : 5;

    // PRIVACY: a private/on-device conversation searches the LOCAL lane only —
    // its content is never sent to the server lane. The server (premium) lane
    // is only consulted for non-private chats and only when allowed.
    final hits = await AvaMemory.I.search(
      query,
      convKey: ctx.convKey,
      topK: topK,
      onDeviceOnly: ctx.private,
      allowServer: !ctx.private && ctx.premium,
    );
    return {
      'hits': [for (final h in hits) h.toJson()],
      'count': hits.length,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// translate — STUB (no standalone translate service in the app yet).
// ─────────────────────────────────────────────────────────────────────────────
class TranslateTool implements AvaTool {
  @override
  String get name => 'translate';
  @override
  String get description => 'Translate text into another language.';
  @override
  String get whenToUse => 'When the user asks to translate a message or phrase.';
  @override
  bool get paid => false;
  @override
  Map<String, Object?> get parameters => {
        'text': {'type': 'string', 'description': 'Text to translate', 'required': true},
        'to': {'type': 'string', 'description': 'Target language (e.g. "es", "French")', 'required': true},
      };

  @override
  Future<Map<String, Object?>> invoke(Map<String, Object?> args, {required AvaToolContext ctx}) async {
    // TODO(P5/translate backing service): the app currently has only the live
    // VOICE translation overlay (features/translation/), no text-translate call.
    // Until a `/api/translate/text` (or equivalent) client exists, signal that
    // the model should translate inline rather than via a tool call.
    final text = (args['text'] ?? '').toString();
    final to = (args['to'] ?? '').toString();
    return {
      'status': 'inline',
      'note': 'No dedicated translate backend wired yet — translate inline.',
      'text': text,
      'to': to,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// schedule — STUB (AvaCalendar/AvaBooking exist server-side, no single client op).
// ─────────────────────────────────────────────────────────────────────────────
class ScheduleTool implements AvaTool {
  @override
  String get name => 'schedule';
  @override
  String get description => 'Create a calendar block / booking for the user.';
  @override
  String get whenToUse => 'When the user asks to schedule a meeting, slot, or reminder.';
  @override
  bool get paid => false;
  @override
  Map<String, Object?> get parameters => {
        'title': {'type': 'string', 'description': 'What the block is for', 'required': true},
        'startsAt': {'type': 'string', 'description': 'ISO-8601 start time', 'required': true},
        'endsAt': {'type': 'string', 'description': 'ISO-8601 end time'},
      };

  @override
  Future<Map<String, Object?>> invoke(Map<String, Object?> args, {required AvaToolContext ctx}) async {
    // TODO(P5/schedule backing service): wire to AvaCalendar's create-block
    // endpoint (worker/src/routes/calendar.ts owns gcal sync; a client-facing
    // "create calendar_block" call is not yet exposed). Returns a TODO so the
    // turn doesn't silently succeed.
    return {
      'status': 'not_wired',
      'note': 'Calendar create not exposed to the client yet — tell the user to use AvaCalendar.',
      'echo': args,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// send_to — STUB (posting is owned by the spine, not a client tool today).
// ─────────────────────────────────────────────────────────────────────────────
class SendToTool implements AvaTool {
  @override
  String get name => 'send_to';
  @override
  String get description => 'Send a message to a contact or into a conversation.';
  @override
  String get whenToUse => 'When the user asks Ava to deliver a message to someone.';
  @override
  bool get paid => false;
  @override
  Map<String, Object?> get parameters => {
        'to': {'type': 'string', 'description': 'Recipient uid or conversation key', 'required': true},
        'text': {'type': 'string', 'description': 'Message body', 'required': true},
      };

  @override
  Future<Map<String, Object?>> invoke(Map<String, Object?> args, {required AvaToolContext ctx}) async {
    // TODO(P5/send_to backing path): message send-on-behalf is sensitive and is
    // owned by the spine (server-side postAvaMessage / the normal send path).
    // A confirm-before-send UX should gate this. Returns a TODO until that flow
    // (likely P6 companion / P7 delegate) is built.
    return {
      'status': 'needs_confirm',
      'note': 'Send-on-behalf requires explicit user confirmation — not auto-sent.',
      'echo': args,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// image.generate — SHIM → Phase 9. Documents the route; P9 implements it.
// ─────────────────────────────────────────────────────────────────────────────
class ImageGenerateTool implements AvaTool {
  @override
  String get name => 'image.generate';
  @override
  String get description => 'Generate an image from a text prompt.';
  @override
  String get whenToUse => 'When the user asks Ava to create or edit a picture.';

  /// Image generation is premium. The UI wraps the actual invocation in
  /// PaidFeature; this flag tells the broker/UI to show the PaidBadge.
  @override
  bool get paid => true;
  @override
  Map<String, Object?> get parameters => {
        'prompt': {'type': 'string', 'description': 'What to draw', 'required': true},
      };

  @override
  Future<Map<String, Object?>> invoke(Map<String, Object?> args, {required AvaToolContext ctx}) async {
    // SHIM: Phase 9 (Generative) owns image gen via POST [AvaApi.image]
    // (/api/ava/image), which generates asynchronously and presents the result
    // in-thread as an `ava` message with a media_ref. This tool intentionally
    // does NOT call it yet — it returns a "coming soon" pointer so the contract
    // is documented and the registry surfaces the tool without breaking.
    return {
      'status': 'coming_soon',
      'route': AvaApi.image, // P9 wires the real call here.
      'note': 'Image generation arrives with the generative phase (P9).',
      'prompt': (args['prompt'] ?? '').toString(),
    };
  }
}
