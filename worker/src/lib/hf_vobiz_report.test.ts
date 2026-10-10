// [HF-VOBIZ-SPEND-1] Report lane: CSV escaping, PDF validity/pagination, IST helpers, which-reports-are-due.
import { describe, it, expect } from "vitest";
import {
  renderLegsCsv, renderReportPdf, csvCell, rs, istDayStart, istDateStr, istMonthStart, parseIstDate, formatIstFull, reportsDue,
  canonicalJson, reportDataSha, splitCsvText, packParts, PDF_LEG_CAP, type ReportData, type LegRow,
} from "./hf_vobiz_report";

const T = (iso: string) => Date.parse(iso);

function leg(i: number, over: Partial<LegRow> = {}): LegRow {
  const end = T("2026-10-10T08:35:09Z") + i * 1000; // 14:05:09 IST
  return {
    seq: i + 1, legUuid: `11111111-2222-3333-4444-${String(i).padStart(12, "0")}`, callId: `call-${String(i).padStart(8, "0")}-aaaa`, role: i % 2 ? "caller" : "host",
    userUid: `u${i % 7}`, userName: `Person ${i % 7}`, userPhone: "+919876543210", callerUid: "u1", direction: "outbound", from: "+911234567890", to: "+919876543210",
    startAt: end - 60_000, answerAt: end - 55_000, endAt: end, durationSec: 60, billsec: 55, costPaise: 1234, streamingCostPaise: 0, totalCostPaise: 1234,
    hangupCause: "NORMAL_CLEARING", hangupSource: "Caller", mos: 4.2, source: "cdr", cdrCheckedAt: end + 100_000, mismatch: null, createdAt: end, ...over,
  };
}
function data(legs: LegRow[]): ReportData {
  return {
    meta: { id: "00000000-0000-4000-8000-000000000001", generatedAt: T("2026-10-10T18:30:00Z"), brand: "Hello Fraands" },
    period: { from: T("2026-10-09T18:30:00Z"), to: T("2026-10-10T18:29:59Z"), userUid: null, userName: null },
    totals: { legs: legs.length, billsec: legs.length * 55, costPaise: legs.length * 1234, streamingCostPaise: 0, unknownLegs: 1, unknownCostPaise: 1234, pendingCdr: 0, mismatches: 0 },
    money: { reconciled: true, note: null, openingPaise: 100000, openingAt: 1, closingPaise: 90000, closingAt: 2, rechargePaise: 0, callCostPaise: 10000, expectedClosingPaise: 90000, unexplainedPaise: 0 },
    days: [{ day: "2026-10-10", legs: legs.length, billsec: legs.length * 55, costPaise: legs.length * 1234, rechargePaise: 0 }],
    users: [{ uid: "u1", name: "Asha ₹ Kumar", phone: "+919876543210", asCaller: { calls: 1, billsec: 55, costPaise: 1234 }, asHost: { calls: 0, billsec: 0, costPaise: 0 }, paidPaise: 2000, vobizCostPaise: 2468, diffPaise: -468 }],
    legs, balances: [{ at: 1, balancePaise: 100000, availablePaise: 100000, ok: true }], balanceTicks: 1, failedTicks: 0,
    recharges: [], alerts: [{ id: "a1", kind: "low_balance", severity: "warn", message: "Balance is low — under Rs 500", amountPaise: 40000, createdAt: 5, ackedAt: null }],
    chain: [{ table: "hf_vobiz_legs", ok: true, rows: legs.length, brokenAt: null }],
  };
}

