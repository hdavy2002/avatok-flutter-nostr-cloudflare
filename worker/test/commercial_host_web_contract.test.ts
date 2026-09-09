import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repo = resolve(import.meta.dirname, "../..");
const host = readFileSync(resolve(repo, "web/src/islands/live-gs/LiveGsHost.tsx"), "utf8");
const hostApi = readFileSync(resolve(repo, "web/src/lib/commercialHost.ts"), "utf8");
const hostPage = readFileSync(resolve(repo, "web/src/pages/live/[id]/host.astro"), "utf8");
const viewer = readFileSync(resolve(repo, "web/src/islands/live-gs/LiveGsViewer.tsx"), "utf8");

describe("browser commercial livestream host contracts", () => {
  it("keeps the receive-only viewer route and adds a sibling host route", () => {
    expect(readFileSync(resolve(repo, "web/src/pages/live/[id].astro"), "utf8")).toContain("LiveGsViewer");
    expect(hostPage).toContain("LiveGsHost");
    expect(hostPage).toContain("listingId={id}");
  });

  it("uses the four server lifecycle authorities", () => {
    for (const action of ["prepare-host", "go-live", "end", "state"]) expect(hostApi).toContain(action);
    expect(host).toContain("prepareCommercialLiveHost");
    expect(host).toContain("goLiveCommercial");
    expect(host).toContain("endCommercialLive");
    expect(host).toContain("commercialLiveHostState");
    expect(hostApi).toContain("Idempotency-Key");
  });

  it("consumes provider identity returned by prepare-host", () => {
    expect(host).toContain("prepared.call_type");
    expect(host).toContain("prepared.call_id");
    expect(host).toContain("prepared.role !== 'host'");
    expect(host).not.toContain("avatok_livestream");
    expect(host).not.toContain("live_${listingId}");
  });

  it("keeps preview private and tears down browser media", () => {
    expect(host).toContain("getUserMedia");
    expect(host).toContain("track.stop()");
    expect(host).toContain("current.leave()");
    expect(host).toContain("Enter private backstage");
    expect(host).toContain("Start live");
    expect(viewer).not.toContain("getUserMedia");
  });

  it("guards asynchronous setup and refreshes auth for long sessions", () => {
    expect(host).toContain("operationGenerationRef");
    expect(host).toContain("mountedRef");
    expect(host).toContain("skipCache: true");
    expect(host).toContain("microphone.enable()");
    expect(host).toContain("camera.enable()");
  });
});
