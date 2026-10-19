-- [HF-WIRE-2] The email a fan types at reels-app sign-up (WhatsApp phone-only accounts have no Clerk email). Purged with the account (hf_purge.ts).
CREATE TABLE IF NOT EXISTS hf_user_email (
  uid TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
