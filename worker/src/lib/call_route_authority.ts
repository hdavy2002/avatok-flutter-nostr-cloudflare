/** Server-owned recipient and quick-reply contracts used by call routes. */
export type PersistedCallParticipants = {
  callerUid: string;
  calleeUid: string;
};

/** Return the other persisted participant, or null for a non-member. */
export function deriveCallRecipient(
  participants: PersistedCallParticipants,
  authenticatedUid: string,
): string | null {
  if (!authenticatedUid) return null;
  if (authenticatedUid === participants.callerUid) return participants.calleeUid;
  if (authenticatedUid === participants.calleeUid) return participants.callerUid;
  return null;
}

/** Only the persisted callee may send an incoming-call quick reply. */
export function deriveQuickReplyRecipient(
  participants: PersistedCallParticipants,
  authenticatedUid: string,
): string | null {
  return authenticatedUid === participants.calleeUid ? participants.callerUid : null;
}

export const QUICK_REPLY_CATALOG_V1: Readonly<Record<string, string>> = Object.freeze({
  will_call_back: "Will call back",
  busy_now: "Busy right now",
  in_meeting: "In a meeting",
  travelling: "Travelling",
  cant_talk: "Can't talk",
});
