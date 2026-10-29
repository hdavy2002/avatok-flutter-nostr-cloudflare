-- [HF-SUPPORT-1] Seed rows. Re-runnable (INSERT OR IGNORE). Apply after 2026-10-29-hf-support-tables.sql.
-- n=10000 so the first ticket number handed out is 10001.
INSERT OR IGNORE INTO support_counter (id, n) VALUES (1, 10000);

INSERT OR IGNORE INTO support_settings (key, value, updated_at) VALUES
  ('alert_whatsapp', '+917817058560', 0),
  ('business_hours', '{"tz":"Asia/Kolkata","utcOffsetMin":330,"days":[1,2,3,4,5,6],"start":"10:00","end":"19:00"}', 0),
  ('holidays', '[]', 0);

-- The owner. uid is filled in at first login by matching the account's verified email.
INSERT OR IGNORE INTO support_staff (email, uid, name, role, created_at) VALUES
  ('hdavy2002@gmail.com', NULL, 'Owner', 'admin', 0);

INSERT OR IGNORE INTO support_signatures (scope_key, html, use_for, updated_by, updated_at) VALUES
  ('team', '', 'team', NULL, 0);
