-- [HF-DESK-CW-3] Free labels for the agent desk (Chatwoot labels). The ticket's category stays the built-in label; these are
-- extra labels an agent creates in Settings > Labels and adds to tickets. CREATE only (re-runnable).
CREATE TABLE IF NOT EXISTS support_labels (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  title           TEXT NOT NULL UNIQUE,            -- lower-case, a-z 0-9 - _
  description     TEXT NOT NULL DEFAULT '',
  color           TEXT NOT NULL DEFAULT '#64748b',
  show_on_sidebar INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS support_ticket_labels (
  ticket_number INTEGER NOT NULL,
  label         TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (ticket_number, label)
);
CREATE INDEX IF NOT EXISTS idx_support_ticket_labels_label ON support_ticket_labels(label);
