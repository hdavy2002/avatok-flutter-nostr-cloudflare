// [WEB-HELP-1 2026-09-11] Content collection for the avatok.ai help centre.
// Markdown files under src/content/help/<section>/<slug>.md become the
// `help` collection via Astro's glob loader — entry.id is the file's path
// relative to `base` without extension, e.g. "billing/platform-fee", which
// src/lib/help.ts turns into the route /help/billing/platform-fee. The zod
// schema below is the enforcement point: a page missing a section, order,
// description or updated date fails `astro build` instead of shipping.
// See Specs/HELP-CENTER-PLAN-2026-09-11.md §4 for the reasoning.
import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const help = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/help' }),
  schema: z.object({
    title: z.string().min(4).max(90),
    description: z.string().min(20).max(200), // meta description + card blurb
    section: z.enum(['getting-started', 'booking-and-paying', 'creators', 'billing', 'account-and-safety']),
    order: z.number().int().min(1), // position within section
    updated: z.coerce.date(),
    keywords: z.array(z.string()).default([]), // extra search terms, e.g. ["UPI","withdraw"]
    audience: z.enum(['buyer', 'creator', 'both']).default('both'),
    faq: z.array(z.object({ q: z.string(), a: z.string() })).default([]), // optional FAQPage JSON-LD source
    draft: z.boolean().default(false), // excluded from build, sitemap, search
  }),
});

export const collections = { help };
