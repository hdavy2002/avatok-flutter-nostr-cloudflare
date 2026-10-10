// @ts-nocheck -- reads a file with node:fs, which the worker tsconfig has no types for
// [HF-NATIVE-S3] The web keeps its own copy of the mood list (web/src/lib/callvaalHomeReference.ts). The worker is the source
// for the native app; this fails loudly if the two drift apart until the web is switched to read /api/hf/options.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { TOPICS, MOOD_GROUPS } from "./hf_options";

const src = readFileSync(new URL("../../../web/src/lib/callvaalHomeReference.ts", import.meta.url), "utf8");

describe("worker topics match the web mood list", () => {
  const web = [...src.matchAll(/\{ group: '([^']+)', slug: '([^']+)', label: '([^']+)' \}/g)].map((m) => ({ group: m[1], slug: m[2], label: m[3] }));
  it("same slugs, labels, groups and order", () => {
    expect(web.length).toBeGreaterThan(20);
    expect(TOPICS.map((t) => ({ group: t.group, slug: t.slug, label: t.label }))).toEqual(web);
  });
  it("same mood group order", () => {
    const m = src.match(/export const moodGroups = \[([^\]]+)\]/);
    const names = [...(m?.[1] ?? "").matchAll(/'([^']+)'/g)].map((x) => x[1]);
    expect(MOOD_GROUPS.map((g) => g.label)).toEqual(names);
  });
});
