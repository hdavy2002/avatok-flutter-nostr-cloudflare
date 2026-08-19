import { describe, expect, it, vi } from "vitest";
import { resolve as resolveDirectory, withSearchCache } from "../src/routes/api";

function envWithProfile(profile: Record<string, unknown> | null) {
  return {
    DB_META: {
      withSession() {
        return {
          prepare() {
            return {
              bind() {
                return { async first() { return profile; } };
              },
            };
          },
        };
      },
    },
  } as never;
}

describe("directory identity hydration", () => {
  it("keeps a raw Clerk uid routable but marks a missing profile explicitly", async () => {
    const response = await resolveDirectory(
      new Request("https://example.test/api/resolve?q=user_example"),
      envWithProfile(null),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      uid: "user_example",
      profile: null,
      profile_found: false,
    });
  });

  it("returns the public name when the profile exists", async () => {
    const response = await resolveDirectory(
      new Request("https://example.test/api/resolve?q=user_example"),
      envWithProfile({
        uid: "user_example",
        display_name: "Sonal",
        first_name: "Sonal",
        last_name: null,
        avatar_url: "https://img.example/sonal.jpg",
        avatok_number_display: "+1 555 0100",
      }),
    );

    expect(await response.json()).toMatchObject({
      uid: "user_example",
      profile_found: true,
      profile: { uid: "user_example", name: "Sonal" },
    });
  });

  it("short-caches profile:null instead of pinning it for thirty minutes", async () => {
    const put = vi.fn(async (
      _key: string,
      _value: string,
      _options: { expirationTtl: number },
    ) => undefined);
    const env = {
      TOKENS: { get: vi.fn(async () => null), put },
    } as never;
    const response = await withSearchCache(
      new Request("https://example.test/api/resolve?q=user_example"),
      env,
      async () => new Response(
        JSON.stringify({ uid: "user_example", profile: null, profile_found: false }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    expect(response.status).toBe(200);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]?.[2]).toEqual({ expirationTtl: 60 });
  });
});
