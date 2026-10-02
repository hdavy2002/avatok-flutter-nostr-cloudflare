import { describe, it, expect } from "vitest";
import { sniffImage, photoKindAllowed } from "./file";

describe("sniffImage", () => {
  it("recognises jpeg and png by magic bytes", () => {
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0]))?.ext).toBe("jpg");
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))?.mime).toBe("image/png");
  });
  it("rejects anything else", () => {
    expect(sniffImage(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBeNull(); // gif
    expect(sniffImage(new Uint8Array([]))).toBeNull();
    expect(sniffImage(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
  });
});
describe("photoKindAllowed", () => {
  it("palm kinds only for palmistry, face kinds only for face_reading", () => {
    expect(photoKindAllowed("palmistry", "palm_right")).toBe(true);
    expect(photoKindAllowed("palmistry", "face_front")).toBe(false);
    expect(photoKindAllowed("face_reading", "face_side")).toBe(true);
    expect(photoKindAllowed("astrology", "palm_left")).toBe(false);
    expect(photoKindAllowed("tarot", "")).toBe(false);
  });
});
