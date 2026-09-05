# PLAN — Poster-first listings (`[POSTER-FIRST-1]`)

**Status:** for owner review. Nothing built yet.
**Date:** 2026-09-05 · **Target:** production (`.avatok-target = prod`)

**The shape, settled 2026-09-05:**

> The **poster is art plus a title and a tagline. Nothing else.** Every fact — price,
> duration, language, category, house rules — lives in the **More info** panel, which is
> HTML text on a flat poster-paper ground. No image is generated for it, so no number
> ever passes through a model.

That one decision removes the entire class of money bug this plan opened with. The model
is asked to letter two short strings it was handed verbatim; the ₹ figure is rendered by
the browser from D1, the way a price should be.

---

## 1. What exists today (verified in code, not memory)

| Thing | Where | State |
|---|---|---|
| 8-step wizard | `web/src/islands/dashboard/listing-form/ListingWizard.tsx:530-551` | live |
| Live preview card (to be removed) | `listing-form/PreviewCard.tsx` → `steps.tsx:216-219` (step 2), `steps.tsx:756` (step 8) | live |
| AI poster generation | `worker/src/lib/listing_poster.ts` | live |
| Model | `gemini-3.1-flash-image` (Nano Banana 2) via Vertex — `ava_image.ts:432` | live |
| Poster prompt | `listing_poster.ts:49-83` | **rewrite** |
| Poster storage | R2 `u/<uid>/public/posters/<listingId>/<sha256>.png`, prepended to `cover_media` as `source:'ai_poster'` | live |
| Auto-generate on submit | `posterAutoGenerateOnSubmit` — **prod KV `true`**, max attempts 2 | live |
| Admin poster approve/reject | `admin_listings.ts:172-242`; publish blocked unless `attrs.poster.status === 'approved'` | live |
| Photos step | client says "optional" (`steps.tsx:585`), **server 400s `cover_required`** (`listings.ts:2054-2059`) | **bug** |
| CF transform (web) | `web/src/lib/config.ts:50-74` — `format=avif,quality=60` | **→ `format=auto`** |
| CF transform (Flutter) | `app/lib/core/avatar_cache.dart:195-218` | **→ `format=auto`** |
| Detail hero | `ListingDetailsComp.astro:284` — raw URL as CSS `background-image`, bypasses the transform | **bug** |

Two real bugs get fixed inside this work: the `cover_required` mismatch, and the detail
hero downloading a full-size PNG on the page that most needs the transform.

---

## 2. The poster

**On the image:** artwork, the **title**, and a **one-line tagline**. That is the
complete list.

**Not on the image:** price, duration, language, category, vibes, house rules, host,
availability, booking. All of it renders as real text in the More info panel and on the
details page.

**Style** — the reference posters (*Do Ladke Dono Kadke*, *Geet*, *Kati Patang*, *Devi*)
are cheap bright screen-printed film posters, not aged paper. The current prompt says
"printed-poster texture", which is exactly what produces the sepia look you didn't want.
The new prompt names the printing process and negates the aging explicitly:

> A 1970s Hindi film poster, freshly SCREEN-PRINTED ON BRIGHT WHITE PAPER. Hand-painted
> Bollywood portrait, flat poster inks in a limited palette — vermilion, marigold, teal,
> cobalt — visible screen-print registration, bold hand-lettered display title in the
> style of Indian film poster painters.
>
> CRISP AND NEW: no aging, no sepia, no foxing, no paper grain, no distressing, no torn
> or burnt edges, no fading, no dust, no scratches.
>
> Render EXACTLY this text and NOTHING ELSE — no cast list, no studio name, no credits,
> no price, no invented words, no filler lettering:
>   TITLE:   "Friday night cooking"
>   TAGLINE: "See me cook"

If the creator uploaded a photo it goes in as `editRef` — plumbing already exists
(`generateImage(env, key, prompt, uid, editRef)`) — so the portrait is painted from their
face rather than a stranger's.

Safety copy stays: fictional characters, no real celebrity likeness, `moderate()` on the
prompt, `moderateGeneratedImage()` on the output.

### Verification — still needed, now cheap

Two strings instead of forty, so the read-back pass is fast and nearly always passes
first time. It stays because **invented text is the likeliest failure**: look at the
references, they are dense with cast lists and studio credits, and the model will happily
paint a fake one. A fabricated studio credit on a real listing is worse than a typo and
is the easiest thing to skim past.

