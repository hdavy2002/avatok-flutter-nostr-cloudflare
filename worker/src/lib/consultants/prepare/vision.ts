// [AUMFE-CONSULT-W2-1 2026-10-02] AstrologyAPI VISION host (palm / face). Everything unverified is isolated HERE.
// Known: host https://vision.astrologyapi.com, endpoint passed to astroCall as "palmistry/<ep>" | "face-reading/<ep>" with host:"vision".
// Flow: get-palm-id / get-face-id (upload photo -> id), then readings by that id.
// TODO(verify against the live API; no key locally): (1) the id-request body field name, (2) the id field in the response,
//   (3) the READING paths and the response shapes. Until verified, a failed reading just makes the cards `missing`
//   (the consultant still sees the photos), and an unrecognised id response keeps the photo as accepted-but-unchecked.
import type { PhotoKind } from "../types";
import type { AstroResult } from "../../astrology";
import type { PrepDeps } from "./deps";

export const VISION = {
  palmId: "palmistry/get-palm-id",
  faceId: "face-reading/get-face-id",
  /** TODO(verify) reading endpoints (appended with the id). */
  palmReading: (id: string) => `palmistry/get-palm-reading/${encodeURIComponent(id)}`,
  faceReading: (id: string) => `face-reading/get-face-reading/${encodeURIComponent(id)}`,
  /** TODO(verify) request body for the id call. */
  idBody: (base64: string): Record<string, unknown> => ({ image: base64 }),
} as const;

export const idEndpointFor = (kind: PhotoKind): string => (kind.startsWith("palm") ? VISION.palmId : VISION.faceId);

export type VisionIdState =
  | { state: "accepted"; id: string; reason: null }
  | { state: "rejected"; reason: string }
  | { state: "unchecked"; reason: string };

/** The API refusing the photo (a 4xx with a message) is a rejection; our own/vendor outage is NOT: the customer's photo is kept. */
export function isOutage(r: { ok: false; error: string; status: number }): boolean {
  return r.status === 0 || r.status >= 500 || r.status === 401 || r.status === 403 || r.status === 429 || r.error === "astro_bad_response";
}

export function extractVisionId(data: any): string | null {
  const v = data?.palm_id ?? data?.face_id ?? data?.id ?? data?.data?.palm_id ?? data?.data?.face_id ?? data?.data?.id;
  return v == null || String(v).trim() === "" ? null : String(v).trim();
}

export function classifyVisionId(r: AstroResult<any>): VisionIdState {
  if (!r.ok) {
    if (isOutage(r)) return { state: "unchecked", reason: "not_checked" };
    return { state: "rejected", reason: String(r.error || "photo_not_readable").slice(0, 160) };
  }
  const id = extractVisionId(r.data);
  return id ? { state: "accepted", id, reason: null } : { state: "unchecked", reason: "no_id_returned" };
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(s);
}

export async function visionId(deps: PrepDeps, kind: PhotoKind, bytes: Uint8Array): Promise<VisionIdState> {
  return classifyVisionId(await deps.call(idEndpointFor(kind), VISION.idBody(toBase64(bytes)), "none", "vision"));
}

/** Pick a plain-object view of a vendor payload for display. */
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Best-effort split of a palm reading response into the desk cards. Unknown shape -> everything lands in `readings`. */
export function splitReading(data: unknown, linePattern: RegExp, partPattern: RegExp, typeKeys: string[]) {
  const d = obj(data);
  const inner = obj(d.data ?? d.result ?? d);
  const lines: Record<string, unknown> = {}, parts: Record<string, unknown> = {}, rest: Record<string, unknown> = {};
  let type: unknown = null;
  for (const [k, v] of Object.entries(inner)) {
    if (typeKeys.includes(k)) type = v;
    else if (partPattern.test(k)) parts[k] = v;
    else if (linePattern.test(k)) lines[k] = v;
    else rest[k] = v;
  }
  return { type, lines, parts, rest };
}
export const splitPalm = (data: unknown) => splitReading(data, /line/i, /mount/i, ["hand_type", "hand_shape", "handType", "type"]);
export const splitFace = (data: unknown) => splitReading(data, /reading|prediction|summary|trait|personality/i, /feature|eye|nose|lip|brow|forehead|chin|ear|cheek|jaw/i, ["face_shape", "shape", "face_type"]);
