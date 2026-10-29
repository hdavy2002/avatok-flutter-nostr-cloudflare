-- [HF-PAGES-1] Policy pages live in the database. The website and the app both read them through GET /api/hf/pages/:slug.
-- body = JSON array of blocks (see worker/src/lib/hf_pages.ts). version bumps on every admin edit.
CREATE TABLE IF NOT EXISTS site_pages (
  slug       TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  summary    TEXT NOT NULL DEFAULT '',
  related    TEXT NOT NULL DEFAULT '[]',
  body       TEXT NOT NULL DEFAULT '[]',
  version    INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  published  INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL DEFAULT ''
);
