-- [HF-REF-FINAL-1] Make host busy/online transitions owned by one call.
ALTER TABLE hf_hosts ADD COLUMN presence_call_id TEXT;
UPDATE hf_hosts
SET presence = CASE WHEN presence = 'online' THEN 'busy' ELSE presence END,
    presence_call_id = (
  SELECT c.id
  FROM hf_calls c
  WHERE c.host_uid = hf_hosts.uid
    AND c.status IN ('ringing_host','ringing_caller','connected','ending','finalizing')
  ORDER BY c.created_at DESC
  LIMIT 1
)
WHERE EXISTS (
  SELECT 1
  FROM hf_calls c
  WHERE c.host_uid = hf_hosts.uid
    AND c.status IN ('ringing_host','ringing_caller','connected','ending','finalizing')
);
CREATE INDEX IF NOT EXISTS idx_hf_hosts_presence_call
  ON hf_hosts(presence_call_id)
  WHERE presence_call_id IS NOT NULL;
