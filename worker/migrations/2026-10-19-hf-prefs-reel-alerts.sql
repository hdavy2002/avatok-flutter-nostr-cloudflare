-- [HF-WIRE-2] Third WhatsApp switch: "New reels from my favourites" (default on). ALTER-only file (scripts/d1_apply_alters.py).
ALTER TABLE hf_user_prefs ADD COLUMN reel_alerts INTEGER NOT NULL DEFAULT 1;
