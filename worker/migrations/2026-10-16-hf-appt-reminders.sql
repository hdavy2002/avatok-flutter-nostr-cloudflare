-- [HF-APPT-REMIND-1] Per-person switch for appointment reminders (default on).
ALTER TABLE hf_user_prefs ADD COLUMN appt_reminders INTEGER NOT NULL DEFAULT 1;
