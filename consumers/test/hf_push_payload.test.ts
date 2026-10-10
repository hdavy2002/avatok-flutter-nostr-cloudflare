// [HF-APP-4] The FCM payload for an HF app push: visible notification, channel, deep-link path.
import { describe, it, expect } from "vitest";
import { buildHfPayload, hfSafePath, HF_PUSH_CHANNEL } from "../src/fcm";

describe("buildHfPayload", () => {
  it("carries a notification block, the channel and the path in data", () => {
    const p = buildHfPayload({ kind: "hf_push", to: "u1", hfKind: "notify_me", title: "Priya is online", body: "You can call now.", path: "/h/priya" });
    expect(p.notification).toEqual({ title: "Priya is online", body: "You can call now." });
    expect(p.channelId).toBe(HF_PUSH_CHANNEL);
    expect(p.highPriority).toBe(true);
    expect(p.data).toEqual({ type: "hf_push", kind: "notify_me", path: "/h/priya", title: "Priya is online", body: "You can call now." });
  });
  it("falls back to / for an unsafe path", () => {
    for (const bad of ["https://evil.example", "//evil.example", "javascript:1", undefined]) {
      expect(buildHfPayload({ kind: "hf_push", to: "u1", hfKind: "low_balance", title: "t", body: "b", path: bad as string }).data.path).toBe("/");
    }
    expect(hfSafePath("/wallet")).toBe("/wallet");
  });
  it("strips odd characters from the kind", () => {
    expect(buildHfPayload({ kind: "hf_push", to: "u1", hfKind: "Bad Kind!", title: "t", body: "b", path: "/" }).data.kind).toBe("adind");
  });
});
