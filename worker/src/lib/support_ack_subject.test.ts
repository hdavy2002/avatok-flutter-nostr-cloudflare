// [HF-SUPPORT-ACK-SUBJECT-1] the ack subject leads with the ticket number and still threads back.
import { describe, expect, it } from "vitest";
import { ticketFromSubject, cleanTicketSubject } from "./support_core";
import { ackSubject, ticketSubject } from "./support_mail";

describe("ack subject", () => {
  it("leads with the ticket number", () => {
    expect(ackSubject(10002, "help")).toBe("Ticket HF-10002 received: help");
    expect(ackSubject(10002, "")).toBe("Ticket HF-10002 received: Your request");
  });
  it("a reply to the ack finds its ticket", () => {
    expect(ticketFromSubject("Re: Ticket HF-10002 received: help")).toBe(10002);
    expect(ticketFromSubject("Re: [HF-10003] help")).toBe(10003);
    expect(ticketFromSubject("my ticket is broken")).toBeNull();
  });
  it("never stacks prefixes", () => {
    expect(cleanTicketSubject("Re: Ticket HF-10002 received: help")).toBe("help");
    expect(ticketSubject(10002, "Re: Ticket HF-10002 received: help")).toBe("[HF-10002] help");
  });
});
