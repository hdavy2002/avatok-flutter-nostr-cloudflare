import { describe, it, expect } from "vitest";
import { customerNameFromIntake, firstNameOf, reviewDisplayName, confirmedCustomerText, confirmedConsultantText, reminderText, thanksText, noShowConsultantAdminText, emailHtml } from "./notify";

describe("names", () => {
  it("finds the customer's name per discipline", () => {
    expect(customerNameFromIntake(JSON.stringify({ kind: "astrology", birth: { name: "ravi kumar" } }))).toBe("ravi kumar");
    expect(customerNameFromIntake(JSON.stringify({ kind: "numerology", birth_name: "Asha Rao" }))).toBe("Asha Rao");
    expect(customerNameFromIntake(JSON.stringify({ kind: "tarot", name: "Mina" }))).toBe("Mina");
    expect(customerNameFromIntake(JSON.stringify({ kind: "palmistry" }))).toBeNull();
    expect(customerNameFromIntake("not json")).toBeNull();
  });
  it("capitalises a first name", () => { expect(firstNameOf("ravi kumar")).toBe("Ravi"); expect(firstNameOf(null)).toBe(""); });
  it("review display name is 'Firstname L.' or first name only", () => {
    expect(reviewDisplayName("ravi kumar sharma", false)).toBe("Ravi S.");
    expect(reviewDisplayName("ravi kumar", true)).toBe("Ravi");
    expect(reviewDisplayName("Mina", false)).toBe("Mina");
    expect(reviewDisplayName(null, false)).toBe("A customer");
  });
});

describe("copy", () => {
  it("customer confirmation carries time, consultant, join link and ref", () => {
    const t = confirmedCustomerText({ name: "Ravi", consultant: "Pt. Sharma", discipline: "Tarot", when: "Sun, 4 Oct 2026 at 7:00 PM IST", joinUrl: "https://x.test/guides/session/cb_1", ref: "AFC-1" });
    for (const s of ["Ravi", "Pt. Sharma", "Tarot", "7:00 PM IST", "https://x.test/guides/session/cb_1", "AFC-1"]) expect(t).toContain(s);
  });
  it("consultant message names the customer first name and desk link", () => {
    const t = confirmedConsultantText({ customer: "Ravi", discipline: "Palmistry", when: "soon", deskUrl: "https://x.test/desk/bookings/cb_1", ref: "AFC-1" });
    expect(t).toContain("Ravi"); expect(t).toContain("/desk/bookings/cb_1");
  });
  it("reminders differ by kind and role", () => {
    const a = { name: "Ravi", other: "Pt. Sharma", discipline: "Tarot", when: "w", url: "u" };
    expect(reminderText({ ...a, kind: "day", role: "customer" })).toContain("Tomorrow");
    expect(reminderText({ ...a, kind: "15", role: "customer" })).toContain("15 minutes");
    expect(reminderText({ ...a, kind: "15", role: "consultant", other: "Ravi" })).toContain("Open the desk");
  });
  it("thanks has the review link", () => { expect(thanksText({ name: "", consultant: "X", reviewUrl: "https://x.test/r" })).toContain("https://x.test/r"); });
  it("admin no-show alert says no automatic refund", () => {
    expect(noShowConsultantAdminText({ ref: "AFC-1", consultant: "X", when: "w", total: 590 })).toContain("No automatic refund");
  });
  it("email html escapes", () => { expect(emailHtml("<b>", ["a<script>"])).not.toContain("<script>"); });
});
