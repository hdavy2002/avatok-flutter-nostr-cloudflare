
# Stream C: site-wide vocabulary sweep  (commit tag [WEB-GATEWAY-C])

Read Specs/WEBGW-COMMON.md first. Another agent (Stream A) owns: web/src/pages/index.astro, components/SiteHeader.astro, components/SiteFooter.astro, components/IndiaLanguageSelector.astro, lib/indiaLandingLocales.ts, lib/i18n/*, components/home/*. DO NOT edit those files.

1. Ideas catalogue (/ideas) and every guide under /blog/creator-ideas/*: titles, summaries, card labels and body copy into plain English. Find the content source (content collection or data file) and edit there. Keep slugs/URLs unchanged.
2. Remove the Dil Ki Baat guide and any idea whose category is companionship, friendship, listening, loneliness or similar: mark draft/unpublish at the source, remove from lists, sitemap-pages ROUTES and llms-creator-ideas.txt.ts, and add a path redirect to /ideas in web/public/_redirects (path form only; host-form rules are ignored by Pages).
3. Also remove any "Style desk"/draping/look-breakdown idea and any dating, astrology-prediction, investment-tip or medical-advice idea. List what you removed in the report.
4. Sweep these pages for the banned words and Hinglish and rewrite in plain English without changing meaning: about, pricing-fees, payouts, contact, marketplace (page chrome and empty states only), tokens, careers, sign-up/sign-in marketing copy, help centre articles under web/src/content/help/**. Policy pages may keep a banned word only where the sentence prohibits the thing.
5. Marketplace group DISPLAY labels must read Live events / 1:1 consultations / Group classes. They are generated from Specs/listing-taxonomy.json. Do NOT edit the JSON or generated files in this stream; instead report the exact JSON keys and current label strings that need changing (Stream F will do it).
6. Report every remaining occurrence you deliberately left, with file and reason:
   grep -rniE "private|meetup|fanbase|find your people|companionship|live-friends|apna|kamaai|kamao" web/src


## OWNER UPDATE 18 Sep (overrides anything above that conflicts)
- Remove unsafe articles: any blog post, guide or help article about companionship, listening sessions, loneliness, making friends, dating, private numbers for strangers, adult themes, astrology predictions, investment tips or medical advice. Unpublish at source, drop from lists/sitemap ROUTES/llms files, add path redirects (/blog/<slug> -> /blog or /ideas). Review blog/your-private-number, blog/never-miss-a-call and blog/ai-in-every-chat: rewrite titles/copy if the feature is legitimate but the wording reads like a dating/anonymous-chat product; list each decision in the report.
- ENTITY CLEANUP (this stream now owns org.ts, LegalStatus.astro, EntityFaq.astro, BetaBanner.astro, Base.astro meta/JSON-LD, marketingContent.js, llms-creator-ideas.txt.ts, api/waitlist.ts and all policy pages):
  * The ONLY legal entity named on the site is the registered one already in org.ts: Ava Global International, Inc. (Delaware). Keep its legalName and address exactly as they are.
  * REMOVE every mention of "Ave Maria International Pvt Ltd" / indianEntity / "Indian operating entity" from org.ts, JSON-LD and all pages. Do not introduce any other Indian company name. Do not write "Pvt Ltd" anywhere.
  * Where a page needs to mention India, use exactly: "An Indian subsidiary is being incorporated in Mumbai; its details will be published here once registered."
  * Simplify LegalStatus.astro to: who you are dealing with (one paragraph), registered office + contact (one paragraph), and the India sentence above. Remove "American and Indian founders" phrasing and the "site is evolving" paragraph only if no policy page depends on it (check usages).
  * Do not change governing-law or jurisdiction clauses.
  * Remove "Delaware company, American and Indian founders" from meta keywords site-wide.
