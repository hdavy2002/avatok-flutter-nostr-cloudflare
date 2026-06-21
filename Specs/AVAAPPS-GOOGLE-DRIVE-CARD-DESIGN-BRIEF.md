# AvaApps — Google Drive Card Design Brief

Designer-facing spec for the in-chat **action cards** AVA renders when a user talks to their Google Drive in plain language. Design language only — no APIs, fields, or data wiring.

---

## 1. The surface

Every Drive result is a full-width chat card from AVA on the lavender card background, thick rounded outline, soft shadow. The shell, top to bottom:

- **Header strip** — `AVA · PRIVATE` (signals this is the user's own Drive, read on-device).
- **Lead line** — one bold, human sentence summarizing the result ("Found 6 files you touched this week").
- **Context pill** — dark rounded pill, Drive glyph + a short restating of the query ("Recent · last 7 days").
- **Body** — either a stack of item rows (Digest), one object (Item), or a hero state.
- **Action row** — tappable buttons following the intent-color system.
- **Timestamp** — muted, bottom-right ("just now").

Drive's personality: tidy, calm, custodial. Lead lines sound like a helpful archivist, not a search engine. File-type color chips and owner avatars carry most of the visual weight.

---

## 2. Intents covered

| User says | Renders as |
|---|---|
| "Find my recent files" / "What did I work on this week?" | **Digest** (file list) |
| "Search my Drive for the Q3 budget" | **Digest** (file list, query echoed) |
| "What's in my Marketing folder?" | **Digest** (folder contents) |
| "Show me that deck Priya shared with me" | **Item** (single file) → falls back to Digest if ambiguous |
| "Share this doc with the team" | **Share sheet** → **Result chip** |
| "What changed in the Launch folder?" | **Digest** (activity list, change badges) |
| "Make a copy / rename / move this file" | **Item** action → **Result chip** |
| "How much space am I using?" | **Item** (storage hero) |

Shared cards: the three file-list intents (recent, search, folder contents) all use **one Digest card** — only the lead line and context pill differ. The "what changed" intent reuses the same Digest skeleton with change badges swapped in.

---

## 3. Cards

### 3a. File Digest card
*(covers recent files, search, folder contents)*

**Purpose** — answer any "show me a list of files" intent.

**Content slots**
- Lead line — count + framing ("6 files, newest first").
- Context pill — scope label ("Search · 'Q3 budget'" or "Folder · Marketing").
- Item rows (stacked, max ~5 then "Show more"):
  - File-type icon chip (color-coded: blue=Docs, green=Sheets, amber=Slides, grey=PDF, purple=image/video, plain=folder).
  - File title (bold, truncates one line).
  - Owner avatar + "you" or owner name.
  - Modified-time, muted ("2h ago").
  - Optional location crumb ("in Marketing / 2026").

**Badges**
- `Shared` — pill when the file has other collaborators.
- `Starred` — small star when flagged.
- `Only you` — quiet badge to reassure on private files.

**Action row** (per row, max 3)

| Button | Intent | Action |
|---|---|---|
| Open | Primary (lime) | Opens the file |
| Share | Secondary (white/outline) | Launches Share sheet |
| ⋯ More | overflow | Rename, Copy, Move, Remove |

Card-level footer button: **Show more** (Secondary) when results are truncated.

**After-action** — "Share" collapses into a Result chip ("✓ Shared with 3 people"). "Open" leaves the card intact.

---

### 3b. File Item card
*(single file: "show me that deck", or the focused object after a search match)*

**Purpose** — present one file with its own action row and richer detail.

**Content slots**
- Lead line ("Here's the deck Priya shared").
- Context pill ("Slides · shared with you").
- Hero block: large file-type icon/thumbnail, full title, owner avatar + name, modified-time, file size, location crumb.
- Collaborator avatar cluster (stacked, "+4").

**Badges** — `Shared`, `Starred`, `Suggested edits pending`, `View only` (signals the user's access level).

**Action row**

| Button | Intent | Action |
|---|---|---|
| Open | Primary (lime) | Opens the file |
| Share | Secondary | Share sheet |
| Make a copy | Secondary | Duplicates |
| Remove | Destructive (pink, right) | Sends to trash, in ⋯ More if 3 are full |

**After-action** — each action resolves to a Result chip: "✓ Copy made", "✓ Moved to trash" (with an **Undo** Secondary inline).

---

### 3c. Folder Activity card
*("what changed in X")*

Reuses the Digest skeleton; rows describe **changes** rather than files.

**Content slots**
- Lead line ("4 changes in Launch since Monday").
- Context pill ("Activity · Launch folder").
- Item rows: actor avatar + name, change verb chip (`edited` / `added` / `commented` / `renamed`), file title, time.

**Badges** — `New` for items added since last viewed; `Comment` chip when the change is a comment.

**Action row** — Open (Primary) per row; card footer **Open folder** (Secondary).

---

### 3d. Storage card
*("how much space am I using?")*

**Purpose** — single-glance storage status. An Item card with a hero gauge.

**Content slots**
- Lead line ("You're using 11.4 GB of 15 GB").
- Horizontal usage bar segmented by type (Drive / Photos / Gmail), color-coded.
- Three quiet stat rows with type + amount.
- Nudge line when >80% full ("Running low — clear space?").

**Badges** — `Almost full` (amber) at >80%, `Full` (pink) at 100%.

**Action row** — **Find large files** (Primary), **Empty trash** (Secondary). At 100%, **Empty trash** promotes to Primary.

**After-action** — "Empty trash" → Result chip "✓ Trash emptied · 1.2 GB freed".

---

### 3e. Result chip (shared component)

Compact confirmation that replaces a card or button after any write action. Mint background + ✓ for success, pink for rejection/removal. Carries a one-line summary and, where reversible, a single **Undo** (Secondary).

Examples: "✓ Shared with marketing-team", "✓ Renamed to 'Q3 Budget FINAL'", "✓ Moved to Archive", "✓ Copy made".

---

## 4. Share / Edit sheet

Launched by any "Share" or "Rename / Move" action. Inline editor sliding over the card.

**Share fields**
- Recipient picker (avatar chips + add field).
- Access level selector — `Viewer` / `Commenter` / `Editor` (segmented).
- Optional message line.
- "Notify people" toggle.
- Link-access summary row ("Restricted" / "Anyone with link").

**Rename / Move fields** (same sheet, different mode)
- Editable title field (Rename).
- Folder destination picker (Move).

**Footer buttons**

| Button | Intent |
|---|---|
| Share / Save | Primary (lime) |
| Cancel | Secondary |

On confirm → sheet collapses into the matching Result chip.

---

## 5. State checklist

| Card | Loading | Empty / Hero | Populated | Success-after-action | Error + Retry |
|---|---|---|---|---|---|
| File Digest | Skeleton rows shimmer | "Nothing matched 'Q3 budget' — try another name" | File rows | Share/Move → chip | "Couldn't reach your Drive" + **Retry** |
| File Item | Hero skeleton | "That file isn't here anymore" | Full detail | Copy/Trash → chip + Undo | Retry |
| Folder Activity | Skeleton rows | "All quiet — no changes here" | Change rows | Open leaves intact | Retry |
| Storage | Bar shimmer | (always populated) | Gauge + stats | Empty trash → chip | Retry |
| Share sheet | — | Empty recipient state | Filled fields | Collapses to chip | "Share didn't go through" + **Retry** |

Empty states stay warm and Drive-flavored ("All quiet", "Nothing here yet") rather than cold "No results".

---

## 6. Generator handoff

> Design a set of mobile chat "action cards" from an AI assistant named AVA for Google Drive, all on a soft lavender card background with thick rounded black outlines, soft drop shadows, and bold friendly type. Each card has a small header strip reading "AVA · PRIVATE", one bold human lead line, a dark rounded context pill with a Drive icon, a body, a row of large thumb-friendly buttons, and a muted timestamp bottom-right. Buttons use a fixed intent system: solid lime = primary/go (one per row), white-with-dark-outline = secondary, soft pink = destructive (right-aligned), mint with a ✓ = positive/done. Render: (1) a **File Digest card** — lead line "Found 6 files you touched this week", a dark pill "Recent · last 7 days", and a stack of file rows each with a color-coded file-type icon (blue Docs, green Sheets, amber Slides, grey PDF), bold title, owner avatar, "2h ago", and Shared/Starred badges, with Open (lime) + Share (outline) + "⋯ More" buttons; (2) a **File Item card** — one Slides file hero with large icon, title "Launch Deck v4", owner avatar, file size, a stacked collaborator avatar cluster "+4", a "Shared" badge, and Open (lime) / Share (outline) / Remove (pink) buttons; (3) a **Folder Activity card** — lead line "4 changes in Launch since Monday" with rows showing actor avatars and verb chips (edited, added, commented); (4) a **Storage card** — lead line "You're using 11.4 GB of 15 GB" with a horizontal segmented usage bar and Find large files (lime) + Empty trash (outline) buttons; (5) a **mint Result chip** reading "✓ Shared with marketing-team" with a small Undo; and (6) a **Share sheet** overlay with recipient avatar chips, a Viewer/Commenter/Editor segmented selector, and Share (lime) / Cancel (outline) footer buttons. Keep everything consistent: lime = go, pink = stop, mint = done, buttons stack on narrow phones.
