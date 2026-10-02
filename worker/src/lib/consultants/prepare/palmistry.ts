// [AUMFE-CONSULT-W2-1 2026-10-02] Palmistry cards: palm_photos, hand_type, lines, mounts, readings.
// Vision host: get-palm-id (done at upload / retried here) then the reading by palm id. Reading path is isolated in vision.ts (TODO verify).
import type { PalmistryIntake, PhotoKind } from "../types";
import { type CardOut, missing, ok } from "./shared";
import { short, type PrepDeps } from "./deps";
import { VISION, splitPalm } from "./vision";

export interface PhotoRow { kind: PhotoKind; api_id: string | null; status: "uploaded" | "accepted" | "rejected"; reason: string | null }

export const photoSummary = (photos: PhotoRow[]) => photos.map((p) => ({ kind: p.kind, status: p.status, reason: p.reason, checked: !!p.api_id }));

export async function buildPalmCards(intake: PalmistryIntake, photos: PhotoRow[], deps: PrepDeps): Promise<CardOut[]> {
  const usable = photos.filter((p) => p.status !== "rejected");
  const cards: CardOut[] = [];
  cards.push(usable.length ? ok("palm_photos", photoSummary(photos), usable.every((p) => p.api_id) ? undefined : "Some photos could not be machine-checked") : missing("palm_photos", "No usable palm photo was uploaded"));
  // Dominant hand first.
  const order: PhotoKind[] = intake.dominant_hand === "left" ? ["palm_left", "palm_right"] : ["palm_right", "palm_left"];
  const withId = order.map((k) => usable.find((p) => p.kind === k && p.api_id)).filter((p): p is PhotoRow => !!p);
  if (!withId.length) {
    const why = usable.length ? "Photo could not be machine-checked yet" : "No usable palm photo";
    return [...cards, ...["hand_type", "lines", "mounts", "readings"].map((k) => missing(k, why))];
  }
  const results = await Promise.all(withId.map(async (p) => ({ p, r: await deps.call(VISION.palmReading(p.api_id!), {}, "forever", "vision") })));
  const good = results.filter((x) => x.r.ok);
  if (!good.length) {
    const err = short((results[0].r as { error: string }).error);
    return [...cards, ...["hand_type", "lines", "mounts", "readings"].map((k) => missing(k, `Reading not available (${err})`))];
  }
  const per = good.map((x) => ({ kind: x.p.kind, ...splitPalm((x.r as { data: unknown }).data) }));
  const byKind = <T>(f: (x: (typeof per)[number]) => T) => Object.fromEntries(per.map((x) => [x.kind, f(x)]));
  const note = good.length < results.length ? "One hand's reading was not available" : undefined;
  cards.push(ok("hand_type", byKind((x) => x.type), note));
  cards.push(ok("lines", byKind((x) => x.lines), note));
  cards.push(ok("mounts", byKind((x) => x.parts), note));
  cards.push(ok("readings", byKind((x) => x.rest), note));
  return cards;
}
