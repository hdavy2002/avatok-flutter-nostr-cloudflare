-- [HF-ADMIN-SPEED-2] Indexes for the Standard-plan admin reports (routes/hf_std_admin.ts). CREATE INDEX only, safe to re-run.
-- calls window: status='completed' AND ended_at range, ordered by ended_at (was: hf_calls_status(status, created_at), so ended_at was filtered by scanning every completed call)
CREATE INDEX IF NOT EXISTS hf_calls_status_ended ON hf_calls(status, ended_at);
-- summary: top-ups, corrections, refund revokes, Google refunds are all "kind + created/refunded time" ranges
CREATE INDEX IF NOT EXISTS hf_token_lots_kind_created ON hf_token_lots(kind, created_at);
CREATE INDEX IF NOT EXISTS hf_token_ledger_kind_created ON hf_token_ledger(kind, created_at);
CREATE INDEX IF NOT EXISTS hf_refund_requests_kind_refunded ON hf_refund_requests(kind, status, refunded_at);
