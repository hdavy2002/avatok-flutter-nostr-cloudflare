/// AvaTool + ToolRegistry (Phase 5 — Tool Layer).
///
/// Phase 0 reserved the NAMES (master-plan §4) but did NOT define them, so this
/// file DEFINES the `AvaTool` interface and the `ToolRegistry`.
///
/// ── The whole point: keep the surfaced set SMALL ─────────────────────────────
/// Tool/context overload is the failure mode we are designing against. The
/// registry only ever holds the small ALWAYS-ON CORE toolset (~5 tools — see
/// core_tools.dart). Everything else (Gmail, Drive, Calendar, hundreds of
/// connector actions) is NEVER registered here — it runs server-side via the
/// AvaApps Composio path (worker ava_agent + routes/ava_apps.ts). So
/// [ToolRegistry.tools] is the thing handed to the model as "tools you always
/// have"; connected-app actions are handled by the agent loop on the worker.
library;

/// A single always-on core tool. Concrete tools live in core_tools.dart.
abstract class AvaTool {
  /// Stable machine name (e.g. `brain.search`, `translate`). Used as the tool
  /// id the model calls and the registry key.
  String get name;

  /// One-line human/model description of WHAT the tool does.
  String get description;

  /// WHEN the model should reach for this tool (kept terse — this is part of
  /// the always-resident prompt budget, so every word costs context).
  String get whenToUse;

  /// True when invoking the tool spends money / requires a subscription. The
  /// UI shows a [PaidBadge] and the call is wrapped in [PaidFeature] at the
  /// point of use; free-bundled tools (most core tools) run ungated.
  bool get paid;

  /// JSON-schema-ish parameter shape for the model (a small, flat map of
  /// `name → {type, description, required?}`). Kept minimal on purpose.
  Map<String, Object?> get parameters;

  /// Run the tool. [args] are the model-supplied arguments; [ctx] carries
  /// invocation context (the conversation key, privacy flag, premium flag) so a
  /// tool can route correctly (e.g. brain.search uses `onDeviceOnly` for a
  /// private chat). Returns a JSON-serialisable result (or a `{error}` map).
  Future<Map<String, Object?>> invoke(
    Map<String, Object?> args, {
    required AvaToolContext ctx,
  });
}

/// Context handed to every [AvaTool.invoke]. Built by the spine (P3/P6) at the
/// call site — it knows the conversation and whether it is private/premium.
class AvaToolContext {
  /// Client-local conversation key ('1:<peerUid>' | 'g:<gid>'), or null for a
  /// blank companion chat.
  final String? convKey;

  /// True when the conversation is on-device-only / private — tools MUST keep
  /// content on-device (e.g. brain.search passes `onDeviceOnly: true`).
  final bool private;

  /// True when the account is entitled to premium/subscription tools. Used to
  /// pass through the broker's free-vs-subscription gate.
  final bool premium;

  const AvaToolContext({
    this.convKey,
    this.private = false,
    this.premium = false,
  });
}

/// The small, always-on core tool registry. Idempotent by [AvaTool.name].
///
/// Deliberately NOT a catalog of every connector — see the library doc. The
/// AvaApps Composio path covers the long tail without bloating this set.
class ToolRegistry {
  ToolRegistry._();

  static final Map<String, AvaTool> _tools = <String, AvaTool>{};

  /// Register (or replace, by name) a core tool.
  static void register(AvaTool tool) {
    _tools[tool.name] = tool;
  }

  static void unregister(String name) => _tools.remove(name);

  /// All registered core tools (insertion-order-stable map values).
  static List<AvaTool> get tools => List<AvaTool>.unmodifiable(_tools.values);

  /// Names of the surfaced core tools.
  static List<String> get names => List<String>.unmodifiable(_tools.keys);

  /// Look up a core tool by name (null if not a core tool — the long tail of
  /// connector actions runs server-side via the AvaApps Composio path, not here).
  static AvaTool? byName(String name) => _tools[name];

  /// The compact tool manifest handed to the model: the core tools only, each
  /// as `{name, description, when, parameters, paid}`. This is the entire
  /// always-resident tool surface — keep it small.
  static List<Map<String, Object?>> manifest() => [
        for (final t in _tools.values)
          {
            'name': t.name,
            'description': t.description,
            'when': t.whenToUse,
            'parameters': t.parameters,
            if (t.paid) 'paid': true,
          },
      ];

  /// Test/hot-reload helper — clears the registry.
  static void clear() => _tools.clear();
}
