import { describe, it, expect } from "vitest";
import { parseEAadhaarXml, profileDobToIso } from "./sandbox_client";

const PHOTO = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3));

const sample = (over: { uid?: string; pht?: string; gender?: string } = {}) => `<?xml version="1.0" encoding="UTF-8"?>
<Certificate type="DigiLocker"><CertificateData><KycRes code="abc" ret="Y" ts="2026-10-09T10:00:00" ttl="">
<UidData uid="${over.uid ?? "xxxxxxxx1234"}" tid="">
<Poi name="Ravi &amp; Sons O&apos;Neil" dob="05-03-1994" gender="${over.gender ?? "M"}"/>
<Poa co="S/O: Mohan &#x4B;umar" house="12/B" street="Gandhi &quot;Marg&quot;" lm="Near Temple" loc="Rajpur" vtc="Dehradun" subdist="Dehradun" dist="Dehradun" state="Uttarakhand" pc="248001" po="Rajpur" country="India"/>
<LData lang="06" name="रवि" co="S/O: मोहन" house="१२" vtc="देहरादून" state="उत्तराखंड"/>
${over.pht === "" ? "" : `<Pht>${over.pht ?? PHOTO}</Pht>`}
</UidData></KycRes></CertificateData><Signature>sig</Signature></Certificate>`;

describe("parseEAadhaarXml", () => {
  it("parses a realistic e-Aadhaar", () => {
    const k = parseEAadhaarXml(sample())!;
    expect(k).not.toBeNull();
    expect(k.last4).toBe("1234");
    expect(k.name).toBe("Ravi & Sons O'Neil");
    expect(k.gender).toBe("M");
    expect(k.dobIso).toBe("1994-03-05");
    expect(k.yearOfBirth).toBe(1994);
    expect(k.careOf).toBe("Mohan Kumar");
    expect(k.address).toContain('Gandhi "Marg"');
    expect(k.address).toContain("Uttarakhand");
    expect(k.address).not.toContain("देहरादून");
    expect(Array.from(k.photo!)).toEqual([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  });
  it("keeps gender T", () => {
    expect(parseEAadhaarXml(sample({ gender: "T" }))!.gender).toBe("T");
  });
  it("returns null photo when Pht is missing or empty", () => {
    expect(parseEAadhaarXml(sample({ pht: "" }))!.photo).toBeNull();
    expect(parseEAadhaarXml(sample({ pht: "  \n " }))!.photo).toBeNull();
  });
  it("tolerates whitespace-wrapped base64 and alternative attribute names", () => {
    const xml = `<UidData uid='xxxxxxxx9876'><Poi name='A B' dob='1990' gender='F'/><Poa careof='D/O Sita' landmark='L' locality='Loc' district='D' pincode='111111'/><Pht>${PHOTO.slice(0, 4)}\n${PHOTO.slice(4)}</Pht></UidData>`;
    const k = parseEAadhaarXml(xml)!;
    expect(k.last4).toBe("9876");
    expect(k.dobIso).toBeNull();
    expect(k.yearOfBirth).toBe(1990);
    expect(k.careOf).toBe("Sita");
    expect(k.address).toBe("L, Loc, D, 111111");
    expect(k.photo!.length).toBe(7);
  });
  it("returns null without a uid", () => {
    expect(parseEAadhaarXml(sample({ uid: "" }))).toBeNull();
    expect(parseEAadhaarXml(sample().replace(/<UidData[^>]*>/, "<UidData>"))).toBeNull();
  });
  it("returns null for garbage", () => {
    expect(parseEAadhaarXml("")).toBeNull();
    expect(parseEAadhaarXml("not xml at all, just some text here")).toBeNull();
    expect(parseEAadhaarXml("<html><body>Access denied</body></html>")).toBeNull();
  });
});

describe("profileDobToIso", () => {
  it("handles ms, seconds and strings", () => {
    expect(profileDobToIso(Date.UTC(1994, 2, 5))).toBe("1994-03-05");
    expect(profileDobToIso(Date.UTC(1994, 2, 5) - 5.5 * 3600_000)).toBe("1994-03-05"); // IST midnight
    expect(profileDobToIso(Date.UTC(1994, 2, 5) / 1000)).toBe("1994-03-05");
    expect(profileDobToIso("05-03-1994")).toBe("1994-03-05");
    expect(profileDobToIso("1994-03-05")).toBe("1994-03-05");
    expect(profileDobToIso("junk")).toBeNull();
    expect(profileDobToIso(undefined)).toBeNull();
  });
});
