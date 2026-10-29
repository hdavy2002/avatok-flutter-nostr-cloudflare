// [HF-SUPPORT-1] MIME parsing: RFC 2047 subject, multipart with an attachment, quoted-printable / base64 / charsets.
import { describe, it, expect } from "vitest";
import { parseMime, decodeEncodedWords, parseAddressList, parseParams, decodeQuotedPrintable } from "./support_mime";

const b64 = (s: string) => btoa(s);
const utf8b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const PNG_BYTES = String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4);

function sample(): string {
  return [
    `From: =?UTF-8?B?${utf8b64("Rāhul Śarma")}?= <Rahul@Example.com>`,
    "To: Hello Fraands Support <support+10234@hellofraands.com>",
    "Cc: other@example.com, \"Doe, Jane\" <jane@example.org>",
    `Subject: =?UTF-8?B?${utf8b64("Wallet ")}?= =?UTF-8?B?${utf8b64("top-up ✓ failed")}?=`,
    "Message-ID: <abc.123@mail.example.com>",
    "In-Reply-To: <prev.1@hellofraands.com>",
    "References: <first.0@hellofraands.com> <prev.1@hellofraands.com>",
    "Date: Thu, 29 Oct 2026 10:15:00 +0530",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="outer"',
    "",
    "preamble ignored",
    "--outer",
    'Content-Type: multipart/alternative; boundary="inner"',
    "",
    "--inner",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Money was cut but wallet shows nothing. Rs=2E 500 =E2=9C=93",
    "Second line with soft=",
    " break",
    "",
    "--inner",
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    utf8b64("<p>Money was cut <b>today</b></p>"),
    "--inner--",
    "",
    "--outer",
    `Content-Type: image/png; name="=?UTF-8?B?${utf8b64("स्क्रीन.png")}?="`,
    `Content-Disposition: attachment; filename*=UTF-8''%E0%A4%B8%E0%A5%8D%E0%A4%95%E0%A5%8D%E0%A4%B0%E0%A5%80%E0%A4%A8.png`,
    "Content-Transfer-Encoding: base64",
    "",
    b64(PNG_BYTES),
    "--outer",
    "Content-Type: application/pdf",
    'Content-Disposition: attachment; filename="receipt.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    b64("%PDF-1.4 fake"),
    "--outer--",
    "",
  ].join("\r\n");
}

describe("parseMime", () => {
  const m = parseMime(new TextEncoder().encode(sample()));

  it("decodes an RFC 2047 subject made of two adjacent encoded words", () => {
    expect(m.subject).toBe("Wallet top-up ✓ failed");
  });
  it("reads addresses, names, ids and the date", () => {
    expect(m.from).toEqual({ name: "Rāhul Śarma", email: "rahul@example.com" });
    expect(m.to.map((a) => a.email)).toEqual(["support+10234@hellofraands.com"]);
    expect(m.cc.map((a) => a.email)).toEqual(["other@example.com", "jane@example.org"]);
    expect(m.cc[1].name).toBe("Doe, Jane");
    expect(m.messageId).toBe("abc.123@mail.example.com");
    expect(m.inReplyTo).toBe("prev.1@hellofraands.com");
    expect(m.references).toEqual(["first.0@hellofraands.com", "prev.1@hellofraands.com"]);
    expect(m.date).toBe(Date.parse("2026-10-29T04:45:00Z"));
  });
  it("finds text (quoted-printable, soft breaks) and html (base64) inside multipart/alternative", () => {
    expect(m.text).toContain("Money was cut but wallet shows nothing. Rs. 500 ✓");
    expect(m.text).toContain("Second line with soft break");
    expect(m.html).toBe("<p>Money was cut <b>today</b></p>");
  });
  it("extracts attachments with bytes, content type and a decoded RFC 2231 file name", () => {
    expect(m.attachments).toHaveLength(2);
    const [png, pdf] = m.attachments;
    expect(png.filename).toBe("स्क्रीन.png");
    expect(png.contentType).toBe("image/png");
    expect(Array.from(png.content.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(png.size).toBe(12);
    expect(pdf.filename).toBe("receipt.pdf");
    expect(new TextDecoder().decode(pdf.content)).toBe("%PDF-1.4 fake");
  });
  it("keeps raw headers (Authentication-Results etc.) available", () => {
    const x = parseMime("Authentication-Results: mx; spf=fail\r\nFrom: a@b.co\r\n\r\nhi");
    expect(x.headers.get("authentication-results")?.[0]).toContain("spf=fail");
    expect(x.text).toBe("hi");
  });
});

describe("helpers", () => {
  it("decodes ISO-8859-1 Q words and underscores", () => {
    expect(decodeEncodedWords("=?ISO-8859-1?Q?Caf=E9_au_lait?=")).toBe("Café au lait");
  });
  it("leaves plain text alone and never throws on junk", () => {
    expect(decodeEncodedWords("plain subject")).toBe("plain subject");
    expect(() => decodeEncodedWords("=?bogus?X?zz?=")).not.toThrow();
    expect(() => parseMime("not an email at all")).not.toThrow();
  });
  it("parses RFC 2231 continuations", () => {
    const p = parseParams("attachment; filename*0*=UTF-8''a%20b; filename*1=.pdf");
    expect(p.value).toBe("attachment");
    expect(p.params.filename).toBe("a b.pdf");
  });
  it("handles address lists with groups, comments and quoted commas", () => {
    expect(parseAddressList('"Last, First" <a@x.io>, b@y.io (Bee)').map((a) => a.email)).toEqual(["a@x.io", "b@y.io"]);
  });
  it("decodes quoted-printable bytes", () => {
    expect(new TextDecoder().decode(decodeQuotedPrintable("caf=C3=A9=\r\nx"))).toBe("caféx");
  });
  it("decodes a windows-1252 text part", () => {
    const x = parseMime("Content-Type: text/plain; charset=windows-1252\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nPrice =80 5");
    expect(x.text).toBe("Price € 5");
  });
});
