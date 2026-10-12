# Host/fan homepage asset provenance

Issue: HF-HOME-HOST-FAN-1. Generated with the built-in `image_gen` tool, not a paid CLI/API fallback. Each photo was generated separately using the approved homepage mock as a visual reference. All generated images were inspected before use. No source photo contains UI, copy, names, domains, prices, buttons or logos; those are accessible HTML/SVG. The SVG paper texture is code-native.

Reference: `hello-fraands-host-fan-homepage-mock-v2.png` (approved 2026-10-12).

Common photo prompt: “Use case: photorealistic-natural. Asset type: single photographic website asset. Use supplied website mock as visual reference for the people and warm editorial photographic impression. Reconstruct [subject below]. No UI, no text, no letters, no names, no logos, no watermarks, no cards, no buttons. Single finished high quality photo, fill frame.”

| Asset | Subject prompt |
| --- | --- |
| hero.webp / hero.jpg | Reconstruct JUST the smiling adult Indian woman in the top hero wearing a vibrant embroidered coral and cream kurta and silver jhumka earrings, looking at a black phone held in her right hand. Long dark wavy hair, warm natural light. Frame head to waist, composition centered, teal and warm ochre textured paper background, tactile subtle torn paper collage edge. Keep the same warm human editorial photographic impression. No interface, no other people, no text, no letters, no logos, no watermarks, no cards, no buttons. Portrait 4:5; suitable for HTML overlays. |
| neha.webp | Just the first creator card photo: young adult Indian woman with long dark wavy hair, rose-pink top, chin resting on hand and smiling at camera, softly blurred warm room with plants. Head and shoulders. Landscape 4:3. |
| arjun.webp | Just the second creator card photo: smiling young adult Indian man with curly dark hair, glasses, short beard and black hoodie in gaming chair, softly blurred purple blue gaming room. Head and shoulders. Landscape 4:3. |
| meera.webp | Just the third creator card photo: young adult Indian woman with dark ponytail, black sleeveless athletic top, head resting lightly on hand, warm friendly smile, softly blurred light gym with plants. Head and shoulders. Landscape 4:3. |
| rohit.webp | Just the fourth creator card photo and male host: young adult Indian man with dark curly wavy hair, short beard, printed indigo and coral shirt, friendly thoughtful smile and head tilted slightly, softly blurred studio room and film posters. Head and shoulders. Landscape 4:3. |
| women.webp | Just the women community photo: two smiling adult Indian women chatting on their own phones, one in a rose kurta with long straight dark hair on the left, one with shoulder-length curls and cream printed top on the right. Warm coral and cream paper collage background. Half length side by side. Landscape 4:3. No paper notes. |
| community.webp | Just the LGBTQ community photo: two smiling young adult Indian people talking on their own phones, person on left curly hair and glasses wearing rainbow checked shirt, person on right with short dark hair wearing denim shirt. Warm lavender paper collage background with a small rainbow flag behind. Half length side by side. Landscape 4:3. No paper notes. |
| host.webp | Recreate JUST the smiling man in the hero video call inset, wearing a dark olive overshirt over white T-shirt, wavy dark hair, light beard, looking at camera with hand raised in friendly wave. Young adult Indian man. Waist-up camera view in soft warm studio, bookcase blurred. Portrait 4:5. Realistic editorial photograph. No interface, no buttons, no text, no logos, no watermark. No paper border. The actual phone controls will be added with HTML. |

Delivery: hero 1000×1250 WebP plus JPEG social fallback; creator and community photographs 800×600 WebP; host 600×750 WebP. Encoded with Sharp (quality 86 WebP, 88 JPEG). Full-resolution generated originals remain in the tool’s generated-images directory. No original reference screenshot is shipped.

## Reference fidelity update — HF-HOME-REFERENCE-2

Built-in image generation, using the supplied complete landing-page image as the visual reference; no paid CLI/API fallback. Existing eight separately generated photos remain in use.

- `host-pointing.webp`: Separate transparent collage of the bottom-left host, smiling adult Indian man with wavy dark hair and light beard, olive overshirt and white T-shirt, pointing both hands right; yellow/teal/coral torn paper and botanical leaves. No text, notes, UI or logo. Generated transparent PNG, trimmed and resized to 900px wide WebP, quality 86.
- `hero-paper.webp`: Separate transparent hero backplate only: face-on layered teal, marigold, coral and cream handmade paper, fibrous irregular torn edges, tiny pink scraps and green botanical cutouts at lower corners. No people, UI, objects, notes or text. Generated transparent PNG, trimmed and resized to 1200px wide WebP, quality 82.

The header, cards, labels, booking illustration, privacy diagram and section text remain native accessible HTML/SVG. The original reference screenshot is not shipped. Artwork recreates the reference composition; generated faces and paper fibers are not pixel-identical source assets.

Reference refinement cutouts (built-in image generation, background extraction): `hero-cutout.webp`, `women-cutout.webp`, `community-cutout.webp`. Each source photograph above was supplied as an edit target. Prompt: preserve exact subjects, clothes, poses, hands and phones; remove the rectangular backdrop to genuine transparency with delicate hair edges. Hero retains only the woman. Women/community retain the two people and a small irregular silhouette of paper scraps/leaves; community retains the rainbow flag. No UI, letters, labels, logos, frames or rectangular matte. Outputs inspected, encoded quality 82 WebP at 1000×1250 (hero) and 800×600 (community pairs). Originals are preserved.

Handwritten notes use self-hosted Kalam Regular from the official Google Fonts repository (`ofl/kalam/Kalam-Regular.ttf`), with its SIL Open Font License in `web/public/fonts/Kalam-OFL.txt`. This removes platform-dependent serif fallbacks.

## HF-REFERENCE-DETAIL-1 · 2026-10-12
Built-in image_gen, original 745px screenshot as sole design reference; no API-key fallback.
- fan-call.webp: faithful square portrait of reference fan, cream kurta, phone held to ear, peach room.
- host-call.webp: faithful square portrait of reference curly-haired navy-shirt host, phone to ear, lavender backdrop.
- women-reference.webp: higher pink-kurta caller and lower curly-haired caller, yellow/teal/mesh scraps.
- community-reference.webp: rainbow-paper caller pair; right caller corrected to dark vertical-striped shirt.
- host-reference.webp: wide edge-bleeding paper/leaf/mesh collage, olive-shirt host pointing across and up.
- cta-foliage.webp: independent far-right coral/yellow/teal paper, leaves and mesh cluster.
Full collage prompt set: reference-detail-prompts.json. Originals: /tmp/hf-detail-art/ (also retained by built-in tool under Codex generated_images).
Portrait originals: exec-d4d50347-5aec-4067-9e87-716a48088226.png and exec-a9d33e87-3d95-4fbd-81a9-7f78bec28ed3.png in /Users/davy/.codex/generated_images/01a130e0-58ce-70b2-9286-d5e371988a00/.
Portrait prompt invariants: recreate only corresponding tiny top circle from original, same appearance, phone-to-ear gesture, tight head/shoulders square, no circle mask, labels or other people.
Images optimized with Sharp resize/WebP; alpha preserved for collage assets.
Lilita One and Patrick Hand downloaded from official google/fonts repository; each SIL OFL license bundled in /fonts/.
Torn fiber mask and pen rays are editable native SVG, not flattened screenshot content.
