-- Daily Workers AI spend counter (Scale proposal Phase 0: neuron budget alarm).
-- Applied to DB_MODERATION. Incremented best-effort by consumers on every model
-- call (moderation + brain). The 6h cron compares calls vs AI_DAILY_CALL_BUDGET
-- and emails ALERT_EMAIL once per day when exceeded.
CREATE TABLE IF NOT EXISTS ai_spend (
  day TEXT PRIMARY KEY,          -- YYYY-MM-DD (UTC)
  calls INTEGER NOT NULL DEFAULT 0,
  ms INTEGER NOT NULL DEFAULT 0, -- summed model latency (rough cost proxy)
  alerted INTEGER NOT NULL DEFAULT 0
);
