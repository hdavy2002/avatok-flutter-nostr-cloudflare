# Global landing visual repair

The initial deployed global page did not implement the approved mockups: its hero had no creator imagery, the three formats were text-only, the eight cards had no people, and catalog/article chrome was duplicated.

## Design source

Approved hero: exec-96c842bd-72ef-4d5a-a063-13203096c6b0.png
Approved middle/footer: exec-bd787c56-9a5a-4407-ac90-904d1c23ea4b.png
Approved eight ideas: exec-3f106d3b-54de-4184-a09a-2bfb91bd6ad6.png

All references and generated originals are under `/Users/davy/.codex/generated_images/01a0a394-a873-78a3-a189-2e56a99062cf/`. Website copies are in `web/public/assets/global/`.

## Asset brief / prompt set

Generated using the built-in image-generation tool, using the approved screenshots as style and subject references. No external API-key billing workflow was used.

- Hero: recreate only the four-person collage: braided Black fashion creator in patterned bellbottoms; Latina dancer in orange-pink flares; East Asian beauty creator in blue fur; South Asian guitarist in green corduroy. Yellow irregular paper, cream outer edge, ink doodles, no text or UI.
- Live: tiger-jacket creator in orange sunglasses waving beside a ring light; yellow paper; no words or fake live counters.
- Call: tilted smartphone showing curly-haired adult creator on video call, picture-in-picture, blue paper; no text.
- Paid: green paper, smiling creator with white glasses, phone showing checkmark and bank pictogram; no amounts or unsupported payment brands.
- Eight ideas: each corresponding approved card's creator, pose and fashion, square photo collage, person mostly on right, left colored paper for real HTML text, doodle rays/hearts; remove all captions/platform logos/UI. Colors in order: coral, yellow, turquoise, blue, lime, pink, orange, lavender.
- Payout map: landscape patchwork-fabric world map with dashed connections, hearts and bank stickers, cream paper; no currency amounts, country availability claims or labels.
- Social preview: cream/yellow collage, black/red avaTOK logo and retro-serif text: “Your people.” / “Your income.” / “Paid live streams & private 1:1 video sessions” / “Made for creators everywhere.” No fake stats, exchange rates or fee promises.

## Asset provenance

| Website asset | Generated original |
|---|---|
+| hero-creators.png | exec-ead81d6c-ae32-4507-b5f4-2f58ff8542d8.png |
| format-live.png | exec-10e0bdd5-c78a-4d2c-9cb0-d06143335f6b.png |
| format-call.png | exec-9afaac85-b069-4fb5-8cb7-13cf75c249ea.png |
| format-paid.png | exec-526439e5-ff2d-471c-b80e-f65505b613cf.png |
| payout-world.png | exec-55bd440d-bb54-4e24-ac75-5822609378f4.png |
| creator-marketplace-og.png | exec-a5327aef-b12f-40f1-a55f-c04e366f9793.png |
| idea-creator-watch-party.png | exec-aa188691-53e4-449c-a698-12077ec6ba9d.png |
| idea-trend-breakdown-live.png | exec-263a3176-a8c4-426f-b076-8ae88e9200b2.png |
| idea-close-friends-studio.png | exec-1fa42edc-b7e7-46da-940c-baf0b64d6434.png |
| idea-channel-coaching.png | exec-b6cd21d4-fe34-419d-a31a-b711cdd251be.png |
| idea-learn-the-move.png | exec-56362ec8-3513-42bf-929c-785ca10e0c57.png |
| idea-ask-me-anything-1-1.png | exec-0668e8b2-474b-45b6-b0d3-1f9951629334.png |
| idea-launch-night-live.png | exec-b8cdca17-0a8f-453e-b30f-36cedd4a3135.png |
| idea-taste-of-your-world.png | exec-35cbf4b9-4c90-492a-8212-8d680a1a3dc2.png |

## Delivery

Real HTML text and links sit over or beside image assets. CI generates 480px and 960px WebP delivery variants; original PNGs remain intact. Below-fold images are lazy-loaded. India uses its existing imagery and component variant.
