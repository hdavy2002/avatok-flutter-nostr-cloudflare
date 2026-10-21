import { describe, expect, it, vi } from "vitest";
import { instagramLookup, TREG_IG_PROFILE, TREG_IG_PROFILE_FALLBACK } from "./hf_channel_providers";

const env = { TREG_API_KEY: "test-secret" };
const user = { id: "73340537603", username: "maya.reels", full_name: "Maya", biography: "Hello",
  edge_followed_by: { count: 123327 }, is_private: false, profile_pic_url_hd: "https://example.com/avatar.jpg" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("Instagram provider fallback", () => {
  it("keeps a successful primary response and does not call the fallback", async () => {
    const f = vi.fn().mockResolvedValue(json({ data: { data: { user } } }));
    expect(await instagramLookup(env, "@Maya.Reels", f)).toMatchObject({
      exists: true, platformUserId: user.id, followers: 123327, handle: "maya.reels",
    });
    expect(f).toHaveBeenCalledTimes(1);
    expect(new URL(f.mock.calls[0][0]).pathname).toBe("/call/tikhub.instagram.user.profile");
  });

  it.each(["http", "network", "json", "missing-user", "missing-id"])("falls back after %s failure", async (failure) => {
    const f = vi.fn();
    if (failure === "network") f.mockRejectedValueOnce(new Error("https://secret.invalid/test-secret"));
    else f.mockResolvedValueOnce(failure === "http" ? json({}, 500)
      : failure === "json" ? new Response("not json")
      : failure === "missing-id" ? json({ data: { user: { username: "maya.reels" } } }) : json({}));
    f.mockResolvedValueOnce(json({ data: { data: { user } } }));
    expect(await instagramLookup(env, "https://www.instagram.com/maya.reels/", f)).toEqual({
      exists: true, platformUserId: user.id, handle: "maya.reels", followers: 123327,
      bio: "Hello", isPrivate: false, countHidden: false, url: "https://www.instagram.com/maya.reels/",
      displayName: "Maya", avatarUrl: "https://example.com/avatar.jpg",
    });
    expect(f).toHaveBeenCalledTimes(2);
    const primary = new URL(f.mock.calls[0][0]);
    const fallback = new URL(f.mock.calls[1][0]);
    expect(primary.pathname).toBe("/call/" + TREG_IG_PROFILE);
    expect(fallback.pathname).toBe("/call/" + TREG_IG_PROFILE_FALLBACK);
    expect(primary.search).toBe("?username=maya.reels");
    expect(fallback.searchParams.get("handle")).toBe("maya.reels");
    for (const [url, init] of f.mock.calls) {
      expect(url).not.toContain(env.TREG_API_KEY);
      expect(new Headers(init.headers).get("X-Treg-Token")).toBe(env.TREG_API_KEY);
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it.each([{ error: "not_found" }, { errorStatus: 404 }, { data: { user: null } }])(
    "preserves a missing account without trying another provider: %j", async (body) => {
      const f = vi.fn().mockResolvedValue(json(body));
      expect(await instagramLookup(env, "ghost", f)).toMatchObject({ exists: false, platformUserId: null });
      expect(f).toHaveBeenCalledTimes(1);
    });

  it("preserves private accounts from either provider", async () => {
    for (const fallback of [false, true]) {
      const f = vi.fn();
      if (fallback) f.mockResolvedValueOnce(json({}, 503));
      const privateUser = { ...user, is_private: true };
      f.mockResolvedValueOnce(json(fallback ? { data: { data: { user: privateUser } } } : { user: privateUser }));
      expect(await instagramLookup(env, "maya.reels", f)).toMatchObject({ exists: true, isPrivate: true });
      expect(f).toHaveBeenCalledTimes(fallback ? 2 : 1);
    }
  });

  it.each(["headers", "body"])("falls back within the budget when %s stalls", async (part) => {
    vi.useFakeTimers();
    try {
      const pending = new Promise<Response>(() => {});
      const f = vi.fn().mockImplementationOnce(() => part === "headers" ? pending
        : Promise.resolve({ ok: true, status: 200, json: () => new Promise(() => {}) }))
        .mockResolvedValueOnce(json({ data: { user } }));
      const result = instagramLookup(env, "maya.reels", f);
      await vi.advanceTimersByTimeAsync(8000);
      expect(await result).toMatchObject({ exists: true, platformUserId: user.id });
      expect(f).toHaveBeenCalledTimes(2);
      expect(f.mock.calls[0][1].signal.aborted).toBe(true);
      expect(f.mock.calls[1][1].signal.aborted).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("returns and logs only safe diagnostics when both providers fail", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const f = vi.fn().mockRejectedValue(new Error("https://secret.invalid/test-secret"));
      await expect(instagramLookup(env, "maya.reels", f)).rejects.toMatchObject({
        code: "provider_unavailable", message: "provider_unavailable",
      });
      expect(f).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[0]).toEqual(["[hf_instagram_lookup]", {
        endpoint: TREG_IG_PROFILE, stage: "fetch", status: null, elapsedMs: expect.any(Number),
      }]);
      const logs = JSON.stringify(warn.mock.calls);
      expect(logs).not.toContain(env.TREG_API_KEY);
      expect(logs).not.toContain("maya.reels");
      expect(logs).not.toContain("secret.invalid");
    } finally { warn.mockRestore(); }
  });

  it("treats malformed responses from both providers as unavailable, not an absent account", async () => {
    const f = vi.fn().mockResolvedValueOnce(json({})).mockResolvedValueOnce(json({ data: { data: {} } }));
    await expect(instagramLookup(env, "maya.reels", f)).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("does not call either provider for missing configuration or invalid handles", async () => {
    const f = vi.fn();
    await expect(instagramLookup({}, "maya.reels", f)).rejects.toMatchObject({ code: "provider_not_configured" });
    await expect(instagramLookup(env, "bad handle", f)).rejects.toMatchObject({ code: "bad_handle" });
    expect(f).not.toHaveBeenCalled();
  });
});
