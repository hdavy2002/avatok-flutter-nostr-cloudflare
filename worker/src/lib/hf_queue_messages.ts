// [HF-CALL-MODES-B] WhatsApp copy for the call queue (HF-CALL-10, spec 2.2). Pure: no I/O. The brand name comes from BRAND and every link from
// brandUrl, never typed (RULE BRAND). Wording is the approved spec text; only the "next" line varies its time phrase.
import { BRAND, brandUrl } from "./brand";

/** First name only (never digits / handles), or a neutral fallback that reads mid-sentence. */
export function queueFirstName(displayName: string | null | undefined, fallback = "the influencer"): string {
  const first = String(displayName ?? "").trim().split(/\s+/)[0] ?? "";
  if (!first || first.length > 24 || /[0-9@+_.\/\\:]/.test(first)) return fallback;
  return first;
}

/** The host's public page: where a fan leaves the queue, books a time or joins again. */
export const queueHostUrl = (slug: string) => brandUrl(`/h/${encodeURIComponent(slug)}`);
/** Where a fan tops up his wallet. */
export const queueTopUpUrl = () => brandUrl("/dashboard/wallet#add");

const rupees = (paise: number) => {
  const r = Math.max(0, Math.ceil(paise)) / 100;
  return Number.isInteger(r) ? `₹${r}` : `₹${r.toFixed(2)}`;
};

export const queueJoinedMsg = (name: string, position: number, slug: string) =>
  `${BRAND.name}: You're in ${name}'s queue, #${Math.max(1, Math.trunc(position))}. We'll WhatsApp you just before we call. Nothing is charged until you talk. Leave the queue: ${queueHostUrl(slug)}`;

/** seconds = the wait before we ring (60 s after a call, 10 s after a skip). */
export const queueNextMsg = (name: string, seconds: number) =>
  `${BRAND.name}: You're next for ${name}. We'll call you ${seconds >= 45 ? "in about 1 minute" : "in a few seconds"} — keep your phone free. Your number stays hidden.`;

export const queueNoAnswerMsg = (name: string, slug: string) =>
  `${BRAND.name}: We called you for ${name} but couldn't reach you, so you've left the queue. Nothing was charged. Join again: ${queueHostUrl(slug)}`;

export const queueLowBalanceMsg = (name: string, needPaise: number) =>
  `${BRAND.name}: It was your turn with ${name}, but your wallet needs at least ${rupees(needPaise)} to start. Top up and join again: ${queueTopUpUrl()}`;

export const queueClosedMsg = (name: string, slug: string) =>
  `${BRAND.name}: ${name} has stopped taking calls for now, so the queue is closed. Nothing was charged. Book a time: ${queueHostUrl(slug)}`;

export const queueExpiredMsg = (name: string) =>
  `${BRAND.name}: Your place in ${name}'s queue has expired. Nothing was charged.`;

/** D3: the influencer missed two queued calls in a row (or paused): waiters are told, their places are kept for a while. */
export const queuePausedMsg = (name: string, minutes: number) =>
  `${BRAND.name}: ${name} has paused the queue for a little while. Your place is kept for up to ${Math.max(1, Math.trunc(minutes))} minutes. Nothing is charged.`;

/** A booking is too close to start this call (rule 9, this fan's own booking). */
export const queueBookingMsg = (name: string, slug: string) =>
  `${BRAND.name}: We couldn't start your call with ${name} because a booked call is too close. Nothing was charged. Join again: ${queueHostUrl(slug)}`;

/** The call could not be placed for a reason on our side or the influencer's. */
export const queueTroubleMsg = (name: string, slug: string) =>
  `${BRAND.name}: We couldn't connect your call with ${name} this time. Nothing was charged. Join again: ${queueHostUrl(slug)}`;

export type QueueMsgKind = "join" | "next" | "noanswer" | "lowbalance" | "closed" | "expired" | "paused" | "booking" | "trouble";
/** whatsapp_outbox.kind for each message (dedupe + audit). The drain only claims status='queued', so these rows are never double-sent. */
export const queueOutboxKind = (k: QueueMsgKind) => `hf_queue_${k}`;
