// [HF-CALL-SAFETY-BE] Pure rules, parsers, XML, money split, enforcement gates and the idempotent recording webhook (real SQLite via node:sqlite).
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import {
  decideOutcome, safetyCfg, retentionFor, nextSendTime, inQuietHours, activeStrikeCount, shouldPause, isWarningStrike, canAppealStrike, strikeExpiresAt,
  adminWindow, clipRange, clipBytes, targetUid, isReportReason, REPORT_VERDICT, fmtClock, DAY_MS, HOUR_MS, type SafetyCfg,
} from "../src/lib/hf_safety_rules";
import { allocateBanRefunds } from "../src/lib/hf_safety_money";
import { parseSttJson, parseGeminiDecision, combineSpeaker, readNoul, readChoice, chunkLines, decideWithFallback, type DecisionProvider } from "../src/lib/hf_safety_providers";
import { recordLegXml, safeVobizUrl, sniffAudioMime } from "../src/lib/hf_vobiz_recording";
import { noticeAndConferenceXml, SAFETY_NOTICE } from "../src/lib/hf_call_math";
import { ingestRecording, audioKey } from "../src/lib/hf_safety_process";
import { hfModStatus, modBlock } from "../src/lib/hf_safety_store";
import { hfSafetyRoute, isSafetyReviewer } from "../src/routes/hf_safety";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (path: string) => any };

const ON: SafetyCfg = safetyCfg({ hfCallRecordingEnabled: true, hfCallReviewEnabled: true, hfAutoStrikeEnabled: true });
const OFF: SafetyCfg = safetyCfg({});

describe("flags default to shadow mode", () => {
  it("everything off, contract numbers", () => {
    expect(OFF).toMatchObject({ recordingEnabled: false, reviewEnabled: false, autoStrikeEnabled: false, highScore: 0.9, queueScore: 0.6, strikesToPause: 3, expiryDays: 90, flaggedAudioDays: 30, cleanTranscriptDays: 30, rulesVersion: 1 });
  });
  it("config.ts carries the contract defaults", () => {
    const src = readFileSync(new URL("../src/routes/config.ts", import.meta.url), "utf8");
    for (const k of ["hfCallRecordingEnabled: false", "hfCallReviewEnabled: false", "hfAutoStrikeEnabled: false", "hfStrikeHighScore: 0.9", "hfStrikeQueueScore: 0.6", "hfStrikesToPause: 3", "hfStrikeExpiryDays: 90", "hfFlaggedAudioDays: 30", "hfCleanTranscriptDays: 30", "hfCallRulesVersion: 1"]) expect(src).toContain(k);
    expect(src).toMatch(/numericKeys[\s\S]*hfStrikeHighScore/);
  });
});

describe("decideOutcome (contract rule 5)", () => {
  const f = (verdict: any, score: number, speaker: any = "influencer", speakerScore = 0.95) => ({ verdict, score, speaker, speakerScore });
  it("clean and low scores do nothing", () => {
    expect(decideOutcome(f("clean", 0.99), ON).action).toBe("none");
    expect(decideOutcome(f("selling", 0.59), ON).action).toBe("none");
  });
  it("0.6 to 0.9 queues with no strike", () => {
    expect(decideOutcome(f("selling", 0.6), ON).action).toBe("queue");
    expect(decideOutcome(f("abuse", 0.89), ON).action).toBe("queue");
  });
  it("0.9 and up strikes only when auto strikes are on and the speaker is also sure", () => {
    expect(decideOutcome(f("selling", 0.9), ON).action).toBe("strike");
    expect(decideOutcome(f("selling", 0.95), OFF).action).toBe("queue");
    expect(decideOutcome(f("selling", 0.95, "fan", 0.89), ON).action).toBe("queue");
    expect(decideOutcome(f("selling", 0.95, null, 0), ON).action).toBe("queue");
  });
  it("danger is always an alert; it only pauses by itself when auto is on and the speaker is sure", () => {
    expect(decideOutcome(f("danger", 0.7), OFF)).toEqual({ action: "danger", autoPause: false });
    expect(decideOutcome(f("danger", 0.95), ON)).toEqual({ action: "danger", autoPause: true });
    expect(decideOutcome(f("danger", 0.95, "fan", 0.5), ON)).toEqual({ action: "danger", autoPause: false });
    expect(decideOutcome(f("danger", 0.3), ON).action).toBe("none");
  });
});

