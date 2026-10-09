import { describe, it, expect } from "vitest";
import { hfR2Prefixes, buildDeleteSql, hfPurgeTables, tsMsExpr, HF_UID_SAFE, purgeHfUser } from "./hf_purge";
import { UID_R2_SAFE } from "./deletion_prefixes";

describe("hf_purge helpers", () => {
  it("uid guard matches the shared R2 guard", () => {
    expect(HF_UID_SAFE.source).toBe(UID_R2_SAFE.source);
    expect(HF_UID_SAFE.flags).toBe(UID_R2_SAFE.flags);
  });
  it("builds trailing-slash prefixes in the right buckets", () => {
    expect(hfR2Prefixes("user_2abc")).toEqual({
      verification: ["hf/kyc/user_2abc/", "hf/selfie/user_2abc/", "hf/intro/user_2abc/"],
      blobs: ["hf/hosts/user_2abc/"],
    });
    expect(hfR2Prefixes("user_2abc", "lane_caller")).toEqual({ verification: ["hf/kyc/user_2abc/", "hf/selfie/user_2abc/"], blobs: [] });
  });
  it("refuses empty, short, wildcard and path-climbing uids", () => {
    for (const bad of ["", "ab", "a/b/c/d", "../x1234", "user_2abc/", "us er", "x".repeat(129)]) {
      expect(hfR2Prefixes(bad)).toEqual({ verification: [], blobs: [] });
    }
  });
  it("never targets the shared avatar catalogue", () => {
    const p = hfR2Prefixes("user_2abc");
    for (const x of [...p.verification, ...p.blobs]) expect(x.startsWith("hf/avatars")).toBe(false);
  });
  it("buildDeleteSql uses only existing columns", () => {
    expect(buildDeleteSql("hf_lane_access", ["id", "caller_uid", "host_uid"], ["caller_uid", "host_uid", "uid"]))
      .toBe("DELETE FROM hf_lane_access WHERE caller_uid=?1 OR host_uid=?1");
    expect(buildDeleteSql("hf_calls", [], ["caller_uid"])).toBeNull();
    expect(buildDeleteSql("hf_calls", ["x"], ["caller_uid"])).toBeNull();
    expect(buildDeleteSql("users", ["uid"], ["uid"])).toBeNull();
    expect(buildDeleteSql("hf_a; DROP", ["uid"], ["uid"])).toBeNull();
  });
  it("statement list: full vs lane_caller vs safety", () => {
    const full = hfPurgeTables("full").map((t) => t.table);
    expect(full).toEqual(expect.arrayContaining(["hf_hosts", "hf_kyc", "hf_selfie", "hf_payout", "hf_kyc_otp", "hf_host_media", "hf_media_jobs", "hf_lane_access", "hf_reviews"]));
    expect(full).not.toContain("hf_calls");
    expect(full).not.toContain("hf_incidents");
    expect(full).not.toContain("hf_blocks");
    expect(hfPurgeTables("full", true).map((t) => t.table)).toEqual(expect.arrayContaining(["hf_calls", "hf_incidents", "hf_blocks"]));
    expect(hfPurgeTables("lane_caller").map((t) => t.table)).toEqual(["hf_lane_access", "hf_selfie", "hf_kyc"]);
    expect(hfPurgeTables("full").filter((t) => t.anchor).map((t) => t.table)).toEqual(["hf_kyc", "hf_hosts"]);
  });
  it("tsMsExpr normalises seconds to ms", () => {
    expect(tsMsExpr("created_at")).toContain("created_at * 1000");
  });
  it("refuses an unsafe uid without touching anything", async () => {
    const env = { DB_META: { prepare() { throw new Error("must not be called"); } } } as any;
    const r = await purgeHfUser(env, "../x");
    expect(r.errors).toEqual(["unsafe_uid"]);
  });
});
