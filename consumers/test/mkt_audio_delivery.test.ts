import { describe, expect, it } from "vitest";
import { mktAudioMessageId, mktResultMessageId } from "../src/mkt_audio";

describe("marketplace audio delivery identity", () => {
  it("uses the stable artifact id for queue retries", () => {
    expect(mktAudioMessageId("mktdeal:neg-123:v1")).toBe("mktdeal:neg-123:v1:audio");
    expect(mktAudioMessageId("mktdeal:neg-123:v1")).toBe(mktAudioMessageId("mktdeal:neg-123:v1"));
  });

  it("enriches the result row in-place", () => {
    expect(mktResultMessageId("mktdeal:neg-123:v1")).toBe("mktdeal:neg-123:v1:result");
    expect(mktResultMessageId("mktdeal:neg-123:v1")).not.toBe(mktAudioMessageId("mktdeal:neg-123:v1"));
  });
});
