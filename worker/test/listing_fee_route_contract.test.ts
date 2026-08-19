import { describe, expect, it } from "vitest";
import { listingFeeQuote, publishListing, setListingStatus, updateListing } from "../src/routes/listings";
import { composePublish } from "../src/routes/compose";
import { finalizeListingPublication } from "../src/lib/listing_billing";

describe("listing fee route integration surface", () => {
  it("keeps both publish paths wired to callable route handlers", () => {
    expect(typeof publishListing).toBe("function");
    expect(typeof composePublish).toBe("function");
    expect(typeof listingFeeQuote).toBe("function");
    expect(typeof finalizeListingPublication).toBe("function");
  });

  it("keeps restore and update handlers available for renewal enforcement", () => {
    expect(typeof updateListing).toBe("function");
    expect(typeof setListingStatus).toBe("function");
  });
});
