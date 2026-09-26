import { describe, it, expect } from "vitest";
import {
  computeGstRupees, computeQuote, validateAddress, validateSankalp, normalizeUtr,
  addressLocked, externalStatus, MAX_CHADHAVA_QTY, MAX_DAKSHINA_RUPEES,
  dueForReminder, normalizeStartsAtMs, REMINDER_LEAD_MS,
  type ListingSnapshot, type ChadhavaCatalogItem,
} from "../src/lib/saathum_checkout_logic";

const listing: ListingSnapshot = {
  id: "l1", title: "Ganesh Havan", price_rupees: 501, visibility: "public",
  prasad_available: true, prasad_price_rupees: 99, starts_at: 2_000_000_000_000, duration_min: 60,
};
const catalog: ChadhavaCatalogItem[] = [
  { id: "chadhava-marigold-garland", title: "Marigold garland", description: null, price_rupees: 51, image_url: null },
  { id: "chadhava-havan-samagri", title: "Havan wood & samagri", description: null, price_rupees: 101, image_url: null },
];

describe("computeGstRupees", () => {
  it("rounds half up to the nearest rupee", () => {
    expect(computeGstRupees(100, 18)).toBe(18);
    expect(computeGstRupees(99, 18)).toBe(18); // 17.82 -> 18
    expect(computeGstRupees(25, 18)).toBe(5); // 4.5 -> 5 (round half up, not banker's)
    expect(computeGstRupees(5, 18)).toBe(1); // 0.9 -> 1
  });
  it("is zero when disabled or subtotal is zero", () => {
    expect(computeGstRupees(0, 18)).toBe(0);
    expect(computeGstRupees(100, 0)).toBe(0);
  });
  it("never returns a negative or non-integer result on bad input", () => {
    expect(computeGstRupees(-5, 18)).toBe(0);
    expect(computeGstRupees(100, -1)).toBe(0);
  });
});

describe("computeQuote", () => {
  const base = { listing, chadhavaCatalog: catalog, gstEnabled: true, gstRatePct: 18 };

  it("prices a ticket-only cart with GST", () => {
    const q = computeQuote({ ...base, chadhava: [], dakshinaRupees: 0, prasad: false });
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    expect(q.value.subtotal_rupees).toBe(501);
    expect(q.value.gst_rupees).toBe(computeGstRupees(501, 18));
    expect(q.value.total_rupees).toBe(501 + q.value.gst_rupees);
    expect(q.value.lines).toHaveLength(1);
  });

  it("adds chadhava, dakshina and prasad lines from server-side prices", () => {
    const q = computeQuote({
      ...base,
      chadhava: [{ id: "chadhava-marigold-garland", qty: 2 }, { id: "chadhava-havan-samagri", qty: 1 }],
      dakshinaRupees: 251, prasad: true,
    });
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    // ticket 501 + garland 51*2=102 + samagri 101 + dakshina 251 + prasad 99
    expect(q.value.subtotal_rupees).toBe(501 + 102 + 101 + 251 + 99);
    expect(q.value.lines.map((l) => l.kind)).toEqual(["ticket", "chadhava", "chadhava", "dakshina", "prasad"]);
  });

  it("ignores a zero-qty chadhava line entirely", () => {
    const q = computeQuote({ ...base, chadhava: [{ id: "chadhava-marigold-garland", qty: 0 }], dakshinaRupees: 0, prasad: false });
    expect(q.ok).toBe(true);
    if (q.ok) expect(q.value.lines).toHaveLength(1);
  });

  it("computes zero GST when disabled, even with gstRatePct set", () => {
    const q = computeQuote({ ...base, gstEnabled: false, chadhava: [], dakshinaRupees: 0, prasad: false });
    expect(q.ok).toBe(true);
    if (q.ok) { expect(q.value.gst_rupees).toBe(0); expect(q.value.total_rupees).toBe(501); }
  });

  it("rejects chadhava qty above the bound", () => {
    const q = computeQuote({ ...base, chadhava: [{ id: "chadhava-marigold-garland", qty: MAX_CHADHAVA_QTY + 1 }], dakshinaRupees: 0, prasad: false });
    expect(q.ok).toBe(false);
    if (!q.ok) expect(q.field).toBe("chadhava");
  });

  it("rejects a duplicate chadhava id in one request", () => {
    const q = computeQuote({
      ...base,
      chadhava: [{ id: "chadhava-marigold-garland", qty: 1 }, { id: "chadhava-marigold-garland", qty: 1 }],
      dakshinaRupees: 0, prasad: false,
    });
    expect(q.ok).toBe(false);
  });

  it("rejects an unknown chadhava id (never trusts a client-invented product)", () => {
    const q = computeQuote({ ...base, chadhava: [{ id: "not-real", qty: 1 }], dakshinaRupees: 0, prasad: false });
    expect(q.ok).toBe(false);
    if (!q.ok) expect(q.error).toBe("chadhava_not_found");
  });

  it("rejects dakshina above the bound", () => {
    const q = computeQuote({ ...base, chadhava: [], dakshinaRupees: MAX_DAKSHINA_RUPEES + 1, prasad: false });
    expect(q.ok).toBe(false);
  });

  it("rejects negative dakshina", () => {
    const q = computeQuote({ ...base, chadhava: [], dakshinaRupees: -1, prasad: false });
    expect(q.ok).toBe(false);
  });

  it("rejects prasad when the listing does not offer it", () => {
    const q = computeQuote({
      ...base, listing: { ...listing, prasad_available: false },
      chadhava: [], dakshinaRupees: 0, prasad: true,
    });
    expect(q.ok).toBe(false);
    if (!q.ok) expect(q.error).toBe("prasad_unavailable");
  });
});

