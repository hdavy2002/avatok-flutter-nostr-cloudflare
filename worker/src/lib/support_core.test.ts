// [HF-SUPPORT-1] Pure rules: numbering, threading, status machine, business hours, loop / spam detection.
import { describe, it, expect } from "vitest";
import {
  allocateTicketNumber, ticketFromRecipients, ticketFromSubject, resolveThread, statusOnCustomerMessage, canCustomerReopen,
  classifyMail, mayAutoReply, spamScore, checkAttachment, defaultPriority, statusLabel, isBusinessTime, nextBusinessOpen,
  addBusinessMs, firstResponseDue, slaState, ackMessage, loadSettings, stripQuotedReply, sanitizeHtml, replyToFor, DAY_MS, HOUR_MS,
} from "./support_core";
import { parseMime } from "./support_mime";
import { makeEnv, rawMail } from "./support_testkit";

// Thursday 29 Oct 2026, 11:00 IST = 05:30Z. Sunday 1 Nov 2026 12:00 IST = 06:30Z.
const THU_11 = Date.parse("2026-10-29T05:30:00Z");
const THU_20 = Date.parse("2026-10-29T14:30:00Z");
const SUN_12 = Date.parse("2026-11-01T06:30:00Z");

describe("ticket numbers", () => {
  it("start at 10001 and never repeat", async () => {
    const t = makeEnv();
    const seen = new Set<number>();
    for (let i = 0; i < 25; i++) seen.add(await allocateTicketNumber(t.env));
    expect(seen.size).toBe(25);
    expect(Math.min(...seen)).toBe(10001);
    expect(Math.max(...seen)).toBe(10025);
  });
  it("is atomic under concurrency", async () => {
    const t = makeEnv();
    const all = await Promise.all(Array.from({ length: 20 }, () => allocateTicketNumber(t.env)));
    expect(new Set(all).size).toBe(20);
  });
});

describe("threading", () => {
  it("reads the number from support+N@ recipients of our domain only", () => {
    expect(ticketFromRecipients(["x@y.com", "Support+10234@HelloFraands.com"])).toBe(10234);
    expect(ticketFromRecipients(["support+10234@evil.com"])).toBeNull();
    expect(ticketFromRecipients(["other+10234@hellofraands.com"])).toBeNull();
  });
  it("reads [HF-N] from the subject through Re:/Fwd:", () => {
    expect(ticketFromSubject("Re: Fwd: [HF-10234] Wallet issue")).toBe(10234);
    expect(ticketFromSubject("no tag")).toBeNull();
  });
  it("prefers recipient, then subject, then In-Reply-To, then References", async () => {
    const lookup = async (id: string) => (id === "a@x" ? 10050 : id === "b@x" ? 10060 : null);
    const base = { recipients: [] as string[], subject: "hi", inReplyTo: null as string | null, references: [] as string[] };
    expect(await resolveThread({ ...base, recipients: ["support+10001@hellofraands.com"], subject: "[HF-10002] x" }, lookup)).toEqual({ number: 10001, source: "recipient", tag: null });
    expect(await resolveThread({ ...base, subject: "[HF-10002] x", inReplyTo: "a@x" }, lookup)).toEqual({ number: 10002, source: "subject" });
    expect(await resolveThread({ ...base, inReplyTo: "a@x" }, lookup)).toEqual({ number: 10050, source: "in_reply_to" });
    expect(await resolveThread({ ...base, inReplyTo: "zz@x", references: ["b@x", "zz@x"] }, lookup)).toEqual({ number: 10060, source: "references" });
    expect(await resolveThread(base, lookup)).toBeNull();
  });
  it("uses the brand domain for Reply-To", async () => {
    // [HF-REPLY-ADDR-1] tagged; see support_reply_address.test.ts
    expect((await replyToFor(makeEnv().env, 10234)).email).toMatch(/^support\+10234-[0-9a-f]{10}@hellofraands\.com$/);
  });
});

describe("status machine", () => {
  const now = Date.parse("2026-10-29T00:00:00Z");
  it("waiting and on_hold become open on a customer reply", () => {
    expect(statusOnCustomerMessage("waiting", null, now)).toEqual({ action: "append", status: "open", reopened: false });
    expect(statusOnCustomerMessage("on_hold", null, now)).toEqual({ action: "append", status: "open", reopened: false });
  });
  it("solved within 7 days reopens, after 7 days opens a linked ticket", () => {
    expect(statusOnCustomerMessage("solved", now - 6 * DAY_MS, now)).toEqual({ action: "append", status: "open", reopened: true });
    expect(statusOnCustomerMessage("solved", now - 8 * DAY_MS, now)).toEqual({ action: "new_linked" });
    expect(canCustomerReopen("solved", now - 6 * DAY_MS, now)).toBe(true);
    expect(canCustomerReopen("solved", now - 8 * DAY_MS, now)).toBe(false);
    expect(canCustomerReopen("closed", now, now)).toBe(false);
  });
  it("closed opens a linked ticket and spam is ignored", () => {
    expect(statusOnCustomerMessage("closed", now, now)).toEqual({ action: "new_linked" });
    expect(statusOnCustomerMessage("spam", null, now)).toEqual({ action: "ignore" });
  });
  it("customer labels and default priorities follow the contract", () => {
    expect(["new", "open", "on_hold"].map(statusLabel)).toEqual(["Open", "Open", "Open"]);
    expect(statusLabel("waiting")).toBe("We replied");
    expect(statusLabel("solved")).toBe("Solved");
    expect(statusLabel("closed")).toBe("Closed");
    expect(defaultPriority("report")).toBe("urgent");
    expect(defaultPriority("wallet")).toBe("high");
    expect(defaultPriority("withdraw")).toBe("high");
    expect(defaultPriority("app")).toBe("normal");
  });
});

