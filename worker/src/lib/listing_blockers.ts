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
const CAPACITIES = new Set([1, 10, 20]);

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

  // Marketplace listings stop here on purpose: no schedule, no capacity, no
  // category-id check and photos optional, so the buy/sell flow stays testable.
  if (isMarket) return out;

  // ---- creator services: live_event and consult ----

  if (l?.title && !l?.category) {
    out.push({
      code: "category_required",
      field: "category",
      message: "Pick a category for this listing.",
      legacy: { status: 400, body: { error: "title and category required" } },
    });
  }

  // A listing must show SOMETHING. Since [POSTER-FIRST-1] an AI poster satisfies
  // this as well as a photo, which is why the message names both ways out.
  const posterState = (parse<any>(l?.attrs, {}) || {}).poster;
  const hasUsablePoster = !!posterState?.url
    && (posterState.status === "draft" || posterState.status === "approved");
  if (coverCount < 1 && !hasUsablePoster) {
    out.push({
      code: "cover_required",
      field: "cover_media",
      message: "Add a photo, or generate the AI poster, before publishing.",
      legacy: {
        status: 400,
        body: {
          error: "cover_required",
          detail: "This listing needs a poster or at least one photo before publishing.",
          poster_status: posterState?.status ?? null,
        },
      },
    });
  }

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

  // [FACE-PHOTO-1 2026-09-05] A reference face is REQUIRED before submit (owner
  // decision). The poster is the listing's whole first impression, and without a
  // face the image model invents a person — which is how "Cooking with Davy"
  // came back as a woman in a sari. The creator's profile avatar was the stopgap;
  // it is often a logo, a group shot, or years old, so the wizard now asks for a
  // photo chosen knowing a poster will be painted from it.
  //
  // Not shown anywhere public — see the wizard control. It is a likeness
  // reference, not a gallery image.
  //
  // GRANDFATHERED past a listing that already HAS a usable poster. The face
  // photo exists to make a good poster; demanding one from a listing whose
  // poster is already generated and approved would block every listing that
  // predates this rule — including ones an admin has already reviewed — over a
  // field that can no longer change the outcome. New listings hit the
  // requirement before the poster is made, which is the point at which it
  // matters.
  const face = (parse<any>(l?.attrs, {}) || {}).face_photo;
  const faceUrl = typeof face === "string" ? face : String(face?.url ?? "");
  if (!hasUsablePoster && !/^https:\/\//i.test(faceUrl)) {
    out.push({
      code: "face_photo_required",
      field: "face_photo",
      message: "Upload a clear photo of your face — the poster is painted from it. It is not shown on your listing.",
      legacy: {
        status: 400,
        body: {
          error: "face_photo_required",
          detail: "This listing needs a reference face photo before publishing.",
        },
      },
    });
  }

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
  } else {
    if (!CAPACITIES.has(Number(l?.capacity))) {
      out.push({
        code: "bad_capacity",
        field: "capacity",
        message: "Capacity must be 1, 10 or 20.",
        legacy: { status: 400, body: { error: "capacity must be 1, 10 or 20" } },
      });
    }
    // Availability belongs to the CREATOR, not to whoever is publishing.
    const creatorUid = String(l?.creator_id ?? "");
    let hasRules = false;
    try {
      hasRules = !!(await env.DB_META
        .prepare("SELECT 1 FROM availability_rules WHERE user_id=?1 LIMIT 1")
        .bind(creatorUid).first());
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
