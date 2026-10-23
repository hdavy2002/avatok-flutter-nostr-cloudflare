-- [HF-CALL-MODES-P0] Backfill call_mode / on_call_since AFTER 2026-10-24-hf-call-modes-alters.sql. Data only, idempotent (safe to re-run).
-- offline presence -> bookings_only (D6: the shipped apps' "Offline" means "Bookings stay open"); online/busy keep the column default 'online'.
-- The WHERE call_mode='online' guard means a re-run never overrides a mode a host chose later (online mode always has presence online|busy).
UPDATE hf_hosts SET call_mode='bookings_only' WHERE call_mode='online' AND presence='offline';
-- A host currently on a connected call gets on_call_since = that call's connected_at (the line lock presence_call_id names it).
UPDATE hf_hosts SET on_call_since = (SELECT c.connected_at FROM hf_calls c WHERE c.id = hf_hosts.presence_call_id AND c.status='connected' AND c.connected_at IS NOT NULL)
 WHERE on_call_since IS NULL AND presence_call_id IS NOT NULL;
