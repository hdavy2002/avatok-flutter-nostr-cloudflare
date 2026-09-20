import {loadUnifiedSchedule,windowsForDate,localParts,unifiedConflicts} from "../cal/engine";
import { gcalAvailabilityReady } from "../cal/gcal_availability";
// [LISTING-BLOCKERS-1 2026-09-05] ONE definition of "can this listing publish?".
//
// WHY THIS FILE EXISTS
//
// The publish rules used to live inline inside publishListingAuthoritative, and
// publish was the only way to reach them. So every other surface GUESSED:
//
//   * the create wizard had its own hand-written checklist that branched on
//     schedule_mode without ever consulting `kind`, so a live_event with
//     schedule_mode='always_on' got no schedule check at all and went all-green;
//   * submitListingForApproval validated the owner, the status and the price
//     floor — and nothing else — so that listing entered the review queue;
//   * the admin queue showed a reviewer a listing with no visible problem, and
//     they approved it;
//   * publish then refused it, forever, with an error nobody upstream had
//     predicted.
//
// The owner lost listing 845567cb to exactly that on 2026-09-05 and asked the
// obvious question: if four thousand listings arrive like this, who is supposed
// to work out what is wrong with each one?
//
// So the rules move here, and everyone reads the same list: publish enforces it,
// submit refuses to enqueue a listing that fails it, the wizard shows it live,
// and the admin queue prints it next to the Publish button.
//
// WHAT BELONGS HERE, AND WHAT DOES NOT
//
// Only problems with the LISTING that a person can fix by editing something.
// Deliberately NOT here, and still in publish:
//
//   * identityGate / KYC       — a fact about the account, not the listing, and
//                                the answer can change between submit and publish
//   * claimBlock               — has a SIDE EFFECT (it claims a calendar slot);
//                                running it from a read-only preview would book
//                                the creator's diary every time the wizard polled
//   * the entitlement charge   — spends money, same reason
//
// Each blocker carries the EXACT status and body publish has always returned for
// it (`legacy`). That is what makes this a refactor rather than a rewrite: the
// wire contract shipped clients depend on is reproduced byte for byte, and the
// structured `code`/`field`/`message` are additive on top.
import type { Env } from "../types";
import { publishBlockedReason, sectionFor } from "./listing_section";
import { readConfig } from "../routes/config";

const MARKET_KINDS = new Set(["sell", "buy", "social"]);

export type ListingBlocker = {
  /** Stable and machine-readable. Clients branch on this, never on `message`. */
  code: string;
  /** The field to point the creator at, in wizard-draft naming. Null when the
   *  problem is not a field (an account-level or platform-level condition). */
  field: string | null;
  /** One sentence, addressed to whoever can fix it. */
  message: string;
  /** The response publish returned for this before the extraction, preserved so
   *  the refactor is invisible to every shipped client. */
  legacy: { status: number; body: Record<string, unknown> };
};

function parse<T>(raw: unknown, fallback: T): T {
  if (raw == null) return fallback;
  if (typeof raw !== "string") return raw as T;
  try { const v = JSON.parse(raw); return (v ?? fallback) as T; } catch { return fallback; }
}

// ---- content policy: claims that must never reach publish (2026-09-20) ----
//
// Saathum lists devotional and astrology services to real people making real
// decisions — a "guaranteed" marriage or a "24-hour curse removal" is not
// colourful marketing here, it is the exact pitch a predatory operator uses
// to extract money from someone scared or desperate. These five categories
// mirror the public Prohibited Services page (lane 04) and are the first
// thing a payment-gateway underwriter will look for.
//
// THIS IS A KEYWORD/PHRASE SCAN, NOT A CLASSIFIER — and that is deliberate,
// not a shortcut. Every other rule in this file runs synchronously with no
// network call because it "cannot be wrong and cannot be unavailable"
// (routes/listing_review.ts's header, describing this exact file) — a model
// call would make this layer occasionally unavailable, and an unavailable
// hard-block layer is worse than a keyword scan that sometimes misses a
// cleverly worded claim or flags an innocent sentence. A model-based SECOND
// pass belongs in listing_review.ts's "warn" layer, alongside the existing
// AI review, precisely because that layer is allowed to be unavailable.
// Tune the phrase lists below as real listings surface gaps; do not "fix"
// a miss by reaching for an API call here.
type ContentPolicyRule = {
  code: string;
  message: string;
  /** Any one pattern matching is enough to trigger the rule. */
  patterns: RegExp[];
};

