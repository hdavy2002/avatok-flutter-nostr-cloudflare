import { describe, expect, it } from "vitest";
import { isPlaceholderEmail, placeholderEmailFor, realEmailOrNull } from "./placeholder_email";
import { BRAND } from "./brand";

describe("[HF-WIRE-17] placeholder email", () => {
  it("is unique per external id and on the no-mail subdomain", () => {
    const a = placeholderEmailFor("hfwa_ABC123xyz");
    expect(a).toBe(`wa-hfwa_abc123xyz@noemail.${BRAND.domain}`);
    expect(placeholderEmailFor("hfwa_other")).not.toBe(a);
  });
  it("is never treated as a real address", () => {
    expect(isPlaceholderEmail(placeholderEmailFor("hfwa_1"))).toBe(true);
    expect(realEmailOrNull(placeholderEmailFor("hfwa_1"))).toBeNull();
    expect(realEmailOrNull("fan@example.com")).toBe("fan@example.com");
    expect(isPlaceholderEmail(`someone@${BRAND.domain}`)).toBe(false);
    expect(realEmailOrNull(null)).toBeNull();
  });
});
