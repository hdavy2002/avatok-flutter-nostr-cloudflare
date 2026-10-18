# Hello Fraands design system — "Indianize it" (owner rules, updated 2026-10-18)

**Read this before any Hello Fraands page, screen, component, artwork prompt or app animation.** It is the
single source for how the owner wants the product to look and how we build it. It replaces the 2026-10-17
"desi homepage" version. Rule ids live in `Specs/RULEBOOK-HELLO-FRAANDS.md` (HF-DS-1, HF-DS-2). The same
philosophy applies to the **website, the Android/iOS app screens, onboarding screens and app animations**.

When a page ships, **update §8 (Theme registry) in the same commit**. A future session reads that table to
avoid repeating a theme, craft, motif or layout.

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
3. **Multi-colour, never one-tone.** He loves the richness of a Rajasthani painting: many bold colours side by
   side. A page whose images all share one hue (all blue, all brown) is wrong. Vary the band colours section by
   section. Green is allowed only inside artwork (leaves), **never as a UI colour**.
4. **Bold and loud.** Go big:
   - Large graphics that blend into the type.
   - Vertical type where it fits (a vertical word down a band or beside art).
   - Oversized headlines.
   - Hinglish voice.
   - Fun meme stickers where the theme allows.
   - Never a generic SaaS look.
5. **No sharp edges anywhere.** Rounded corners on cards, images, frames, chips, listing cards, inputs and
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
13. **Mock first for big redesigns.** For "Indianize it", the 3-idea pitch is the approval step. Never change an
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
- **Buttons from art** use `border-image` 9-slice:
  - **Measure** the PNG first: the opaque *face rows* (top/bottom transparent margins) and how far the end
    decoration reaches.
  - Slice to them, e.g. `0 220 fill / 0 70px` for a 900×180 key whose ends reach about 200px, or
    `19 220 18 220 fill` when the face sits between rows 19 and 161.
  - Phones: `border-image-width: 0 56px`, min-height 48px.
  - Label centring: flex center + text-align center, Nunito 900.
  - Add any drawn "key depth" back as `filter: drop-shadow(...)`, not as part of the slice. Otherwise the text
    sits off-centre.
- **Section borders:**
  - Drawn 20:1 (1600×80). Show at `background-size: (height × 20) 100%` with `repeat-x`, e.g.
    `clamp(560px, 52vw, 880px) 100%` for a `clamp(28px, 2.6vw, 44px)` band.
  - **Never `auto 100%` on a squashed source, and never stretch.**
  - If the owner's PNG was resized unevenly (motifs look squashed or stretched), compress it back via
    background-size and tell him.
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

## 7. Image prompt packs

### 7.1 Pack structure

1. Design idea: the story, a table of steps or sections against art forms, the crafts used.
2. **Characters block:** fixed looks (age, skin, hair, clothes colours, phone-case colour), so every image matches.
3. **Style block** to paste before every prompt: the art form, a **multi-colour** palette, outlines, no 3D.
4. **Negative prompt:**
   - Photo, 3D, gradient, watermark, brand or app-store or payment logos, misspellings, extra fingers.
   - Green background, neon, gloomy mood, **peacocks**.
   - **Every theme already used** (from §8).
5. **Text rule:** no words or numbers in pictures (the page adds them), except sticker lettering, which must be
   spelled exactly.
6. A table per folder: file name, size, transparency, prompt.
7. A checklist at the end.

### 7.2 Size and format rules

| Asset | Size | Rules |
|---|---|---|
| Hero | ~1100×1100–1300, transparent | Subject in the centre 70% (phones crop) |
| Step / story panels | 1000×750, edge to edge | No border; the page adds the frame |
| Square strip tiles | 600×600 | — |
| Closing art | 900×720 | — |
| Medallions | 300×300, transparent | **Plain flat-colour centre (~50%) with nothing in it** |
| Badges / icons | 400×400, transparent | — |
| Borders | 1600×80, seamless horizontal repeat | **Generate wide, then crop or scale evenly; never squash.** Circles must stay round and figures keep their natural width |
| Background tiles | 600×600 | Seamless both ways, **low contrast** (text sits on top) |
| Buttons | 900×180 | Fill the full height (no empty space above or below); decoration only in the **left and right 200px**; plain flat-colour middle; no text |
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
  - there are no peacocks;
  - no theme is repeated.
- **Restart the astro dev server** after the art lands. The `existsSync` results are cached, so new files don't
  show until you do.

---

## 8. Theme registry (do not reuse; add every new page here)

