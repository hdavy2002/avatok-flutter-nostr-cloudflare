import { beforeAll, describe, expect, it, vi } from "vitest";

describe("HF reference wallet catalogue migration", () => {
  let sql: string;
  beforeAll(async () => {
    // Vite loads the actual migration as text without adding Node types to the Worker.
    const migration = await vi.importActual<{ default: string }>(
      "../../migrations/2026-10-12-hf-wallet-reference-packs.sql?raw",
    );
    sql = migration.default;
  });

  it("adds fixed 360 and 500 rupee Play products", () => {
    expect(sql).toContain("'hf_rupees_360', 360, 'gp-r2', 1, 36000");
    expect(sql).toContain("'hf_rupees_500', 500, 'gp-r2', 1, 50000");
  });

  it("removes superseded fixed packs instead of accepting arbitrary input", () => {
    expect(sql).toContain("'hf_rupees_600', 'hf_rupees_1200'");
    expect(sql).not.toContain("hf_rupees_custom");
  });
});