```
1  GENERATE  Gemini paints the poster: art + title + tagline.
2  VERIFY    The PNG goes back to Gemini as an image input —
             "read every piece of text in this poster, return JSON".
3  DIFF      title   fuzzy >=0.90   (hand-lettering legitimately restyles)
             tagline fuzzy >=0.85
             anything else  MUST BE EMPTY  <- the real check
4  RETRY     Mismatch -> regenerate with the failure fed back in.
             Up to posterVerifyMaxAttempts (3).
5  FALL BACK Still wrong -> composite the title/tagline over the artwork
             and flag for admin. A listing is never blocked.
```

Same Vertex plumbing as `ava_image.ts`, just `responseModalities: ["TEXT"]` with the
image as an `inlineData` part. Every verdict is stored on `attrs.poster.verify` so a bad
prompt shows up as a pattern rather than a one-off.

**Devanagari** is allowed but verifies worse than Latin; a Devanagari title that fails
twice falls back to Latin rather than burning all three attempts.

**Cost:** typically 2 calls per ratio, worst case 6. The portrait is generated and
verified first; the other two ratios are `editRef` reframes of it, so artwork and
lettering carry over and normally verify first time.

---

## 3. The More info panel — "blank poster, text on top"

The quick-info popup (new island `web/src/islands/listing/QuickInfo.tsx`) is a flat
poster-paper ground with real text over it — same ink palette and same type stack as the
poster, so it reads as the back of the same object, but every value is live from D1 and
selectable, searchable, translatable and screen-readable.

Contents: About · Location · Date & time · Duration · **Price** · Language · What to
expect · Boundaries & house rules, then `Book now · Details · Close`. All of it is
already on the listing row — no new API. **Details** navigates to `/l/<id>`.

Type per the CLAUDE.md rules: Anton display, Nunito labels, all tracking positive, never
negative on bold or display.

---

## 4. Three ratios

| Ratio | Use | Render size |
|---|---|---|
| `2:3` portrait | phone cards, app cards, Flutter grid | 1080×1620 |
| `4:3` | iPad / tablet detail hero | 1600×1200 |
| `16:9` wide | desktop detail hero | 2400×1350 |

Stored as siblings: `…/posters/<listingId>/<hash>-{portrait,tablet,wide}.png`.
`attrs.poster` grows `variants: { portrait, tablet, wide }`; `url` stays the portrait, so
every existing reader keeps working untouched.

Selection is `<picture>` + `srcset` on web (browser picks, no JS, no layout shift) and
`MediaQuery.sizeOf` in Flutter. Every URL goes through `cfImage()` / `sizedUrl()` —
**including the detail hero**, which moves off its raw `background-image` onto a real
`<img>` so it can carry `srcset`.

**Format: `format=auto`** replaces the hardcoded `format=avif` in
`web/src/lib/config.ts:50-74` and `app/lib/core/avatar_cache.dart:195`. Cloudflare then
serves AVIF, WebP or JPEG per browser — smallest bytes everywhere, no AVIF decode penalty
on cheap Android.

**Caching:** CF edge caching is automatic on `/cdn-cgi/image/`; add
`Cache-Control: public, max-age=31536000, immutable` on poster R2 objects. Safe because
keys are content-addressed — a regenerated poster is a new key, never a stale hit.

---

## 5. UI changes

**Wizard (`steps.tsx`)**
- Delete the step 2 live preview column (`steps.tsx:216-219`) and its sticky wrapper;
  step 2 becomes a full-width form.
- Step 7 photos: reword to "Optional — your poster is the main image. Photos you add
  appear below it." Keep max 5 and the 8 MB cap.
- Step 8 becomes **Poster & publish**: generate → show the real poster at true ratio →
  Approve / Regenerate. `PreviewCard` stays only until the poster exists.

**Cards (`ListingTile.tsx`)** — the poster is the whole card. Below it, one **More info**
button. Nothing else competing.

**More info popup** — §3.

**Detail page (`ListingDetailsComp.astro`)** — hero is the ratio-appropriate poster via
`<picture>`. Uploaded photos are a gallery *below* it, never above.

