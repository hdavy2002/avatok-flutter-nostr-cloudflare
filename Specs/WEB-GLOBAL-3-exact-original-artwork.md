# Global landing page — exact original artwork

Owner instruction: use the approved original images, not generated or inspired replacements. India remains unchanged. Use Astra directly, not DeepAstra.

## Implementation

- Hero, three format cards, payout map, category portraits and red CTA are literal source-image crops. Desktop preserves the original compositions. Mobile stacks smaller source crops with ordinary document-flow image sizing.
- The eight creator idea cards use the original 1536×1024 concept, in the approved order. `OriginalIdeasSection` is shared by the homepage and global catalogue. Every card opens its existing individual article.
- Global article hero images and related cards use the same original crops. Editorial guide content remains intact.
- Global header remains sticky and functional; its logo and top doodle are original image crops. Existing login, country/language controls and footer destinations remain. India components and page have not been edited.
- The artwork contains illustrative payout figures, country/currency coverage and fee claims. A visible qualification links to current payout details; the artwork is not confirmation of worldwide payout availability.

## Reproduction and checks

`web/scripts/global-original-crops.json` identifies exact crop rectangles. `web/scripts/crop-originals.py` produces PNG and lossless WebP assets from the retained hero/middle source images. `web/scripts/crop-original-ideas.py` crops the original ideas image without resizing or retouching.

The GitHub Actions homepage check compares decoded pixels of all hero/middle PNG and WebP crops and all eight idea cards against their source regions. Existing article, anchor, India and shared-footer checks remain.

No local build is permitted by project policy. Production deployment and browser acceptance checks remain pending explicit confirmation for this correction.