describe("IST + money helpers", () => {
  it("formats times in IST with seconds", () => {
    expect(formatIstFull(T("2026-10-10T08:35:09Z"))).toBe("10 Oct 2026 14:05:09 IST");
    expect(formatIstFull(null)).toBe("-");
  });
  it("day / month boundaries are IST", () => {
    const ms = T("2026-10-10T20:00:00Z"); // 11 Oct 01:30 IST
    expect(istDateStr(ms)).toBe("2026-10-11");
    expect(istDayStart(ms)).toBe(T("2026-10-10T18:30:00Z"));
    expect(istMonthStart(T("2026-10-01T18:29:00Z"))).toBe(T("2026-09-30T18:30:00Z")); // 23:59 IST on 1 Oct
    expect(istMonthStart(T("2026-10-15T00:00:00Z"), 1)).toBe(T("2026-08-31T18:30:00Z"));
  });
  it("parseIstDate accepts real dates only", () => {
    expect(parseIstDate("2026-10-10")).toBe(T("2026-10-09T18:30:00Z"));
    expect(parseIstDate("2026-02-30")).toBeNull();
    expect(parseIstDate("10-10-2026")).toBeNull();
  });
  it("rupees are ascii with two decimals", () => {
    expect(rs(1234)).toBe("Rs 12.34");
    expect(rs(5)).toBe("Rs 0.05");
    expect(rs(12345678)).toBe("Rs 1,23,456.78");
    expect(rs(-250)).toBe("-Rs 2.50");
    expect(rs(null)).toBe("-");
  });
  it("canonical json sorts keys so the hash is stable", async () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe('{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}');
    const a = data([leg(1)]); const b = { ...a, meta: { ...a.meta, id: "other", generatedAt: 5 } };
    expect(await reportDataSha(a)).toBe(await reportDataSha(b)); // meta is not part of the data hash
    expect(await reportDataSha(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("renderLegsCsv", () => {
  it("escapes commas, quotes, newlines and formula starts", () => {
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell("a\nb")).toBe('"a\nb"');
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell(null)).toBe("");
    expect(csvCell(0)).toBe("0");
  });
  it("one header + one row per leg, money as plain rupees, times IST", () => {
    const csv = renderLegsCsv(data([leg(1, { userName: 'Ravi, "R" Kumar', mismatch: "total differs", cdrCheckedAt: null })]));
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0].startsWith("seq,vobiz_leg_uuid,our_call_id,role")).toBe(true);
    expect(csv).toContain('"Ravi, ""R"" Kumar"');
    expect(csv).toContain("12.34,0.00,12.34");
    expect(csv).toContain("10 Oct 2026 14:05:10 IST");
    expect(csv).toContain(",pending,total differs");
    expect(csv.endsWith("\r\n")).toBe(true);
  });
  it("has no cap: 25,000 legs give 25,001 lines", () => {
    const legs = Array.from({ length: PDF_LEG_CAP + 5000 }, (_, i) => leg(i));
    expect(renderLegsCsv(data(legs)).trimEnd().split("\r\n")).toHaveLength(legs.length + 1);
  });
});

describe("renderReportPdf", () => {
  it("produces a valid multi-page PDF for a few hundred legs, even with characters Helvetica cannot draw", async () => {
    const legs = Array.from({ length: 300 }, (_, i) => leg(i, i === 3 ? { userName: "हिन्दी ₹ name" } : {}));
    const bytes = await renderReportPdf(data(legs));
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    expect(new TextDecoder().decode(bytes.slice(-6))).toContain("%%EOF");
    const { PDFDocument } = await import("pdf-lib");
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThan(3);
    const first = pdf.getPage(0).getSize();
    expect(first.width).toBeGreaterThan(first.height); // landscape
  });
  it("a tiny report still renders (one leg, no balances)", async () => {
    const d = data([leg(0)]); d.balances = []; d.alerts = []; d.users = []; d.days = [];
    const bytes = await renderReportPdf(d);
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("%PDF");
  });
});

describe("reportsDue", () => {
  const keys = (now: number) => reportsDue(now).map((r) => `${r.kind}:${r.key}`);
  it("before 23:55 IST only yesterday's catch-up is a candidate", () => {
    expect(keys(T("2026-10-10T18:00:00Z"))).toEqual(["daily:2026-10-09"]); // 23:30 IST on 10 Oct
  });
  it("from 23:55 IST the ending day is due", () => {
    const now = T("2026-10-10T18:25:00Z"); // 23:55 IST 10 Oct
    const r = reportsDue(now);
    expect(r.map((x) => x.key)).toEqual(["2026-10-09", "2026-10-10"]);
    const today = r[1];
    expect(today.from).toBe(T("2026-10-09T18:30:00Z"));
    expect(today.to).toBe(T("2026-10-10T18:29:59.999Z"));
    expect(today.label).toBe("10 Oct 2026");
  });
  it("00:30 IST next day: yesterday (the day that just ended) is the candidate", () => {
    expect(keys(T("2026-10-10T19:00:00Z"))).toEqual(["daily:2026-10-10"]);
  });
  it("monthly: the 1st before 00:10 IST is not due, after it the previous month is", () => {
    expect(keys(T("2026-10-31T18:35:00Z")).some((k) => k.startsWith("monthly"))).toBe(false); // 00:05 IST 1 Nov
    const after = reportsDue(T("2026-10-31T18:45:00Z")).find((r) => r.kind === "monthly")!; // 00:15 IST 1 Nov
    expect(after.key).toBe("2026-10");
    expect(after.from).toBe(T("2026-09-30T18:30:00Z"));
    expect(after.to).toBe(T("2026-10-31T18:29:59.999Z"));
    expect(after.label).toBe("Oct 2026");
  });
  it("monthly catches up until the 3rd, then stops", () => {
    expect(reportsDue(T("2026-11-02T06:00:00Z")).some((r) => r.kind === "monthly")).toBe(true);
    expect(reportsDue(T("2026-11-04T06:00:00Z")).some((r) => r.kind === "monthly")).toBe(false);
  });
  it("January rolls back to December of the previous year", () => {
    const r = reportsDue(T("2027-01-01T06:00:00Z")).find((x) => x.kind === "monthly")!;
    expect(r.key).toBe("2026-12");
  });
});

describe("email splitting", () => {
  it("small CSV is untouched; big CSV splits at row boundaries with the header repeated and nothing lost", () => {
    const small = "a,b\n1,2\n";
    expect(splitCsvText(small, 1000)).toEqual([small]);
    const rows = Array.from({ length: 200 }, (_, i) => `${i},"multi\nline ${i}",x`);
    const csv = ["id,note,z", ...rows].join("\n") + "\n";
    const chunks = splitCsvText(csv, 800);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) { expect(c.startsWith("id,note,z\n")).toBe(true); expect(Math.ceil(new TextEncoder().encode(c).length / 3) * 4).toBeLessThanOrEqual(800); }
    const joined = chunks.map((c, i) => (i === 0 ? c : c.slice("id,note,z\n".length))).join("");
    expect(joined).toBe(csv);
  });
  it("packs attachments in order within the budget; an oversize one gets its own email", () => {
    const a = (n: string, len: number) => ({ name: n, content: "x".repeat(len) });
    const parts = packParts([a("p", 60), a("c1", 50), a("c2", 30), a("big", 500), a("c3", 10)], 100);
    expect(parts.map((p) => p.map((x) => x.name))).toEqual([["p"], ["c1", "c2"], ["big"], ["c3"]]);
  });
  it("summary PDF omits the leg table and is much smaller", async () => {
    const d = data(Array.from({ length: 400 }, (_, i) => leg(i)));
    const full = await renderReportPdf(d), sum = await renderReportPdf(d, { summary: true });
    expect(sum.length).toBeLessThan(full.length);
    const { PDFDocument } = await import("pdf-lib");
    expect((await PDFDocument.load(sum)).getPageCount()).toBeLessThan(5);
  });
});
