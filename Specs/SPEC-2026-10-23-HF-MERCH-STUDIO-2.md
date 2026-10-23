# SPEC 2026-10-23 · HF-MERCH-STUDIO-2 · Merch studio rebuild (AI art, layers, all Printrove products)

Owner request 2026-10-23 (Davy). Builds on `Specs/SPEC-2026-10-23-HF-MERCH.md` (merch v1, live). Rules: `Specs/RULEBOOK-HELLO-FRAANDS.md` §19.
Design: `Specs/HF-DESIGN-SYSTEM.md` (read the ★ section). Worktree: `wt-hf-merch-studio-2`, branch `issue/hf-merch-studio-2`.

## 0. Owner decisions (2026-10-23)
- D1 Influencer can start a product from **Upload** (own art/photo) or **Create with AI** (Nano Banana 2 = Vertex `gemini-3.1-flash-image`).
  AI takes the influencer's photo/art as reference + a prompt, makes a picture; then the normal flow continues (pick product → design → price).
- D2 **Every AI picture costs a fixed admin-set charge** (admin page "AI charges", one field: rupees per picture). Every change/edit
  of an AI picture is a new picture and costs the same charge. Before generating, the UI always says "This will cost ₹X" and shows the
  wallet balance; if the wallet is short it says so and links to /wallet (no generation).
- D3 Only **paid wallet money** (purchase lots) pays. Free test credit never pays (same rule as merch purchases, HF-MERCH-6).
- D4 If generation fails (provider error, safety block, timeout) the charge is **refunded automatically** (idempotent).
- D5 Sell **all Printrove products that print** (≈28: T-shirts, hoodies, sweatshirts, joggers, shorts, jackets, polos, crop tops,
  tote bags, phone cases, bottles, mugs, posters/frames, notebooks, pop sockets, mouse pads, masks …), grouped by category.
  A product Printrove gives no print area for is skipped.
- D6 The studio gets real design tools: layers (images + text), fonts (incl. Devanagari), background remover, rotate/flip/align,
  undo/redo, opacity, text colour/outline/shadow/curve-free, zoom. Free libraries only (web: Konva, MIT). The page is
  Indianized and must look professional (no sloppy/boxy layout).
- D7 Web and the Android app (hf-flutter) both get the same flow. Commit to main, **do not trigger an app build**.

## 1. Flow (web and app identical)
1. **Start** — two big choices: "Upload your art / photo" and "Create with AI (₹X per picture)". Both end with ≥1 merch art
   (`artId`) in the influencer's "My art" tray. AI panel: up to 3 reference pictures (upload or pick from tray), prompt box,
   style chips (Bollywood poster, Madhubani, Warli, Kalamkari, Pop art, Truck art, Watercolour, Line art, 70s retro,
   Typography, Cartoon-free "3D clay"…), "Plain background for printing" toggle (default on), Generate button labelled
   "Create picture · ₹X". Results appear in a grid; "Change this" (edit prompt on a result, costs ₹X) and "Use this".
   Ownership checkbox stays for uploads ("I own this art…"); AI results are owned by the influencer (still needs the box ticked
   once when a reference photo of a real person is used: "I have the right to use these photos").
2. **Product** — category tabs (All · T-shirts · Hoodies & sweatshirts · Bottoms · Jackets · Accessories · Home & desk …,
   only those present), product cards with the product silhouette in its first colour, "from ₹" price, colour dots.
   Then side (only sides with a print area), colours (≤8), sizes (all preselected).
3. **Design** — the studio: product silhouette in the chosen colour with the dashed print area; layers placed inside the print
   area; left/right tool panels; DPI/sharpness meter for the selected image layer (≥150 DPI blocks "Looks good" like today:
   `dpiQuality` in `lib/studioGeometry`); shows "Prints W × H in" for the union of all layers.
4. **Price & publish** — unchanged money logic (quote with the exported print size), restyled.

## 2. Print file contract (unchanged server, new client)
- The print file is ONE transparent PNG = the union bounding box of all visible layers, clipped to the print area, rendered at
  300 DPI (cap 5000 px on the long side → effective DPI may drop; report the real DPI). `x/y/w/h` in inches from the print-area
  top-left. `POST /api/hf/merch/print-file` with `x-art-id = primary art` (the first image layer; if the design is text-only,
  first upload the rendered composite as art via `/art`, then use that id).
