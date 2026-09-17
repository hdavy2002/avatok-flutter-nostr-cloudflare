# Global creator marketplace: fresh disco direction

## Latest revision: photo-collage, not corporate

Owner rejected the restrained disco illustration direction as too corporate. Current preview at the same URL is now a fluid, full-width photo-zine: original `assets/global/` photography, textured paper, red/yellow/blue/lime palette, rough decorative edges, Comfortaa headings, three format panels and eight photo-led linked ideas. Generated disco illustrations remain saved but are no longer used by this preview. No new image generation or bitmap editing in this revision.

The page no longer has a 1240px maximum-width shell. Responsive content gutters are retained for readability; colour bands span the viewport. Native text remains outside images; images use contain/intrinsic sizing. Major section margins are now 110px desktop and 80px mobile. Preview reviewed at 320, 390, 820 and desktop viewport widths: no horizontal page or heading overflow detected. Existing links preserved; production/India unchanged. The earlier implementation notes below document the superseded first preview.

Status: local preview only. Production and the Indian experience are unchanged. No build or deployment was requested for this revision; no local compile was run.

Preview: http://127.0.0.1:8770/ (static review server; `/tmp/avatok-disco-preview.74Ot7i`).
Prepared Astro route: `/global-next`, noindex. It imports the same authored HTML and CSS as the static preview and uses the existing shared global header/footer. The preview reuses deployed chrome markup; Astro compilation remains a CI check before publication.

## Owner direction

Entirely new art and layout, not cropped screenshot sections or an imitation of the previous artwork. 70s disco / Saturday Night Fever fashion, GenZ friendly, international influencers and fans. Comfortaa headings. Torn paper and generous section separation. Real responsive text and links, no text embedded in artwork. Keep India unchanged.

## Implementation

- `web/src/content/disco-landing.html`: full readable page, two new illustrations, separate creator/fan actions, paid livestreaming and private video sections, earning explanation, three steps, eight linked editorial ideas, local payouts, FAQs, final CTA.
- `web/src/styles/disco-landing.css`: 130px desktop / 88px mobile section spacing; background-only torn edges; intrinsic image dimensions; content never clipped. Responsive cards and real Comfortaa typography.
- `web/src/pages/global-next.astro`: preview route; current homepage remains untouched.
- `GlobalHeader.astro`: backwards-compatible optional `design` and `homePath` props. Original default unchanged. New page reuses the shared sticky header, country/language controls, authentication links and mobile menu.
- Self-hosted `web/public/fonts/Comfortaa-Bold.ttf` with `Comfortaa-OFL.txt`. Original source: Google Fonts Comfortaa v47. Actual font visibly verified in the preview.
- All existing footer links retained through `SiteFooter` global variant.

## Copy boundaries

Do not claim higher payouts than every other platform, guaranteed earnings, universal currency coverage or universal payment-method support without evidence. Focus on creators setting prices and earning from booked sessions. Local currencies / bank transfers / UPI depend on country and eligibility; link current payout and pricing pages.

## Review evidence

- Desktop and 390px viewport browser review; no page-wide horizontal overflow (mobile client/scroll width 375px).
- All eight idea cards present; all local navigation anchors resolve; no heading horizontal overflow in mobile review.
- Public destinations (eight articles, signup/login, marketplace, help, policies, footer) returned HTTP 200 on read-only HEAD checks. Authenticated booking and payments were not submitted/tested.
- Comfortaa served locally rather than relying on remote font CSS. Whole hero figures/shoes retained; all body images use intrinsic scaling.
- `git diff --check` passed. `graphify update .` completed. No production writes, commits, pushes or build dispatches.

## Artwork provenance and final prompts

Created with built-in image_gen by Astra asset-only worker; one call per asset, no previous screenshot inputs. Final project assets:

- `web/public/assets/global-disco/creator-floor.png` (1254 × 1254)
- `web/public/assets/global-disco/fan-conversation.png` (1536 × 1024)

### Hero prompt

Use case: illustration-story
Asset type: standalone square 1:1 hero illustration for AvaTOK creator/fan marketplace.
Create entirely original art: three diverse adult global creators in their twenties on a small disco floor, one holding a microphone, one waving toward the viewer/camera, one striking a fashion pose. Small disco ball overhead. 70s Saturday Night Fever fashion/disco mood, GenZ friendly: bellbottom trousers, wide collars, chunky platform shoes. Represent varied skin tones and genders with distinctive expressive faces.
Style: modern editorial paper-cut illustration, sophisticated sculptural shapes, layered paper and subtle print grain, polished art direction. Plum, vivid orange, butter yellow, cream and pink palette. Warm cream background.
Composition: clean intentional balanced grouping, all three full bodies including platform shoes entirely visible, generous empty margins on every side; disco floor small and contained. Joyful confident energy.
Constraints: no text, no labels, no logos, no UI, no busy stickers, no screenshot or website layout. Only a standalone illustration.

### Conversation prompt

Use case: illustration-story
Asset type: standalone landscape 3:2 illustration for AvaTOK creator/fan marketplace.
Create entirely original art: an intimate friendly video conversation between two diverse adults in their twenties, a creator and a fan, in separate warm retro rooms shown side by side. Both are clearly engaged in a joyful genuine conversation, expressive smiles and natural conversational gestures, each facing slightly toward the other across the composition. Wide-collar 70s fashion and headphones. Minimal room props.
Style: modern editorial paper-cut illustration with sophisticated sculptural shapes, layered paper and subtle print grain. GenZ friendly 70s Saturday Night Fever fashion influence. Plum, vivid orange, butter yellow, cream and pink palette. Warm welcoming light.
Composition: two complementary intimate room vignettes side by side in a single cohesive landscape artwork, simple architectural division, comfortable breathing room. Their connection is the focus.
Constraints: no text, no labels, no logos, no fake buttons, no UI frames or controls, no busy stickers, no screenshot or website layout. Only a standalone illustration.

## Before publication

Obtain approval of this fresh direction, then promote the content to the default global homepage, select disco design on the shared global header consistently, update obsolete original-pixel homepage checks, and run the existing CI web workflow. Do not change India's landing/header/footer or include unrelated wallet/pricing work. The current OG image is preserved; a new social card requires an explicit request.
