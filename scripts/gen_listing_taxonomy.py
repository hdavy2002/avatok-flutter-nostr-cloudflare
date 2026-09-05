#!/usr/bin/env python3
"""[MKT-3GROUP-1 2026-09-05] Generate the language mirrors of the marketplace
taxonomy from Specs/listing-taxonomy.json.

WHY A GENERATOR AND NOT THREE HAND-WRITTEN FILES. The same 3 groups and 41
sub-categories have to exist in the worker (validation + the D1 seed), on the
web (the wizard's blips and the marketplace) and in the Flutter app (the same
marketplace, offline). Three hand-maintained copies of one list is three copies
that disagree within a month, and the disagreement shows up as a listing that
vanishes from the marketplace because its category is in one mirror and not
another. The JSON is canonical; everything else is output.

    python3 scripts/gen_listing_taxonomy.py            # write the mirrors
    python3 scripts/gen_listing_taxonomy.py --check    # fail if they are stale

Plain python3, no deps. Add a target here rather than hand-editing a mirror.
"""
import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "Specs", "listing-taxonomy.json")

HEADER = """/* [MKT-3GROUP-1 2026-09-05] The marketplace taxonomy, mirrored for the web.
 *
 * GENERATED FROM Specs/listing-taxonomy.json by scripts/gen_listing_taxonomy.py.
 * That JSON is canonical and the worker + Flutter mirrors come from it too. Edit
 * the JSON and re-run the generator; a hand-edit here drifts three surfaces
 * apart, which is the exact failure this file exists to prevent.
 *
 * ⚠️ THIS IS A FALLBACK, NOT THE SOURCE OF TRUTH AT RUNTIME. Categories live in
 * D1 (`listing_categories`) and are served by GET /api/explore/categories, which
 * is what the worker validates a listing's category against. Always prefer the
 * fetched list and fall back to this only when the fetch fails — otherwise a
 * category added in D1 stays invisible on the web until someone redeploys.
 *
 * Prose, the wording rules and the reasoning:
 * Specs/SPEC-2026-09-05-THREE-GROUPS-AND-HOURLY-PRICING.md
 */

export type GroupId = 'india_goes_live' | 'find_your_people' | 'book_their_time';

export interface Group {
  id: GroupId;
  /** Section heading. `emphasis` is the trailing word that takes the coral. */
  heading: string;
  emphasis: string;
  blurb: string;
  /** Wizard step-1 kinds whose sub-categories come from this group. */
  kinds: string[];
  /** `listings.section` values that roll up into this group. */
  sections: string[];
}

export interface SubCategory {
  id: string;
  label: string;
  emoji: string;
  group: GroupId;
  sort: number;
  /** Hide the blip while this platform flag is off. */
  requiresFlag?: string;
}
"""

HIDDEN = """
/* [MKT-3GROUP-1] 'Voices with character' (ai_voice_agents) is deliberately NOT a
 * group: the owner removed it from the front page and the marketplace on
 * 2026-09-05. The SECTION value stays alive in the worker's SECTIONS union
 * because published rows carry it — it simply maps to no group, so nothing
 * renders it. Do not "tidy up" by deleting the value. */
export const HIDDEN_SECTIONS: ReadonlySet<string> = new Set(['ai_voice_agents']);
"""

HELPERS = """
/** Sub-categories in one group, in display order. */
export function subCategoriesFor(group: GroupId): SubCategory[] {
  return SUB_CATEGORIES.filter((c) => c.group === group).sort((a, b) => a.sort - b.sort);
}

/** The groups a wizard step-1 kind can file a listing into.
 *
 *  `consult` returns TWO groups on purpose. A 1:1 listing can be paid company
 *  ('Find your people') or a professional ('Book their time'), and step 1 does
 *  not distinguish them — the owner's decision (2026-09-05) is that the
 *  SUB-CATEGORY decides. So step 2 shows both groups' blips under their two
 *  headings, and whichever the creator picks is what files the listing. */
export function groupsForKind(kind: string): Group[] {
  return GROUPS.filter((g) => g.kinds.includes(kind));
}

/** Which group a listing belongs to, from its category. Null when it belongs to
 *  none — a marketplace-goods category, or an ai_voice_agents listing. */
export function groupForCategory(category: string | null | undefined): GroupId | null {
  if (!category) return null;
  return SUB_CATEGORIES.find((c) => c.id === category)?.group ?? null;
}

/** Fee split for one participant for one hour, in tokens (1 token = ₹1).
 *
 *  ⚠️ FOR DISPLAY ONLY. The worker recomputes this when money actually moves; a
 *  client-computed fee must never reach a ledger row. Keep the two in step. */
export function feeSplit(pricePerHour: number): { fee: number; creator: number } {
  const price = Math.max(0, Math.round(pricePerHour || 0));
  if (price <= PRICING.flatTokensPerHour) return { fee: price, creator: 0 };
  const fee = PRICING.flatTokensPerHour
    + Math.round((price - PRICING.flatTokensPerHour) * PRICING.commissionPct / 100);
  return { fee, creator: price - fee };
}
"""


