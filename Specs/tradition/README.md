# Tradition library (DRAFT)

## Purpose

Short, accurate, plain-English passages about Hindu tradition. A virtual pandit ("Pandit ji") retrieves them by vector search to explain which deity, weekday, colour, chakra or puja tradition links to what, and why a T-shirt design (deity, symbol, chakra, mandala, yantra) is suggested for a given weekday.

Every passage must stand alone: a retrieved chunk is read without its neighbours, so each names its subject in full.

## Status: every entry is a DRAFT

All entries are drafts. **Nothing here is approved for customer-facing use until a qualified pandit has reviewed it.** Reviewers should correct, soften or delete any claim they cannot stand behind. Where lineages differ, the entry should say so rather than pick one.

## Owner rule: go by the book, sell no promises

Describe what tradition prescribes or believes. Never claim outcomes.

Use wording like:
- "is traditionally worshipped on ..."
- "devotees believe ..."
- "is commonly associated with ..."
- "many families observe ..."
- "texts describe ..." (only when a text really does)
- "practice varies by region and family"

Never use wording like: guarantees, cures, will remove, will fix, 100%, definitely, "you will get ...", "this will solve ...". Also avoid fear language ("dangerous", "cursed", "doomed") and never suggest that a person must buy something or perform a ritual to avoid harm. No medical, legal, financial or marriage-outcome claims. Astrology-linked remedies are described as customs, not as effective treatments.

The build script rejects these words in passages: guarantee, cure, will remove, will fix, 100%, definitely.

## Sourcing rules

Accuracy matters more than volume. If unsure of a claim, leave it out.

The `source` field must be one of:
- A named classical text, only where it is genuinely and widely recognised as the source for that specific point (for example Brihat Parashara Hora Shastra for graha significations, Satchakra-nirupana / Shat-chakra-nirupana for classical chakra descriptions, Shiva Purana for Shiva worship, Hanuman Chalisa by Tulsidas, Devi Mahatmya / Durga Saptashati).
- `Widely followed tradition`
- `Common North Indian practice`
- `Regional practice (varies)`
- `Modern convention` (for things such as the rainbow chakra colours, Navratri day colours, or T-shirt design suggestions)

Never invent chapter or verse numbers, and never put a quotation in an entry unless it is a well-known mantra or a title.

## Entry format

Each topic file holds many entries. The build script parses them, so keep the format exact.

```
### <id-kebab-unique>
- topic: navagraha | weekday | deity | chakra | symbol | puja | dosha | festival | colour
- title: <short title>
- graha: <surya, chandra, mangal, budh, guru, shukra, shani, rahu, ketu, or empty>
- weekday: <monday ... sunday, or empty>
- deity: <lowercase name, or empty>
- source: <see sourcing rules>
- lang: en

<passage, 60-160 words (script enforces 40-220), plain English,
Hindi terms in Roman script with a short gloss>
```

Rules:
- Ids are lowercase kebab-case and unique across all files.
- All seven metadata fields must be present, even when the value is empty.
- Passage is one paragraph after a blank line.
- Banned promise words fail the build.

## Files

- `navagraha.md`, `weekdays-and-vrats.md`, `deities.md`, `chakras.md`, `symbols-mandalas-yantras.md`, `pujas-and-havans.md`, `doshas.md`, `festivals.md`
- `corpus.jsonl` is generated: `python3 scripts/tradition_build.py`. Do not edit by hand.

## Regional variation

Colours, grains, metals and day-deity pairings differ between traditions, families and regions. Where a point is commonly given but not universal, the entry says "commonly" or "in many traditions". Reviewers should add regional notes (South Indian, Bengali, Gujarati, Maharashtrian and others) where they know them.
