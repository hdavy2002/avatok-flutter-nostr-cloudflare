# Hello Fraands design system — "Indianize it" (owner rules, updated 2026-10-18)

**Read this before any Hello Fraands page, screen, component, artwork prompt or app animation.** It is the
single source for how the owner wants the product to look and how we build it. It replaces the 2026-10-17
"desi homepage" version. Rule ids live in `Specs/RULEBOOK-HELLO-FRAANDS.md` (HF-DS-1, HF-DS-2, HF-DS-7, HF-DS-8). App screens: §11. The same
philosophy applies to the **website, the Android/iOS app screens, onboarding screens and app animations**.

When a page ships, **update §8 (Theme registry) in the same commit**. A future session reads that table to
avoid repeating a theme, craft, motif or layout.

---

> **⚠️ NON-NEGOTIABLE (owner, repeated 2026-10-18): before ANY push to the web or ANY app build, take a visual
> look in the external browser (§9) and fix every issue first. Borders must never be squeezed or stretched,
> buttons must never be stretched or distorted, text never overlaps, art never blends into the background.**
> This applies to web pages, app screens (check the build/preview or screenshots), onboarding and animations.

> **★ Owner-approved art standards (2026-10-18, from the /faq work): §6.1 borders, §6.2 buttons, §6.3 object art and
> heroes, §7.4 border prompt template, §12 mistakes not to repeat.** Read them before making or wiring any border,
> button, hero or object image.

## ★ Design philosophy: art-directed, never boxy (owner, 2026-10-18; read first)

**The owner is not looking for sloppy, boxy designs.** Every page and app screen must feel *deliberately designed
at every level*, from the overall composition to the crop of a portrait and the placement of a single word. This
philosophy leads; the rest of this file says how we deliver it. Where an older rule below conflicts, **this section
wins**.

### The style
Bold, expressive, **art-directed graphic design**, with the visual imagination of an advertising campaign carried
through a usable website or app:
- oversized typography;
- cutout photography;
- playful, layered compositions;
- contemporary Indian character.

### Compose text and images together
- **Headlines become part of the artwork.**
  - Dramatic scale, intentional line breaks, tightly composed lettering.
  - Occasional combinations of **solid and outline type** (Nunito 900 with `-webkit-text-stroke` for the outline;
    still only Nunito/Comfortaa).
- **Interactions between people and type** must feel carefully composed and physically believable:
  - a creator stands in front of a word while an arm passes behind another letter;
  - a person leans against a geometric shape or emerges beyond a frame.
- **Photography:**
  - Expressive photographs of **Indian creators** with varied personalities, appearances and interests.
  - Poses chosen to work with the design.
  - Clean background removal that preserves natural hair and clothing edges.
  - Mix full photographs with cutout portraits, oversized letters, circles, arches and selective illustrations.
- **Headlines:** short and memorable, with personality. The words and their arrangement work together visually.
  Supporting copy stays concise and readable.

### Rhythm and personality
- A **strong focal point in every section**.
- Alternate bold compositions with quieter areas and **generous breathing room**.
- Use asymmetry, deliberate overlaps, unexpected crops and changes in scale, while keeping clear alignment.
- Each section has **its own composition** within one coherent visual language.

### Contemporary Indian design
- **Warm ivory base** with a **controlled selection** of vermilion, marigold, rani pink, indigo or leaf green.
  Choose **a few colours that work together** per page or section rather than every colour everywhere.
  - This refines the older "multi-colour" rule: rich, but curated.
  - Leaf green is allowed here only as one of these chosen accents, never as a dominant UI colour.
- Indian **block-print borders, botanical stamps, textile-inspired patterns and hand-drawn accents**, used
  selectively. Each must have a clear role: framing imagery, separating sections or highlighting content.
- The feeling: **youthful, welcoming, culturally rooted, polished.**

### Applied to the marketplace (and every product page)
- **Hero:** a memorable composition of oversized lettering and creator photography, with a **prominent, usable
  search field**.
- **Easy to scan:** search, category filters, creator names and actions.
- **Creator cards:** distinctive image crops, subtle printed borders, thoughtful typography.
- **Save the drama** (big overlaps, people breaking frames) for featured creators, category banners and promotional
  sections.