**Flutter** — same rules in the marketplace grid and listing detail; ratio by
`MediaQuery`, transform via `avatar_cache.sizedUrl`.

---

## 6. Server changes

1. `listing_poster.ts` — new prompt (title + tagline only), three-ratio render,
   `variants` on `attrs.poster`, `editRef` from an uploaded photo, immutable cache
   headers.
2. **New `worker/src/lib/poster_verify.ts`** — the read-back pass, JSON contract, diff
   rules from §2, verdict persisted to `attrs.poster.verify`.
3. `worker/src/lib/poster_compose.ts` — the fallback, reached only after
   `posterVerifyMaxAttempts` failures. Now only has to set two strings, so it is small.
   `tool/poster_compose_preview.py` is the working reference.
4. `listings.ts:2054-2059` — `cover_required` becomes **poster-or-photo required**. Today
   a creator with no photo and a failed generation hits a dead end at publish.
5. New flags, **declared in `config.ts` DEFAULTS in the same commit** so they are not
   fake flags: `posterVariantsEnabled`, `posterVerifyEnabled`,
   `posterComposeFallbackEnabled`, `posterVerifyMaxAttempts` and `posterStyleVersion`
   (both numbers → both need `numericKeys` entries). Each proven with a non-400
   `flags.sh set` before it is called done.
6. Telemetry per `Specs/SPEC-2026-09-02-TELEMETRY-CATALOG.md`: `poster_generate`
   (ratio, latency, ok, attempt, style_version), **`poster_verify` (ok, attempt,
   extra_text_found, title_score)** — the success value the ship gate asserts on —
   `poster_compose_fallback`, `poster_variant_served` (web + app), `$exception` on every
   failure path. Tagged with the creator's email.

---

## 7. Order of work

| Phase | What | Est. |
|---|---|---|
| 0 | Spike: does `imageConfig.aspectRatio` work on `gemini-3.1-flash-image`? Staging only. | 0.5 d |
| 1 | New prompt + style, portrait only. **Look approved by you before anything else is built on it.** | 1 d |
| 2 | Verify pass: `poster_verify.ts`, JSON contract, diff rules, retry with failure fed back | 1.5 d |
| 3 | Three ratios, R2 layout, `variants`, `format=auto`, cache headers | 1 d |
| 4 | Web: remove wizard preview, poster card, More info panel, detail hero via `<picture>` | 2 d |
| 5 | Flutter: poster cards, ratio selection, quick-info sheet | 1.5 d |
| 6 | Compose fallback + server: `cover_required` fix, flags declared and proven, telemetry, `ship_manifest.json` entry | 1 d |
| 7 | Verify: `flutter analyze`, `npx tsc --noEmit` in `worker/`, design-guard, ship-gate, two devices on the new build, **20-poster batch measuring the real first-pass rate** | 1 d |

**Total ≈ 9.5 working days.** Phase 1 is a hard gate — no plumbing gets built on a poster
style you have not looked at.

---

## 8. Risks

- **Invented text** (fake credits, fake studio names) is now the *only* text failure that
  matters, and it is explicitly a verification failure. Phase 7 measures the real rate on
  20 posters rather than assuming the verifier works. Admin approval stays in front of
  publish regardless.
- **Latency.** Each generation is ~90s and there are three ratios, so a poster can take a
  few minutes. The flow is already async (`ctx.waitUntil`), but the wizard must say so
  rather than appear stuck.
- **Existing published listings** are untouched — `attrs.poster.url` stays the portrait.
  Backfilling old listings to three ratios is a separate opt-in job.
- **Prod is live.** Everything ships behind the flags in §6, default off, flipped one at
  a time when you say so.

---

## 9. Decisions taken (2026-09-05)

1. **Poster carries title + tagline only.** Price and every other fact live in the More
   info panel as HTML text over a flat poster ground — no image generated, no number
   through a model.
2. **Lettering is AI-painted, not composited** — hand-lettered titles are what make the
   reference posters read as posters. Compositing is the fallback.
3. **Verification stays**, scoped to two strings plus a hard "nothing else" check.
4. **`format=auto`** on web and Flutter.
5. **Style:** bright screen-printed film poster, not aged paper; the prompt names the
   process and negates the aging.

Working reference for the fallback renderer: `tool/poster_compose_preview.py` (preview
harness, not shippable code).
