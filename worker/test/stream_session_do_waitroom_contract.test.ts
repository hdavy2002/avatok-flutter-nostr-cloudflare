import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sanitizeChatAttachment } from "../src/do/stream_session";

// [WAITROOM-1] Source-level contract tests for StreamSessionDO's new
// waiting-room message shapes, matching this codebase's convention for DO
// tests that don't stand up a full SQLite-backed DurableObjectState (see
// test/messenger_call_billing_do_contract.test.ts / *_behavior.test.ts).
const DO = readFileSync("src/do/stream_session.ts", "utf8");

function methodSource(source: string, signature: string, endMarker: string): string {
  const start = source.indexOf(signature);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end <= start) throw new Error(`source boundary not found: ${signature}`);
  return source.slice(start, end);
}

describe("StreamSessionDO roster message", () => {
  it("sends roster on the welcome frame and computes it from live sockets", () => {
    const handleWs = methodSource(DO, "private handleWs(req: Request)", "async webSocketMessage");
    expect(handleWs).toMatch(/type:\s*"welcome"[\s\S]{0,400}roster:\s*this\.rosterFlags\(\)/);
  });

  it("re-sends roster after a presence join", () => {
    const handleWs = methodSource(DO, "private handleWs(req: Request)", "async webSocketMessage");
    // presence:true is queued alongside a fresh roster computation, not a stale snapshot.
    expect(handleWs).toMatch(/type:\s*"presence"[\s\S]{0,20}joined:\s*true[\s\S]{0,200}type:\s*"roster"/);
  });

  it("re-sends roster after a presence leave, excluding the closing socket", () => {
    const dropped = methodSource(DO, "private dropped(ws: WebSocket)", "// ---");
    expect(dropped).toMatch(/type:\s*"presence"[\s\S]{0,60}joined:\s*false[\s\S]{0,200}type:\s*"roster"[\s\S]{0,60}rosterFlags\(ws\)/);
  });

  it("rosterFlags reports independent host/attendee booleans, excluding a given socket", () => {
    const flags = methodSource(DO, "private rosterFlags(", "\n  }");
    expect(flags).toMatch(/host\s*=\s*true/);
    expect(flags).toMatch(/attendee\s*=\s*true/);
    expect(flags).toContain("if (ws === excludeWs) continue;");
    expect(flags).toMatch(/return\s*{\s*host,\s*attendee,\s*host_checked_in_at/);
  });

  it("welcome and every roster message carry host_checked_in_at", () => {
    const handleWs = methodSource(DO, "private handleWs(req: Request)", "async webSocketMessage");
    expect(handleWs).toMatch(/type:\s*"welcome"[\s\S]{0,400}host_checked_in_at:/);
    const flags = methodSource(DO, "private rosterFlags(", "\n  }");
    expect(flags).toContain("host_checked_in_at");
  });

  it("records the first host socket open time once, idempotently", () => {
    const handleWs = methodSource(DO, "private handleWs(req: Request)", "async webSocketMessage");
    expect(handleWs).toMatch(/if \(role === "host"\)[\s\S]{0,200}host_checked_in_at/);
    expect(handleWs).toContain("if (!already.host_checked_in_at)");
  });

  it("migrates the session table in place for DOs created before host_checked_in_at existed", () => {
    expect(DO).toContain("ALTER TABLE session ADD COLUMN host_checked_in_at INTEGER");
  });
});

describe("StreamSessionDO live_grace listing_id [WAITROOM-4 / R3]", () => {
  it("live_grace_arm stores listing_id (and backfills sid/kind) instead of relying on `schedule` ever having run", () => {
    const armCase = methodSource(DO, 'case "live_grace_arm":', 'case "live_grace_clear":');
    expect(armCase).toContain("body.listing_id");
    expect(armCase).toContain("UPDATE session SET listing_id=?1");
    expect(armCase).toContain("await this.armAlarm(Number(body.t)");
  });

  it("migrates the session table in place for DOs created before listing_id existed", () => {
    expect(DO).toContain("ALTER TABLE session ADD COLUMN listing_id TEXT");
  });

  it("alarm() passes listing_id (falling back to sid) to endLiveOnHostNoReturn, not sid alone", () => {
    const alarm = methodSource(DO, "async alarm(): Promise<void>", "private async flushGifts");
    expect(alarm).toContain("const graceListingId = s.listing_id || s.sid;");
    expect(alarm).toMatch(/if \(d\.kind === "live_grace" && graceListingId\)/);
    expect(alarm).toContain("endLiveOnHostNoReturn(this.env, String(graceListingId));");
    // The old bug: gating solely on s.sid, which the commercial live lane
    // (never calling `schedule` on this DO) would leave permanently empty.
    expect(alarm).not.toMatch(/d\.kind === "live_grace" && s\.sid/);
  });
});

describe("StreamSessionDO chat relay", () => {
  it("relays chat as {from, text, at, uid} distinct from the flying-message wire shape", () => {
    const wsMessage = methodSource(DO, "async webSocketMessage", "async webSocketClose");
    // [APP-ONLY-TX-1] The no-attachment branch must stay byte-identical to the
    // shape every already-shipped client was written against.
    expect(wsMessage).toMatch(/t === "chat"[\s\S]{0,1600}: \{\s*type:\s*"chat",\s*from:\s*meta\.name,\s*text,\s*at:\s*now,\s*uid:\s*meta\.uid\s*\}\)/);
  });

  it("caps chat at 500 chars (not the 120-char flying-message cap)", () => {
    const wsMessage = methodSource(DO, "async webSocketMessage", "async webSocketClose");
    const chatBlock = wsMessage.slice(wsMessage.indexOf('t === "chat"'));
    expect(chatBlock).toContain(".slice(0, 500)");
  });

  it("chat reuses the mute/ban gate and the slow-mode check", () => {
    const wsMessage = methodSource(DO, "async webSocketMessage", "async webSocketClose");
    // The mute/ban gate is a single early return at the top of the handler,
    // shared by every message type including chat.
    expect(wsMessage).toMatch(/mod\)\s*return;/);
    const chatBlock = wsMessage.slice(wsMessage.indexOf('t === "chat"'));
    expect(chatBlock).toContain("slow_mode_sec");
    expect(chatBlock).toContain("last_msg");
    expect(chatBlock).toContain("PROFANITY.test(text)");
  });

  // ── [APP-ONLY-TX-1 2026-09-12] attachment pass-through (RULEBOOK §7) ──
  it("relays an optional attachment object alongside the chat line", () => {
    const wsMessage = methodSource(DO, "async webSocketMessage", "async webSocketClose");
    const chatBlock = wsMessage.slice(wsMessage.indexOf('t === "chat"'));
    expect(chatBlock).toContain("sanitizeChatAttachment(m.attachment)");
    expect(chatBlock).toMatch(/type:\s*"chat",\s*from:\s*meta\.name,\s*text,\s*at:\s*now,\s*uid:\s*meta\.uid,\s*attachment/);
  });

  it("accepts an attachment-only line (no caption) but never an empty one", () => {
    const wsMessage = methodSource(DO, "async webSocketMessage", "async webSocketClose");
    const chatBlock = wsMessage.slice(wsMessage.indexOf('t === "chat"'));
    expect(chatBlock).toContain("if (!text && !attachment) return;");
  });

  it("sanitizeChatAttachment enforces https, a 1 KB envelope, a 25 MB size cap and an allow-list of types", () => {
    expect(DO).toContain("const ATTACH_MAX_JSON = 1024;");
    expect(DO).toContain("const ATTACH_MAX_BYTES = 25 * 1024 * 1024;");
    const fn = methodSource(DO, "export function sanitizeChatAttachment", "\n}");
    expect(fn).toContain("/^https:\\/\\//i.test(url)");
    expect(fn).toContain("ATTACH_MIME_OK.test(mime)");
    expect(fn).toContain("size > ATTACH_MAX_BYTES");
    expect(fn).toContain("JSON.stringify(out).length > ATTACH_MAX_JSON");
  });

  // [APP-ONLY-TX-WORKER-1] The attachment URL must point at our own CDN/R2
  // public read host (RULEBOOK §7 file-upload work) — never a foreign URL a
  // client could smuggle in and have relayed as if avaTOK hosted it.
  it("sanitizeChatAttachment rejects a URL whose host is not our own blossom CDN", () => {
    const fn = methodSource(DO, "export function sanitizeChatAttachment", "\n}");
    expect(fn).toContain("ATTACH_HOST_OK.test(parsed.hostname)");
    expect(DO).toMatch(/ATTACH_HOST_OK = \/\^\(blossom\(-staging\)\?\\\.avatok\\\.ai\)\$\/i;/);
  });
});