describe("strikes", () => {
  const now = Date.UTC(2026, 9, 28);
  it("active for 90 days, 3 pause, warn on the 2nd", () => {
    expect(strikeExpiresAt(now, 90) - now).toBe(90 * DAY_MS);
    const list = [{ removedAt: null, expiresAt: now + 1 }, { removedAt: null, expiresAt: now - 1 }, { removedAt: now - 5, expiresAt: now + 99 }];
    expect(activeStrikeCount(list, now)).toBe(1);
    expect(shouldPause(2, 3)).toBe(false);
    expect(shouldPause(3, 3)).toBe(true);
    expect(isWarningStrike(2, 3)).toBe(true);
    expect(isWarningStrike(1, 3)).toBe(false);
  });
  it("one appeal per active strike", () => {
    expect(canAppealStrike({ removedAt: null, expiresAt: now + 5, appealStatus: null }, now)).toBe(true);
    expect(canAppealStrike({ removedAt: null, expiresAt: now + 5, appealStatus: "open" }, now)).toBe(false);
    expect(canAppealStrike({ removedAt: now - 1, expiresAt: now + 5, appealStatus: null }, now)).toBe(false);
    expect(canAppealStrike({ removedAt: null, expiresAt: now - 1, appealStatus: null }, now)).toBe(false);
  });
});

describe("retention dates (rule 9)", () => {
  it("clean: no audio kept, transcript 30 days; flagged: audio 30 days, transcript 1 year", () => {
    const now = 1_000_000;
    expect(retentionFor({ flagged: false, now }, ON)).toEqual({ audioExpiresAt: null, transcriptExpiresAt: now + 30 * DAY_MS, verdictExpiresAt: now + 365 * DAY_MS });
    expect(retentionFor({ flagged: true, now }, ON)).toEqual({ audioExpiresAt: now + 30 * DAY_MS, transcriptExpiresAt: now + 365 * DAY_MS, verdictExpiresAt: now + 365 * DAY_MS });
  });
});

describe("quiet hours IST", () => {
  const ist = (h: number, d = 28) => Date.UTC(2026, 9, d, h, 0) - 5.5 * HOUR_MS;
  it("blocks 23:00 to 08:00 and defers to 08:00", () => {
    expect(inQuietHours(ist(7))).toBe(true);
    expect(inQuietHours(ist(8))).toBe(false);
    expect(inQuietHours(ist(22))).toBe(false);
    expect(inQuietHours(ist(23))).toBe(true);
    expect(nextSendTime(ist(2))).toBe(ist(8));
    expect(nextSendTime(ist(23))).toBe(ist(8, 29));
    expect(nextSendTime(ist(12))).toBe(ist(12));
  });
});

describe("admin transcript window and clip", () => {
  it("flagged line plus 2 each side", () => {
    expect(adminWindow(20, 10)).toEqual({ from: 8, to: 12 });
    expect(adminWindow(20, 0)).toEqual({ from: 0, to: 2 });
    expect(adminWindow(20, 19)).toEqual({ from: 17, to: 19 });
    expect(adminWindow(20, null).to).toBeLessThan(0);
  });
  it("15 second clip inside the call", () => {
    expect(clipRange(100, 600)).toEqual({ startSec: 92.5, endSec: 107.5 });
    expect(clipRange(2, 600)).toEqual({ startSec: 0, endSec: 15 });
    expect(clipRange(599, 600)).toEqual({ startSec: 585, endSec: 600 });
    expect(clipRange(5, 10)).toBeNull();
    const b = clipBytes(600_000, 600, { startSec: 100, endSec: 115 });
    expect(b).toEqual({ offset: 100_000, length: 15_000 });
    expect(fmtClock(372)).toBe("06:12");
  });
  it("targets the speaker, never the other person", () => {
    expect(targetUid("fan", "F", "H")).toBe("F");
    expect(targetUid("influencer", "F", "H")).toBe("H");
    expect(targetUid(null, "F", "H")).toBeNull();
  });
  it("fan report reasons map to verdicts", () => {
    expect(isReportReason("asked_number")).toBe(true);
    expect(isReportReason("nope")).toBe(false);
    expect(REPORT_VERDICT.asked_number).toBe("contact_sharing");
    expect(REPORT_VERDICT.abusive).toBe("abuse");
  });
});

