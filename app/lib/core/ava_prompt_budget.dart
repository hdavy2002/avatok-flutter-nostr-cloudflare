/// AvaPromptBudget — a hard per-turn token budget for the on-device model.
///
/// As Ava's memory grows, the danger isn't CPU — it's prompt bloat. A 350M model
/// gets slow and loses the plot once the prompt balloons. So we cap each part of
/// the prompt BEFORE inference: the profile/memory note and the retrieved RAG
/// context each get a ceiling, and the user's own message is always kept whole.
///
/// Token count is estimated at ~4 chars/token (no tokenizer needed on the phone)
/// — close enough to keep the assembled prompt near the target. Rough budget per
/// turn: system ~150 + memory ~300 + RAG ~700 + user → comfortably under ~1800.
class AvaPromptBudget {
  AvaPromptBudget._();

  /// Cap for the "about the user" note (profile + preferences + traits).
  static const int kMemoryTokens = 300;

  /// Cap for retrieved RAG snippets.
  static const int kRagTokens = 700;

  static const int _kCharsPerToken = 4;

  /// Trim [text] to at most [maxTokens] (≈ chars), cutting on a newline/space
  /// boundary near the limit so we never slice a word in half. Marks the cut
  /// with an ellipsis. Returns [text] unchanged when already within budget.
  static String cap(String text, int maxTokens) {
    final maxChars = maxTokens * _kCharsPerToken;
    if (text.length <= maxChars) return text;
    var cut = text.substring(0, maxChars);
    final nl = cut.lastIndexOf('\n');
    final sp = cut.lastIndexOf(' ');
    final boundary = nl > maxChars - 200 ? nl : (sp > maxChars - 80 ? sp : -1);
    if (boundary > 0) cut = cut.substring(0, boundary);
    return '${cut.trimRight()} …';
  }

  /// Cap the memory/profile note.
  static String memory(String text) => cap(text, kMemoryTokens);

  /// Cap the retrieved RAG context.
  static String rag(String text) => cap(text, kRagTokens);
}
