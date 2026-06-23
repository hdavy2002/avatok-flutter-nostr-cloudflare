/// thread_context — assemble a Messenger thread into a grounding block for
/// "Discuss this chat with Ava".
///
/// Phase 1: verbatim transcript of the last [maxTurns] turns. Phase 3 adds a
/// map-reduce summariser for long threads (kept under the prompt budget). The
/// block is built ON-DEVICE from already-decoded message text and is only ever
/// passed transiently as `context` to the moderated proxy.
library;

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
}