### Mobile
Preserve the hierarchy and visual character. Reposition overlapping elements (don't just shrink them) and keep
controls accessible and centred (§2.11).

### Avoid these failures (check every design against this list)
- Repeating the same rounded card layout throughout the page.
- Placing every image inside a separate rectangular container.
- Identical heading-and-three-card sections, repeated.
- Random blobs, icons, gradients or shadows as substitutes for composition.
- Shrinking all typography to safe, uniform sizes.
- A polished hero followed by generic template sections.
- Decoration that obscures essential text, faces or controls.

### Building it (implementation notes)
- **Cutouts:** transparent PNG/WebP cutouts layered with z-index over real HTML text.
  - For "arm behind a letter", split the cutout into two layers: the body in front, the arm masked behind, or a
    second masked copy above the word.
  - Shapes come from CSS (`border-radius` arches, circles, `clip-path`).
- **Text stays real HTML text**, never baked into images: it has to stay accessible, searchable and translatable.
- **Overlaps** never cover a face, a control or the text a user needs. Verify this in the browser at every width.
- **Reference images** from the owner guide typographic confidence, image-and-letter interaction, depth, colour
  relationships and energy. Develop an **original** design from those principles; never copy a reference.

---

## 0. The command: "Indianize it"

When the owner says **"Indianize this page"** / **"please indianize <page or URL>"** (in any session), run this flow.
He may add a flavour: *"indianize this with Bollywood humour / memes"*, *"indianize this with a 70s India look —
long-collar shirts, bell-bottoms, a Vespa, a couple on a Jawa or Yezdi motorcycle"*, *"…with Onam"*, etc. The
flavour leads the concept.

1. **Read first.**
   - This file, especially §8, which lists the themes already used.
   - The current page (source + live URL).
   - Its copy contracts (`web/scripts/check-*.mjs`).
   - The product facts in §1.
2. **Pitch 3 ideas and wait for approval.** Each idea is a different Indian theme: an art form or craft, a
   festival or event, a region (north, south, east, west or north-east) or a slice of daily life. It must not
   be in §8. For each idea give:
   - its name and a one-line story;
   - the example or character that walks the user through the content;
   - the crafts used for borders, tiles, buttons and badges;
   - the palette;
   - the layout shape (scroll, booth, comic, ledger and so on).

   Use AskUserQuestion. **No code before he picks.**
3. **Build the layout.**
   - New page skin (§6) with CSS stand-ins for every art slot, so the page works before the art exists.
   - Less reading, more picture (§3).
   - Desktop + phone (§5).
4. **Write the image prompt pack** (§7) and save it:
   - Project doc `claude/hello-fraands-<page>-artwork-prompts.md`, plus a copy in the session outputs.
   - Give him the folder (`web/public/assets/hf-<page>/`) and the exact file names.
5. **Visual check, then deploy** (§9). Look at the page yourself in the external browser at 1440 / 820 / 390 / 320,
   then deploy. The owner's standing rule: *after you finish, just deploy*.
6. **When he says the images are saved:**
   - Check them: a contact sheet plus sizes, alpha, bounding box and button/border measurements (§7.3).
   - Wire them in and restart the dev server.
   - Check visually again and fix the slices.
   - Deploy.
   - Verify the live page.
7. **Record the theme** in §8 and the rulebook in the same commit.

---

## 1. Know the product before designing

- **What it is.** A brand that connects **fans** with their favourite Indian social-media **influencers**
  (YouTube, Instagram, Facebook) on a **private, masked phone call**.
- **Masked calls.** We ring the influencer first. They press 1 to accept or 2 to decline. Then we ring the fan
  and join the calls. Both calls come from our number, so neither real number is shared.
- **Fans:**
  - Pay **per minute of the phone call, at the influencer's rate**, from a rupee wallet.
  - Ringing, a declined call or a missed call costs ₹0.
  - **Never** mention per-second billing or rounding.
  - **Never** name the payment gateway (Cashfree, Razorpay) or Google Pay / Google Play as payment.
- **Influencers (owner model, 2026-10-18):**
  - Create a free account, then **upgrade to influencer for free from the dashboard**.
  - Set their **own per-minute rate, as they see fit** (no range shown).
  - Earn **60% of the connected-call charge minus ₹2.00 per connected minute** for the telephone call.
  - **The 40% covers platform fees and GST.**
  - Being online does not guarantee calls.
  - **Indian influencers only, for now.**
  - Do **not** describe registration, verification or KYC steps (KYC is no longer part of the flow).
  - Influencers appear as an AI avatar they chose, not their real photo.
- **Safety:** press **#** to end and block; reports are reviewed by our team; there's a women-only lane. Calls
  are for conversation, not professional advice.
- **Brand name and domain:** only from `Specs/brand.json` / `BRAND`. The push script blocks a hand-typed brand
  name, even in comments.

Design every page so a first-time Indian user understands *this* product quickly. The art tells the story, and
a worked example (a named character, real rupee numbers) does the explaining.

---

## 2. The owner's taste (non-negotiable)

1. **Every page is Indian artistry, and every page is a different India.** Each page takes a new Indian art,
   craft, festival, event, region (south to north, east to west, the north-east) or daily-life scene. India has
   endless traditions, so never repeat one.
2. **Fresh images and ideas every time.**
   - **Never reuse** another page's artwork, motifs, layout or concept, not even as a temporary placeholder.
   - Until the owner's art arrives, the stand-ins are drawn in CSS.
   - Before using a motif, check §8.
3. **Multi-colour, never one-tone (now: a curated few colours on warm ivory; see ★).** He loves the richness of a Rajasthani painting: many bold colours side by
   side. A page whose images all share one hue (all blue, all brown) is wrong. Vary the band colours section by
   section. Green: only inside artwork, or leaf green as one chosen accent per the ★ brief, **never as a dominant UI colour**.
4. **Bold and loud.** Go big:
   - Large graphics that blend into the type.
   - Vertical type where it fits (a vertical word down a band or beside art).
   - Oversized headlines.
   - Hinglish voice.
   - Fun meme stickers where the theme allows (textured, painterly, not cartoons).
   - Never a generic SaaS look.
5. **No sharp edges anywhere** (but vary the shapes and crops — arches, circles, cutouts — rather than one repeated rounded card; see ★). Rounded corners on cards, images, frames, chips, listing cards, inputs and
   buttons (radius 14–28px; pills for buttons and chips).
6. **Never boxy.**
   - Bands run edge to edge, full width.
   - Content uses the wide `.wrap` (max 1440–1760px), never a narrow centred column.
   - Large screens must look full and intentional.
7. **Space around everything.**
   - Nothing jumbled.
   - Stickers never sit on top of the main art or text.
   - Neighbouring sections are visibly separate (a different band colour or a craft border, plus padding).
8. **Little reading.**
   - Explain with pictures, numbers, chips and short lines.
   - Cut paragraphs to one sentence where you can.
   - Keep the legal or contract sentences that tests require, and nothing more.
9. **Animals.**
   - **No peacocks** (not in prompts, art or icons).
   - Elephants are fine when the theme calls for them.
   - Parrots, camels, fish, deer, birds and cows are fine.
10. **Fonts:** **Nunito** (headings, buttons, numbers, badges; weight 800–900) and **Comfortaa** (body) only. No
    tiny text (body ≥16px, captions ≥13px). Button text is always **bold** (Nunito 900).
11. **Phones:**
    - The header, page title and every section's eyebrow, title, text, chips and buttons are **centred by
      default**.
    - Lists and form fields may stay left-aligned inside a centred card when centring would hurt reading.
    - No text overlapping text or art.
12. **No preview or placeholder lines on public pages.** Remove "The current site is a preview…" when you meet it.
13. **No flat illustrations (owner 2026-10-18).** Every image is **textured and dimensional**:
    - Visible material texture: hand-made paper grain, cloth weave, embroidery stitches, brush strokes, lacquer
      gloss, mud-wall or wood grain, metal inlay.
    - Real depth: soft shading and highlights, layered relief (paper-cut, appliqué, carved or embossed layers),
      cast shadows, objects that feel touchable, like a painted miniature or a handcrafted diorama.
    - Still Indian folk-art in look and still multi-colour. It is **not** glossy plastic CGI, cartoon 3D or
      photorealism.
    - Never flat vector art, flat fills with no texture, or clip-art.
    - **Photography is the exception (★ philosophy):** creator and people imagery for heroes, featured creators and
      campaign sections should be **expressive photographs of Indian creators as clean cutouts** (natural hair and
      clothing edges kept). The textured, painterly rule applies to the illustrations, craft accents, badges,
      borders and stickers around them.
    - **No cartoons.** No cartoon characters, chibi or big-head caricatures, comic or animated-movie styling.
      People are drawn in the craft's own painterly way (miniature painting, Patachitra, mural, embroidery),
      with natural proportions.
    - **Exception: backgrounds behind text (owner 2026-10-18).** Background tiles, section grounds and any
      image that text sits on top of must **not** be richly textured or dimensional, because realistic texture
      fights the text and it can't be read. Make backgrounds however suits the design: calm, low-contrast, soft
      pattern or near-plain colour. The textured, dimensional rule applies to everything else (hero art, story
      panels, medallions, badges, stickers, buttons, borders, frames).
14. **Objects stand on their own (owner 2026-10-18).** A drawn object that *is* the tile (a dabba, a kite, a record,
    a ball) is shown **big, with no card, no box and no tinted square behind it**, standing on the section ground
    with a soft drop shadow. Only its label sits under it. Small objects inside cards were rejected (§6.3).
15. **Hero art is big.** The hero picture takes the wider column (about 55%) and grows up to ~1040px on large
    screens; on phones it is full width. A hero picture that sits small beside the text was rejected (§6.3).
16. **Chunky, never thin.** Buttons and borders must look generous: taller keys with bigger labels, taller borders
    with whole motifs. Anything that reads as a thin strip or a squeezed pill was rejected (§6.1, §6.2).
17. **Mock first for big redesigns.** For "Indianize it", the 3-idea pitch is the approval step. Never change an
    approved design's look when only copy changes.

---

## 3. Layout recipe (what has worked)

- **A story spine.** One named character walks through the content:
  - Riya calls Ajay on /how-it-works.
  - Neha becomes an influencer on /hosts/join.

  Steps are panels with a numbered medallion, a short heading, one line and a tiny example chip: a profile card
  with ₹20/min, the keypad keys 1 Accept / 2 Decline, or the bill 10 min × ₹20 = ₹200.
- **Hero.**
  - Bold headline (2 lines; the accent phrase in a second colour).
  - The Hindi/Hinglish line in `.hf-hindi > em` (tests expect it).
  - 3 fact chips.
  - 2 buttons.
  - Big hero art.
  - On phones, the art goes first, then the copy.
- **Money explained as pictures.**
  - Split boxes, e.g. Fan pays ₹20 → Your 60% ₹12 → Call −₹2 → You earn ₹10.
  - Coins or receipts for totals.
  - A small calculator when it helps.
- **Each section** gets its own craft ground (a tile) and a craft border between bands.
- **A closing panel** with art, a short "Ab aapki baari" style heading and two buttons.
- **Shared header and footer** (`components/callvaal/Header.astro`, `Footer.astro`) on every page, except
  sign-in / sign-up, which have no header or footer (owner rule).

---

## 4. Type and sizes (measured from shipped pages; keep this scale)

| Role | Size | Notes |
|---|---|---|
| Hero H1 | `clamp(40px, 5vw, 82px)` (home hero up to `clamp(50px, 7vw, 120px)`) | Nunito 900, line-height ~1.03, `text-wrap: balance` |
| Section H2 | `clamp(32px, 3.6vw, 60px)` | Nunito 900 |
| Card H3 | `clamp(22px, 2.2vw, 36px)` | Nunito 900 |
| Eyebrow / kicker | `clamp(13px, .85vw, 16px)`, letter-spacing .2em, UPPERCASE | Nunito 800–900, accent colour |
| Body | `clamp(16px, 1.1vw, 19px)`, weight 600, line-height 1.55 | Comfortaa |
| Buttons | `clamp(17px, 1.2vw, 21px)`; phones 15–16px | Nunito 900, `!important` (global link styles override it otherwise) |
| Big numbers | `clamp(28px, 2.6vw, 42px)` | Nunito 900 |

- **Gutters:** 32px desktop, 16px phones (`max(16px, env(safe-area-inset-*))`).
- **Section padding:** `clamp(56px, 6vw, 104px)`.
- Never use negative letter-spacing on bold type, and never use synthetic bold.
- **On phones, shrink before wrapping.** Keep the owner's line breaks and test at 320px.

---

## 5. Responsive rules

- Grids collapse to one column at ≤900px. Flipped (alternating) rows reset, so the art always comes first.
- On phones:
  - Everything is centred (§2.11).
  - Cards narrow their padding (14–16px).
  - The scroll or sheet wrappers drop their extra gutters, so text columns are never thinner than ~240px.
  - Buttons go full width (max 360px) in a column.
- **No horizontal scroll at 320 / 390px.** CI runs a Playwright check at **320px with a 200% root font**.
  Don't use `white-space: nowrap` on button labels; let them wrap if needed, but design them to fit on one line.
- Tables become visuals (coins, rows) or get compact padding on phones.
- Stickers that would cover art on desktop are hidden on phones.

---

## 6. Building a page skin (code pattern)

- **One scoped skin per page:**
  - `web/src/styles/<page>-<concept>.css`, scoped under a short class (`.hw`, `.jp`, `.gh`, `.auth--pco`).
  - `web/src/components/<page>/<page>Skin.ts` with the art slots.
- **Art slots:**
  - `existsSync(public + path)` at **build time**, so the page must be `export const prerender = true`.
  - Lesson: `existsSync` in an SSR page caused a **500 on Cloudflare** (the sign-in pages).
- **Background art** is passed as CSS custom properties holding a full layer (`url(...) position / size repeat`),
  used as `var(--x-art, <CSS stand-in>)`.
- **Optional skins** are gated with `data-skins~="key"` on the wrapper.
- **Images:**
  - Always go through `publicImage(path, { width, fit: 'scale-down' })` (the Cloudflare AVIF pipeline).
  - Set width/height attributes. Use `loading="lazy"`, except for the hero (`fetchpriority="high"`).
- **CSS stand-ins:** every slot has a drawn-in-CSS fallback in the same palette, so the page ships and passes
  tests before the art arrives.
- **Buttons from art:** see **§6.2** (owner-approved sizes, measuring and slicing).
- **Section borders:** see **§6.1** (owner-approved v2 standard: 1600×160 art with whole motifs, `auto 100%`).
- **Background tiles must match their band.** Before wiring, look at each tile's colour and put it only on bands of
  the same colour family (a maroon tile on maroon bands, a cream tile on cream bands). An opaque tile replaces the
  band's background colour, so a pale pink tile on a maroon band turns the band pink and breaks white text. If no
  tile fits a band, leave that band on its CSS stand-in.
- **Re-check contrast after art lands.** A tile is often lighter than its CSS stand-in. Cream or white accent text
  that read well on the stand-in can vanish; switch the accent to an ink or maroon colour where it does.
- **White rounded frames:** art laid over a busy or same-coloured background gets
  `border: 8px solid #fff; border-radius: 18–24px; box-shadow: 0 0 0 3px ink, 0 10px 0 3px ink`, so it never
  blends into the background. This has been used on the call strip and the closing art.
- **Medallions:** round badges with an empty centre. Put the number in Nunito 900 on top, and the image at
  `inset: -10/-12px`, because the PNGs have small transparent margins.
- **Tests:**
  - Standalone art pages are exempted from the legal-layout summary and date checks in
    `check-hello-fraands-pages.mjs` and `check-homepage-browser.mjs`. Keep one H1, an H2, `.hf-hindi em`, and
    the shared header and footer.
  - Update the copy contracts when the owner changes facts. Never delete a contract without replacing it.

---

### 6.1 Section borders — the approved v2 standard (owner, 2026-10-18)

The owner said of the /faq borders: *"I like the borders you have now made, record this for future use."* This is
the standard for every page from now on.

- **Art:** **1600×160 PNG (10:1)**, seamless left to right, every motif **whole** inside the frame (no tile, tiffin,
  scallop or check cut by the top or bottom edge) with about 10px of the band's ground colour above and below. Each
  repeat unit is about 140–160px tall, so 8–10 units span the 1600px. Prompt template: §7.4.
- **Show it at its true shape:** `background: url(...) center / auto 100% repeat-x`. Set the size string once in the
  page's skin file (e.g. `const BAND = 'center / auto 100% repeat-x'` in `components/faq/faqSkin.ts`).
- **Band height:** `height: clamp(66px, 5.8vw, 108px); border-block: 3px solid var(--ink);` → about 66px on phones,
  84px on a 1440 screen and 108px on large screens. Don't go lower: whole motifs at true shape look tiny under 60px.
- **Never** squash, stretch or crop a border. Never set the repeat width by hand on art that already has the right
  shape.
- **History (so nobody repeats it):** v1 borders were 1600×80 crops whose motifs were cut inside the file (Minton
  flowers without tops, tiffins without lids and bases). At 28–44px they looked like thin strips; made taller they
  still looked "chopped", because no CSS can show what the file doesn't contain. The fix was new art, not CSS.
- **Old 20:1 art** (other pages: `hf-how`, `hf-join`, `hf-help`, `hf-contact`…) keeps its measured
  `(height × 20) 100%` sizing until it is regenerated to v2. If one looks squashed (round motifs come out oval),
  draw the repeat narrower to restore round shapes and tell the owner; better still, ask for v2 art.
- CSS stand-ins still draw a simple version of each border so the page works before the art arrives.

### 6.2 Buttons from art — approved sizes (owner, 2026-10-18)

Owner feedback on /faq: *"the buttons are looking squeezed — increase the text size, adjust the height and width"*,
then *"they still seem squeezed height-wise"*. The fix that was approved:

- **Measure the PNG first** (PIL): the opaque *face rows* (e.g. rows 7–150 of 180) and where the plain middle colour
  starts (`flat cols` along the middle row, ~170–200px in). Slice with
  `border-image: url(...) <top> <decor> <bottom> <decor> fill / 0 <cap> stretch`, e.g. `7 200 30 200 fill`.
- **Cap width** = `height × decor ÷ faceRows`, so the ends keep their drawn shape. **Check the art for uneven
  resizing:** if a drawn square (a tile, a glass) on the ends comes out wider than tall, the PNG was squashed when it
  was saved; divide the cap by that factor (the /faq keys needed ÷1.25) and tell the owner.
- **Approved sizes** (Nunito 900 labels):

  | Width | Key height | Label |
  |---|---|---|
  | desktop | 80px | `clamp(20px, 1.35vw, 24px)` |
  | ≤900px | 68px | 20px |
  | ≤420px | 62px | 18px |
  | ≤360px | 56px | 14–16px |

- Every label fits on **one line** at 320px and at 200% root font (`range.getClientRects().length === 1`). If a long
  label can't fit, shorten the wording (e.g. "Influencer dhoondo") rather than squeezing the key or the text.
- On phones the button column is `max-width: 440px`, full width, stacked.
- Key depth is a `filter: drop-shadow(0 4px 0 rgba(ink,.55))`, never part of the slice.

- **Leaves, scrolls and other wide art "keys" (owner, 2026-10-19, /help pothi):** same rule — cap = height × decor ÷
  faceRows (the pothi leaf: `83 356 95 356`, cap = 2.92 × height). Give the element a **fixed height** so text can
  never stretch the caps. Where the caps no longer fit beside the text (≤1100px), don't squeeze them: switch to a
  card with the whole leaf at true shape as its header strip (`::before`, height `min(52px, 12.5cqw)`).
- **Wooden chips (pothi leaves) — the approved standard (owner, 2026-10-19, /help):** every chip on every page uses
  these numbers. Height `clamp(104px, 8vw, 132px)`; each lotus end `1.6 × height` wide (the art's true cap is
  2.92×; the owner narrowed it step by step and approved 1.6); the numbered flower medallion is **46% of the chip
  height** with its number at 17% of the height (Nunito 900); question text `clamp(22px, 1.75vw, 32px)` Nunito 900,
  topic pill 16px, opened answer text `clamp(19px, 1.45vw, 26px)` (owner reduced these 2026-10-19 after seeing them live).
  iPad (701–1100px): 64px medallion, question 24px, answer 20px. Phones (≤1100px): card with a whole-leaf header
  `min(66px, 16cqw)` tall (ends 1.6× its height), 112px medallion with a 42px number, question 24–32px, answer 22–28px.
- **Art buttons (keys) — the approved standard (owner, 2026-10-19):** caps `0.95 × key height` for the help keys
  (squashed PNGs), labels Nunito 900 forced with `!important` (the shared chrome resets link fonts), 22–26px on
  desktop and 17–20px on phones, always one line.
- **Standard header (owner, 2026-10-19):** one header on every page (`components/callvaal/Header.astro`): Home ·
  Explore · How it works · Help, then Sign in and the red **Join us** CTA (`.cv-join`, 3px ink border, hard shadow,
  Nunito 900) while signed out. Signed in: Join us and Sign in disappear; Dashboard and Sign out show.
- **Footer toran (owner, 2026-10-19):** edge to edge, hanging straight from the bottom edge of the last section (no gap, no hairline): the homepage marigold toran (`/assets/hf-desi/toran-marigold.webp`) hangs
  from the top of the shared footer (`components/callvaal/Footer.astro`, `.cv-footer-toran`, 72px) on every page.
  Pages don't add their own toran above the footer.
- **Framed covers (books, ledgers):** a 9-slice frame must be **symmetric** and its sides must **repeat**
  (`border-image-repeat: round`), never `stretch` — a tall page stretched the /help bahi-khata paisleys into stripes.
  If the art has a one-sided extra (tassels), mirror the clean half into a new file (`bahikhata-frame.png`) rather
  than slicing around it.

### 6.3 Object art and hero art (owner, 2026-10-18)

- **Objects as tiles** (dabbas, kites, records…): no card, no tinted square. Grid `repeat(auto-fill,
  minmax(min(100%, 300px), 1fr))` on desktop (about 330px each), two per row on phones. The image fills its box
  (`width: 112%; margin: -6%; object-fit: contain`) to use up the transparent margin, with
  `filter: drop-shadow(0 12px 10px rgba(ink,.35))`. The label sits under it with a soft cream glow
  (`text-shadow`) so it reads on any ground.
- **The same object beside each section heading** is shown big too (the full width of the heading column, up to
  ~380px; ~320px on phones), with no frame.
- **Hero picture:** hero grid `minmax(0,.9fr) minmax(0,1.1fr)`, picture `width: 100%; max-width: 1040px`; on phones
  `width: 100%; max-width: 720px`, placed first. Never let the picture bleed past the column with negative margins
  (it gets clipped at 1100px).
- **Transparent margins:** if the owner's transparent PNG has empty rows (e.g. 150px top and bottom), crop them in
  CSS with `aspect-ratio: <painted band>; object-fit: cover` rather than editing the file.

## 7. Image prompt packs

### 7.1 Pack structure

1. Design idea: the story, a table of steps or sections against art forms, the crafts used.
2. **Characters block:** fixed looks (age, skin, hair, clothes colours, phone-case colour), so every image matches.
3. **Style block** to paste before every prompt: the art form, a **multi-colour** palette, outlines, and always
   **"richly textured, dimensional, hand-crafted look: visible paper/cloth/brush texture, soft shading and depth,
   layered relief"** (§2.13). **Not** for background tiles and grounds: their block says "calm, low-contrast,
   soft pattern, text must stay readable on top"; no realistic texture.
4. **Negative prompt:**
   - (For illustration and craft assets:) photo, 3D, gradient, watermark, brand or app-store or payment logos, misspellings, extra fingers.
   - **Flat vector illustration, flat colour fills, no texture, clip-art, cartoon, cartoon characters, chibi,
     caricature, comic style, animated-movie style**, glossy plastic 3D/CGI.
   - Green background, neon, gloomy mood, **peacocks**.
   - **Every theme already used** (from §8).
5. **Text rule:** no words or numbers in pictures (the page adds them), except sticker lettering, which must be
   spelled exactly.
6. A table per folder: file name, size, transparency, prompt.
7. A checklist at the end.

### 7.1b Photographic creator prompts (★ philosophy)

- Expressive photographic portraits of Indian creators with varied ages, looks, styles and interests (a cook, a
  musician, a fitness coach, a comic, a traveller, a gamer…).
- Poses chosen for the composition: leaning, pointing, reaching, laughing, arms out, looking at a word.
- Shot against a plain studio backdrop for clean background removal, then delivered as **transparent PNG/WebP
  cutouts** with natural hair and clothing edges.
- Name the pose and crop needed (e.g. "arm raised to pass behind a letter", "leaning left against an arch").
- These are **generated or model images for design**, never real influencers' photos. On the live product,
  influencers appear as the AI avatar they chose (§1).

### 7.2 Size and format rules

| Asset | Size | Rules |
|---|---|---|
| Hero | ~1100×1100–1300, transparent | Subject in the centre 70% (phones crop) |
| Step / story panels | 1000×750, edge to edge | No border; the page adds the frame |
| Square strip tiles | 600×600 | — |
| Closing art | 900×720 | — |
| Medallions | 300×300, transparent | **Plain flat-colour centre (~50%) with nothing in it** |
| Badges / icons | 400×400, transparent | — |
| Borders | **1600×160**, seamless horizontal repeat | **v2 standard (§6.1, §7.4): every motif whole inside the frame with ~10px margin top and bottom.** Generate wide (3200×320), scale **evenly**. Never squash; circles stay round |
| Background tiles | 600×600 | Seamless both ways, **low contrast, calm, not textured or dimensional** (text sits on top and must stay readable) |
| Buttons | 900×180 | Fill the full height (no empty space above or below); decoration only in the **left and right 200px**; plain flat-colour middle; no text. **Generate at the true aspect and scale evenly** (the /faq keys came squashed ~1.25× and had to be corrected in CSS) |
| Object tiles (dabbas etc.) | 400×400, transparent | One object, centred, small margin, soft shadow; no background, no card |
| Rollers / rails | 1400×110, transparent | — |

- **File locations:** `web/public/assets/hf-<page>/<folder>/<exact-name>.png`. The owner generates the images and
  saves them; he may push them himself.

### 7.3 When the art lands

- Make a **contact sheet** (PIL) of every file and look at it.
- Print the size, mode and alpha `getbbox()` for each file.
- Measure the button face rows and decoration extents.
- Check, flagging anything wrong to the owner:
  - medallion centres are empty;
  - characters are consistent;
  - nothing is one-tone;
  - nothing looks flat or cartoonish (each image has texture and depth), **except backgrounds**, which must be
    calm enough for text to read on top;
  - there are no peacocks;
  - no theme is repeated;
  - **borders: every motif whole** (nothing cut at the top or bottom), left and right edges join with no visible
    seam;
  - **no uneven resizing:** measure a drawn square (a tile, a check, a glass) in each border and button end; if its
    width and height differ, the file was squashed. Correct in CSS and tell the owner;
  - **each background tile's colour matches the band it will sit on** (§6).
- **Restart the astro dev server** after the art lands. The `existsSync` results are cached, so new files don't
  show until you do.

---

### 7.4 Border prompt template (owner-approved, 2026-10-18)

Paste this block for every border, then add one line describing the page's motif:

> Seamless horizontal border band, exactly **1600×160** (generate at 3200×320 and scale down evenly; never resize
> width and height by different amounts). The right edge continues the left edge exactly. **Every motif is whole
> inside the frame: nothing touches or crosses the top or bottom edge; leave about 10px of the ground colour above
> and below.** Each repeat unit is about 140–160px tall, 8–10 units across. Painted, dimensional craft style (§2.13),
> multi-colour. No text, no peacocks, no green ground.

The approved /faq borders, as examples of the motif line:

| File | Motif line |
|---|---|
| `border-kaali-peeli.png` | A Bombay kaali-peeli taxi's black-and-yellow check stripe: two neat rows of whole square checks, painted enamel with slight wear, thin chrome trim along the top and bottom, a small even margin of black above and below. |
| `border-awning.png` | An Irani café awning seen straight on: vertical maroon, cream and rose stripes, a wooden rail along the top and fully rounded scallops along the bottom, every scallop complete, a thin strip of cream wall below. |
| `border-minton-tiles.png` | A row of whole square Minton floor tiles, each complete with its four-petal flower (bottle blue, saffron and cream with yellow centres) and a thin grout line, with a narrow cream margin above and below. |
| `border-tiffin-row.png` | A row of small complete three-tier tiffins (handle, lid, three tiers and base all visible), alternating rose, bottle blue, saffron and magenta, evenly spaced on a taxi-yellow ground, nothing cut. |

## 8. Theme registry (do not reuse; add every new page here)

| Page | Theme / concept | Crafts, motifs, characters used | Layout shape | Assets |
|---|---|---|---|---|
| `/` home | **Desi street / truck art** | Truck art, marigold toran, Warli friends strip, block print, Madhubani fish pair, rangoli mandala, Bollywood poster, chai tapri, rickshaw woman, jhoola women, creator train, dhol-wala, elephant with padlock; Hinglish stickers (Arre waah, Kya scene hai, Ek call toh banta hai, Reels se real tak, Chai pe charcha, Bas karo scroll); "HORN OK PLEASE" marquee | Full-width colour bands | `hf-desi/` |
| `/marketplace` explore | **Bazaar Pop** | Bunting, rosettes, pastel tile frames, marquee dots, category icons | Video-first creator grid | `hf-explore/` |
| `/help` + articles | **Gaon ka Ghar**: a happy village home at Sankranti | Painted mud-wall house, tiled khaprail roof, mandana dots, rangoli doorstep, **kites** for topics, palm-leaf pothi for top questions, stitched cloth bahi-khata for articles, aangan, women in kurta and jeans flying kites, meme stickers (havelis rejected as "haunted") | House → sky → courtyard | `hf-help/` |
| `/sign-in`, `/sign-up` | **STD-PCO booth** (no header or footer) | Red STD·ISD·PCO booth, yellow signboard, rotary phone, coin slot, keypad-key buttons, painted-signboard input frames, coin strip, cement floor tiles | Booth picture + booth form | `hf-auth/` |
| `/how-it-works` | **Teen Kadam, Teen Kala**: three steps, three paintings | Step 1 **Warli**, step 2 **Rajasthani Phad**, step 3 **Kashmiri papier-mâché**; borders **Ajrakh, Warli, Phad, Sozni, Phulkari**; grounds **Sanganeri, Warli mud, Leheriya, Kashmiri lacquer, Dabu indigo**; mirror-work and Sozni buttons; Riya (fan) and Ajay (influencer) | Cover medallion → 3 painted steps → 3-tile call strip → bill → CTA | `hf-how/` |
| `/hosts/join` | **Pat-Katha**: a Bengal Patachitra story scroll (the owner calls it the "lac" page) | **Patachitra** panels, a patua (scroll singer), **Channapatna lacquer** rollers and buttons, **Kantha** borders, **Gond** medallions and dot ground, **Bandhani** hero, **Bidri** earnings ledger, **Ikat** privacy section, **Kalamkari** close; Neha (cooking creator, Indore), Sana (fan) | Unrolling vertical scroll of 4 panels → Bidri ledger with coins + calculator → 3 promises → close | `hf-join/` |
| `/faq` | **Irani Café Dabba**: a Bombay Irani café with a dabbawala crate at the door | Café signboard, Farokh-uncle at the counter, glass biscuit jars, bun-maska, cutting chai, marble tables, **11 painted tiffin dabbas** with dabbawala codes (one per topic), café bill pad (Pooja, fan from Dadar, ₹20/min × 10 min), **Irani café rules board** for safety, dabbawala on a bicycle; borders **kaali-peeli taxi checks, striped awning, Minton tiles, tiffin row**; grounds **Minton floor, wooden crate, checked tablecloth, bentwood curls, glass jars, marble**; stickers "Yes, we have FAQs!", "Bole toh simple" | Café front → dabba rack (topic index) → bill → rules board → menu sections (sticky dabba + 2-col question cards) → next table → close | `hf-faq/` |
| `/contact` | **Aapki Farmaish**: a 70s radio request show | Big wooden **transistor** (Bakelite knobs, tuning dial), studio mic + ON AIR lamp, vinyl records, farmaish **postcard** with airmail stripe + ₹0 stamp (the email), 3 **records** for the steps, "Farmaish ke niyam" board with enamel tick/cross badges (what to send / never send), **tuning-dial stations** 88 Grievance · 98 Report · 108 Emergency (Bakelite knob medallions), brass station **nameplate** (postal address), 70s scooter close; Kamla (listener, mustard long-collar shirt + cherry bell-bottoms), Rafiq-bhai (announcer, teal safari suit); borders **speaker grille, 70s waves, record row, dial scale**; grounds **terrazzo, 70s curtain, ring wallpaper, radio veneer, postcard paper**; stickers "Mere paas reply hai!", "Agli farmaish aapki" | Studio → postcard → 3 records → niyam board → tuning dial → nameplate close | `hf-contact/` |
| `/about` | **Gully ka Scorecard**: a Sunday street-cricket match in a lane | Sky-blue lime-washed wall with **chalk stumps**, giant outline **HOWZAT** behind a photo cutout of **Bunty** (fan, 19, Kanpur) batting; **one over = six balls**, one fact each (tennis-ball badges on a chalked pitch line, the 6th a big **sixer** card: numbers stay private); a **painted tin scoreboard** with rivets for who runs it; **Meher** (cricket-commentary creator, photo cutout) at the mic on a circle; the **umpire's raised finger** + ✕ chips for what this is not; evening lane close; borders **chalk runs, bat-grip tape, brick wall**; grounds **lime-wash wall, cement pitch, tin slate**; buttons **willow bat, tin plate**; stickers "Howzat!", "Bas ek over aur", "Kya shot hai!" | Wall hero → over track (ball zigzag + circle-cropped lane painting) → scoreboard + commentator → umpire board → close | `hf-about/` |
| Policy pages (shared `HelloFraandsPage` layout: influencer, safety and legal footer pages, except /hosts/join) | **Ghat ki Seedhiyan**: a walk down a Varanasi ghat; one template, three colour flavours by footer group (*niyam* vermilion + marigold, *suraksha* rani + Ganga blue, *kaanoon* indigo + vermilion) | Painted ghat at sunrise with **Bholu the boatman** (photo cutout, leaning on his oar), giant outline word per flavour (NIYAM / SURAKSHA / KAANOON), **bamboo ghat chhatris** as the "On this page" bar, **sandstone steps** with a ledge (one per section) and **brass-lota** number medallions, marigold-bud bullets, Ganga close with a **boat + Dev Deepawali diyas** carrying related pages, **wooden oar** buttons; borders **diya row, marigold garland, sandstone balusters**; grounds **sandstone, ghat stone, Ganga ripples**; stamp "Seedhi baat · Saaf niyam" | Sunrise hero → diya border → chhatri row → garland → zig-zag staircase of steps → baluster border → river close | `hf-legal/` |

**Styles also used** (don't reuse as a page theme): comic-book halftone (rejected), postal / stamp look (rejected
as "postal"), haveli (rejected), Chettinad tiles + kolam + filter-kaapi as the site header/footer (rejected 2026-10-18), tombstone-like arched windows (rejected), scrapbook (old home).

**Known peacocks to replace** (made before the no-peacock rule): `hf-how/panels/step-2-phad.png` (peacock at the right) and `hf-join/medallions/gond-1-peacock.png`. Regenerate without peacocks when the owner asks.

### 8.1 Theme ideas not used yet (pick from here or invent new)

- **South:**
  - Kerala snake-boat race (Vallam Kali), Kathakali faces, Kerala murals, Onam pookalam.
  - Pongal pots (the Chettinad tiles / kolam / filter-kaapi header-footer was rejected, see above).
  - Mysuru Dasara with Ganjifa cards, Mysore and Tanjore gold paintings.
  - Kondapalli and Etikoppaka toys, Cheriyal scrolls.
  - Hyderabad Laad Bazaar lac bangles.
  - Goa azulejo tiles and susegad beach shacks.
- **West:**
  - Gujarat Navratri garba and dandiya, Rogan art, Kutch mirror and Lippan mud-mirror work.
  - Pushkar camel fair, Kathputli puppets.
  - Mumbai Ganesh Chaturthi (dabbawalas, kaali-peeli taxi and the Irani café are taken by /faq).
  - Pichwai (Nathdwara) cows and lotus.
- **North:**
  - Holi, Lohri bonfire (Varanasi ghats, diyas, chhatris and the boatman are taken by the policy pages).
  - Dilli chaat and Chandni Chowk, Lucknow Chikankari.
  - Himachal and Ladakh prayer flags, Thangka.
- **East and north-east:**
  - Kolkata Durga Puja pandal and Kalighat painting.
  - Odisha Saura art, Bastar Dhokra metal.
  - Assam Bihu and gamosa, Manipur Ras Leela, Nagaland Hornbill festival, Sohrai / Khovar mud art, Madhubani.
- **Daily life and eras:**
  - Gully cricket, kirana store, local train (the home page has a train, so avoid trains), barber shop.
  - Wedding baraat with band-baaja, mehndi night, Sunday Doordarshan with the TV antenna.
  - **70s India** (bell-bottoms, long collars, Vespa, Jawa / Yezdi, Ambassador taxi) — the radio-request show, transistor and scooter are taken by /contact; another 70s page needs a different slice (Ambassador taxi, Jawa, disco, Doordarshan).
  - 80s–90s cassettes and the STD era (the booth is taken).
  - Bollywood humour and memes (the poster style is taken on the home page; use dialogue memes instead).

---

## 9. Visual QA before every deploy (owner rule: "take a visual look yourself")

Load the page in the **external browser** (Chrome extension). Use iframes on a blank tab at **1440, 820, 390,
320** (and a 2560 window), and check:

- [ ] No text overlapping text or images; no title clipped; no sticker crowding.
- [ ] No art blending into its background. Add a white rounded frame (§6) where it does.
- [ ] Button labels sit inside the face, clear of the end decoration, and fit on one line. Check with
  `range.getClientRects().length`.
- [ ] **Borders are not squeezed or stretched**: motifs look like the source (round circles stay round, figures
  keep their width). Compare the rendered band against the PNG at the same height.
- [ ] **Buttons are not stretched**: end caps keep their drawn shape (round ends stay round, no oval or squashed
  decoration, no smeared middle); labels bold and centred inside the plain middle. Check desktop and phone widths.
- [ ] Medallion numbers are centred.
- [ ] No flat or cartoon-looking art (§2.13); nothing is one-tone; sections are visibly separate; there's space around things.
- [ ] No horizontal scroll (`scrollWidth === clientWidth`) at 320 / 390.
- [ ] Everything on phones is centred, header included.
- [ ] Lazy images forced to eager when checking (`img.loading = 'eager'`).
- [ ] **Borders show whole motifs** at their true shape (§6.1) and the band is 66–108px tall, not a thin strip.
- [ ] **Buttons look chunky** (§6.2): 56–80px tall, labels 14–24px on one line, ends not squashed.
- [ ] **Objects and hero picture are big** (§6.3), with no cards or tinted squares around objects.
- [ ] Accent text still readable on the real tile art (not only on the CSS stand-in).

**Previewing owner art locally:** `astro dev` cannot show art that goes through `publicImage()` (the
`/cdn-cgi/image/...` URLs only work on Cloudflare), so a dev-server check silently shows the CSS stand-ins. Run
`npx astro build`, then serve `web/dist` with `python3 scripts/hf_preview_dist.py web/dist web/public` (port 4393),
which maps `/cdn-cgi/image/<opts>/<path>` back to the file, and check `http://127.0.0.1:4393/<page>/` in iframes.

**Then:**

1. Run the local build + `node web/scripts/check-release-contracts.mjs`.
2. Commit with `python3 scripts/git_safe_commit.py "<msg>" <paths…>`.
   - **Always pass the paths. Never run it with `--help` or no paths:** that commits the whole tree, including
     temp files.
   - Keep `.tmp-sheet/` out of commits.
   - Revert `web/src/lib/publicImageManifest.json` if a local build touched it.
3. Push: `python3 scripts/git_safe_push.py <ISSUE-ID>`.
4. Deploy: `gh workflow run web-deploy.yml --ref main -f publish=true`.
   - Wait for build + browser-check (~8 min).
   - Approve the pending deployment (environment id 17866973083).
5. Verify the **live** page in the browser.
   - Several sessions deploy at once and a newer `web-deploy.yml` run **cancels** the older one. If yours is
     cancelled, check that the newest run's commit includes yours (`git merge-base --is-ancestor`), wait for it,
     approve it if it waits at the gate, then verify the live page actually shows your change.

---

## 10. Homepage tokens (site chrome and fallbacks)

The homepage (`web/design/desi-home.source.html` → `scripts/build-desi-home.py`) still defines the shared chrome
and base tokens. Each Indianized page adds its own multi-colour palette on top of them.

- **Colours:**

  | Name | Hex |
  |---|---|
  | ink | `#30245f` |
  | magenta | `#be246e` |
  | orange | `#ff793c` |
  | yellow | `#fbd447` |
  | cream | `#fff2cf` |
  | paper | `#fffdf7` |
  | pink | `#efabd0` |
  | lavender | `#bfc2ee` |
  | peach | `#ffa179` |
  | light yellow | `#ffdf89` |

  Never green.
- **Shapes:** 3px ink borders; hard offset shadows (`6–8px 6–8px 0 ink`, no blur); radius 14px for buttons and
  18–24px for cards.
- **Store buttons:** always the art `btn-google-play.webp` / `btn-app-store.webp`. App Store shows a non-link
  "Coming soon".
- **Footer:** column headers in Nunito 900 at 1.25rem; even columns; the disclaimer is centred site-wide.
- **Header nav:** Explore · How it works (`/how-it-works`) · Help (`/help`) · auth links.

---

## 11. Mobile app screens (owner, 2026-10-19; rule HF-DS-8)

The Hello Fraands Android app (`hf-flutter/`) follows the same philosophy as the website (★, §0, §2): a
different India per flow, multi-colour, bold, rounded, never boxy, little reading. This section covers what
changes on a phone.

**Where things live**
- **Tokens:** `hf-flutter/lib/core/theme/hf_tokens.dart` (`HfColors`, `HfText`, `HfRadius`, `HfSpacing`,
  `HfShadows`, `HfMotion`) and `hf_theme.dart`. Screens never hard-code a colour or size; add a token instead.
- **Screen list:** `hf-flutter/lib/core/router/app_router.dart`. Brand name and links come from `Brand`
  (`lib/core/brand.dart`) and are never typed out.

**How a screen gets made**
1. **One theme per flow, not per screen**, so a flow feels continuous. Example flows: onboarding, booking,
   the call, the wallet, the host dashboard. Pitch 3 ideas (§0), and record the chosen one in §8.
2. **Mock it in a phone frame first** (360×800, also checked at 320 wide and at the largest font size) and get
   the owner's approval before any Dart is written.
3. Art pack (§7) → build in Flutter → **ship it** → the owner checks it on his phone. There is no local preview
   (no toolchain on the Mac), so the visual check (§9) is done on the Closed Alpha build or on screenshots.

**Phone rules**
- **Type:** Nunito everywhere, with Comfortaa only for the wordmark. Nothing smaller than 14sp. Use the
  `HfText` scale (hero 30 · headline 27 · title 24 · section 20 · subsection 17). No text may be cut off at 200%
  system font size.
- **Touch:** every tap target is at least 48dp. The primary button is 56dp tall, full width up to 360dp, with a
  one-line 16–18sp label. The main action sits at the bottom, within thumb reach.
- **Layout:** 16dp side gutters inside the safe areas (notch, gesture bar). Hero and header blocks are
  centred (§2.11), with one focal point per screen. The bottom tab bar stays plain and readable; art goes in
  headers, heroes and empty states, never behind lists or forms.
- **Art:** the same standards as the web (§6.1–6.3). Borders keep every motif whole, scaled to height, in
  48–72dp bands. Heroes run full width. Object art is big, with no tinted square. Images are WebP at 2× and 3×,
  ≤200 KB each.
- **States:** design loading, empty, error and offline for every screen. Empty states are where the character
  and the theme art carry the screen.
- **Motion:** animations move like the craft (a scroll unrolling, a kite rising, a coin dropping into a slot),
  UI transitions last ≤400ms, and reduced motion is respected (`core/motion/reduced_motion.dart`).
- **Always:** no green (`test/core/tokens_test.dart` enforces it), no peacocks, Phosphor icons only, and the
  Android back gesture always works.

**Open (owner to decide before the first redesign):** the app's palette is still neutral (page `#F6F3EE`, ink
`#000000`, orange primary `#F28C28`), while the website uses the §10 palette (ink `#30245f`, magenta, cream…).
Either the app moves to the §10 palette, or the neutral base stays and each flow's theme adds its colours on top.

