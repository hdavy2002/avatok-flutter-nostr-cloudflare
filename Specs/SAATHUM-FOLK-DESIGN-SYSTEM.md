# Saathum grand folk design system

The Saathum homepage uses the saathum-grand-v4 identity for the Hindu religious
experiences marketplace. It is an open editorial composition with a warm cream
canvas, teal ink, red headings, gold details and full width colour fields. Sections
do not use small rounded panels or sticker badges.

## Type

Comfortaa is the display face for the wordmark and headings. Nunito carries body
copy, navigation and calls to action. Desktop body copy is 20px or larger, hero
headings are about 64px, and section headings are 48px or larger. Tablet and phone
sizes scale with clamp() while keeping readable line lengths.

## Artwork

The hero uses /assets/saathum-grand/hero.png, an RGBA 1214x1295 transparent
composition: a sunset Ganga aarti inside a tall scalloped arch with a painted
peacock, elephant and diya foreground. It is loaded through publicImage and
publicImageSrcSet and grows to marketplace scale on wide screens.

Six opaque square category scenes are rendered through BookingArtwork from
/assets/saathum-booking/category-{name}.png. Three opaque 3:2 listing photos use
/assets/saathum-booking/listing-{name}.png. Category scenes are open editorial
tiles with no enclosing pastel card. Listings use a straight white image edge and
copy below. The female guru (satsang) and culture folk art are allowed to grow
large. The organiser band uses the transparent elephant artwork on both sides,
mirrored with CSS on the right.

## Layout

The hero gives copy a generous left column and the arch artwork a wide right
column. Categories are three columns on desktop, two on tablet and one on phones
with square art remaining at least 150px. Listing photography is wide and
unboxed. Belonging is a full-width pale sage field, followed by a separate
three-step row. Culture alternates art and copy. Organiser content is a full-width
coral field with large flanking elephants.

Responsive checks cover 2560, 1920, 1440, 1100, 820, 390 and 320px viewports.
The browser check eagerly decodes and scrolls every art group before screenshots,
then verifies no horizontal overflow, broken images, cramped category art or
hidden footer links.

## Navigation and footer

SiteHeader and SiteFooter remain shared components. Home CTAs retain
data-home-cta telemetry, authentication links, mobile drawer behaviour and
accessible section IDs. The footer keeps every existing home-navigation and legal
destination in centered wrapping rows. It ends with the exact phrase:
Made in India with Love ❤️ and cutting chai.
