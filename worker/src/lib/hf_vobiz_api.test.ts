import { describe, it, expect } from "vitest";
import { parseCdr, rupeesToPaise, parseTimeMs } from "./hf_vobiz_api";

const flat = { uuid: "u-1", call_direction: "outbound", caller_id_number: "+911", destination_number: "+912", start_time: "2026-10-10 06:00:00",
  answer_time: "2026-10-10T06:00:05+05:30", end_time: "2026-10-10 06:01:00", duration: "60", billsec: 55, cost: "0.285", streaming_cost: 0.1,
  total_cost: 0.385, currency: "INR", hangup_cause: "NORMAL_CLEARING", hangup_source: "Caller", mos: "4.2" };

describe("hf_vobiz_api", () => {
  it("converts rupees to paise", () => {
    expect(rupeesToPaise("0.285")).toBe(29);
    expect(rupeesToPaise(1.1)).toBe(110);
    expect(rupeesToPaise(0.29)).toBe(29);
    expect(rupeesToPaise(null)).toBeNull();
    expect(rupeesToPaise("abc")).toBeNull();
  });
  it("parses times, zoneless as UTC", () => {
    expect(parseTimeMs("2026-10-10 06:00:00")).toBe(Date.UTC(2026, 9, 10, 6, 0, 0));
    expect(parseTimeMs("2026-10-10T06:00:05+05:30")).toBe(Date.UTC(2026, 9, 10, 0, 30, 5));
    expect(parseTimeMs("garbage")).toBeNull();
    expect(parseTimeMs("")).toBeNull();
  });
  it("parses a flat CDR", () => {
    const c = parseCdr(flat)!;
    expect(c.uuid).toBe("u-1");
    expect(c.costPaise).toBe(29);
    expect(c.streamingCostPaise).toBe(10);
    expect(c.totalCostPaise).toBe(39);
    expect(c.durationSec).toBe(60);
    expect(c.billsec).toBe(55);
    expect(c.startAt).toBe(Date.UTC(2026, 9, 10, 6, 0, 0));
    expect(c.mos).toBe(4.2);
    expect(c.from).toBe("+911");
  });
  it("parses nested shapes", () => {
    expect(parseCdr({ data: flat })!.uuid).toBe("u-1");
    expect(parseCdr({ success: true, data: { cdr: flat } })!.uuid).toBe("u-1");
    expect(parseCdr({ objects: [flat] })!.uuid).toBe("u-1");
    expect(parseCdr({ object: flat })!.uuid).toBe("u-1");
    expect(parseCdr([flat])!.uuid).toBe("u-1");
    expect(parseCdr({ call_uuid: "x9" })!.uuid).toBe("x9");
  });
  it("returns null on junk", () => {
    expect(parseCdr(null)).toBeNull();
    expect(parseCdr({ data: [] })).toBeNull();
    expect(parseCdr({ foo: 1 })).toBeNull();
    expect(parseCdr("x")).toBeNull();
  });
});
