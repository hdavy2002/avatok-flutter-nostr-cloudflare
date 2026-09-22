# Saathum Folk — Rajasthani design system v1
Owner-approved direction, 22 September 2026. This is the reusable visual source of truth for future Saathum pages. New pages may use different graphics while preserving this palette, art direction, navigation, typography, and sticker treatment.

## Palette
| Token | Value | Use |
| --- | --- | --- |
| --folk-paper | #fff6e6 | Warm ivory page and paper panels |
| --folk-ink | #51251f | Deep brown text and outlines |
| --folk-red | #ad3028 | Sindoor/vermilion CTAs, accents, small headings |
| --folk-saffron | #ef9e25 | Kesar and marigold details |
| --folk-pink | #e79b9a | Gulabi pink accents |
| --folk-gold | #bc8238 | Antique-gold borders and ornaments |
| --folk-white | #ffffff | Sticker edges, high-contrast button text |
| --folk-muted | #79554a | Secondary body text |
| --folk-line | #d7b58b | Delicate rules |
Supporting warm fills: #f7e8d1, #f2d6ae, #f3d4c7, #f9e4b8, #f1d1bb.
No green. No blue, teal, or indigo backgrounds, card fills, section fills, buttons, or large decorative fields. Blue/teal is permitted only as small details on clothing or ornaments; default new art to all-warm colors.
No peacocks or peacock feathers, including metadata/social artwork.

## Art direction
Indian Hindu religious folk art, with Rajasthani Pichwai/Phad inspiration. Rich painted detail, elegant silhouettes, ornamental floral patterns, ivory elephants, decorated sacred cows, deer, temple arches, lotus, diyas, marigolds, bells and cutting chai. Respectful devotional mood, welcoming and joyful.
Every raster illustration is a separate original transparent asset with a thick white silhouette border. No rectangular screenshot crops masquerading as stickers. Avoid baked-in UI, text, prices, and menus. All product copy stays real HTML.
The existing hero/ritual/chai art is a style reference, not mandatory content on every page. New pages should commission subject-specific art using the same warm palette and white contour.
Small utility/category icons use FolkIcon.astro: warm solid fills, brown outlines, white circular sticker rims. Add new icons to this component when necessary.
Asset prompts and generation provenance are recorded in SAATHUM-FOLK-ART-PROMPTS.md. Built-in imagegen was used; no billed API fallback.

## Typography and layout
Display: DM Serif Display (400, normal and italic); body/navigation: Nunito (normal, 700/800 emphasis), system fallbacks.
Headlines are deep brown with short vermilion italic accents. Eyebrows use small, spaced uppercase Nunito. Handwritten-feeling annotations use display italic sparingly.
Readable HTML, generous paper space, maximum content width 1240px. Mobile text reflows; never scale a screenshot to fit.
Use 36px total mobile gutters, 56px tablet, 88px desktop; two/three/six category columns as space permits. Listings use one column on phones and three on desktop.
Use only restrained ornament: repeated flower/diamond ribbon, thin double rules, small seals. White sticker edges must remain visibly distinct from ivory.
Cards use 6–8px white borders, warm paper interiors, rounded or arched corners, soft brown shadows and subtle alternating rotations (~1–2°). Keep text level enough to read. No rotation on text-only forms.
Buttons use vermilion, white text, 3px white border, modest rounded corners, and a small warm shadow. Links remain clearly interactive. Focus rings must be visible. Respect reduced-motion preferences.

## Header and footer contract
Use SiteHeader and SiteFooter with folk={true} and indiaLandingLanguage={false}. The normal/global variants are intentionally unchanged.
HOME_HEADER_LINKS in web/src/lib/homeNavigation.ts is the single menu source: Marketplace, Wiki, Pricing, Ideas, Experiences, For organisers.
Preserve authenticated Dashboard/Sign out versus logged-out Log in/Sign up. Mobile uses one modal drawer with Escape/close/focus restoration, not a second independent implementation.
Footer uses HOME_FOOTER_COLUMNS: Bazaar, Creators, Company, plus all 17 legal/safety links in SiteFooter.astro. Keep the entire menu visible and responsive; never hide it behind an About booking disclosure.
Keep historical destinations: marketplace/live/private browsing, Start selling, Creator dashboard, Payouts, Safety, About, Help, Careers, Contact, Terms and Privacy; retain current organiser/guides/joining/company-status destinations.
Historical Live streaming and 1:1 consultations now use supported marketplace group query routes, not missing homepage anchors.
Mandatory footer line: **Made in India with love ❤️ and cutting chai**.
Other pages may vary illustrations and main content, but should reuse this exact navigation structure unless the owner asks otherwise.

## Reusing the shell
Import Base, SiteHeader, SiteFooter and web/src/styles/saathum-folk.css.
Render Base with chrome={false}, a .folk-site wrapper, SiteHeader folk, main content, then SiteFooter folk. Never enable Base chrome at the same time as explicit chrome.
Set a unique data-design value for a materially new page design. Use .folk-wrap, .folk-button, .folk-text-link, .folk-eyebrow and .folk-section-heading.
FolkArtwork renders hero/rituals/chai through publicImage/publicImageSrcSet. Extend its asset-name type for new graphics, record actual dimensions, preserve alpha, eagerly load only the hero and lazy-load below the fold.
New assets belong in web/public/assets/saathum-folk/. Their immutable production copies are generated by the existing public-image build pipeline. Never embed local generation paths into the page.
Keep the hero’s white borders baked into the transparent illustration; CSS shadows add depth only. Do not flatten transparency to a dark background.

## Functional and release rules
Reuse existing routes, auth and telemetry. Keep sample events explicitly labelled and linked to real marketplace searches; never invent available tickets, live counts or ratings.
Retain homepage section/CTA markers consumed by railwayHome.ts. Shared navigation already emits nav_click; do not attach duplicate handlers.
CI checks: web/scripts/check-homepage.mjs and check-homepage-browser.mjs verify menu destinations, labelled samples, real sticker assets, no retired artwork, warm fields, responsive overflow, image loading, and mobile drawer behavior.
All builds/checks run in the explicitly requested GitHub Actions web workflow. No local builds/tests. Production web publishes through web-deploy.yml on main with publish=true and the production approval gate.
Future graphics should be visually inspected on the ivory page at mobile and desktop sizes before approving the release gate.
