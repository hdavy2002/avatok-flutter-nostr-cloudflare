// [HF-CREATOR-PRICE-1] Versioned creator contract. Standard and legacy tariffs are independent.
import { chargePaise, type CallSplit } from "./hf_token_math";

export const HOST_CATEGORIES = ["standard", "influencer", "celebrity"] as const;
export type HostCategory = (typeof HOST_CATEGORIES)[number];
export type CreatorCategory = Exclude<HostCategory, "standard">;
export const CREATOR_VERSION = "creator-r1";
export const CREATOR_MIN_RUPEES = 5;
export const CREATOR_MAX_RUPEES = 1000;
export const isHostCategory = (v: unknown): v is HostCategory => typeof v === "string" && (HOST_CATEGORIES as readonly string[]).includes(v);
export const isCreatorCategory = (v: unknown): v is CreatorCategory => v === "influencer" || v === "celebrity";
export const validCreatorRate = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= CREATOR_MIN_RUPEES && v <= CREATOR_MAX_RUPEES;

export interface CreatorSnapshot {
  plan: "creator"; version: "creator-r1"; category: CreatorCategory;
  ratePaise: number; hostShareBps: 6000; callCostPaisePerMin: 200;
  taxMode: "gst_absorbed_in_platform_commission";
}
export function creatorSnapshotFor(category: CreatorCategory, rateRupees: number): CreatorSnapshot {
  if (!isCreatorCategory(category) || !validCreatorRate(rateRupees)) throw new RangeError("Invalid creator rate/category");
  return { plan: "creator", version: CREATOR_VERSION, category, ratePaise: rateRupees * 100,
    hostShareBps: 6000, callCostPaisePerMin: 200, taxMode: "gst_absorbed_in_platform_commission" };
}
export function validCreatorSnapshot(v: unknown): v is CreatorSnapshot {
  if (!v || typeof v !== "object") return false;
  const s = v as Partial<CreatorSnapshot>;
  return s.plan === "creator" && s.version === CREATOR_VERSION && isCreatorCategory(s.category)
    && typeof s.ratePaise === "number" && validCreatorRate(s.ratePaise / 100)
    && s.hostShareBps === 6000 && s.callCostPaisePerMin === 200 && s.taxMode === "gst_absorbed_in_platform_commission";
}
/** Creator = floor(60% of gross) minus one ₹2 recovery per connected call-minute (both phone legs total).
 * GST is absorbed in the platform's gross commission; no extra fan/creator charge is added.
 * Amounts round cumulatively, once per call. V = creator + call recovery + gross platform commission.
 */
export function creatorCallSplit(snapshot: CreatorSnapshot, seconds: number): CallSplit {
  if (!validCreatorSnapshot(snapshot)) throw new RangeError("Invalid creator snapshot");
  const valuePaise = chargePaise(snapshot.ratePaise, seconds);
  const callCostPaise = Math.min(valuePaise, chargePaise(snapshot.callCostPaisePerMin, seconds));
  const hostPaise = Math.max(0, Number(BigInt(valuePaise) * BigInt(snapshot.hostShareBps) / 10000n) - callCostPaise);
  return { valuePaise, callCostPaise, hostPaise, platformPaise: valuePaise - callCostPaise - hostPaise };
}
