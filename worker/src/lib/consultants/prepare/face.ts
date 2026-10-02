// [AUMFE-CONSULT-W2-1 2026-10-02] Face-reading cards: face_photos, features, readings.
// Vision host: get-face-id (done at upload / retried here) then the reading by face id. Reading path is isolated in vision.ts (TODO verify).
import type { FaceIntake } from "../types";
import { type CardOut, missing, ok } from "./shared";
import { short, type PrepDeps } from "./deps";
import { VISION, splitFace } from "./vision";
import { photoSummary, type PhotoRow } from "./palmistry";

export async function buildFaceCards(_intake: FaceIntake, photos: PhotoRow[], deps: PrepDeps): Promise<CardOut[]> {
  const usable = photos.filter((p) => p.status !== "rejected");
  const cards: CardOut[] = [];
  cards.push(usable.length ? ok("face_photos", photoSummary(photos), usable.every((p) => p.api_id) ? undefined : "Some photos could not be machine-checked") : missing("face_photos", "No usable face photo was uploaded"));
  const withId = (["face_front", "face_side"] as const).map((k) => usable.find((p) => p.kind === k && p.api_id)).filter((p): p is PhotoRow => !!p);
  if (!withId.length) {
    const why = usable.length ? "Photo could not be machine-checked yet" : "No usable face photo";
    return [...cards, missing("features", why), missing("readings", why)];
  }
  const results = await Promise.all(withId.map(async (p) => ({ p, r: await deps.call(VISION.faceReading(p.api_id!), {}, "forever", "vision") })));
  const good = results.filter((x) => x.r.ok);
  if (!good.length) {
    const err = short((results[0].r as { error: string }).error);
    return [...cards, missing("features", `Reading not available (${err})`), missing("readings", `Reading not available (${err})`)];
  }
  const per = good.map((x) => ({ kind: x.p.kind, ...splitFace((x.r as { data: unknown }).data) }));
  const byKind = <T>(f: (x: (typeof per)[number]) => T) => Object.fromEntries(per.map((x) => [x.kind, f(x)]));
  const note = good.length < results.length ? "One photo's reading was not available" : undefined;
  cards.push(ok("features", byKind((x) => ({ type: x.type, ...x.parts })), note));
  cards.push(ok("readings", byKind((x) => ({ ...x.lines, ...x.rest })), note));
  return cards;
}