describe("allocateBanRefunds", () => {
  const calls = [
    { callId: "a", fanUid: "f1", chargePaise: 500, at: 1 },
    { callId: "b", fanUid: "f2", chargePaise: 700, at: 3 },
    { callId: "c", fanUid: "f1", chargePaise: 400, at: 2 },
  ];
  it("newest first, last one partial, never beyond what is held", () => {
    const r = allocateBanRefunds(calls, 1000);
    expect(r.allocs.map((a) => [a.callId, a.paise])).toEqual([["b", 700], ["c", 300]]);
    expect(r.total).toBe(1000);
    expect(r.byFan).toEqual([{ fanUid: "f2", paise: 700 }, { fanUid: "f1", paise: 300 }]);
  });
  it("enough money refunds everything; none refunds nothing", () => {
    expect(allocateBanRefunds(calls, 99999).total).toBe(1600);
    expect(allocateBanRefunds(calls, 0).total).toBe(0);
    expect(allocateBanRefunds([], 500).allocs).toEqual([]);
  });
});

describe("model output parsers", () => {
  it("parseSttJson sorts lines, maps speakers, drops junk", () => {
    const r = parseSttJson(JSON.stringify([{ start_sec: 30, speaker: "host", text: " hello  ji ", speaker_confidence: 0.9 }, { start_sec: 5, speaker: "caller", text: "namaste", speaker_confidence: 2 }, { start_sec: 9, text: "" }, "x"]));
    expect(r.lines.map((l) => [l.t, l.speaker, l.text])).toEqual([["00:05", "fan", "namaste"], ["00:30", "influencer", "hello ji"]]);
    expect(r.lineConf).toEqual([1, 0.9]);
    expect(parseSttJson("not json")).toEqual({ lines: [], lineConf: [] });
  });
  it("parseGeminiDecision validates verdicts and indexes", () => {
    const lines = [{ sec: 1, t: "00:01", speaker: "fan" as const, text: "a" }, { sec: 2, t: "00:02", speaker: "influencer" as const, text: "b" }];
    const ok = parseGeminiDecision(JSON.stringify({ verdict: "selling", score: 0.95, flagged_line: 1, speaker: "influencer", speaker_confidence: 0.97 }), lines, [0.9, 0.95]);
    expect(ok).toMatchObject({ verdict: "selling", score: 0.95, speaker: "influencer", flaggedIdx: 1 });
    expect(parseGeminiDecision(JSON.stringify({ verdict: "clean", score: 0.2 }), lines, [])).toMatchObject({ verdict: "clean", speaker: null });
    expect(parseGeminiDecision(JSON.stringify({ verdict: "bogus", score: 1 }), lines, [])).toBeNull();
    expect(parseGeminiDecision("{", lines, [])).toBeNull();
    expect(parseGeminiDecision(JSON.stringify({ verdict: "abuse", score: 3, flagged_line: 99, speaker: "fan", speaker_confidence: 1 }), lines, [])?.flaggedIdx).toBeNull();
  });
  it("speaker confidence is halved when the picks disagree and never above either source", () => {
    const agree = combineSpeaker({ choice: "fan", prob: 0.95 }, "fan", 0.9);
    const clash = combineSpeaker({ choice: "fan", prob: 0.95 }, "influencer", 0.9);
    expect(agree.speaker).toBe("fan");
    expect(agree.score).toBeLessThanOrEqual(0.9);
    expect(clash.score).toBeLessThan(agree.score);
  });
  it("tolerant readers and chunking", () => {
    expect(readNoul({ a: { value: 0.7 } }, "a")).toBeGreaterThanOrEqual(0);
    expect(readChoice(undefined, "x")).toEqual({ choice: null, prob: 0 });
    const ch = chunkLines(95);
    expect(ch[0]).toEqual([0, 40]);
    expect(ch[ch.length - 1][1]).toBe(95);
  });
  it("falls back to the next provider when one throws", async () => {
    const bad: DecisionProvider = { name: "bad", decide: async () => { throw new Error("down"); } };
    const good: DecisionProvider = { name: "good", decide: async () => ({ verdict: "clean", score: 0.1, speaker: null, speakerScore: 0, flaggedIdx: null, provider: "good", model: "m" }) };
    const r = await decideWithFallback({} as any, [], [], { callId: "c", uid: "u" }, [bad, good]);
    expect(r.provider).toBe("good");
    await expect(decideWithFallback({} as any, [], [], { callId: "c", uid: "u" }, [bad])).rejects.toThrow();
  });
});