// [APP-ONLY-TX-WORKER-1] Runtime (not just source-text) coverage of the
// exported validator — sanitizeChatAttachment is a pure function, so this
// runs it for real rather than pattern-matching its source.
describe("sanitizeChatAttachment (runtime)", () => {
  const base = { url: "https://blossom.avatok.ai/u/1/public/deadbeef", name: "notes.pdf", size: 1024, mime: "application/pdf" };

  it("accepts a well-formed descriptor on our own blossom host (prod)", () => {
    expect(sanitizeChatAttachment(base)).toEqual(base);
  });

  it("accepts the staging blossom host too", () => {
    const staged = { ...base, url: "https://blossom-staging.avatok.ai/u/1/public/deadbeef" };
    expect(sanitizeChatAttachment(staged)).toEqual(staged);
  });

  it("rejects a foreign host masquerading as our CDN", () => {
    expect(sanitizeChatAttachment({ ...base, url: "https://evil.example.com/x" })).toBeNull();
    expect(sanitizeChatAttachment({ ...base, url: "https://blossom.avatok.ai.evil.com/x" })).toBeNull();
    expect(sanitizeChatAttachment({ ...base, url: "https://notblossom.avatok.ai/x" })).toBeNull();
  });

  it("rejects http (non-https)", () => {
    expect(sanitizeChatAttachment({ ...base, url: "http://blossom.avatok.ai/x" })).toBeNull();
  });

  it("rejects a disallowed mime type", () => {
    expect(sanitizeChatAttachment({ ...base, mime: "application/x-msdownload" })).toBeNull();
  });

  it("rejects a size over the 25 MB cap", () => {
    expect(sanitizeChatAttachment({ ...base, size: 25 * 1024 * 1024 + 1 })).toBeNull();
  });

  it("accepts exactly the 25 MB cap", () => {
    expect(sanitizeChatAttachment({ ...base, size: 25 * 1024 * 1024 })).not.toBeNull();
  });

  it("rejects a negative or non-numeric size", () => {
    expect(sanitizeChatAttachment({ ...base, size: -1 })).toBeNull();
    expect(sanitizeChatAttachment({ ...base, size: "big" })).toBeNull();
  });

  it("rejects a missing/garbage url", () => {
    expect(sanitizeChatAttachment({ ...base, url: "" })).toBeNull();
    expect(sanitizeChatAttachment({ ...base, url: "not a url" })).toBeNull();
    expect(sanitizeChatAttachment(null)).toBeNull();
    expect(sanitizeChatAttachment("string")).toBeNull();
  });

  it("defaults and truncates the file name", () => {
    expect(sanitizeChatAttachment({ ...base, name: undefined }).name).toBe("file");
    const long = sanitizeChatAttachment({ ...base, name: "a".repeat(500) });
    expect(long.name.length).toBe(120);
  });
});

