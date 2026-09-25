// [DASH2-API 2026-09-25] Pure rules of the customer dashboard.
import { describe, it, expect } from "vitest";
import {
  eventState, refundEligibility, normalizeVpa, encodeCursor, decodeCursor, maskE164,
  paymentStatus, rupeesParamToPaise, istTimeOfDay, nextReceiptNo, formatRupeesAscii,
  winAnsiSafe, validateProfilePatch, REFUND_WINDOW_MS,
} from "../src/lib/me_dashboard_logic";
import { coverImageUrl, shapeListing } from "../src/lib/me_dashboard_data";

const NOW = Date.UTC(2026, 8, 25, 6, 0, 0);
const ev = (over: Record<string, unknown>) => ({ kind: "live_event", status: "published", starts_at: NOW + 3_600_000, duration_min: 60, ...over });

describe("eventState (server-computed, listing_schedule is the authority)", () => {
  it("future published + paid -> upcoming", () => expect(eventState(ev({}), true, NOW).state).toBe("upcoming"));
  it("provider-confirmed live -> live", () => expect(eventState(ev({ status: "live", starts_at: NOW - 60_000 }), true, NOW).state).toBe("live"));
  it("start passed but not live yet -> still upcoming (never claims live)", () => {
    const r = eventState(ev({ starts_at: NOW - 60_000 }), true, NOW);
    expect(r.state).toBe("upcoming"); expect(r.schedule).toBe("starting");
  });
  it("past its end -> ended", () => expect(eventState(ev({ starts_at: NOW - 3 * 3_600_000 }), true, NOW).state).toBe("ended"));
  it("completed / cancelled -> ended", () => {
    expect(eventState(ev({ status: "completed" }), true, NOW).state).toBe("ended");
    expect(eventState(ev({ status: "cancelled" }), true, NOW).state).toBe("ended");
  });
  it("unpaid future -> pending_payment; unpaid ended -> ended", () => {
    expect(eventState(ev({}), false, NOW).state).toBe("pending_payment");
    expect(eventState(ev({ starts_at: NOW - 3 * 3_600_000 }), false, NOW).state).toBe("ended");
  });
  it("seconds-based legacy starts_at is normalised", () => {
    expect(eventState(ev({ starts_at: Math.floor((NOW + 3_600_000) / 1000) }), true, NOW).state).toBe("upcoming");
  });
  it("stuck live projection long after its end -> ended", () => {
    expect(eventState(ev({ status: "live", starts_at: NOW - 10 * 3_600_000 }), true, NOW).state).toBe("ended");
  });
});

describe("refundEligibility — the 24h rule", () => {
  it("paid and exactly 24h ahead -> ok", () => expect(refundEligibility({ status: "paid", eventStartsAt: NOW + REFUND_WINDOW_MS, now: NOW }).ok).toBe(true));
  it("paid and 24h minus 1ms -> refused", () => {
    const r = refundEligibility({ status: "paid", eventStartsAt: NOW + REFUND_WINDOW_MS - 1, now: NOW });
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error).toBe("refund_window_closed");
  });
  it("past event -> refused", () => expect(refundEligibility({ status: "paid", eventStartsAt: NOW - 1, now: NOW }).ok).toBe(false));
  it("pending / refund_requested / refunded -> refused with distinct codes", () => {
    const far = NOW + 3 * REFUND_WINDOW_MS;
    const codes = (["pending", "refund_requested", "refunded"] as const).map((s) => {
      const r = refundEligibility({ status: s, eventStartsAt: far, now: NOW }); return r.ok ? "ok" : r.error;
    });
    expect(codes).toEqual(["not_paid", "refund_already_requested", "already_refunded"]);
  });
  it("no start time -> refused", () => expect(refundEligibility({ status: "paid", eventStartsAt: null, now: NOW }).ok).toBe(false));
});

describe("paymentStatus", () => {
  it("folds refunds over the base status", () => {
    expect(paymentStatus("paid", null)).toBe("paid");
    expect(paymentStatus("paid", "requested")).toBe("refund_requested");
    expect(paymentStatus("paid", "refunded")).toBe("refunded");
    expect(paymentStatus("paid", "rejected")).toBe("paid");
    expect(paymentStatus("refunded", null)).toBe("refunded");
    expect(paymentStatus("pending", "requested")).toBe("pending");
  });
});

describe("normalizeVpa", () => {
  it.each(["name@okhdfc", "a.b-c_d@ybl", "9876543210@paytm", "  Mixed.Case@OKSBI "])("accepts %s", (v) => expect(normalizeVpa(v)).toBe(v.trim().toLowerCase()));
  it.each(["", "a@b", "x@", "@ybl", "name@ok1", "na me@ybl", "name@@ybl", "name@y-bl", 42, null])("rejects %s", (v) => expect(normalizeVpa(v)).toBeNull());
});