| Page | Theme / concept | Crafts, motifs, characters used | Layout shape | Assets |
|---|---|---|---|---|
| `/` home | **Desi street / truck art** | Truck art, marigold toran, Warli friends strip, block print, Madhubani fish pair, rangoli mandala, Bollywood poster, chai tapri, rickshaw woman, jhoola women, creator train, dhol-wala, elephant with padlock; Hinglish stickers (Arre waah, Kya scene hai, Ek call toh banta hai, Reels se real tak, Chai pe charcha, Bas karo scroll); "HORN OK PLEASE" marquee | Full-width colour bands | `hf-desi/` |
| `/marketplace` explore | **Bazaar Pop** | Bunting, rosettes, pastel tile frames, marquee dots, category icons | Video-first creator grid | `hf-explore/` |
| `/help` + articles | **Gaon ka Ghar**: a happy village home at Sankranti | Painted mud-wall house, tiled khaprail roof, mandana dots, rangoli doorstep, **kites** for topics, palm-leaf pothi for top questions, stitched cloth bahi-khata for articles, aangan, women in kurta and jeans flying kites, meme stickers (havelis rejected as "haunted") | House → sky → courtyard | `hf-help/` |
| `/sign-in`, `/sign-up` | **STD-PCO booth** (no header or footer) | Red STD·ISD·PCO booth, yellow signboard, rotary phone, coin slot, keypad-key buttons, painted-signboard input frames, coin strip, cement floor tiles | Booth picture + booth form | `hf-auth/` |
| `/how-it-works` | **Teen Kadam, Teen Kala**: three steps, three paintings | Step 1 **Warli**, step 2 **Rajasthani Phad**, step 3 **Kashmiri papier-mâché**; borders **Ajrakh, Warli, Phad, Sozni, Phulkari**; grounds **Sanganeri, Warli mud, Leheriya, Kashmiri lacquer, Dabu indigo**; mirror-work and Sozni buttons; Riya (fan) and Ajay (influencer) | Cover medallion → 3 painted steps → 3-tile call strip → bill → CTA | `hf-how/` |
| `/hosts/join` | **Pat-Katha**: a Bengal Patachitra story scroll (the owner calls it the "lac" page) | **Patachitra** panels, a patua (scroll singer), **Channapatna lacquer** rollers and buttons, **Kantha** borders, **Gond** medallions and dot ground, **Bandhani** hero, **Bidri** earnings ledger, **Ikat** privacy section, **Kalamkari** close; Neha (cooking creator, Indore), Sana (fan) | Unrolling vertical scroll of 4 panels → Bidri ledger with coins + calculator → 3 promises → close | `hf-join/` |
| `/faq` | Notebook palette (no art theme yet; can be Indianized) | Yellow "Yes, we have FAQs!" badge | Search + accordions | — |
| Legal / policy pages | Shared content layout (not yet Indianized) | — | Two-column cards | — |

**Styles also used** (don't reuse as a page theme): comic-book halftone (rejected), postal / stamp look (rejected
as "postal"), haveli (rejected), tombstone-like arched windows (rejected), scrapbook (old home).

### 8.1 Theme ideas not used yet (pick from here or invent new)

- **South:**
  - Kerala snake-boat race (Vallam Kali), Kathakali faces, Kerala murals, Onam pookalam.
  - Tamil kolam at dawn, Madras filter-coffee tumbler, Chettinad tiles and Athangudi floors, Pongal pots.
  - Mysuru Dasara with Ganjifa cards, Mysore and Tanjore gold paintings.
  - Kondapalli and Etikoppaka toys, Cheriyal scrolls.
  - Hyderabad Laad Bazaar lac bangles.
  - Goa azulejo tiles and susegad beach shacks.
- **West:**
  - Gujarat Navratri garba and dandiya, Rogan art, Kutch mirror and Lippan mud-mirror work.
  - Pushkar camel fair, Kathputli puppets.
  - Mumbai dabbawalas, kaali-peeli taxi, Irani café, Ganesh Chaturthi.
  - Pichwai (Nathdwara) cows and lotus.
- **North:**
  - Varanasi ghats and Dev Deepawali diyas, Holi, Lohri bonfire.
  - Dilli chaat and Chandni Chowk, Lucknow Chikankari.
  - Himachal and Ladakh prayer flags, Thangka.
- **East and north-east:**
  - Kolkata Durga Puja pandal and Kalighat painting.
  - Odisha Saura art, Bastar Dhokra metal.
  - Assam Bihu and gamosa, Manipur Ras Leela, Nagaland Hornbill festival, Sohrai / Khovar mud art, Madhubani.
- **Daily life and eras:**
  - Gully cricket, kirana store, local train (the home page has a train, so avoid trains), barber shop.
  - Wedding baraat with band-baaja, mehndi night, Sunday Doordarshan with the TV antenna.
  - **70s India** (bell-bottoms, long collars, Vespa, Jawa / Yezdi, Ambassador taxi).
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
- [ ] Borders aren't squashed or stretched; medallion numbers are centred.
- [ ] Nothing is one-tone; sections are visibly separate; there's space around things.
- [ ] No horizontal scroll (`scrollWidth === clientWidth`) at 320 / 390.
- [ ] Everything on phones is centred, header included.
- [ ] Lazy images forced to eager when checking (`img.loading = 'eager'`).

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

## 11. The mobile app

The same rules apply to app screens, onboarding and animations:

- A unique Indian theme per flow, and multi-colour.
- Rounded everything, bold Nunito, centred layouts.
- A worked example with a character.
- Art generated from prompt packs.
- Animations that move like the craft (a scroll unrolling, a kite rising, a coin dropping into a slot).

Record app themes in §8 too.
