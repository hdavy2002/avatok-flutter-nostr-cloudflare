// [HF-REPLY-ADDR-1] Unguessable reply addresses: support+N-<tag>@ with a keyed tag.
import { describe, it, expect } from "vitest";
import { makeEnv, rawMail, putInbound, type TestEnv } from "./support_testkit";
import { processInbound } from "./support_inbound";
import { replyToFor, replyTag, isValidReplyTag, recipientThread } from "./support_core";

let seq = 0;
async function send(t: TestEnv, from: string, to: string, subject: string, body: string) {
  const id = `ra${++seq}`;
  const job = await putInbound(t, id, rawMail({ From: from, To: to, Subject: subject, "Message-ID": `<${id}@mail.example.com>` }, body), from, to);
  return processInbound(t.env, job, Date.now()) as Promise<any>;
}

describe("reply address", () => {
  it("is tagged, stable per ticket, different per ticket and per database key", async () => {
    const t = makeEnv();
    const a = (await replyToFor(t.env, 10001)).email;
    expect(a).toMatch(/^support\+10001-[0-9a-f]{10}@hellofraands\.com$/);
    expect((await replyToFor(t.env, 10001)).email).toBe(a);
    expect(await replyTag(t.env, 10002)).not.toBe(await replyTag(t.env, 10001));
    const other = makeEnv();
    expect(await replyTag(other.env, 10001)).not.toBe(await replyTag(makeEnv().env, 10001)); // a fresh key per database
    expect(await isValidReplyTag(t.env, 10001, a.split("-")[1].split("@")[0])).toBe(true);
    expect(await isValidReplyTag(t.env, 10001, "0000000000")).toBe(false);
  });
  it("prefers a tagged recipient over a plain one", () => {
    expect(recipientThread(["support+10001@hellofraands.com", "support+10002-abcdef1234@hellofraands.com"])).toEqual({ number: 10002, tag: "abcdef1234" });
    expect(recipientThread(["support+10001@hellofraands.com"])).toEqual({ number: 10001, tag: null });
  });
});

describe("inbound threading", () => {
  it("a Cc'd person replying to the tagged address lands on the ticket", async () => {
    const t = makeEnv();
    const first = await send(t, "Rahul <rahul@example.com>", "support@hellofraands.com", "Help", "first");
    const to = (await replyToFor(t.env, first.ticket)).email;
    const r = await send(t, "Boss <boss@company.com>", to, "Re: [HF-10001] Help", "adding context from the boss");
    expect(r.result).toBe("appended");
    expect(r.ticket).toBe(10001);
  });
  it("a guessed address (plain or with a wrong tag) from a stranger opens a new ticket instead", async () => {
    const t = makeEnv();
    await send(t, "Rahul <rahul@example.com>", "support@hellofraands.com", "Help", "first");
    const plain = await send(t, "Mallory <m@evil.com>", "support+10001@hellofraands.com", "hi", "inject");
    expect(plain.result).toBe("created");
    expect(plain.ticket).not.toBe(10001);
    const wrong = await send(t, "Mallory <m@evil.com>", "support+10001-0123456789@hellofraands.com", "hi", "inject again");
    expect(wrong.ticket).not.toBe(10001);
  });
  it("the owner can still reply to an old plain address", async () => {
    const t = makeEnv();
    await send(t, "Rahul <rahul@example.com>", "support@hellofraands.com", "Help", "first");
    const r = await send(t, "Rahul <rahul@example.com>", "support+10001@hellofraands.com", "Re: Help", "more");
    expect(r).toMatchObject({ result: "appended", ticket: 10001 });
  });
});
