# Saathum approved reference layout

The owner approved the compact desktop mockup on 2026-09-22 and explicitly
required reuse of the existing sticker graphics and scene images. The homepage
identity is `saathum-reference-v5`. Implementation uses Astra only.

## Composition

Use a broad cream canvas, teal ink, vermilion calls to action, and the existing
Indian floral border. The desktop hero has copy on the left and the saved grand
arch artwork filling the right. Headline: “Close to your roots. Wherever you are.”
Comfortaa remains the display face and Nunito the body/navigation face.

Six rectangular category tiles share one desktop row, with three on tablets and
two on phones. Three landscape listing photos have straight white edges, visible
sample-event labels, short titles, categories and marketplace links. These are
illustrative samples, never invented bookable inventory.

One compact full-width sage strip combines the saved female guru satsang sticker,
the belonging headline, and Explore / Book / Join live steps. Follow with a slim
cream organiser strip flanked by the existing elephant stickers. Do not restore
the separate large welcome, craft or three-step sections from the previous layout.
Keep their original artwork files saved.

## Assets

Reuse `/assets/saathum-grand/hero.png` unchanged (1214x1295 RGBA). Reuse all six
`/assets/saathum-booking/category-*.png` and three `listing-*.png` files unchanged.
Keep `/assets/saathum-bright/satsang.png`, `lotus.png`, `border.png`, and the booking
`elephant.png` artwork. Retain all other saved graphics on disk. Use the public
image pipeline, responsive srcsets, appropriate sizes, and eager hero loading.
Sticker outlines and drop shadows remain; listing images stay photographic scenes.

## Navigation and footer

The homepage header uses Explore events, Experiences and How it works. Guest links
are Sign in and Become an organiser. Authenticated dashboard/sign-out and accessible
mobile drawer behavior remain intact; other routes retain their existing header.

The footer is cream with centered open menus: every Bazaar, Creators and Company
entry plus all existing legal/safety links. No enclosing footer cards. The final
line remains exactly “Made in India with Love ❤️ and cutting chai.”

## Verification

GitHub Actions only: static link/art/SEO checks, existing safety/performance checks,
and browser screenshots at 320, 390, 820, 1100, 1122, 1440, 1920 and 2560px.
Check no horizontal overflow, decoded images, square category scenes, landscape
listing photos, six-across desktop layout, compact sage band, readable cream footer,
mobile drawer/auth behavior and preserved asset sources before production release.

## Organisers companion page

The owner requested the same graphics, visual style and ethos for `/organisers`.
The page opts into the shared reference shell and adds the scoped
`saathum-organisers-v1` style. Saved female-guru artwork leads the hero, music
art accompanies the thirteen topics, existing guide/story art remains, and saved
elephants frame the closing invitation. Open numbered columns and sage bands
replace the old poster panels.

All existing hosting instructions, seven FAQs, four guides, permission guidance,
fee language, illustrative scenario and payout-status disclosure remain intact.
The earnings planner component and its calculation module are unchanged. CI
checks its input updates, invalid-ticket error and recovery, auth-aware organiser
CTAs, FAQ opening, image loading and layout from 320 to 2560 pixels.