---

## 12. Mistakes not to repeat (owner feedback log)

| Date | What went wrong | What the owner wants instead |
|---|---|---|
| 2026-10-18 | /faq borders 28–44px tall, motifs cut inside 1600×80 files | v2 borders: 1600×160, whole motifs, `auto 100%`, bands 66–108px (§6.1, §7.4) |
| 2026-10-18 | Made borders taller but kept the cropped art ("still chopping off") | Fix the art, not the CSS: ask for whole-motif files |
| 2026-10-18 | Dabbas small inside cards with tinted squares | Objects big, no card, no square (§6.3) |
| 2026-10-18 | Buttons thin and squeezed; labels small | Taller keys, bigger labels, caps at drawn shape, squash corrected (§6.2) |
| 2026-10-18 | Hero café picture small beside the text | Hero picture in the wider column, up to 1040px; full width on phones (§6.3) |
| 2026-10-18 | Pale pink tile on maroon bands; cream accent text vanished on light tile art | Match tiles to band colours; re-check contrast with the real art (§6) |
| 2026-10-19 | /help: pothi lotus ends, bahi-khata frame and Indian buttons squeezed; thin 40:1 mandana strip above the footer | Caps at drawn shape with fixed height, card + leaf header on phones, symmetric frame with `round` sides, buttons sliced to face rows (§6.2), rangoli border at v2 height |
| 2026-10-18 | Checked the page on `astro dev`, which never shows `publicImage()` art | Build + `scripts/hf_preview_dist.py` before judging art (§9) |
