import { describe, expect, it } from "vitest";
import { buildSfuPrepareBody, isDataChannelOnlySdp } from "../src/routes/call_sfu";

describe("authenticated SFU transport prepare contract", () => {
  const dataOnlyOffer = [
    "v=0",
    "o=- 0 0 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    "a=group:BUNDLE 0",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "a=mid:0",
  ].join("\r\n");

  it("accepts a datachannel-only SDP offer", () => {
    expect(isDataChannelOnlySdp(dataOnlyOffer)).toBe(true);
  });

  it("rejects offers that include media sections", () => {
    expect(isDataChannelOnlySdp(`${dataOnlyOffer}\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n`)).toBe(false);
    expect(isDataChannelOnlySdp("v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n")).toBe(false);
  });

  it("rejects a non-WebRTC application transport", () => {
    expect(isDataChannelOnlySdp("v=0\r\nm=application 9 TCP/DTLS/SCTP arbitrary\r\n")).toBe(false);
  });

  it("uses Cloudflare's camel-case DataChannel establish contract", () => {
    const body = buildSfuPrepareBody(dataOnlyOffer);
    expect(body).toEqual({
      dataChannel: { location: "remote", dataChannelName: "server-events" },
      sessionDescription: { type: "offer", sdp: dataOnlyOffer },
    });
    expect(body).not.toHaveProperty("datachannel");
  });
});
