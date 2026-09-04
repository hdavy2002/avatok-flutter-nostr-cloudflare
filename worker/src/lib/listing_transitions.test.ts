// [MKT-STATUS-GATE-1] Tests for the listing status state machine. Pure module, no
// mocking needed — see listing_transitions.ts for the bug this closes.
import { describe, it, expect } from "vitest";
import { checkTransition, allowedTargets, TRANSITIONS, TERMINAL_STATUSES, type ListingStatus } from "./listing_transitions";

describe("listing_transitions: the core fix — live is never creator/admin-settable", () => {
  const nonSystemFroms: ListingStatus[] = ["draft", "pending_review", "approved", "rejected", "published", "live"];
  for (const from of nonSystemFroms) {
    it(`creator ${from} -> live is refused`, () => {
      const r = checkTransition(from, "live", "creator");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe(from === "live" ? "noop_transition" : "live_is_provider_confirmed");
    });
    it(`admin ${from} -> live is refused`, () => {
      const r = checkTransition(from, "live", "admin");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe(from === "live" ? "noop_transition" : "live_is_provider_confirmed");
    });
  }

  it("system published -> live requires provider_confirmed and is allowed", () => {
    const r = checkTransition("published", "live", "system");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rule.requires).toBe("provider_confirmed");
      expect(r.rule.id).toBe("system_go_live");
    }
  });

  it("no TRANSITIONS row ever targets live for a non-system actor", () => {
    for (const rule of TRANSITIONS) {
      if (rule.to === "live") {
        expect(rule.actors).toEqual(["system"]);
      }
    }
  });
});

describe("listing_transitions: reproduces the closed bug from setListingStatus", () => {
  // These are exactly the illegal jumps setListingStatus's current source-status blind
  // spot allows (pending_review/rejected/approved/completed/cancelled -> live).
  const badSources: ListingStatus[] = ["pending_review", "rejected", "approved", "completed", "cancelled"];
  for (const from of badSources) {
    it(`creator ${from} -> live is refused`, () => {
      expect(checkTransition(from, "live", "creator").ok).toBe(false);
    });
  }
});

describe("listing_transitions: creator cannot reach approved or rejected", () => {
  it("no rule with actor creator targets approved", () => {
    for (const rule of TRANSITIONS) {
      if (rule.to === "approved") expect(rule.actors).not.toContain("creator");
    }
  });
  it("no rule with actor creator targets rejected", () => {
    for (const rule of TRANSITIONS) {
      if (rule.to === "rejected") expect(rule.actors).not.toContain("creator");
    }
  });
});

describe("listing_transitions: terminal statuses have exactly one way out", () => {
  // An earlier revision of the table made cancelled/completed absolutely terminal.
  // That would have 409'd the shipped archive-restore button in production — the old
  // setListingStatus served "RESTORE from Archived -> back to draft" from the same
  // branch that carried the bypass. Terminal here means "no exit EXCEPT the owner
  // pulling it back to draft to reuse it", not "no exit". Do not re-tighten this
  // without checking the restore UI first.
  for (const status of TERMINAL_STATUSES) {
    it(`${status} -> draft is allowed for the creator (archive restore)`, () => {
      expect(checkTransition(status, "draft", "creator").ok).toBe(true);
      expect(allowedTargets(status, "creator")).toEqual(["draft"]);
    });
    it(`${status} offers nothing to admin or system`, () => {
      expect(allowedTargets(status, "admin")).toEqual([]);
      expect(allowedTargets(status, "system")).toEqual([]);
      expect(checkTransition(status, "draft", "admin").ok).toBe(false);
    });
    it(`${status} -> live/published stays refused for every actor`, () => {
      for (const actor of ["creator", "admin", "system"] as const) {
        expect(checkTransition(status, "live", actor).ok).toBe(false);
        expect(checkTransition(status, "published", actor).ok).toBe(false);
      }
    });
  }
});

describe("listing_transitions: the documented happy paths", () => {
  it("creator draft -> pending_review", () => {
    const r = checkTransition("draft", "pending_review", "creator");
    expect(r.ok).toBe(true);
  });
  it("creator rejected -> draft (revision)", () => {
    const r = checkTransition("rejected", "draft", "creator");
    expect(r.ok).toBe(true);
  });
  it("creator approved -> published requires publish_gate", () => {
    const r = checkTransition("approved", "published", "creator");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rule.requires).toBe("publish_gate");
  });
  it("admin draft|pending_review -> approved", () => {
    expect(checkTransition("draft", "approved", "admin").ok).toBe(true);
    expect(checkTransition("pending_review", "approved", "admin").ok).toBe(true);
  });
  it("system live -> completed requires provider_confirmed", () => {
    const r = checkTransition("live", "completed", "system");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rule.requires).toBe("provider_confirmed");
  });
});

describe("listing_transitions: [LIST-REVIEW-BINDING-1] system review-invalidation rows", () => {
  // updateListing (routes/listings.ts) demotes approved/published/live back to
  // pending_review when a material edit changes reviewedContentHash. These three
  // rows are the ONLY authority for that move — see this file's header. A creator
  // or admin must never be able to trigger the same demotion themselves; that would
  // let a creator bounce their own published listing back into the queue on demand
  // (e.g. to dodge a hold, a report, or a pending cancellation) instead of it only
  // happening as a side effect of an edit the system itself judged material.
  const sources: { from: ListingStatus; id: string }[] = [
    { from: "approved", id: "system_review_invalidated_approved" },
    { from: "published", id: "system_review_invalidated_published" },
    { from: "live", id: "system_review_invalidated_live" },
  ];

  for (const { from, id } of sources) {
    it(`system ${from} -> pending_review is allowed, requires "none", id ${id}`, () => {
      const r = checkTransition(from, "pending_review", "system");
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.rule.requires).toBe("none");
        expect(r.rule.id).toBe(id);
      }
    });

    it(`creator ${from} -> pending_review is refused`, () => {
      const r = checkTransition(from, "pending_review", "creator");
      expect(r.ok).toBe(false);
    });

    it(`admin ${from} -> pending_review is refused`, () => {
      const r = checkTransition(from, "pending_review", "admin");
      expect(r.ok).toBe(false);
    });

    it(`${from} -> pending_review is not offered to creator or admin in allowedTargets`, () => {
      expect(allowedTargets(from, "creator")).not.toContain("pending_review");
      expect(allowedTargets(from, "admin")).not.toContain("pending_review");
      expect(allowedTargets(from, "system")).toContain("pending_review");
    });
  }
});

describe("listing_transitions: never throws on garbage input", () => {
  it("unknown status strings refuse safely", () => {
    expect(() => checkTransition("bogus", "live", "creator")).not.toThrow();
    expect(checkTransition("bogus", "live", "creator").ok).toBe(false);
    expect(() => checkTransition("draft", "nope", "admin")).not.toThrow();
    expect(allowedTargets("nonsense", "creator")).toEqual([]);
  });
});