const CONTENT_POLICY_RULES: ContentPolicyRule[] = [
  {
    code: "guaranteed_outcome",
    message: "Remove promises of a guaranteed outcome (marriage, wealth, children, exam results, visas). Describe the service, not a promised result.",
    patterns: [
      /\bguarantee(d|s)?\b[^.!?\n]{0,40}\b(marry|marriage|married|wedding|rich|wealth|money|child|children|conceive|pregnan\w*|exam|pass|visa|job)\b/i,
      /\b(marry|marriage|married|wedding|rich|wealth|money|child|children|conceive|pregnan\w*|exam|pass|visa|job)\b[^.!?\n]{0,40}\bguarantee(d|s)?\b/i,
      /\b100\s*%\s*(guarantee(d)?|result|success|sure)\b/i,
      /\bsure[- ]shot\b/i,
      /\bno[- ]fail\b/i,
      /\bassured (result|success|marriage|job|visa)\b/i,
    ],
  },
  {
    code: "medical_claim",
    message: "Remove medical claims. This service cannot promise to cure, treat or heal an illness or medical condition.",
    patterns: [
      /\b(cure|cures|cured|heal|heals|healing|treat|treats|treatment)\b[^.!?\n]{0,40}\b(cancer|disease|illness|infertility|diabetes|covid|tumou?r|disorder|medical condition)\b/i,
      /\b(cancer|disease|illness|infertility|diabetes|covid|tumou?r|disorder|medical condition)\b[^.!?\n]{0,40}\b(cure|cures|cured|heal|heals|healing|treat|treats|treatment)\b/i,
    ],
  },
  {
    code: "fear_selling",
    message: "Remove fear-based claims (curses, black magic removal, danger predictions, urgent remedies). Offer the service without predicting harm to the buyer.",
    patterns: [
      /\bblack magic\b/i,
      /\bkala\s*jadu\b/i,
      /\bcurse removal\b/i,
      /\bremove (your |the )?curse\b/i,
      /\bvashikaran\b/i,
      /\bevil eye removal\b/i,
      /\bburi\s*nazar\b/i,
      /\bdanger in your (chart|kundli|horoscope)\b/i,
      /\byour life is in danger\b/i,
      /\burgent remedy\b/i,
      /\bimmediate danger\b/i,
      /\b24[- ]hour(s)? remedy\b/i,
      /\bremedy within 24 hours\b/i,
      /\bwithout this remedy\b/i,
    ],
  },
  {
    code: "harm_risk",
    message: "Remove anything describing animal sacrifice, dangerous fire or chemicals, or a minor participating in the ritual — these cannot be offered here.",
    patterns: [
      /\banimal sacrifice\b/i,
      /\bsacrific(e|ing)\b[^.!?\n]{0,20}\b(goat|chicken|animal|hen)\b/i,
      /\bbali\s*pratha\b/i,
      /\bopen flame ritual\b/i,
      /\bfire walking\b/i,
      /\bhandle (burning|hot) (coals|iron)\b/i,
      /\bhazardous chemical\b/i,
      /\btoxic chemical\b/i,
      /\b(child|children|kid|kids|minor|minors)\b[^.!?\n]{0,30}\b(will |can |may )?(participate|perform|assist|join)\b/i,
    ],
  },
  {
    code: "pressure_tactics",
    message: "Remove pressure tactics (\"act now or\", threats of what happens if the buyer doesn't book). Let buyers decide without urgency or threats.",
    patterns: [
      /\bact now or\b/i,
      /\bbook now or (face|suffer)\b/i,
      /\blast chance before\b/i,
      /\bhurry before it'?s too late\b/i,
      /\byour fate depends on booking\b/i,
      /\bbook immediately or\b/i,
    ],
  },
];

/** Every free-text surface a creator controls: the card fields plus the
 *  details-page `attrs` blob (how-it-works, house rules, FAQ, sample Q&A —
 *  see routes/listings.ts contentAttrsError), scanned as one JSON blob so
 *  this list does not need to track every attrs key by name. */
function policyScanSources(l: Record<string, any>): Array<{ field: string; text: string }> {
  const attrsText = (() => {
    try { return JSON.stringify(parse<Record<string, unknown>>(l?.attrs, {})); } catch { return ""; }
  })();
  return [
    { field: "title", text: String(l?.title ?? "") },
    { field: "blurb", text: String(l?.blurb ?? "") },
    { field: "description", text: String(l?.description ?? "") },
    { field: "attrs", text: attrsText },
  ];
}

function contentPolicyBlockers(l: Record<string, any>): ListingBlocker[] {
  const out: ListingBlocker[] = [];
  const sources = policyScanSources(l);
  for (const rule of CONTENT_POLICY_RULES) {
    const hit = sources.find((s) => s.text && rule.patterns.some((re) => re.test(s.text)));
    if (hit) {
      out.push({
        code: rule.code,
        field: hit.field,
        message: rule.message,
        legacy: { status: 400, body: { error: rule.code, field: hit.field, message: rule.message } },
      });
    }
  }
  return out;
}

