import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("InboxDO cold-sync pagination contract", () => {
  it("returns a sentinel-backed next cursor without widening a page", () => {
    const inbox = readFileSync("src/do/inbox.ts", "utf8");
    expect(inbox).toContain("cursor, SYNC_LIMIT + 1");
    expect(inbox).toContain("const hasMore = page.length > SYNC_LIMIT");
    expect(inbox).toContain("page.slice(0, SYNC_LIMIT)");
    expect(inbox).toContain("has_more: hasMore");
    expect(inbox).toContain("next_cursor: nextCursor");
  });

  it("keeps the app page cursor separate from the live global cursor", () => {
    const hub = readFileSync("../app/lib/sync/sync_hub.dart", "utf8");
    expect(hub).toContain("int _syncPageCursor = 0");
    expect(hub).toContain("bool _syncRecoveryActive = false");
    expect(hub).toContain("'cursor': nextCursor");
    expect(hub).toContain("sync_pagination_requested");
    expect(hub).toContain("nextCursor > _syncPageCursor");
    expect(hub).toContain("fromSync || !_syncRecoveryActive");
    expect(hub).toContain("void _armSyncRecoveryTimeout()");
    expect(hub).toContain("_onClosed('sync_timeout')");
  });
});
