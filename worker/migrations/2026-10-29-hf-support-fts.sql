-- [HF-SUPPORT-1] Full-text search over subject + latest preview + contact email/name. OPTIONAL: if this statement fails
-- on a D1 database, search falls back to LIKE automatically (routes/hf_support_admin.ts searchTickets).
-- A plain (not external-content) FTS5 table that the worker keeps in step: delete-then-insert on every ticket change.
CREATE VIRTUAL TABLE IF NOT EXISTS support_fts USING fts5(
  number UNINDEXED,
  subject,
  preview,
  contact,
  tokenize = 'unicode61 remove_diacritics 2'
);