def js(value):
    return json.dumps(value, ensure_ascii=False)


def render_ts(data):
    out = [HEADER, "export const GROUPS: Group[] = ["]
    for g in data["groups"]:
        out.append("  {")
        out.append("    id: %s," % js(g["id"]))
        out.append("    heading: %s," % js(g["heading"]))
        out.append("    emphasis: %s," % js(g["emphasis"]))
        out.append("    blurb: %s," % js(g["blurb"]))
        out.append("    kinds: %s," % js(g["kinds"]))
        out.append("    sections: %s," % js(g["sections"]))
        out.append("  },")
    out.append("];")
    out.append(HIDDEN)
    out.append("export const SUB_CATEGORIES: SubCategory[] = [")
    for c in data["categories"]:
        flag = (" requiresFlag: %s," % js(c["requires_flag"])) if c.get("requires_flag") else ""
        out.append("  { id: %s, label: %s, emoji: %s, group: %s, sort: %d,%s }," % (
            js(c["id"]), js(c["label"]), js(c["emoji"]), js(c["group"]), c["sort"], flag))
    out.append("];")
    p = data["pricing"]
    out.append("""
/** [PRICE-HOURLY-1] Per participant, PER HOUR. A 2-hour booking bills the flat
 *  fee twice (owner decision 2026-09-05: "per 1 hour"). `minPriceTokensPerHour`
 *  exists because at or below the flat fee the creator would earn nothing — the
 *  wizard refuses to go lower, and so does the server. */
export const PRICING = {
  flatTokensPerHour: %d,
  commissionPct: %d,
  minPriceTokensPerHour: %d,
} as const;""" % (p["flat_tokens_per_hour"], p["commission_pct"], p["min_price_tokens_per_hour"]))
    m = data["media_mode"]
    out.append("""
/** [MKT-3GROUP-1] `listings.media_mode`. audio_only hides the video control for
 *  the whole session; audio_video means the creator may NOT turn video off —
 *  they sold a video session. THE FIELD ONLY: wiring it into the call UI is
 *  separate work. */
export type MediaMode = 'audio_video' | 'audio_only';
export const MEDIA_MODES: { id: MediaMode; label: string; help: string }[] = [
  { id: 'audio_video', label: %s, help: %s },
  { id: 'audio_only', label: %s, help: %s },
];
export const MEDIA_MODE_DEFAULT: MediaMode = %s;""" % (
        js(m["labels"]["audio_video"]), js(m["rules"]["audio_video"]),
        js(m["labels"]["audio_only"]), js(m["rules"]["audio_only"]),
        js(m["default"])))
    out.append(HELPERS)
    return "\n".join(out).rstrip() + "\n"


TARGETS = {
    os.path.join("web", "src", "lib", "listingTaxonomy.ts"): render_ts,
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="exit 1 if a mirror is stale instead of rewriting it")
    args = ap.parse_args()

    with open(SRC, encoding="utf-8") as fh:
        data = json.load(fh)

    stale = []
    for rel, render in TARGETS.items():
        path = os.path.join(ROOT, rel)
        want = render(data)
        have = None
        if os.path.exists(path):
            with open(path, encoding="utf-8") as fh:
                have = fh.read()
        if have == want:
            print("up to date: %s" % rel)
            continue
        if args.check:
            stale.append(rel)
            continue
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(want)
        print("wrote: %s (%d bytes)" % (rel, len(want)))

    if stale:
        print("\nSTALE — re-run `python3 scripts/gen_listing_taxonomy.py`:")
        for rel in stale:
            print("  %s" % rel)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
