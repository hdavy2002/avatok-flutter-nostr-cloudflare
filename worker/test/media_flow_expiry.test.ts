// [AVA-MULTITOOL-1] Media-lane arbitration: idle expiry for stored song/video
// flow state, and the most-recently-touched preference when both lanes are
// active in the same conversation. Pure-function tests — AvaAgentDO applies
// these decisions at the top of turn().
import { describe, expect, it } from "vitest";
import {
  MEDIA_FLOW_IDLE_EXPIRY_MS,
  isMediaFlowExpired,
  isSongFlowState,
  preferMostRecentLane,
  stampFlowUpdated,
  type SongFlowState,
} from "../src/lib/song_flow";
import { isVideoFlowState, type VideoFlowState } from "../src/lib/video_flow";

const NOW = 1_766_000_000_000;

describe("isMediaFlowExpired", () => {
  it("keeps a flow touched within the 2h window", () => {
    expect(isMediaFlowExpired(NOW - MEDIA_FLOW_IDLE_EXPIRY_MS + 1, NOW)).toBe(false);
    expect(isMediaFlowExpired(NOW, NOW)).toBe(false);
  });

  it("expires a flow idle for longer than 2h", () => {
    expect(isMediaFlowExpired(NOW - MEDIA_FLOW_IDLE_EXPIRY_MS - 1, NOW)).toBe(true);
    expect(isMediaFlowExpired(NOW - 3 * 24 * 60 * 60 * 1000, NOW)).toBe(true);
  });

  it("treats a legacy flow with no stamp (or a broken stamp) as expired", () => {
    expect(isMediaFlowExpired(undefined, NOW)).toBe(true);
    expect(isMediaFlowExpired(Number.NaN, NOW)).toBe(true);
  });
});

describe("stampFlowUpdated", () => {
  it("stamps without disturbing the rest of the state", () => {
    const flow: SongFlowState = { phase: "reviewing", kind: "vocal", lyrics: "la la" };
    const stamped = stampFlowUpdated(flow, NOW);
    expect(stamped).toEqual({ ...flow, updatedAt: NOW });
    expect(flow.updatedAt).toBeUndefined(); // no mutation
  });

  it("produces state that still passes both validators", () => {
    const song: SongFlowState = { phase: "awaiting_brief", kind: "instrumental" };
    const video: VideoFlowState = { phase: "discovering", conversation: "make a video" };
    expect(isSongFlowState(stampFlowUpdated(song, NOW))).toBe(true);
    expect(isVideoFlowState(stampFlowUpdated(video, NOW))).toBe(true);
  });

  it("validators reject a corrupted stamp but accept a missing one", () => {
    expect(isSongFlowState({ phase: "reviewing", updatedAt: "yesterday" })).toBe(false);
    expect(isSongFlowState({ phase: "reviewing" })).toBe(true);
    expect(isVideoFlowState({ phase: "discovering", updatedAt: "yesterday" })).toBe(false);
    expect(isVideoFlowState({ phase: "discovering" })).toBe(true);
  });
});

describe("preferMostRecentLane", () => {
  it("gives the turn to the most recently touched lane", () => {
    expect(preferMostRecentLane(NOW, NOW - 1000)).toBe("song");
    expect(preferMostRecentLane(NOW - 1000, NOW)).toBe("video");
  });

  it("keeps the pre-existing video-first lane order on ties and legacy states", () => {
    expect(preferMostRecentLane(NOW, NOW)).toBe("video");
    expect(preferMostRecentLane(undefined, undefined)).toBe("video");
    expect(preferMostRecentLane(undefined, NOW)).toBe("video");
  });

  it("a stamped song lane beats an unstamped video lane", () => {
    expect(preferMostRecentLane(NOW, undefined)).toBe("song");
  });
});
