import { describe, it, expect, vi } from "vitest";
import type { Env } from "../types";

vi.mock("../routes/config", () => ({ readConfig: vi.fn(async (env: { __pub?: boolean }) => ({ guidesPublic: env.__pub === true })) }));
import { isPreviewer, canSeeGuides, isAdminUid, previewerUidsRaw } from "./preview";

const mk = (o: Record<string, unknown>) => o as unknown as Env;

describe("preview gate", () => {
  it("admin and agent-admin uids are previewers, trimmed, comma or space separated", () => {
    const env = mk({ ADMIN_UIDS: "a1, a2", AGENT_ADMIN_UIDS: "g1 g2" });
    for (const u of ["a1", "a2", "g1", "g2"]) expect(isPreviewer(env, u)).toBe(true);
    expect(isPreviewer(env, "x")).toBe(false);
    expect(isPreviewer(env, "")).toBe(false);
    expect(isAdminUid(env, "g1")).toBe(false);
    expect(isAdminUid(env, "a2")).toBe(true);
    expect(previewerUidsRaw(mk({}))).toBe("");
  });
  it("canSeeGuides: public flag opens to all, else previewers only", async () => {
    const env = mk({ ADMIN_UIDS: "a1" });
    expect(await canSeeGuides(env, "a1")).toBe(true);
    expect(await canSeeGuides(env, "u9")).toBe(false);
    expect(await canSeeGuides(env, null)).toBe(false);
    const pub = mk({ ADMIN_UIDS: "a1", __pub: true });
    expect(await canSeeGuides(pub, null)).toBe(true);
  });
});