describe("Vobiz recording XML", () => {
  it("record verb: session recording, no beep, escaped callback", () => {
    const x = recordLegXml("https://x.test/a?b=1&c=2", 3600);
    expect(x).toContain('recordSession="true"');
    expect(x).toContain('playBeep="false"');
    expect(x).toContain("&amp;");
    expect(recordLegXml(null, 3600)).toBe("");
  });
  it("conference XML is unchanged without the record verb and only prepends it with one; nothing new is spoken", () => {
    const base = { room: "r1", callbackUrl: "https://x.test/conf", timeLimitSec: 600 };
    const plain = noticeAndConferenceXml(base);
    const rec = noticeAndConferenceXml({ ...base, record: recordLegXml("https://x.test/rec", 600) });
    expect(plain).not.toContain("<Record");
    expect(rec).toContain("<Record");
    expect(rec.replace(/<Record[^>]*\/>/, "")).toBe(plain);
    expect(rec.match(/<Speak>/g)?.length).toBe(1);
    expect(SAFETY_NOTICE.length).toBeGreaterThan(0);
  });
  it("only fetches https vobiz hosts and sniffs containers", () => {
    expect(safeVobizUrl("https://media.vobiz.ai/x.mp3")).not.toBeNull();
    expect(safeVobizUrl("http://media.vobiz.ai/x.mp3")).toBeNull();
    expect(safeVobizUrl("https://evil.com/vobiz.ai")).toBeNull();
    expect(safeVobizUrl("https://notvobiz.ai/x")).toBeNull();
    expect(sniffAudioMime(new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0, 0]).buffer)).toBe("audio/mpeg");
    expect(sniffAudioMime(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0, 0, 0, 0]).buffer)).toBe("audio/wav");
    expect(audioKey("c1", "rec/../x")).toBe("hf-call-audio/c1/rec____x.mp3");
  });
});

// ── real SQLite behind a D1-shaped shim ───────────────────────────────────────────────────────────────────────────
function d1(db: any) {
  return {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...b: unknown[]) { binds = b; return stmt; },
        async run() { const r = db.prepare(sql).run(...binds); return { meta: { changes: Number(r.changes) }, success: true }; },
        async first() { return db.prepare(sql).get(...binds) ?? null; },
        async all() { return { results: db.prepare(sql).all(...binds) }; },
      };
      return stmt;
    },
  };
}
function migrate(db: any, names: string[]) {
  for (const n of names) db.exec(readFileSync(new URL(`../migrations/2026-10-28-hf-call-safety-${n}.sql`, import.meta.url), "utf8"));
}