describe("business hours and SLA", () => {
  it("Mon-Sat 10-19 IST", () => {
    expect(isBusinessTime(THU_11)).toBe(true);
    expect(isBusinessTime(THU_20)).toBe(false);
    expect(isBusinessTime(SUN_12)).toBe(false);
  });
  it("after hours rolls to the next opening (Monday 10:00 IST for Sunday)", () => {
    expect(nextBusinessOpen(SUN_12)).toBe(Date.parse("2026-11-02T04:30:00Z"));
  });
  it("24 business hours is 3 working days of 9h minus; urgent is 2h", () => {
    expect(firstResponseDue("urgent", THU_11)).toBe(THU_11 + 2 * HOUR_MS);
    const due = firstResponseDue("normal", THU_11);
    expect(due).toBe(addBusinessMs(THU_11, 24 * HOUR_MS));
    expect(due).toBeGreaterThan(THU_11 + 2 * DAY_MS); // 24 business hours span 2.67 working days
    expect(isBusinessTime(due - 1)).toBe(true);
  });
  it("sla state goes ok -> amber -> red", () => {
    const created = THU_11;
    const due = created + 10 * HOUR_MS;
    expect(slaState(due, null, created, created + HOUR_MS)).toBe("ok");
    expect(slaState(due, null, created, created + 9 * HOUR_MS)).toBe("amber");
    expect(slaState(due, null, created, due + 1)).toBe("red");
    expect(slaState(due, created + 1, created, due + 5 * HOUR_MS)).toBe("ok");
  });
  it("ack text adds the hours line only outside business hours", async () => {
    const s = await loadSettings(makeEnv().env);
    expect(ackMessage(10234, THU_11, s)).toBe("Your ticket HF-10234 is open. Someone from Hello Fraands will respond back soon.");
    expect(ackMessage(10234, THU_20, s)).toContain("Our team works 10 am–7 pm IST, Monday to Saturday. We'll reply within 24 hours.");
  });
});

describe("loop, auto-reply and spam rules", () => {
  const cls = (h: Record<string, string>, from = "fan@example.com") => classifyMail(parseMime(rawMail({ From: from, Subject: "hello", ...h }, "body")), from);
  it("accepts a normal mail", () => expect(mayAutoReply(cls({}))).toBe(true));
  it("never auto-replies to auto-submitted, precedence bulk, list, bounce, no-reply, or our own mail", () => {
    expect(mayAutoReply(cls({ "Auto-Submitted": "auto-replied" }))).toBe(false);
    expect(mayAutoReply(cls({ Precedence: "bulk" }))).toBe(false);
    expect(mayAutoReply(cls({ "List-Id": "<l.example.com>" }))).toBe(false);
    expect(mayAutoReply(cls({ "Return-Path": "<>" }))).toBe(false);
    expect(mayAutoReply(cls({}, "no-reply@shop.com"))).toBe(false);
    expect(mayAutoReply(cls({}, "mailer-daemon@x.com"))).toBe(false);
    expect(mayAutoReply(cls({}, "support@hellofraands.com"))).toBe(false);
    expect(mayAutoReply(cls({ "X-Saathum-Outbox-Key": "k" }))).toBe(false);
    expect(mayAutoReply(cls({ Subject: "Out of office: back Monday" }))).toBe(false);
  });
  it("auto-submitted: no does not count", () => expect(cls({ "Auto-Submitted": "no" }).autoReply).toBe(false));
  it("scores spam on failed authentication plus spam words, not on a plain question", () => {
    const spam = parseMime(rawMail({ From: "a@b.co", Subject: "WINNER lottery click here", "Authentication-Results": "mx; spf=fail; dmarc=fail" }, "bitcoin giveaway"));
    expect(spamScore(spam).isSpam).toBe(true);
    const ok = parseMime(rawMail({ From: "a@b.co", Subject: "Wallet top-up failed", "Authentication-Results": "mx; spf=pass; dkim=pass" }, "Money was cut but wallet is empty."));
    expect(spamScore(ok).isSpam).toBe(false);
  });
});

describe("attachments", () => {
  it("allows images and pdf up to 10 MB, refuses executables and archives", () => {
    expect(checkAttachment("a.png", "image/png", 100).ok).toBe(true);
    expect(checkAttachment("a.pdf", "application/pdf", 10 * 1024 * 1024).ok).toBe(true);
    expect(checkAttachment("a.pdf", "application/pdf", 10 * 1024 * 1024 + 1)).toEqual({ ok: false, reason: "too_large" });
    for (const n of ["x.exe", "x.apk", "x.bat", "x.js", "x.scr", "x.zip", "X.EXE", "x.png.exe"]) {
      expect(checkAttachment(n, "image/png", 10)).toEqual({ ok: false, reason: "blocked_type" });
    }
    expect(checkAttachment("a.png", "image/png", 0)).toEqual({ ok: false, reason: "empty" });
  });
});

describe("text helpers", () => {
  it("strips quoted replies and signatures lines", () => {
    const t = "Thanks, that worked.\n\nOn Thu, 29 Oct 2026 at 10:00, Hello Fraands Support <support@hellofraands.com> wrote:\n> old stuff\n> more";
    expect(stripQuotedReply(t)).toBe("Thanks, that worked.");
  });
  it("sanitises HTML (no script, handlers, javascript: urls)", () => {
    const out = sanitizeHtml('<p onclick="x()">hi<script>alert(1)</script><a href="javascript:alert(1)">l</a><img src=x onerror=alert(1)></p>');
    expect(out).not.toMatch(/script|onclick|onerror|javascript:/i);
    expect(out).toContain("hi");
  });
});
