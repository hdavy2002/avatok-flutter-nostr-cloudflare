# India additions — local visual preview

Preview: http://127.0.0.1:4321/india-next

`src/pages/india-next.astro` is a copy of the original `india.astro`, with these additions inserted before its existing booking express section. The source `india.astro` remains unchanged. Preserve its existing hero, ideas, formats, onboarding, header, and footer.

The preview currently shows PaidFormats, CreatorIdeas, CreatorJourney, and EarningsCalculator. The six other additions were removed from the page at the owner’s request; their component files are retained for possible future reuse.

Each section has its own component so it can be redesigned or reordered independently:

| Component | Section |
| --- | --- |
| CreatorIntro.astro | Fanbase announcement |
| PaidFormats.astro | Paid livestream and 1:1 offer cards |
| LiveShowcase.astro | Livestream feature |
| OneToOne.astro | Online meetup and availability |
| CreatorIdeas.astro | Creator offer examples |
| CreatorJourney.astro | Four steps |
| FanBooking.astro | Booking pass example |
| EarningsCalculator.astro | Interactive illustrative gross estimate |
| CreatorFaq.astro | Questions and boundaries |
| CreatorClosing.astro | Creator invitation |

Owner refinement: use the same Comfortaa/Baloo 2 headings and Instrument Sans body as /india; use site radius tokens (20–28px) and pill buttons. Graphics reuse /help/art stickers and TruckBorder motifs.

New styling is scoped under `.india-additions` in `src/styles/india-additions.css`. Existing `/india` styles are imported unchanged. The earlier translation dictionaries and calculator script are reused. Original copied content stays as authored; additions and opt-in chrome retain the draft language switching. Full localization review and service wiring remain separate from this visual preview.

No publishing, deployment, backend changes, or production writes are part of this prototype.

BookingExpress.astro now combines the three earning formats, four-step Hinglish journey, railway ticket artwork, and listing CTA at the former format-row position. It replaces CreatorJourney and the original standalone booking ticket in the preview.
