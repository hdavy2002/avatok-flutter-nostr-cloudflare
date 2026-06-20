/// AvaPlanner — a deterministic intent planner (a tiny intent DSL), used BEFORE
/// the on-device model decides anything.
///
/// Keyword routing ("does the text contain 'call'?") is fragile: "call John" is a
/// phone call, "call my lawyer about this" needs no tool, and "call John and ask
/// him" means contact, not dial. So instead we match high-precision, ANCHORED
/// patterns that map an utterance to a structured intent + slots:
///
///   "send message to bob"  → { intent: send_message, recipient: bob }
///   "check my email"       → { intent: check_email }
///
/// If a pattern matches with high confidence we route deterministically — no
/// model pass, no hallucination, no battery cost. Everything ambiguous falls
/// through to the LFM model router. This is how Siri/Alexa/Assistant evolved,
/// and it typically removes the model from the majority of tool requests.
library;

enum PlanScope { apps, local }

class PlannerResult {
  final String intent;
  final PlanScope scope;
  final double confidence; // 0..1
  final Map<String, String> slots;
  const PlannerResult(this.intent, this.scope, this.confidence,
      [this.slots = const {}]);
}

class _IntentPattern {
  final String intent;
  final PlanScope scope;
  final RegExp re;
  final double confidence;
  final List<String> slotNames; // named in capture-group order
  const _IntentPattern(
      this.intent, this.scope, this.re, this.confidence, this.slotNames);
}

class AvaPlanner {
  AvaPlanner._();

  /// A plan must be at least this confident to skip the model and execute.
  static const double kExecuteThreshold = 0.9;

  // Patterns are anchored (^) so only a CLEAR command fires — a casual mention
  // mid-sentence won't. Order matters: first match wins, most specific first.
  static final List<_IntentPattern> _patterns = <_IntentPattern>[
    // ── Email (read) ──
    _IntentPattern(
        'check_email',
        PlanScope.apps,
        RegExp(
            r"^(?:check (?:my )?email|any (?:new )?emails?|unread emails?|read (?:my )?email|do i have (?:any )?(?:new )?emails?)\b",
            caseSensitive: false),
        0.96,
        const []),
    // ── Email (send) ──
    _IntentPattern(
        'send_email',
        PlanScope.apps,
        RegExp(
            r'^(?:send (?:an )?email to|email)\s+([\w .@]+?)(?:\s+(?:about|saying|re:?)\s+(.+))?$',
            caseSensitive: false),
        0.95,
        const ['recipient', 'body']),
    // ── Messaging ──
    _IntentPattern(
        'send_message',
        PlanScope.apps,
        RegExp(
            r'^(?:send (?:a )?message to|text|message|dm|tell)\s+([\w .]+?)(?:\s+(?:that|saying|about)\s+(.+))?$',
            caseSensitive: false),
        0.93,
        const ['recipient', 'body']),
    // ── Calendar (read) ──
    _IntentPattern(
        'calendar_view',
        PlanScope.apps,
        RegExp(
            r"^(?:what'?s on my calendar|my (?:calendar|schedule)|what'?s my schedule|agenda for|am i free)\b",
            caseSensitive: false),
        0.95,
        const []),
    // ── Calendar (create) ──
    _IntentPattern(
        'create_event',
        PlanScope.apps,
        RegExp(
            r'^(?:schedule (?:a )?(?:meeting|call|event)|create (?:an )?event|add .+ to my calendar|put .+ on my calendar)\b',
            caseSensitive: false),
        0.92,
        const []),
    // ── Reminder ──
    _IntentPattern(
        'reminder',
        PlanScope.apps,
        RegExp(r'^remind me to\s+(.+)$', caseSensitive: false),
        0.93,
        const ['body']),
    // ── Drive (browse / find) ──
    _IntentPattern(
        'drive_view',
        PlanScope.apps,
        RegExp(r'^(?:my (?:google )?drive|files in (?:my )?drive)\b',
            caseSensitive: false),
        0.92,
        const []),
    _IntentPattern(
        'find_file',
        PlanScope.apps,
        RegExp(
            r'^(?:find|open|get) (?:the )?(?:file|doc|document|sheet|spreadsheet)\s+(.+?)(?:\s+in (?:my )?drive)?$',
            caseSensitive: false),
        0.9,
        const ['query']),
    // ── Local memory lookup (on-device retrieval, no tool) ──
    _IntentPattern(
        'find_memory',
        PlanScope.local,
        RegExp(
            r'^(?:find|show me|what did i (?:say|tell you)|recall|do i have)\b.*\b(?:note|notes|message|said|about)\b',
            caseSensitive: false),
        0.9,
        const []),
    // NOTE: "call X" is deliberately NOT a pattern — it's too ambiguous
    // ("call my lawyer about this" needs no dialer). The model router handles it.
  ];

  /// Match [text] to a structured intent, or null if nothing fits. The caller
  /// decides whether [PlannerResult.confidence] clears [kExecuteThreshold].
  static PlannerResult? plan(String text) {
    final t = text.trim();
    if (t.isEmpty) return null;
    for (final p in _patterns) {
      final m = p.re.firstMatch(t);
      if (m == null) continue;
      final slots = <String, String>{};
      for (var i = 0; i < p.slotNames.length; i++) {
        final g = (i + 1) <= m.groupCount ? m.group(i + 1) : null;
        if (g != null && g.trim().isNotEmpty) slots[p.slotNames[i]] = g.trim();
      }
      return PlannerResult(p.intent, p.scope, p.confidence, slots);
    }
    return null;
  }
}
