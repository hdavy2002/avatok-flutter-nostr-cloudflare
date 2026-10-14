import { describe, expect, it } from "vitest";
import { instantBookingOverlapGuardSql } from "./hf_calls";

describe("instant booking overlap SQL bind layout", () => {
  it("uses guard binds 8 through 12 after the seven legacy insert values", () => {
    const sql = instantBookingOverlapGuardSql(8);
    expect(sql).toContain("?8=0");
    expect(sql).toContain("b.host_uid IN (?9,?10)");
    expect(sql).toContain("<?12");
    expect(sql).toContain(">?11");
  });
  it("uses guard binds 13 through 17 after the twelve token insert values", () => {
    const sql = instantBookingOverlapGuardSql(13);
    expect(sql).toContain("?13=0");
    expect(sql).toContain("b.host_uid IN (?14,?15)");
    expect(sql).toContain("<?17");
    expect(sql).toContain(">?16");
  });

  it("rejects invalid bind offsets", () => {
    expect(() => instantBookingOverlapGuardSql(0)).toThrow();
  });
});
