import { describe, it, expect } from "vitest";
import { admitSlot, canCancel, externalStatus, openForMatching, receiptNoFor, toBookingDTO, visibleStatuses, BOOK_HORIZON_DAYS, type BookingRow } from "./booking_logic";
import { priceFor } from "./pricing";

const NOW = 1_800_000_000_000;
const row = (o: Partial<BookingRow> = {}): BookingRow => ({
  id: "cb_0123456789abcdef0123", ref: "AFC-01234567", consultant_id: "cn_1", uid: "u", request_key: "k", discipline: "tarot",
  slot_start_ms: NOW + 5 * 3600e3, slot_end_ms: NOW + 5.5 * 3600e3, status: "held", rate_rupees: 1000, gst_rupees: 180, total_rupees: 1180,
  fee_rupees: 200, payout_rupees: 800, intake_json: "{}", questions_json: '["a"]', prep_status: "pending", pay_method: "upi",
  receiving_account_key: "acc", amount_paise: 117_950, rounding_discount_paise: 50, payer_reference: null, reference_revision: 0, reason_code: null,
  utr: null, paid_claimed_at: null, receipt_no: null, confirmed_at: null, expires_at: NOW + 600e3, created_at: NOW, updated_at: NOW, ...o,
});

describe("status helpers", () => {
  it("external status mirrors the shop rules", () => {
    expect(externalStatus(row(), NOW + 1000)).toBe("held");
    expect(externalStatus(row(), NOW + 601e3)).toBe("expired");
    expect(externalStatus(row({ paid_claimed_at: NOW }), NOW + 179e3)).toBe("held");
    expect(externalStatus(row({ paid_claimed_at: NOW }), NOW + 181e3)).toBe("awaiting_review");
    expect(externalStatus(row({ paid_claimed_at: NOW }), NOW + 900e3)).toBe("awaiting_review");
    expect(externalStatus(row({ status: "confirmed" }), NOW)).toBe("confirmed");
  });
  it("cancel + matching predicates", () => {
    expect(canCancel("held")).toBe(true);
    expect(canCancel("awaiting_review")).toBe(true);
    expect(canCancel("confirmed")).toBe(false);
    expect(canCancel("expired")).toBe(false);
    expect(openForMatching(row())).toBe(true);
    expect(openForMatching(row({ status: "awaiting_review" }))).toBe(true);
    expect(openForMatching(row({ status: "confirmed", confirmed_at: 1 }))).toBe(false);
    expect(openForMatching(row({ reason_code: "finalize_error" }))).toBe(false);
  });
  it("receipt number is derived from the id", () => {
    expect(receiptNoFor("cb_0123456789abcdef0123", Date.parse("2026-10-02T00:00:00Z"))).toBe("AR-2026-0123456789");
  });
});

describe("admitSlot", () => {
  const start = NOW + 3 * 3600e3;
  it("accepts a produced slot", () => { expect(admitSlot(start, NOW, [start])).toEqual({ ok: true }); });
  it("rejects past, too soon, too far, unproduced", () => {
    expect(admitSlot(NOW - 1, NOW, [NOW - 1])).toEqual({ ok: false, error: "slot_in_past" });
    expect(admitSlot(NOW + 3600e3, NOW, [NOW + 3600e3])).toEqual({ ok: false, error: "slot_too_soon" });
    const far = NOW + (BOOK_HORIZON_DAYS + 1) * 86_400_000;
    expect(admitSlot(far, NOW, [far])).toEqual({ ok: false, error: "slot_too_far" });
    expect(admitSlot(start, NOW, [start + 1800e3])).toEqual({ ok: false, error: "slot_unavailable" });
    expect(admitSlot(1.5, NOW, [])).toEqual({ ok: false, error: "slot_in_past" });
  });
});

describe("visibleStatuses", () => {
  it("dark: only previewers; public: only live", () => {
    expect(visibleStatuses(false, false)).toEqual([]);
    expect(visibleStatuses(false, true)).toEqual(["draft", "live"]);
    expect(visibleStatuses(true, true)).toEqual(["live"]);
    expect(visibleStatuses(true, false)).toEqual(["live"]);
  });
});

describe("toBookingDTO", () => {
  it("maps frozen prices and join window", () => {
    const d = toBookingDTO(row(), { slug: "s", name: "N", photo_url: "p" }, NOW);
    expect(d.price).toEqual(priceFor(1000));
    expect(d.join_opens_ms).toBe(row().slot_start_ms - 600e3);
    expect(d.questions).toEqual(["a"]);
    expect(d.status).toBe("held");
    expect(d.expires_at).toBe(NOW + 600e3);
  });
  it("tolerates bad questions json, hides expiry once confirmed", () => {
    const d = toBookingDTO(row({ questions_json: "{{", status: "confirmed" }), { slug: "s", name: "N", photo_url: "p" }, NOW);
    expect(d.questions).toEqual([]);
    expect(d.expires_at).toBeNull();
  });
});