describe("StreamSessionDO commercial money-alarm no-op", () => {
  it("stores a commercial flag on schedule", () => {
    const schedule = methodSource(DO, 'case "schedule":', "return json({ ok: true });");
    expect(schedule).toMatch(/commercial=\?7/);
    expect(schedule).toMatch(/body\.commercial === true \? 1 : 0/);
  });

  it("skips the Q_MONEY evaluate send for commercial sessions but still marks session_ended", () => {
    const alarm = methodSource(DO, "async alarm(): Promise<void>", "private async flushGifts");
    expect(alarm).toMatch(/Number\(s\.commercial\)\s*!==\s*1/);
    // The Q_MONEY send must be nested inside that guard.
    const guardIdx = alarm.indexOf("Number(s.commercial)");
    const sendIdx = alarm.indexOf("Q_MONEY.send");
    expect(sendIdx).toBeGreaterThan(guardIdx);
    // session_ended still fires unconditionally on money_end so waiting-room
    // clients learn the slot is over even though settlement is elsewhere.
    const sessionEndedIdx = alarm.indexOf('type: "session_ended"');
    expect(sessionEndedIdx).toBeGreaterThan(sendIdx);
  });

  it("migrates the session table in place for DOs created before the commercial column existed", () => {
    expect(DO).toContain("ALTER TABLE session ADD COLUMN commercial INTEGER NOT NULL DEFAULT 0");
  });
});
