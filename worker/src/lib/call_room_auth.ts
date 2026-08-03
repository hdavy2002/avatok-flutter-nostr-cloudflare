export type RoomSideTag = "side:caller" | "side:callee";

export const CALL_ROOM_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;

export function roomTokenExpired(expiresAt: number | undefined, now: number): boolean {
  return typeof expiresAt === "number" && expiresAt > 0 && now > expiresAt;
}

export function authenticatedSideTag(side: "caller" | "callee"): RoomSideTag {
  return `side:${side}`;
}

/** Stable seat identity for counts across socket replacement and hibernation. */
export function socketSeatKey(tags: string[]): string | null {
  const side = tags[1];
  if (side === "side:caller" || side === "side:callee") return side;
  return tags[0] || null;
}

export function sameRoomSeat(
  tags: string[],
  side: RoomSideTag | null,
  peerId: string,
): boolean {
  return side ? tags[1] === side : tags[0] === peerId;
}

/** Same-side sockets are removed before this check. One opposite seat is the
 * expected second participant; two other identities would make this a third. */
export function roomSeatIsFull(side: RoomSideTag | null, otherSeatCount: number): boolean {
  void side; // documents that callers have already applied side deduplication
  return otherSeatCount >= 2;
}
