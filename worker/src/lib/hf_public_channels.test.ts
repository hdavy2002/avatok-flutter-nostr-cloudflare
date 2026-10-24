import { describe, it, expect } from "vitest";
import { toPublicChannel } from "./hf_public_channels";

describe("[HF-CHANNEL-MOBILE-1] toPublicChannel", () => {
  it("YouTube uses the channel total views", () => {
    const c = toPublicChannel({ platform: "youtube", handle: "@talks", url: null, followers: 3400, views: 210000, reel_views: 900, last_sync_at: 5 });
    expect(c).toEqual({ platform: "youtube", handle: "talks", url: "https://www.youtube.com/@talks", followers: 3400, views: 210000, viewsKind: "channel", updatedAt: 5 });
  });
  it("Instagram sums the imported video views and keeps a stored https link", () => {
    const c = toPublicChannel({ platform: "Instagram", handle: "me", url: "https://www.instagram.com/me/", followers: 55, views: 0, reel_views: 1200, last_sync_at: null });
    expect(c.views).toBe(1200);
    expect(c.viewsKind).toBe("videos");
    expect(c.url).toBe("https://www.instagram.com/me/");
  });
  it("never trusts a non-https url", () => {
    expect(toPublicChannel({ platform: "facebook", handle: "x", url: "javascript:alert(1)", followers: null, views: null, reel_views: null, last_sync_at: null }).url).toBe("https://www.facebook.com/x");
  });
});