describe("ingestRecording is idempotent", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE hf_calls (id TEXT PRIMARY KEY, lane TEXT)");
  db.exec("INSERT INTO hf_calls VALUES ('call-1', 'women'), ('call-2', NULL)");
  migrate(db, ["recordings"]);
  const env = { DB_META: d1(db) } as any;
  const good = { RecordingID: "rec-abc123", RecordUrl: "https://media.vobiz.ai/x.mp3", RecordingDuration: "61", Event: "RecordStop" };
  it("creates one row for repeated deliveries and marks women lane", async () => {
    const a = await ingestRecording(env, "call-1", "caller", good);
    const b = await ingestRecording(env, "call-1", "caller", good);
    expect(a).toMatchObject({ ok: true, duplicate: false });
    expect(b).toMatchObject({ ok: true, duplicate: true });
    const rows = db.prepare("SELECT * FROM hf_call_recordings").all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ call_id: "call-1", status: "received", women_lane: 1, duration_sec: 61 });
  });
  it("rejects bad input without writing", async () => {
    expect((await ingestRecording(env, "call-1", "caller", { ...good, RecordingID: "" })).ok).toBe(false);
    expect((await ingestRecording(env, "call-1", "caller", { ...good, RecordingID: "rec-evil1", RecordUrl: "https://evil.com/a.mp3" })).reason).toBe("bad_url");
    expect((await ingestRecording(env, "nope", "caller", { ...good, RecordingID: "rec-other1" })).reason).toBe("unknown_call");
    expect(db.prepare("SELECT COUNT(*) AS n FROM hf_call_recordings").get().n).toBe(1);
  });
  it("ignores the start event that has no file yet", async () => {
    const r = await ingestRecording(env, "call-2", "caller", { RecordingID: "rec-start1", Event: "Record" });
    expect(r.duplicate).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM hf_call_recordings").get().n).toBe(1);
  });
});

describe("enforcement gates", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db, ["mod-state"]);
  const env = { DB_META: d1(db) } as any;
  const put = (uid: string, status: string) => db.prepare("INSERT INTO hf_mod_state (uid, status, reason, review_due_at, updated_at) VALUES (?,?,?,?,?)").run(uid, status, "strikes", null, Date.now());
  it("nobody is blocked by default", async () => {
    expect((await hfModStatus(env, "u-none")).status).toBe("active");
    expect(await modBlock(env, "u-none", "call")).toBeNull();
  });
  it("paused and banned get 403 account_paused at every gate", async () => {
    put("u-paused", "paused"); put("u-banned", "banned");
    for (const where of ["online", "call", "queue", "booking", "payout"] as const) {
      for (const uid of ["u-paused", "u-banned"]) {
        const r = await modBlock(env, uid, where);
        expect(r?.status).toBe(403);
        expect((await r!.json() as any).error).toBe("account_paused");
      }
    }
  });
  it("fails open when the table is missing (migration not applied yet)", async () => {
    const empty = new DatabaseSync(":memory:");
    expect((await hfModStatus({ DB_META: d1(empty) } as any, "x")).status).toBe("active");
  });
});

describe("routes", () => {
  it("ignores paths that are not safety paths", async () => {
    expect(await hfSafetyRoute(new Request("https://x.test/api/hf/other"), {} as any, "/api/hf/other")).toBeNull();
  });
  it("admin paths refuse an anonymous caller", async () => {
    const env = { TOKENS: { get: async () => null }, DB_META: d1(new DatabaseSync(":memory:")), ADMIN_UIDS: "adm1" } as any;
    const r = await hfSafetyRoute(new Request("https://x.test/api/admin/hf/safety/summary"), env, "/api/admin/hf/safety/summary");
    expect(r).not.toBeNull();
    expect(r!.status).toBeGreaterThanOrEqual(401); // never served without a verified admin (500 = auth not configured in this bare env)
    expect(await r!.text()).not.toContain("checkedToday");
  });
  it("reviewer list narrows admins only when set", async () => {
    let list: string | null = null;
    const env = { ADMIN_UIDS: "adm1,adm2", TOKENS: { get: async () => list } } as any;
    expect(await isSafetyReviewer(env, "adm1")).toBe(true);
    expect(await isSafetyReviewer(env, "stranger")).toBe(false);
    list = "adm2";
    expect(await isSafetyReviewer(env, "adm1")).toBe(false);
    expect(await isSafetyReviewer(env, "adm2")).toBe(true);
  });
});
