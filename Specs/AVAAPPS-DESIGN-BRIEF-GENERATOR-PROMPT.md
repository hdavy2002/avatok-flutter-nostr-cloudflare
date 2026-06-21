# AvaApps — Design-Brief Generator Prompt

Paste the prompt below into any capable AI. Fill in the **`[APP]`** line (and
optionally the intents you care about). It will produce a card design brief in
the same structure as the Gmail/Calendar one — designer-facing, no API wiring.

---

## THE PROMPT (copy from here)

You are a product designer writing a **design brief** for in-chat "action cards"
rendered by an AI assistant named **AVA**. The user asks AVA something in plain
language and AVA replies with a card that shows the result and offers tappable
action buttons. Your output is a **design spec only** — describe content slots,
badges, buttons, and states in design language. Do NOT mention APIs, fields,
JSON, or how data is fetched.

**App this brief is for:** `[APP — e.g. Google Drive]`
**Optional — key things users will ask it:** `[e.g. "find my recent files",
"share this doc", "what changed in this folder" — or leave blank and infer the
5–8 most common intents yourself]`

### Design system you must follow (fixed across all AvaApps)
- **Surface:** each result is a full-width chat card from AVA with: a header strip
  (`AVA · PRIVATE`), one bold human **lead line** summarizing the result, a dark
  **context pill** (icon + summary), a **body** (item rows or a hero state), an
  **action row** of buttons, and a muted timestamp.
- **Three reusable card archetypes** — frame everything as these:
  1. **Digest card** — lead line + context pill + a stack of item rows (a list result).
  2. **Item card** — one object with its own mini action row.
  3. **Result chip** — compact confirmation that replaces a card/button after an action.
  Plus a **Compose/Edit sheet** (inline editor) and **Loading/Empty/Error** states.
- **Button intent system** (use consistently):
  - **Primary** = solid lime, one per row, the main forward action.
  - **Secondary** = white with dark outline, neutral/alternate action.
  - **Destructive** = soft pink, removes/rejects (never first, right-aligned).
  - **Positive/status** = mint with ✓, confirms / done / positive state.
  - Max **3 buttons** per item row; overflow → "⋯ More" menu.
- **Visual language:** thick rounded outlines, soft shadow, lavender card bg,
  lime = go, pink = stop, mint = positive/done, bold friendly type, large
  thumb-friendly buttons that stack on narrow phones.

### What to produce (use these section headings)
0. **The surface** — restate the shell briefly for this app.
1. **Intents covered** — list the 5–8 user phrases this app should handle, each
   mapped to which archetype renders it (Digest / Item / Result chip / Sheet).
2. **One section per card** — for EACH card give:
   - Purpose (the intent it answers).
   - Content slots (named, in design terms — e.g. "title, owner avatar, modified-time, type icon").
   - Badges (when shown and what they signal).
   - Action row (the buttons + their intent color from the system above).
   - After-action behavior (what Result chip replaces it).
3. **Compose/Edit sheet** — only if this app has a create/edit/share action;
   list its fields and footer buttons.
4. **State checklist** — confirm each card is designed for Loading, Empty/Hero,
   Populated, Success-after-action, and Error+Retry.
5. **Generator handoff** — a single paste-ready paragraph the user can give to an
   AI image/UI tool to render the whole set in the AVA style.

### Rules
- Keep it skimmable: tables for button rows, short bullets for slots.
- Invent sensible, realistic content for examples (names, titles, counts).
- Reduce duplication — if two intents share a card, say so rather than repeating.
- Tailor the lead lines and empty/hero states to this app's personality.

Now write the full design brief for **`[APP]`**.

---

## How to use
1. Replace `[APP]` with the app (Google Drive, Google Sheets, Notion, Slack, Asana…).
2. Optionally fill the "key things users will ask" line; otherwise the AI infers them.
3. Run it. You'll get a brief shaped like the Gmail/Calendar one, ready to feed to a UI design tool.

**Tip:** keep all generated briefs in `Specs/` named `AVAAPPS-<APP>-CARD-DESIGN-BRIEF.md`
so the whole AvaApps card system stays consistent.
