import { describe, expect, it } from "vitest";
import { categoryFor, directionFor, labelFor } from "../src/routes/wallet_statement";

describe("wallet statement permanent visibility policy", () => {
  it("classifies unknown future transaction types by signed amount", () => {
    expect(directionFor("future_debit_type", -3)).toBe("spend");
    expect(directionFor("future_credit_type", 3)).toBe("earn");
    expect(directionFor("future_bookkeeping_type", 0)).toBe("other");
  });

  it("never mislabels metered AI capabilities as marketplace activity", () => {
    expect(categoryFor("ai_image_generate")).toBe("ava");
    expect(categoryFor("ai_media_image_generate")).toBe("ava");
    expect(labelFor("ai_settle", "ai_image_generate", -5)).toBe("AI image generation");
    expect(labelFor("ai_settle", "ai_ava_thread_tools", -2)).toBe("Ava thread tools");
  });

  it("keeps known adjustment credits visible as incoming money", () => {
    expect(directionFor("adjustment", 100)).toBe("earn");
  });
});
