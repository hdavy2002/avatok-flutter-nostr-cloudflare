// [HF-APP-4] Token validation, deep-link path safety and push copy / job building.
import { describe, it, expect } from "vitest";
import { validPushToken, cleanShell, safePushPath, hfPushCopy, buildHfPushJob, HF_PUSH_KINDS } from "./hf_push_pure";

const GOOD = "dQw4w9WgXcQ:APA91bH" + "x".repeat(140);

describe("validPushToken", () => {
  it("accepts a normal FCM-shaped token", () => expect(validPushToken(GOOD)).toBe(true));
  it("rejects short, long, spaced and non-string values", () => {
    expect(validPushToken("abc")).toBe(false);
    expect(validPushToken("a".repeat(5000))).toBe(false);
    expect(validPushToken(GOOD + " x")).toBe(false);
    expect(validPushToken(GOOD + "<script>")).toBe(false);
    expect(validPushToken(null)).toBe(false);
    expect(validPushToken(12345)).toBe(false);
  });
});

describe("cleanShell", () => {
  it("keeps a version and strips junk", () => {
    expect(cleanShell("1")).toBe("1");
    expect(cleanShell(2)).toBe("2");
    expect(cleanShell("1.0; DROP")).toBe("1.0DROP");
    expect(cleanShell({})).toBe("");
    expect(cleanShell("x".repeat(50)).length).toBe(20);
  });
});

describe("safePushPath", () => {
  it("allows same-site relative paths", () => {
    expect(safePushPath("/h/priya")).toBe("/h/priya");
    expect(safePushPath("/review/abc_DEF-1")).toBe("/review/abc_DEF-1");
    expect(safePushPath("/wallet")).toBe("/wallet");
  });
  it("blocks other sites, schemes, admin and control characters", () => {
    for (const bad of ["//evil.example", "https://evil.example", "javascript:alert(1)", "h/x", "/\\evil", "/a\nb", "/admin", "/admin/users", "", "/" + "a".repeat(400)]) {
      expect(safePushPath(bad)).toBeNull();
    }
    expect(safePushPath(5)).toBeNull();
  });
});

describe("hfPushCopy + buildHfPushJob", () => {
  it("builds all seven kinds with a safe path, a title and a body", () => {
    for (const k of HF_PUSH_KINDS) {
      const m = hfPushCopy(k, "Brand", { name: "Priya", slug: "priya", token: "tok123", rupees: 500 });
      const job = buildHfPushJob("uid_1234", m);
      expect(job).not.toBeNull();
      expect(job!.kind).toBe("hf_push");
      expect(job!.hfKind).toBe(k);
      expect(job!.to).toBe("uid_1234");
    }
  });
  it("sends notify_me to the host profile and review_request to the review page", () => {
    expect(hfPushCopy("notify_me", "Brand", { name: "Priya", slug: "priya" }).path).toBe("/h/priya");
    expect(hfPushCopy("review_request", "Brand", { name: "Priya", token: "tok" }).path).toBe("/review/tok");
  });
  it("refuses unknown kinds, unsafe paths and empty copy", () => {
    expect(buildHfPushJob("u", { kind: "nope", title: "t", body: "b", path: "/" })).toBeNull();
    expect(buildHfPushJob("u", { kind: "low_balance", title: "t", body: "b", path: "//x" })).toBeNull();
    expect(buildHfPushJob("u", { kind: "low_balance", title: " ", body: "b", path: "/" })).toBeNull();
    expect(buildHfPushJob("", { kind: "low_balance", title: "t", body: "b", path: "/" })).toBeNull();
  });
  it("clips long copy", () => {
    const j = buildHfPushJob("u", { kind: "low_balance", title: "t".repeat(200), body: "b".repeat(500), path: "/wallet" })!;
    expect(j.title.length).toBeLessThanOrEqual(60);
    expect(j.body.length).toBeLessThanOrEqual(160);
  });
});
