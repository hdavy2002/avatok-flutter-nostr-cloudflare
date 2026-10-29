-- [HF-INFLUENCER-GATE-1 2026-10-29] 'approved' and 'pending_check' are RETIRED host statuses (nothing writes them any more).
-- Owner 2026-10-29: 'approved' was set automatically (channel / video KYC) with no human approval, so it is NOT an influencer: back to 'draft'.
-- A 'pending_check' row was only ever created by a social login / channel add: she is a fan with a draft row, not an influencer.
UPDATE hf_hosts SET status='draft', updated_at=strftime('%s','now')*1000 WHERE status='approved';
UPDATE hf_hosts SET status='draft', updated_at=strftime('%s','now')*1000 WHERE status='pending_check';
