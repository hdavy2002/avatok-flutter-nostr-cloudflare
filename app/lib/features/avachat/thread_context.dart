/// thread_context — assemble a Messenger thread into a grounding block for
/// "Discuss this chat with Ava".
///
/// Phase 1: verbatim transcript of the last [maxTurns] turns. Phase 3 adds a
/// map-reduce summariser for long threads (kept under the prompt budget). The
/// block is built ON-DEVICE from already-decoded message text and is only ever
/// passed transiently as `context` to the moderated proxy.
library;

import '../../core/ava_prompt_budget.dart';

/// One decoded turn of a conversation, as the discuss feature needs it.
class DiscussTurn {
  /// True = the current user sent it; false = the other party.
  final bool me;

  /// The decoded, human-readable text (media bubbles become a short caption).
  final String text;

  const DiscussTurn({required this.me, required this.text});
}

class ThreadContext {
  ThreadContext._();

  /// Header line shown to the model (and mirrored in the UI context chip).
  static String header(String peerLabel, int shownTurns, {bool isGroup = false}) {
    final who = peerLabel.trim().isEmpty
        ? (isGroup ? 'a group chat' : 'your chat')
        : peerLabel.trim();
    final scope = isGroup ? 'group chat $who' : 'conversation with $who';
    return 'Conversation context — the $scope (last $shownTurns messages):';
  }

  /// Build a verbatim grounding block from [turns], keeping the most recent
  /// [maxTurns]. Speakers are labelled "Me:" / "<peerLabel>:". Empty turns are
  /// dropped. Returns '' when there is nothing substantive to show.
  static String buildVerbatim({
    required String peerLabel,
    required List<DiscussTurn> turns,
    int maxTurns = 40,
    bool isGroup = false,
  }) {
    final cleaned = turns.where((t) => t.text.trim().isNotEmpty).toList();
    if (cleaned.isEmpty) return '';
    final recent =
        cleaned.length > maxTurns ? cleaned.sublist(cleaned.length - maxTurns) : cleaned;
    final peer = peerLabel.trim().isEmpty ? 'Them' : peerLabel.trim();
    final lines = recent.map((t) => '${t.me ? 'Me' : peer}: ${t.text.trim()}').join('\n');
    return '${header(peer, recent.length, isGroup: isGroup)}\n$lines';
  }

  /// Token budget (≈ chars/4) for the whole transcript block. Cloud Gemini can
  /// take far more, but we keep prompts lean + cheap and summarise beyond this.
  static const int kTranscriptTokenBudget = 1500;

  /// Raw (un-summarised) most-recent turns to always keep verbatim — recency
  /// matters most when asking "what do you think of this chat".
  static const int kRawTailTurns = 12;

  static const int _kCharsPerToken = 4;
  static int _estTokens(String s) => (s.length / _kCharsPerToken).ceil();

  /// Build a grounding block that stays under [kTranscriptTokenBudget]. Short
  /// threads come back verbatim; long ones are map-reduce summarised: older turns
  /// are chunked and passed to [summarize] (an on-device-initiated LLM call),
  /// while the last [kRawTailTurns] stay verbatim. Falls back to a hard
  /// character cap if summarisation yields nothing.
  ///
  /// [summarize] takes a block of chat lines and returns a short recap. Kept as a
  /// callback so this file has no dependency on the AI client.
  static Future<String> buildSmart({
    required String peerLabel,
    required List<DiscussTurn> turns,
    required Future<String> Function(String chunk) summarize,
    bool isGroup = false,
  }) async {
    final cleaned = turns.where((t) => t.text.trim().isNotEmpty).toList();
    if (cleaned.isEmpty) return '';
    final peer = peerLabel.trim().isEmpty ? 'Them' : peerLabel.trim();
    String fmt(DiscussTurn t) => '${t.me ? 'Me' : peer}: ${t.text.trim()}';

    // Short enough → verbatim.
    final allLines = cleaned.map(fmt).join('\n');
    final head = header(peer, cleaned.length, isGroup: isGroup);
    if (_estTokens('$head\n$allLines') <= kTranscriptTokenBudget) {
      return '$head\n$allLines';
    }

    // Long → summarise everything except the recent tail.
    final tailCount = cleaned.length > kRawTailTurns ? kRawTailTurns : cleaned.length;
    final older = cleaned.sublist(0, cleaned.length - tailCount);
    final tail = cleaned.sublist(cleaned.length - tailCount);

    // Chunk older turns to ~half the budget each, summarise, concatenate.
    final summaries = <String>[];
    final chunkCharBudget = (kTranscriptTokenBudget * _kCharsPerToken) ~/ 2;
    final buf = StringBuffer();
    Future<void> flush() async {
      if (buf.isEmpty) return;
      try {
        final s = (await summarize(buf.toString())).trim();
        if (s.isNotEmpty) summaries.add(s);
      } catch (_) {/* skip this chunk on failure */}
      buf.clear();
    }

    for (final t in older) {
      final line = fmt(t);
      if (buf.length + line.length > chunkCharBudget) await flush();
      buf.writeln(line);
    }
    await flush();

    final recap = summaries.isEmpty
        ? '(earlier messages omitted)'
        : summaries.join('\n');
    final tailLines = tail.map(fmt).join('\n');
    final block = '$head\n'
        'Earlier in the conversation (summarised):\n$recap\n\n'
        'Most recent messages:\n$tailLines';
    return AvaPromptBudget.cap(block, kTranscriptTokenBudget);
  }
}
