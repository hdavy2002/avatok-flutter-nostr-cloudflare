import '../ava_companion/persona.dart';

/// "Discuss this chat with Ava" — the seed + persona for opening ChatAVA
/// (the Companion thread) pointed at one Messenger conversation.
///
/// Flow: from a Messenger thread the user taps "Discuss with Ava". We assemble
/// the recent transcript ON-DEVICE (see `thread_context.dart`) and open a
/// CompanionThreadScreen with [discussPersona] + that transcript as grounding
/// context. Ava can then give an opinion on the chat and help draft replies.
///
/// PRIVACY: the transcript is built from the user's own on-device message store
/// and passed transiently as the per-turn `context` to the moderated proxy. It
/// is NEVER indexed server-side (DM/group content stays on the device, matching
/// the AvaBrain E2E rule).
class AvaDiscussSeed {
  /// '1:<peerHex>' for a DM, 'g:<gid>' for a group.
  final String convKey;

  /// Display name of the other party / group (e.g. "Sonal").
  final String peerLabel;

  /// True when [convKey] is a group conversation.
  final bool isGroup;

  /// The on-device-assembled grounding block (the recent transcript). May be
  /// summarised for long threads — see `thread_context.dart`.
  final String transcript;

  const AvaDiscussSeed({
    required this.convKey,
    required this.peerLabel,
    required this.isGroup,
    required this.transcript,
  });
}

/// Build the steering persona for a discussion about [peerLabel]'s thread. It is
/// a normal [AvaPersona] (system-prompt preset) so the existing Companion thread
/// + moderated proxy handle it with no new infrastructure. The actual messages
/// ride in the separate `discussContext` grounding string, not here.
AvaPersona discussPersona(String peerLabel, {bool isGroup = false}) {
  final who = peerLabel.trim().isEmpty
      ? (isGroup ? 'a group chat' : 'someone')
      : peerLabel.trim();
  final subject = isGroup ? 'a group conversation ($who)' : 'a conversation with $who';
  return AvaPersona(
    id: 'discuss',
    name: 'Chat with $who',
    tagline: 'Talk through your conversation with $who.',
    glyph: '🧭',
    systemPrompt:
        'You are Ava, the friendly AI companion built into AvaTOK. The user wants '
        'to talk through $subject. The relevant messages are provided to you as '
        'context (labelled "Me:" for the user and by name for the other side). '
        'Give candid, useful, kind opinions about what is going on, read the tone '
        'and subtext, and answer the user\'s questions about it. When the user asks '
        'you to write or improve a reply, draft it in their voice as a message they '
        'could send — keep it natural and ready to paste. Be concise by default and '
        'expand when asked. Never pretend to be human; decline anything unsafe, '
        'hateful, or sexual involving minors.',
  );
}
