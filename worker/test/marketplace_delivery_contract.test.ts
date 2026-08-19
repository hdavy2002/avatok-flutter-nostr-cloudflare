import { describe, expect, it } from "vitest";
import { appendMarketplaceMessage, marketplaceArtifactId, marketplaceMessageId, marketplaceResultMessageId, patchMarketplaceMessage } from "../src/lib/delivery";
import { isNegotiableListing, marketplaceDealDecision } from "../src/routes/marketplace";

describe("marketplace delivery identity", () => {
  it("exposes the seller decision handler", () => {
    expect(typeof marketplaceDealDecision).toBe("function");
  });

  it("accepts only the current published marketplace version", () => {
    const base = { kind: "sell", status: "published", content_version: 3, expires_at: Date.now() + 60_000 };
    expect(isNegotiableListing(base, 3)).toBe(true);
    expect(isNegotiableListing({ ...base, status: "draft" }, 3)).toBe(false);
    expect(isNegotiableListing({ ...base, expires_at: Date.now() - 1 }, 3)).toBe(false);
    expect(isNegotiableListing({ ...base, kind: "consult" }, 3)).toBe(false);
    expect(isNegotiableListing(base, 2)).toBe(false);
  });
  it("keeps one stable artifact identity across retries", () => {
    expect(marketplaceArtifactId("neg-123")).toBe("mktdeal:neg-123:v1");
    expect(marketplaceArtifactId("neg-123", 2)).toBe("mktdeal:neg-123:v2");
    expect(marketplaceArtifactId("neg-123", 0)).toBe("mktdeal:neg-123:v1");
  });

  it("derives the same message/client id for both InboxDO copies", () => {
    const artifact = marketplaceArtifactId("neg-123");
    expect(marketplaceResultMessageId(artifact)).toBe("mktdeal:neg-123:v1:result");
    expect(marketplaceMessageId(artifact)).toBe("mktdeal:neg-123:v1:audio");
    expect(marketplaceMessageId(artifact)).toBe(marketplaceMessageId(artifact));
    expect(marketplaceMessageId(artifact, "decision")).not.toBe(marketplaceMessageId(artifact));
  });

  it("patches the stable logical result row instead of appending audio", async () => {
    let seenUrl = "";
    let requestBody: any;
    const env = {
      INBOX: {
        idFromName: (uid: string) => uid,
        get: () => ({
          fetch: async (url: string, init: RequestInit) => {
            seenUrl = url;
            requestBody = JSON.parse(String(init.body));
            return new Response(JSON.stringify({ ok: true, found: true, live: true }), { status: 200 });
          },
        }),
      },
    } as any;
    await expect(patchMarketplaceMessage(env, "seller", marketplaceResultMessageId("mktdeal:n:v1"), JSON.stringify({ has_audio: true })))
      .resolves.toEqual({ found: true, live: true });
    expect(seenUrl).toBe("https://inbox/msg_body");
    expect(requestBody.client_id).toBe("mktdeal:n:v1:result");
    expect(JSON.parse(requestBody.body).has_audio).toBe(true);
  });

  it("fails loudly on a non-2xx InboxDO append", async () => {
    let requestBody: any;
    const env = {
      INBOX: {
        idFromName: (uid: string) => uid,
        get: () => ({
          fetch: async (_url: string, init: RequestInit) => {
            requestBody = JSON.parse(String(init.body));
            return new Response(JSON.stringify({ error: "transient" }), { status: 503 });
          },
        }),
      },
    } as any;
    await expect(appendMarketplaceMessage(env, {
      recipient: "seller", sender: "buyer", conv: "dm_buyer__seller",
      body: JSON.stringify({ t: "marketplace_deal" }), mediaRef: "mkt/deal/a.wav",
      clientId: "mktdeal:neg:v1:audio", mid: "mktdeal:neg:v1:audio", createdAt: 123,
    })).rejects.toThrow("marketplace_inbox_append_failed:503");
    expect(requestBody.client_id).toBe("mktdeal:neg:v1:audio");
    expect(requestBody.mid).toBe("mktdeal:neg:v1:audio");
  });
});
