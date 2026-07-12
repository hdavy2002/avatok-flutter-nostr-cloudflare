// [AVA-SPAM-3] Plain-assertion checks for the deterministic scorer + bloom builder.
//
// NO test tooling / deps by design (rulebook: no new deps). Self-contained: a tiny
// assert(), scenario functions, and an exported runTests() that throws on the first
// failure. Runnable later by ANY TS runner — import { runTests } and call it (e.g.
// from a vitest `it(...)`, which is already a devDependency, or `npx tsx`). Kept as
// an executable spec of the consensus rules so a future change that breaks them is
// caught deterministically. (Worker CI runs `flutter test` only, so this file is
// never auto-collected — it will not fail a build.)

import {
  scoreNumber,
  computeReporterTrust,
  FORMULA_VERSION,
  RED_THRESHOLD,
  CAUTION_THRESHOLD,
  RED_MIN_REPORTERS,
  BASE_TRUST,
  type ReportInput,
} from "./scoring";
import { buildBloom, bloomMightContain, optimalParams, serializeBloom, BLOOM_MAGIC } from "./bloom";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
}

const NOW = 1_752_000_000_000; // fixed clock so every run is identical
const DAY = 24 * 60 * 60 * 1000;

function spamReports(count: number, trust: number, ageMs = 0): ReportInput[] {
  const out: ReportInput[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ reporterUid: "u" + i, trust, verdict: "spam", createdMs: NOW - ageMs });
  }
  return out;
}

export async function runTests(): Promise<void> {
  // 1. A single report NEVER marks spam (stays below red; caution at most).
  {
    const r = scoreNumber({ now: NOW, reports: spamReports(1, 1.0) });
    assert(r.label !== "red", "single report must never be red");
    assert(r.score < RED_THRESHOLD, "single report score must be < RED_THRESHOLD");
    assert(r.formulaVersion === FORMULA_VERSION, "formula version echoed");
  }

  // 2. Below the distinct-reporter floor, even high-trust reporters cannot go red.
  {
    const r = scoreNumber({ now: NOW, reports: spamReports(RED_MIN_REPORTERS - 1, 1.0) });
    assert(r.label !== "red", "fewer than RED_MIN_REPORTERS must not be red");
    assert(r.score <= RED_THRESHOLD - 1, "score capped below red under the floor");
  }

  // 3. >= RED_MIN_REPORTERS distinct AVERAGE-trust reporters ⇒ red.
  {
    const r = scoreNumber({ now: NOW, reports: spamReports(RED_MIN_REPORTERS, 0.6) });
    assert(r.distinctReporters === RED_MIN_REPORTERS, "distinct reporters counted");
    assert(r.label === "red", "5 average-trust reporters should be red, got " + r.label + " score=" + r.score);
    assert(r.score >= RED_THRESHOLD, "red score >= threshold");
  }

  // 4. Brigading: 5 FRESH LOW-trust accounts barely move it → caution, not red.
  {
    const r = scoreNumber({ now: NOW, reports: spamReports(RED_MIN_REPORTERS, BASE_TRUST) });
    assert(r.label !== "red", "low-trust brigade must not reach red, got score=" + r.score);
    assert(r.score >= CAUTION_THRESHOLD, "brigade still shows caution ('reported by K')");
  }

  // 5. Distinct-reporter gate: 10 reports from the SAME uid = 1 distinct ⇒ not red.
  {
    const dup: ReportInput[] = [];
    for (let i = 0; i < 10; i++) dup.push({ reporterUid: "same", trust: 1.0, verdict: "spam", createdMs: NOW });
    const r = scoreNumber({ now: NOW, reports: dup });
    assert(r.distinctReporters === 1, "duplicate uid counts once");
    assert(r.label !== "red", "one reporter (even repeated) never red");
  }

  // 6. Redemption: not_spam reports pull the score DOWN.
  {
    const base = scoreNumber({ now: NOW, reports: spamReports(6, 0.6) });
    const mixed = scoreNumber({
      now: NOW,
      reports: [
        ...spamReports(6, 0.6),
        { reporterUid: "d1", trust: 1.0, verdict: "not_spam", createdMs: NOW },
        { reporterUid: "d2", trust: 1.0, verdict: "not_spam", createdMs: NOW },
      ],
    });
    assert(mixed.score < base.score, "not_spam reports reduce the score");
  }

  // 7. Decay: old reports weigh less than fresh ones.
  {
    const fresh = scoreNumber({ now: NOW, reports: spamReports(6, 0.6, 0) });
    const old = scoreNumber({ now: NOW, reports: spamReports(6, 0.6, 180 * DAY) });
    assert(old.score < fresh.score, "aged reports decay below fresh reports");
  }

  // 8. Determinism: identical inputs ⇒ identical output.
  {
    const a = scoreNumber({ now: NOW, reports: spamReports(5, 0.6) });
    const b = scoreNumber({ now: NOW, reports: spamReports(5, 0.6) });
    assert(a.score === b.score && a.label === b.label, "scorer is deterministic");
  }

  // 9. Reporter trust: agreement raises, disagreement lowers, empty = base.
  {
    assert(computeReporterTrust(0, 0) === BASE_TRUST, "no history ⇒ base trust");
    assert(computeReporterTrust(10, 0) > BASE_TRUST, "all agreements raise trust");
    assert(computeReporterTrust(0, 10) < BASE_TRUST, "all disagreements lower trust");
    const t = computeReporterTrust(10, 0);
    assert(t <= 1.0 && t >= 0.05, "trust stays clamped");
  }

  // 10. Bloom: inserted keys are found; params + serialization are sane.
  {
    const keys = ["aa11", "bb22", "cc33", "dd44"];
    const f = await buildBloom(keys, 0.01);
    for (const key of keys) {
      assert(await bloomMightContain(f, key), "inserted key must be found: " + key);
    }
    const p = optimalParams(1000, 0.01);
    assert(p.m > 0 && p.k > 0, "optimal params positive");
    const ser = serializeBloom(f);
    assert(String.fromCharCode(ser[0], ser[1], ser[2], ser[3], ser[4]) === BLOOM_MAGIC, "magic header written");
    assert(ser.length > 16, "serialized bloom has header + bits");
  }

  // eslint-disable-next-line no-console
  console.log("[spam/scoring.test] all assertions passed");
}

// To run later without adding tooling: import { runTests } from this file and call
// it (e.g. from a vitest `it(...)`, or `npx tsx -e "import('./scoring.test.ts').then(m=>m.runTests())"`).
// No auto-exec block here so the file stays a clean module under both tsc and vitest.
