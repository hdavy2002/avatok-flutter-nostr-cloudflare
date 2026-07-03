-- [MULTIACCT-2] Device-level push token + account-level routing.
--
-- WHY: One phone is shared by a parent + each child account (rulebook rule 1),
-- and users log out/in frequently. The FCM token belongs to the DEVICE (like the
-- Clerk client token, which is already global), not to whichever account happened
-- to register it. The old push_tokens_v2 table keyed tokens by `uid`, so an
-- account switch ORPHANED the previous account's token row and a re-login minted a
-- fresh row while the server still held the stale one — the silent-fan-out bug
-- (2026-07-03: callee re-logged-in, server sent a call push to a dead token, the
-- call never rang, no push_no_device). See MULTIACCT-1 for the fan-out fix; this
-- migration fixes the STORAGE model so switch = flip the mapping, never orphan.
--
-- DESIGN (minimal-change, additive — push_tokens_v2 is KEPT and dual-written so
-- nothing breaks during rollout; resolution can prefer the new join and fall back):
--   device_tokens(device_id, platform, token, updated_at)
--     — one row PER DEVICE. The FCM/APNs token as it currently is on that device.
--       A token refresh UPDATES this row in place (keyed by device_id), so a
--       device never accumulates stale token rows.
--   account_devices(account_id, device_id, active, last_seen)
--     — which accounts are reachable on which device. Login/account-switch UPSERTs
--       (account_id, device_id, active=1). Logout sets active=0. A callee's tokens
--       resolve as: SELECT dt.token FROM account_devices ad JOIN device_tokens dt
--       ON dt.device_id=ad.device_id WHERE ad.account_id=? AND ad.active=1.
--
-- Apply (STAGING/PROD — DO NOT run as part of this change; owner applies manually):
--   wrangler d1 execute avatok-meta --remote --file=migrations/device_tokens.sql

CREATE TABLE IF NOT EXISTS device_tokens (
  device_id  TEXT PRIMARY KEY,       -- stable per-device UUID (client-persisted, device-level)
  platform   TEXT NOT NULL,          -- 'fcm' | 'apns'
  token      TEXT NOT NULL,          -- the current FCM/APNs token on this device
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_device_tokens_token ON device_tokens(token);

CREATE TABLE IF NOT EXISTS account_devices (
  account_id TEXT NOT NULL,          -- Clerk uid reachable on this device
  device_id  TEXT NOT NULL,          -- FK → device_tokens.device_id
  active     INTEGER NOT NULL DEFAULT 1, -- 1 = account currently signed in on this device
  last_seen  INTEGER NOT NULL,
  PRIMARY KEY (account_id, device_id)
);
CREATE INDEX IF NOT EXISTS idx_account_devices_account ON account_devices(account_id);
CREATE INDEX IF NOT EXISTS idx_account_devices_device  ON account_devices(device_id);