describe("validateAddress", () => {
  const good = { name: "Priya Sharma", phone: "9876543210", line1: "12 MG Road", city: "Dehradun", state: "Uttarakhand", pincode: "248001" };

  it("accepts a well-formed India address", () => {
    const r = validateAddress(good);
    expect(r.ok).toBe(true);
  });
  it("accepts a +91-prefixed phone and normalizes it", () => {
    const r = validateAddress({ ...good, phone: "+919876543210" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.phone).toBe("9876543210");
  });
  it("rejects a non-6-digit pincode", () => {
    const r = validateAddress({ ...good, pincode: "12345" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("pincode");
  });
  it("rejects a pincode starting with 0", () => {
    const r = validateAddress({ ...good, pincode: "012345" });
    expect(r.ok).toBe(false);
  });
  it("rejects a bad phone number", () => {
    const r = validateAddress({ ...good, phone: "12345" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("phone");
  });
  it("rejects a missing line1", () => {
    const r = validateAddress({ ...good, line1: "" });
    expect(r.ok).toBe(false);
  });
  it("rejects a non-object", () => {
    expect(validateAddress(null).ok).toBe(false);
    expect(validateAddress("x").ok).toBe(false);
  });
});

describe("validateSankalp", () => {
  it("requires a name", () => {
    expect(validateSankalp({}).ok).toBe(false);
    expect(validateSankalp({ name: "  " }).ok).toBe(false);
  });
  it("accepts name-only", () => {
    const r = validateSankalp({ name: "Ramesh" });
    expect(r.ok).toBe(true);
  });
  it("accepts optional gotra/family/wish and trims them", () => {
    const r = validateSankalp({ name: "Ramesh", gotra: " Kashyap ", family: [" Sita ", "Ram"], wish: " health " });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.gotra).toBe("Kashyap");
      expect(r.value.family).toEqual(["Sita", "Ram"]);
      expect(r.value.wish).toBe("health");
    }
  });
  it("rejects a non-array family", () => {
    expect(validateSankalp({ name: "Ramesh", family: "Sita" }).ok).toBe(false);
  });
});

describe("normalizeUtr", () => {
  it("accepts exactly 12 digits", () => {
    expect(normalizeUtr("123456789012")).toBe("123456789012");
    expect(normalizeUtr(" 123456789012 ")).toBe("123456789012");
  });
  it("rejects anything else", () => {
    expect(normalizeUtr("12345678901")).toBeNull();
    expect(normalizeUtr("1234567890123")).toBeNull();
    expect(normalizeUtr("12345678901a")).toBeNull();
    expect(normalizeUtr(123456789012 as unknown as string)).toBeNull();
  });
});

describe("addressLocked", () => {
  // Use a real ms-scale timestamp (>100_000_000_000) so it is never mistaken for
  // the "stored in seconds" case addressLocked also normalizes.
  const startsAtMs = 2_000_000_000_000;
  it("is locked once now passes starts_at", () => {
    expect(addressLocked(startsAtMs, startsAtMs - 1)).toBe(false);
    expect(addressLocked(startsAtMs, startsAtMs)).toBe(true);
    expect(addressLocked(startsAtMs, startsAtMs + 1)).toBe(true);
  });
  it("is never locked for a null starts_at", () => {
    expect(addressLocked(null, 999_999_999_999)).toBe(false);
  });
  it("treats a small (seconds-scale) starts_at as seconds, matching normalizeStartsAtMs", () => {
    const startsAtSec = 2_000_000_000; // year ~2033 in seconds
    expect(addressLocked(startsAtSec, startsAtSec * 1000 - 1)).toBe(false);
    expect(addressLocked(startsAtSec, startsAtSec * 1000)).toBe(true);
  });
});

describe("normalizeStartsAtMs", () => {
  it("passes through an ms-scale value unchanged", () => {
    expect(normalizeStartsAtMs(2_000_000_000_000)).toBe(2_000_000_000_000);
  });
  it("scales a seconds-scale value up to ms", () => {
    expect(normalizeStartsAtMs(2_000_000_000)).toBe(2_000_000_000_000);
  });
  it("is null for null/undefined/zero/negative", () => {
    expect(normalizeStartsAtMs(null)).toBeNull();
    expect(normalizeStartsAtMs(undefined)).toBeNull();
    expect(normalizeStartsAtMs(0)).toBeNull();
    expect(normalizeStartsAtMs(-5)).toBeNull();
  });
});

describe("dueForReminder", () => {
  const now = 2_000_000_000_000;
  it("is due when the event starts within the lead window and hasn't started", () => {
    expect(dueForReminder({ status: "confirmed", reminder_sent_at: null, starts_at: now + REMINDER_LEAD_MS }, now)).toBe(true);
    expect(dueForReminder({ status: "confirmed", reminder_sent_at: null, starts_at: now + 1 }, now)).toBe(true);
  });
  it("is not due once the event has started or passed", () => {
    expect(dueForReminder({ status: "confirmed", reminder_sent_at: null, starts_at: now }, now)).toBe(false);
    expect(dueForReminder({ status: "confirmed", reminder_sent_at: null, starts_at: now - 1 }, now)).toBe(false);
  });
  it("is not due before the lead window opens", () => {
    expect(dueForReminder({ status: "confirmed", reminder_sent_at: null, starts_at: now + REMINDER_LEAD_MS + 1 }, now)).toBe(false);
  });
  it("is not due when a reminder was already sent", () => {
    expect(dueForReminder({ status: "confirmed", reminder_sent_at: now - 1000, starts_at: now + 1000 }, now)).toBe(false);
  });
  it("is not due for a non-confirmed status", () => {
    for (const status of ["awaiting_payment", "review_pending", "expired", "cancelled"] as const) {
      expect(dueForReminder({ status, reminder_sent_at: null, starts_at: now + 1000 }, now)).toBe(false);
    }
  });
  it("is not due with no starts_at", () => {
    expect(dueForReminder({ status: "confirmed", reminder_sent_at: null, starts_at: null }, now)).toBe(false);
  });
  it("handles a seconds-scale starts_at the same as normalizeStartsAtMs would", () => {
    const startsAtSec = Math.floor((now + 1000) / 1000);
    expect(dueForReminder({ status: "confirmed", reminder_sent_at: null, starts_at: startsAtSec }, now)).toBe(true);
  });
});

describe("externalStatus", () => {
  it("expires a stale awaiting_payment row without a cron", () => {
    expect(externalStatus({ status: "awaiting_payment", expires_at: 100 }, 200)).toBe("expired");
    expect(externalStatus({ status: "awaiting_payment", expires_at: 300 }, 200)).toBe("awaiting_payment");
  });
  it("passes through confirmed and review_pending untouched", () => {
    expect(externalStatus({ status: "confirmed", expires_at: 100 }, 200)).toBe("confirmed");
    expect(externalStatus({ status: "review_pending", expires_at: 100 }, 200)).toBe("review_pending");
  });
  it("collapses cancelled into expired (contract has no cancelled state)", () => {
    expect(externalStatus({ status: "cancelled", expires_at: 999_999_999_999 }, 200)).toBe("expired");
  });
});