describe("cursor", () => {
  it("round-trips", () => {
    const c = { t: NOW, id: "cashfree-order:abc/+=" };
    const enc = encodeCursor(c);
    expect(enc).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(enc)).toEqual(c);
  });
  it("rejects garbage", () => {
    for (const bad of ["", "!!!", "e30", encodeCursor({ t: 1, id: "x" }).slice(0, 5), "W1wiYVwiXQ"]) expect(decodeCursor(bad)).toBeNull();
  });
});

describe("misc helpers", () => {
  it("masks +91 numbers like the spec example", () => expect(maskE164("+919812345210")).toBe("+91 98•••••210"));
  it("rupee params become paise", () => {
    expect(rupeesParamToPaise("250")).toBe(25000); expect(rupeesParamToPaise("1.5")).toBe(150);
    expect(rupeesParamToPaise("")).toBeNull(); expect(rupeesParamToPaise("-3")).toBeNull(); expect(rupeesParamToPaise(null)).toBeNull();
  });
  it("time-of-day uses IST", () => {
    expect(istTimeOfDay(Date.UTC(2026, 8, 25, 1, 0))).toBe("morning");   // 06:30 IST
    expect(istTimeOfDay(Date.UTC(2026, 8, 25, 8, 0))).toBe("afternoon"); // 13:30 IST
    expect(istTimeOfDay(Date.UTC(2026, 8, 25, 13, 0))).toBe("evening");  // 18:30 IST
  });
  it("receipt numbers", () => {
    expect(nextReceiptNo(2026, null)).toBe("SH-2026-000001");
    expect(nextReceiptNo(2026, "SH-2026-000122")).toBe("SH-2026-000123");
    expect(nextReceiptNo(2027, "SH-2026-000122")).toBe("SH-2027-000001");
  });
  it("rupee formatting (WinAnsi-safe)", () => {
    expect(formatRupeesAscii(150000)).toBe("Rs. 1,500");
    expect(formatRupeesAscii(123450)).toBe("Rs. 1,234.50");
  });
  it("winAnsiSafe drops undrawable glyphs", () => {
    expect(winAnsiSafe("₹500 — गणेश पूजा “Ganesh”")).toBe('Rs.500 - "Ganesh"');
  });
});

describe("shapeListing / cover image", () => {
  it("prefers the AI poster, else the first image", () => {
    expect(coverImageUrl('[{"type":"image","url":"/a.jpg"},{"type":"image","url":"/p.jpg","source":"ai_poster"}]')).toBe("/p.jpg");
    expect(coverImageUrl('[{"type":"video","url":"/v.mp4"},{"type":"image","r2_key":"k/1.jpg"}]')).toBe("k/1.jpg");
    expect(coverImageUrl("not json")).toBeNull();
  });
  it("maps price rupees -> paise and builds the checkout URL", () => {
    const l = shapeListing({ id: "L1", title: "Havan", category: "puja", price: 501, starts_at: NOW, status: "published", attrs: '{"deity":"Ganesh"}', capacity: 10, seats_taken: 3 });
    expect(l.price_paise).toBe(50100); expect(l.book_url).toBe("/book/L1"); expect(l.deity).toBe("Ganesh"); expect(l.seats_left).toBe(7);
    expect(shapeListing({ id: "L2", price: 99, free_entry: 1 }).price_paise).toBe(0);
  });
});

describe("validateProfilePatch", () => {
  it("accepts a partial patch", () => {
    const r = validateProfilePatch({ gotra: " Kashyap ", notify: { push: true }, family: ["Asha", { name: "Ravi", relation: "son" }] });
    expect("patch" in r && r.patch).toEqual({ gotra: "Kashyap", notify: { push: true }, family: ["Asha", { name: "Ravi", relation: "son" }] });
  });
  it("rejects bad Indian PIN, non-boolean notify, empty name", () => {
    expect("invalid" in validateProfilePatch({ address: { line1: "x", pin: "12345", country: "India" } })).toBe(true);
    expect("invalid" in validateProfilePatch({ notify: { email: "yes" } })).toBe(true);
    expect("invalid" in validateProfilePatch({ name: "  " })).toBe(true);
  });
});

describe("receipt PDF", () => {
  it("renders an A4 PDF even with non-WinAnsi text (Devanagari, ₹)", async () => {
    const { renderReceiptPdf } = await import("../src/lib/me_receipt_pdf");
    const bytes = await renderReceiptPdf({
      receiptNo: "SH-2026-000001", issuedAt: NOW,
      billedTo: { name: "आशा Sharma", email: "a@example.com", address: ["1 MG Road", "Mumbai, MH, 400001", "India"] },
      item: { title: "गणेश पूजा — Ganesh Puja ₹501", startsAt: NOW + 3_600_000, durationMin: 60 },
      amountPaise: 62700, paidAt: NOW, utr: "512345678901", payerVpa: null, paymentId: "i1", orderId: "o1",
      status: "REFUNDED", refund: { amountPaise: 62700, utr: "REF123456", at: NOW },
    });
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    expect(bytes.byteLength).toBeGreaterThan(1000);
  });
});
