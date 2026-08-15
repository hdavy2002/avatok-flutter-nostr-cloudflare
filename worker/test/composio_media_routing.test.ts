import { describe, expect, it } from "vitest";
import {
  looksLikeVideoRequest,
} from "../src/lib/composio";
import { classifySongRequest } from "../src/lib/song_flow";

describe("forced media routing intent", () => {
  it("recognizes unmistakable video creation without treating calls as video", () => {
    expect(looksLikeVideoRequest("make a video of a neon city at night")).toBe(true);
    expect(looksLikeVideoRequest("turn this photo into a video")).toBe(true);
    expect(looksLikeVideoRequest("turn that image into a video")).toBe(true);
    expect(looksLikeVideoRequest("turn the picture into a video")).toBe(true);
    expect(looksLikeVideoRequest("@ava animate it")).toBe(true);
    expect(looksLikeVideoRequest("@ava make it move")).toBe(true);
    expect(looksLikeVideoRequest("I mean 6 second video of an Indian woman promoting AvaTOK")).toBe(true);
    expect(looksLikeVideoRequest("@ava actually a 1.5-second clip showing a launch party")).toBe(true);
    expect(looksLikeVideoRequest("start a video call with Maya")).toBe(false);
    expect(looksLikeVideoRequest("turn this photo into a video call with Maya")).toBe(false);
    expect(looksLikeVideoRequest("I watched a video about turning photos into art")).toBe(false);
    expect(looksLikeVideoRequest("I mean a video of a launch party")).toBe(false);
    expect(looksLikeVideoRequest("I watched a 6 second video of a launch party")).toBe(false);
    expect(looksLikeVideoRequest("make a video of a conference keynote")).toBe(true);
    expect(looksLikeVideoRequest("generate a movie scene set in a meeting room")).toBe(true);
    expect(looksLikeVideoRequest("schedule a conference meeting with Maya")).toBe(false);
  });

  it("uses the unified song classifier for vocal and instrumental routes", () => {
    expect(classifySongRequest("write me a song about finding home")).toBe("vocal");
    expect(classifySongRequest("make an instrumental reggae beat with bass")).toBe("instrumental");
    expect(classifySongRequest("make music with no vocals")).toBe("instrumental");
    expect(classifySongRequest("what song is playing?")).toBe(null);
    expect(classifySongRequest("start a video call with Maya")).toBe(null);
  });
});