/**
 * Every reason this listing cannot go live, in the order publish would have hit
 * them. Empty array = publishable as far as its own content is concerned.
 *
 * Never throws: a lookup that fails is reported as a blocker, not as an
 * exception, because this runs on the wizard's polling path as well as on
 * publish and a transient D1 error must not look like a crash to a creator.
 */
export async function listingBlockers(
  env: Env,
  l: Record<string, any>,
): Promise<ListingBlocker[]> {
  const out: ListingBlocker[] = [];
  const kind = String(l?.kind ?? "");
  const isMarket = MARKET_KINDS.has(kind);

  const covers = parse<unknown[]>(l?.cover_media, []);
  const coverCount = Array.isArray(covers) ? covers.length : 0;

  if (!l?.title) {
    out.push({
      code: "title_required",
      field: "title",
      message: "This listing needs a title.",
      legacy: isMarket
        ? { status: 400, body: { error: "title required" } }
        : { status: 400, body: { error: "title and category required" } },
    });
  }

  if (coverCount > 5) {
    out.push({
      code: "too_many_photos",
      field: "cover_media",
      message: `Remove ${coverCount - 5} photo${coverCount - 5 === 1 ? "" : "s"} — the maximum is 5.`,
      legacy: { status: 400, body: { error: "max 5 photos", cover_count: coverCount, limit: 5 } },
    });
  }

  if (!(Number(l?.price) >= 0)) {
    out.push({
      code: "bad_price",
      field: "price",
      message: "The price is missing or not a number.",
      legacy: { status: 400, body: { error: "bad price" } },
    });
  }

  // [LISTING-CONTENT-POLICY-1] Applies to every kind, including marketplace —
  // a predatory claim is exactly as much of a problem in a "sell" listing's
  // description as in a live_event's, and there is no reason a buy/sell/social
  // listing should be exempt from a rule about not lying or frightening a buyer.
  out.push(...contentPolicyBlockers(l));

  // Marketplace listings stop here on purpose: no schedule, no capacity, no
  // category-id check and photos optional, so the buy/sell flow stays testable.
  if (isMarket) return out;

  // ---- creator services: live_event and consult ----

  // [LISTING-PERFORMER-1 2026-09-20] The creator posting this is often not the
  // one performing it — a coordinator lists a visiting priest, or a platform
  // partner arranges the pandit. A buyer paying for a devotional service needs
  // to know who is actually doing it before they pay, so at least one of
  // performed_by / facilitated_by must be set before publish.
  if (!String(l?.performed_by ?? "").trim() && !String(l?.facilitated_by ?? "").trim()) {
    out.push({
      code: "performer_disclosure_required",
      field: "performed_by",
      message: "Say who actually performs this — you, a priest, or a partner — so buyers know who they're booking.",
      legacy: {
        status: 400,
        body: { error: "performer_disclosure_required", message: "performed_by or facilitated_by is required" },
      },
    });
  }

  if (l?.title && !l?.category) {
    out.push({
      code: "category_required",
      field: "category",
      message: "Pick a category for this listing.",
      legacy: { status: 400, body: { error: "title and category required" } },
    });
  }

  // [LISTING-POSTER-OPTIONAL-1] Photos are optional at submission time. The
  // poster is generated asynchronously after the creator submits, from the
  // listing's title, category/tags and description. `coverCount` is still used
  // below to enforce the five-photo maximum when photos are supplied.

  if (l?.category) {
    let known = false;
    try {
      known = !!(await env.DB_META
        .prepare("SELECT 1 FROM listing_categories WHERE id=?1 AND active=1")
        .bind(l.category).first());
    } catch {
      // Treat a lookup failure as unknown rather than as valid. Publishing into
      // a category we could not confirm is the worse of the two mistakes.
      known = false;
    }
    if (!known) {
      out.push({
        code: "unknown_category",
        field: "category",
        message: "That category no longer exists — pick another one.",
        legacy: { status: 400, body: { error: "unknown category" } },
      });
    }
  }

  // A section whose delivery is switched off cannot be published into (today:
  // adda rooms, which need group calling while conferenceEnabled is false).
  try {
    const section = sectionFor(kind, l?.category);
    const gated = publishBlockedReason(section, await readConfig(env));
    if (gated) {
      out.push({
        code: "section_unavailable",
        field: null,
        message: gated,
        legacy: { status: 409, body: { error: "section_unavailable", section, message: gated } },
      });
    }
  } catch { /* a config read failure must not invent a blocker */ }

  if (kind === "live_event") {
    const start = Number(l?.starts_at), dur = Number(l?.duration_min);
    // Deliberately checked on KIND, not on schedule_mode. Branching on
    // schedule_mode alone is the exact bug this file exists to end: a live_event
    // saved as 'always_on' skipped the check entirely and sailed through.
    if (!(start > Date.now())) {
      out.push({
        code: "starts_at_required",
        field: "starts_at",
        message: Number.isFinite(start) && start > 0
          ? "The start time is in the past — pick a future date and time."
          : "Set the date and time this event starts.",
        legacy: { status: 400, body: { error: "starts_at (future) and duration_min (5–480) required" } },
      });
    }
    if (!(dur >= 5 && dur <= 480)) {
      out.push({
        code: "duration_required",
        field: "duration_min",
        message: "Set how long the event runs, between 5 and 480 minutes.",
        legacy: { status: 400, body: { error: "starts_at (future) and duration_min (5–480) required" } },
      });
    }
    const creatorUid = String(l?.creator_id ?? "");
    if (creatorUid && start > Date.now() && dur >= 5 && dur <= 480) {
      const cal = await gcalAvailabilityReady(env, creatorUid, undefined, true);
      if (!cal.ready) {
        const message = cal.reason === "disconnected" ? "Connect Google Calendar before submitting this event." : cal.reason === "no_selected_calendars" ? "Select at least one Google Calendar before submitting this event." : "Refresh Google Calendar before submitting this event so conflicts can be checked.";
        out.push({ code: "calendar_not_ready", field: null, message, legacy: { status: 409, body: { error: "calendar_unavailable", detail: message } } });
      } else {
        try {
          const schedule = await loadUnifiedSchedule(env, creatorUid, String(l?.id ?? ""));
          const conflicts = await unifiedConflicts(env, creatorUid, String(l?.id ?? ""), start, start + dur * 60000, schedule.buffer_min);
          if (conflicts.length) out.push({ code: "calendar_conflict", field: "starts_at", message: `This time conflicts with ${conflicts[0].title || "another calendar commitment"}. Pick a different date or time.`, legacy: { status: 409, body: { error: "availability_unavailable", detail: "You already have something booked at that time. Pick a different slot." } } });
        } catch {
          out.push({ code: "calendar_check_failed", field: null, message: "Calendar availability could not be checked. Refresh Google Calendar and try again.", legacy: { status: 503, body: { error: "calendar_unavailable", detail: "Calendar availability could not be checked." } } });
        }
      }
    }
  } else {
    if (Number(l?.capacity)!==1) {
      out.push({
        code: "bad_capacity",
        field: "capacity",
        message: "A 1:1 consultation has one seat.",
        legacy: { status: 400, body: { error: "capacity must be 1" } },
      });
    }
    // Availability belongs to the CREATOR, not to whoever is publishing.
    const creatorUid = String(l?.creator_id ?? "");
    if (creatorUid && !(await gcalAvailabilityReady(env, creatorUid, undefined, true)).ready) out.push({ code: "calendar_not_ready", field: null, message: "Connect and refresh Google Calendar before submitting this consultation.", legacy: { status: 409, body: { error: "calendar_unavailable", detail: "Connect and refresh Google Calendar before submitting this consultation." } } });
    let hasRules = false;
    try {
      const schedule=await loadUnifiedSchedule(env,creatorUid,String(l?.id??''));
      const shared=await loadUnifiedSchedule(env,creatorUid,null);
      const named=await env.DB_META.prepare("SELECT id FROM listing_slots WHERE listing_id=?1 AND status='open' AND capacity=1 AND ends_at>?2 LIMIT 1").bind(String(l?.id??''),Date.now()).first();
      hasRules=!!named || (schedule.mode==='exclusive' && Number(l?.starts_at)>Date.now() && Number(l?.duration_min)>=5 && Number(l?.duration_min)<=480);
      const today=localParts(Date.now(),schedule.timezone).date;
      const day=new Date(`${today}T00:00:00Z`);
      for(let n=0;!hasRules && n<=schedule.horizon_days;n++){
        hasRules=windowsForDate(shared,day.toISOString().slice(0,10),schedule).some(w=>w.end_min-w.start_min>=schedule.duration_min);
        day.setUTCDate(day.getUTCDate()+1);
      }
    } catch { hasRules = false; }
    if (!hasRules) {
      out.push({
        code: "no_availability",
        field: null,
        message: "Set your availability in AvaCalendar before publishing a consult listing.",
        legacy: {
          status: 409,
          body: {
            error: "no_availability",
            detail: "Set your availability in AvaCalendar before publishing a consult listing.",
          },
        },
      });
    }
  }

  return out;
}

/** The publish-shaped response for the first blocker, with the full list added.
 *  `blockers` is additive — an older client reads `error` exactly as before. */
export function blockerResponse(
  blockers: ListingBlocker[],
): { ok: false; status: number; body: Record<string, unknown> } {
  const first = blockers[0];
  return {
    ok: false,
    status: first.legacy.status,
    body: { ...first.legacy.body, blockers },
  };
}
