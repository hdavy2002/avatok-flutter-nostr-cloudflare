-- [AUMFE-KNOWLEDGE-VECTOR-1 2026-10-01] Shared knowledge layer tables (DB_META).
-- NOT yet applied. CREATE-only. Apply (production, a deliberate coordinator step, never an agent):
--   scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-01-aumfe-knowledge.sql
-- Times are epoch ms INTEGER. D1 is the truth; Vectorize is only the finder.

-- Approved library of Hindu tradition text. Only status='approved' rows are ever indexed or returned.
CREATE TABLE IF NOT EXISTS tradition_corpus (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  lang TEXT NOT NULL DEFAULT 'en',
  graha TEXT,
  weekday TEXT,
  deity TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','archived')),
  chunk_count INTEGER NOT NULL DEFAULT 0,
  indexed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_tradition_corpus_status ON tradition_corpus (status);
CREATE INDEX IF NOT EXISTS idx_tradition_corpus_topic ON tradition_corpus (topic);

-- Per-product / per-event tradition note: why this design suits whom and when.
CREATE TABLE IF NOT EXISTS product_tradition_notes (
  id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('shop_product','event')),
  subject_id TEXT NOT NULL,
  design_type TEXT CHECK (design_type IS NULL OR design_type IN ('deity','symbol','chakra','mandala','yantra','mantra','other')),
  design_elements_json TEXT NOT NULL DEFAULT '[]',
  print_colours_json TEXT NOT NULL DEFAULT '[]',
  shirt_colour TEXT,
  deity TEXT,
  graha TEXT,
  chakra TEXT,
  wear_days_json TEXT NOT NULL DEFAULT '[]',
  occasions_json TEXT NOT NULL DEFAULT '[]',
  mantra TEXT,
  tradition_note TEXT NOT NULL DEFAULT '',
  story TEXT NOT NULL DEFAULT '',
  sources_json TEXT NOT NULL DEFAULT '[]',        -- ids of tradition_corpus rows
  match_reasons_json TEXT NOT NULL DEFAULT '[]',  -- ordered [{step:'deity'|'chakra'|'print_colour'|'shirt_colour', fact, source_id?}]
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','rejected')),
  drafted_at INTEGER,
  approved_by TEXT,
  approved_at INTEGER,
  vector_id TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE (subject_kind, subject_id)
);

CREATE TABLE IF NOT EXISTS knowledge_index_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  index_name TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('upsert','delete')),
  ok INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  ms INTEGER,
  created_at INTEGER NOT NULL
);
