import { describe, it, expect } from "vitest";
import {
  ratePaise, hostSharePerMinPaise, billedMinutes, maxMinutesFor, settleCall, hostTokensToCredit, callerHandle, announceText,
  hostAnnounceXml, noticeAndConferenceXml, hangupXml, callerDidntPickUpXml, SAFETY_NOTICE,
} from "./hf_call_math";

describe("host share", () => {
  it("matches the contract at Rs 5/10/20/30", () => {
    expect([5, 10, 20, 30].map((r) => hostSharePerMinPaise(ratePaise(r)))).toEqual([180, 480, 1080, 1680]);
  });
  it("is 0 at or below the Rs 2 fixed fee and never negative", () => {
    expect(hostSharePerMinPaise(200)).toBe(0);
    expect(hostSharePerMinPaise(100)).toBe(0);
  });
  it("rounds down to whole paise", () => {
    expect(hostSharePerMinPaise(333)).toBe(79); // 0.6 * 133 = 79.8
  });
});

describe("billed minutes", () => {
  it("is zero when nothing connected, else per started minute", () => {
    expect(billedMinutes(0)).toBe(0);
    expect(billedMinutes(-5)).toBe(0);
    expect(billedMinutes(1)).toBe(1);
    expect(billedMinutes(60)).toBe(1);
    expect(billedMinutes(61)).toBe(2);
    expect(billedMinutes(3600)).toBe(60);
  });
});

describe("max minutes", () => {
  it("is balance / rate, capped at 60", () => {
    expect(maxMinutesFor(100, 20)).toBe(5);
    expect(maxMinutesFor(39, 20)).toBe(1);
    expect(maxMinutesFor(19, 20)).toBe(0);
    expect(maxMinutesFor(5000, 5)).toBe(60);
    expect(maxMinutesFor(0, 5)).toBe(0);
  });
});

describe("settleCall", () => {
  it("charges per started minute and pays the host share", () => {
    expect(settleCall({ connectedSeconds: 125, rateRupees: 5, fundsRupees: 100 })).toEqual({ billedMinutes: 3, chargeRupees: 15, hostEarningPaise: 540, capped: false });
  });
  it("charges nothing for a call that never connected", () => {
    expect(settleCall({ connectedSeconds: 0, rateRupees: 20, fundsRupees: 100 })).toEqual({ billedMinutes: 0, chargeRupees: 0, hostEarningPaise: 0, capped: false });
  });
  it("never charges more than the funds secured and counts only the minutes they paid for", () => {
    const s = settleCall({ connectedSeconds: 400, rateRupees: 20, fundsRupees: 50 });
    expect(s.capped).toBe(true);
    expect(s.chargeRupees).toBe(50);
    expect(s.billedMinutes).toBe(2);
    expect(s.hostEarningPaise).toBe(2 * 1080);
  });
});

describe("host tokens carry", () => {
  it("credits whole rupees and carries the remainder", () => {
    expect(hostTokensToCredit(0, 0, 180)).toBe(1);
    expect(hostTokensToCredit(180, 1, 180)).toBe(2); // 360 paise = Rs 3 earned, Rs 1 already credited
    expect(hostTokensToCredit(80, 0, 10)).toBe(0);
  });
});

describe("spoken text", () => {
  it("builds the host announcement", () => {
    expect(announceText("Riya", 3)).toBe("Call from Riya. 3 previous calls with you. Press 1 to accept, 2 to decline.");
    expect(announceText("Riya", 1)).toContain("1 previous call with you");
  });
  it("never reads out digits or handles", () => {
    expect(callerHandle("Riya Sharma")).toBe("Riya");
    expect(callerHandle("9876543210")).toBe("a caller");
    expect(callerHandle("@riya")).toBe("a caller");
    expect(callerHandle(null)).toBe("a caller");
  });
});

describe("XML builders", () => {
  it("host announcement uses GetDigits for 1 and 2 with a 10 s timeout and falls through to hangup", () => {
    const x = hostAnnounceXml({ handle: "Riya", previousCalls: 0, digitsUrl: "https://x/y?a=1&b=2" });
    expect(x).toContain("<GetDigits");
    expect(x).toContain('validDigits="12"');
    expect(x).toContain('timeout="10"');
    expect(x).toContain("a=1&amp;b=2");
    expect(x).toContain("Press 1 to accept, 2 to decline.");
    expect(x.indexOf("</GetDigits>")).toBeLessThan(x.indexOf("<Hangup/>"));
  });
  it("conference XML carries the safety notice, the hash trigger and the callback", () => {
    const x = noticeAndConferenceXml({ room: "hf_abc", callbackUrl: "https://x/conf/host", timeLimitSec: 600 });
    expect(x).toContain(SAFETY_NOTICE);
    expect(x).toContain('digitsMatch="#"');
    expect(x).toContain('callbackUrl="https://x/conf/host"');
    expect(x).toContain('endConferenceOnExit="true"');
    expect(x).toContain(">hf_abc</Conference>");
    expect(x.indexOf("<Speak>")).toBeLessThan(x.indexOf("<Conference"));
  });
  it("hangup helpers", () => {
    expect(hangupXml()).toContain("<Hangup/>");
    expect(callerDidntPickUpXml()).toContain("The caller didn't pick up");
  });
});
