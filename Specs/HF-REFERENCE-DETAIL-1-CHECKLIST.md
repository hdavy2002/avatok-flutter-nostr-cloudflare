# HF-REFERENCE-DETAIL-1 visual correction checklist
Owner authorized all crop-audit corrections and live deployment, 2026-10-12.
Target: original 745px crop supplied in conversation; compare normalized widths.
Footer component and shared footer CSS must remain unchanged.
## Implemented and visually reviewed
- Headings: replace swollen Fredoka letterforms with narrower Lilita One; footer unchanged.
- Handwriting: self-host Patrick Hand, lighter narrower note/caption text.
- Paper: replace periodic zigzags with displaced fiber mask, uneven broad contour and mottling.
- Privacy: separate phone-to-ear fan/host portraits; smaller label strips and compact shield.
- Privacy: finer arrows, shield rays, irregular cream label, handwritten yellow strip and rays.
- Women: diagonal pair with curly lower-right woman, tighter faces and torn/mesh scraps.
- Women: note in upper-right empty space, both faces clear, red pen accents.
- LGBTQ+: layered rainbow paper, dark striped right shirt, low cutout pair and mesh.
- LGBTQ+: narrow multiline note and heart, red/navy accents.
- Community: bold lead phrases, compact lighter KYC pills and CTA labels.
- Eligibility: preserved as accessible described-by text, removed extra visible layout row.
- Steps: reference line wraps, lighter outlined icons, shaded larger number discs and yellow rays.
- CTA: wide edge-bleeding host collage, across/up pointing pose, layered leaf/mesh papers.
- CTA: text directly over torn teal scrap, smaller centered copy/button, right yellow note underline/heart.
- CTA: independent far-right foliage/paper/mesh cluster restored.
## Verification evidence
- Release code: `fd6f32d108fcb6309a0e7d8d58ded679e4fbd169`.
- [GitHub Actions run 38288829814](https://github.com/hdavy2002/avatok-flutter-nostr-cloudflare/actions/runs/38288829814): build, homepage contracts, both safety jobs and browser matrix passed.
- Nine normal viewport widths and five 200% text checks passed; narrow privacy labels wrap without horizontal overflow.
- Actual immutable CI screenshots reviewed at 1024 and 1440 against the normalized original crop; final 1024 and 320/200% artifacts reviewed before production approval.
- Local screenshot evidence: `/tmp/hf-detail-review-fd6f32d1/`.
- Shared footer component and stylesheet have no changes against baseline `11373989`.
- Production run completed successfully; immutable deployment: https://9484fe06.avatok-app.pages.dev.
- Live https://hellofraands.com reviewed in a fresh browser at 1024px: correct font/artwork, all 11 images loaded, document width equals viewport, footer preserved.
- App Links checks passed on root and www. PostHog deploy annotation returned HTTP 201. Preeti sync skipped because PREETI_SYNC_TOKEN is absent.
- Closeout changes only this evidence document; deployed code remains fd6f32d1.
Raster assets are faithful generated recreations, not exact source photo extractions.
