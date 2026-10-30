// [HF-DESK-CW-3] Cc / Bcc ride in headers_json as X-HF-Cc / X-HF-Bcc and must never be sent as headers.
import { describe, it, expect } from "vitest";
import { splitRecipientHeaders } from "./email_job";

describe("splitRecipientHeaders", () => {
  it("pulls Cc / Bcc out, keeps the other headers", () => {
    const r = splitRecipientHeaders({ "X-HF-Cc": "a@x.com, b@y.com", "X-HF-Bcc": "audit@z.com", "In-Reply-To": "<m@x>" });
    expect(r.cc).toEqual(["a@x.com", "b@y.com"]);
    expect(r.bcc).toEqual(["audit@z.com"]);
    expect(r.headers).toEqual({ "In-Reply-To": "<m@x>" });
  });
  it("drops anything that is not an address and caps at 10", () => {
    const many = Array.from({ length: 12 }, (_, i) => `u${i}@x.com`).join(",");
    const r = splitRecipientHeaders({ "x-hf-cc": `bad, ${many}` });
    expect(r.cc).toHaveLength(10);
    expect(r.cc).not.toContain("bad");
    expect(r.headers).toBeUndefined();
  });
  it("no headers -> nothing", () => {
    expect(splitRecipientHeaders(undefined)).toEqual({ cc: [], bcc: [], headers: undefined });
  });
});
