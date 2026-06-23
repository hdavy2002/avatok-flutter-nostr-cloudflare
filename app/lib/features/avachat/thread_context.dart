/// thread_context — assemble a Messenger thread into a grounding block for
/// "Discuss this chat with Ava".
///
/// Phase 1: verbatim transcript of the last [maxTurns] turns. Phase 3 adds a
/// map-reduce summariser for long threads (kept under the prompt budget). The
/// block is built ON-DEVICE from already-decoded message text and is only ever
/// passed transiently as `context` to the moderated proxy.
library;

import 'dart:convert';

import '../../core/ava_prompt_budget.dart';

/// One decoded turn of a conversation, as the discuss feature needs it.
class DiscussTurn {
  /// True = the current user sent it; false = the other party.
  final bool me;

  /// The decoded, human-readable text (media bubbles become a short caption).
  final String text;

  /// Group threads only: the sender's label for a non-`me` turn. Null falls back
  /// to the peer/group label.
  final String? speaker;

  const DiscussTurn({required this.me, required this.text, this.speaker});
}

/// Decode raw AvaTok message envelopes (`{"t":"text","body":…}`, media, etc.)
/// into [DiscussTurn]s — used by the picker path that reads straight from the
/// per-account SQLite store. Receipts, reads, edits, votes and special bubbles
/// (calls, locations, polls, Ava replies) are skipped; media becomes a short
/// caption so the conversation still reads naturally.
List<DiscussTurn> turnsFromEnvelopes(List<({bool mine, String payload})> rows) {
  const skip = {
    'receipt', 'read', 'edit', 'vote', 'ava', 'ava_private', 'ava_status',
    'loc', 'live', 'card', 'poll', 'sticker', 'gcall', 'recept',
  };
  final out = <DiscussTurn>[];
  for (final r in rows) {
    String text = r.payload;
    try {
      final env = jsonDecode(r.payload);
      if (env is Map) {
        final t = env['t']?.toString();
        if (t != null && skip.contains(t)) continue;
        if (t == 'media') {
          final name = (env['name'] ?? '').toString();
          text = name.isEmpty ? '[media]' : '[media: $name]';
        } else if (t == 'text') {
          text = (env['body'] ?? '').toString();
        } else if (env['body'] != null) {
          text = env['body'].toString();
        }
      }
    } catch (_) {/* legacy plain text — use as-is */}
    if (text.trim().isEmpty) continue;
    out.add(DiscussTurn(me: r.mine, text: text));
  }
  return out;
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
    final lines = recent.map((t) => '${_label(t, peer)}: ${t.text.trim()}').join('\n');
    return '${header(peer, recent.length, isGroup: isGroup)}\n$lines';
  }

  /// Speaker label for a turn: "Me" for the user, the sender's name (groups) or
  /// the peer label otherwise.
  static String _label(DiscussTurn t, String peer) =>
      t.me ? 'Me' : ((t.speaker != null && t.speaker!.trim().isNotEmpty) ? t.speaker!.trim() : peer);

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
    String fmt(DiscussTurn t) => '${_label(t, peer)}: ${t.text.trim()}';

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
