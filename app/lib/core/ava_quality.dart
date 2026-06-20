import 'analytics.dart';

/// AvaQuality — CORRECTNESS / usefulness telemetry for Ava, separate from the
/// speed events (ondevice_generate, ava_local_turn, …).
///
/// Users don't care that Ava answered in 300ms if the answer was wrong. These
/// events let us watch the things that actually mean quality:
///   • ava_answer     — was the answer grounded in real sources? how big did the
///                       prompt get? what's the hallucination risk?
///   • ava_tool       — did a connected-app action actually succeed?
///   • ava_correction — did the user push back ("that's wrong", "not what I
///                       asked")? Corrections-per-100-messages is gold.
class AvaQuality {
  AvaQuality._();

  /// Rough token estimate (~4 chars/token). Good enough to watch prompt bloat
  /// without shipping a tokenizer to the phone.
  static int _toks(String? s) =>
      (s == null || s.isEmpty) ? 0 : (s.length / 4).ceil();

  /// Record one answer's grounding + context-size profile.
  /// [source]: memory | rag | tool | llm | hybrid. [citations]: real sources
  /// shown. The hallucination risk is high when Ava had nothing to stand on.
  static void answer({
    required String surface,
    required String source,
    required bool grounded,
    int citations = 0,
    bool memoryUsed = false,
    int sourcesFound = 0,
    bool ok = true,
    String systemText = '',
    String memoryText = '',
    String ragText = '',
    String userText = '',
  }) {
    final risk = (sourcesFound == 0 && !memoryUsed)
        ? 'high'
        : (sourcesFound == 0 ? 'medium' : 'low');
    final sys = _toks(systemText);
    final mem = _toks(memoryText);
    final rag = _toks(ragText);
    final usr = _toks(userText);
    // ignore: unawaited_futures
    Analytics.capture('ava_answer', {
      'surface': surface,
      'answer_source': source,
      'grounded': grounded,
      'citations_count': citations,
      'memory_used': memoryUsed,
      'sources_found': sourcesFound,
      'hallucination_risk': risk,
      'ok': ok,
      'sys_tokens': sys,
      'memory_tokens': mem,
      'rag_tokens': rag,
      'user_tokens': usr,
      'context_tokens': sys + mem + rag + usr,
    });
  }

  /// Memory ROI — the metric most assistants never measure: of what we
  /// RETRIEVED and INJECTED, how much actually got REFERENCED in the answer?
  /// "referenced" is a heuristic: an injected snippet counts if it shares a
  /// meaningful word (5+ chars) with the answer text. Lets us see whether memory
  /// is helping or just burning context.
  static void roi({
    required String surface,
    required int retrieved,
    required String injected,
    required String answer,
  }) {
    final lines =
        injected.split('\n').where((l) => l.trim().isNotEmpty).toList();
    final referenced = _overlapCount(lines, answer);
    // ignore: unawaited_futures
    Analytics.capture('ava_memory_roi', {
      'surface': surface,
      'retrieved': retrieved,
      'injected': lines.length,
      'referenced': referenced,
    });
  }

  static int _overlapCount(List<String> injectedLines, String answer) {
    if (injectedLines.isEmpty || answer.isEmpty) return 0;
    Set<String> big(String s) => s
        .toLowerCase()
        .split(RegExp(r'[^a-z0-9]+'))
        .where((w) => w.length >= 5)
        .toSet();
    final aWords = big(answer);
    if (aWords.isEmpty) return 0;
    var refs = 0;
    for (final line in injectedLines) {
      if (big(line).any(aWords.contains)) refs++;
    }
    return refs;
  }

  /// A connected-app tool-call outcome (Gmail/Calendar/Drive/…).
  static void tool({
    required String tool,
    required bool succeeded,
    required int ms,
    String? reason,
  }) {
    // ignore: unawaited_futures
    Analytics.capture('ava_tool', {
      'tool': tool,
      'tool_called': true,
      'tool_succeeded': succeeded,
      'duration_ms': ms,
      if (reason != null) 'reason': reason,
    });
  }

  /// Phrases that usually mean "Ava got it wrong".
  static final RegExp _correctionRe = RegExp(
    r"(that'?s (wrong|incorrect|not right|not it)|not what i (asked|meant)|you (misunderstood|got it wrong)|wrong answer|^no[,. ]|incorrect)",
    caseSensitive: false,
  );

  /// Emit an ava_correction if [text] looks like the user correcting the
  /// previous Ava answer. Only counts when the prior turn was Ava's, and only
  /// for short messages (a long reply that happens to contain "no" isn't a
  /// correction). Returns true when one was logged.
  static bool maybeCorrection({
    required String surface,
    required bool prevWasAva,
    required String text,
    String? answerSource,
  }) {
    if (!prevWasAva) return false;
    final t = text.trim();
    if (t.isEmpty || t.length > 80) return false;
    if (!_correctionRe.hasMatch(t)) return false;
    // ignore: unawaited_futures
    Analytics.capture('ava_correction', {
      'surface': surface,
      'snippet_len': t.length,
      // What kind of answer got corrected? Corrections of memory-backed answers
      // are the ones that tell us memory is misleading Ava.
      if (answerSource != null) 'answer_source': answerSource,
    });
    return true;
  }

  /// Best-effort tool name from a natural-language app request, so ava_tool can
  /// be broken down by integration.
  static String toolGuess(String query) {
    final q = query.toLowerCase();
    if (q.contains('email') || q.contains('inbox') || q.contains('gmail')) {
      return 'gmail';
    }
    if (q.contains('calendar') || q.contains('event') || q.contains('meeting')) {
      return 'googlecalendar';
    }
    if (q.contains('drive') || q.contains('file') || q.contains('document')) {
      return 'googledrive';
    }
    return 'apps';
  }
}