- `placement.frame='rect'`, `zoom=100`. Server `validatePlacement` gets an `area` override (D5) so non-shirt kinds validate.
- Mockups: render the silhouette + print at 900 px for up to 4 colours, upload via `/mockup` (as today).

## 3. Worker API (new)
All under `/api/hf/merch`, same envelope `{ok:true,…}` / `{ok:false,error,message}`; seller gate = live host (sellerCtx).
- `GET  ai` → `{ enabled, chargePaise, chargeRupees, balancePaise /*paid only*/, testCreditPaise, canAfford, recent:[{genId, artId, url, width, height, prompt, style, createdAt}] }` (recent = last 24 done gens).
- `POST ai/generate` body `{ requestKey (8–64 [A-Za-z0-9_-]), prompt (3–800 chars), style?, refArtIds?: string[] (≤3, own merch arts), baseArtId? (edit an earlier result), plainBackground?: boolean (default true), aspect?: '1:1'|'3:4'|'4:3'|'9:16' }`
  → 200 `{ gen:{genId, chargedPaise}, art: ArtUpload, balancePaise }`
  → 402 `{ error:'insufficient_funds', chargePaise, balancePaise, shortPaise, testCreditNotUsable, message }`
  → 422 `{ error:'prompt_blocked'|'art_blocked', refundedPaise, message }`, 502 `{ error:'generation_failed', refundedPaise, message }`,
  → 403 `ai_off`. Same `requestKey` again returns the first result (never charges twice).
- `POST art/:artId/remove-bg` → `{ art: ArtUpload }` (new art, transparent PNG). Free. Cloudflare Images `segment:'foreground'`;
  on failure 502 `{error:'bg_remove_failed', message:'…try "Erase plain colour" instead'}`.
- `GET  catalog` items gain `category` (slug), `categoryLabel`, `family` (silhouette key, §5), `sides` limited to sides with an
  area, `printAreas: { front?:{wIn,hIn}, back?:{wIn,hIn} }`, optional `imageUrl`.
- Admin: `GET/PUT /api/admin/merch/ai` `{ enabled, chargeRupees }` + `stats { today, last30:{count, chargedPaise, refundedPaise} }`, `recent[]` (last 50 gens with seller name, prompt, status, art url).
- Config keys: `hfMerchAiEnabled` (bool, default true), `hfMerchAiChargeRupees` (number, default 10, range 0–500; numericKeys).
- D1 `hf_merch_ai_gens` (own CREATE migration file): id, uid, request_key, status ('charging'|'generating'|'done'|'failed'|'refunded'),
  charge_paise, prompt, style, ref_art_ids_json, base_art_id, result_art_id, error, created_at, updated_at; UNIQUE(uid, request_key).
- Wallet: reuse `settleCall(..., { fixedValuePaise, onlyKind:'purchase' })` with call id `merchai:<genId>`; refund mirrors
  `refundWalletForOrder` (op ids `hfmai:<genId>:p`, mark `hfmai:<genId>:mark`).
- Telemetry: `merch_ai_generate` (status started|done|failed|refunded|insufficient), `$ai_generation` at completion
  (`$ai_model='gemini-3.1-flash-image'`, `$ai_provider='vertex'`), `merch_bg_remove`.

## 4. Fonts (shared web + app)
Static OFL/Apache TTFs in `web/public/fonts/merch/` (served at `https://hellofraands.com/fonts/merch/<file>`; app uses
`Brand.url('/fonts/merch/<file>')` + `FontLoader`). Families (display name → file):
Yatra One, Rozha One, Kalam (Bold), Khand (Bold), Mukta (ExtraBold), Tiro Devanagari Hindi, Sahitya (Bold), Poppins (ExtraBold)
— these 8 render Devanagari — plus Anton, Bebas Neue, Pacifico, Permanent Marker, Lobster, Abril Fatface, Righteous, Bangers.
Load on demand only when the studio opens (web-performance rule). UI chrome stays Nunito/Comfortaa.

## 5. Product families (silhouettes)
`tee, tee_long, vneck, polo, crop_top, hoodie, crop_hoodie, sweatshirt, jacket, joggers, shorts, tote, mug, bottle, phone_case,
poster, notebook, popsocket, mousepad, mask, cap, other`. Each family: an SVG path on a 1000×1000 stage + the print-area rectangle
for front/back as fractions of the stage (designer scales the area to keep the inch aspect ratio from the catalogue).
