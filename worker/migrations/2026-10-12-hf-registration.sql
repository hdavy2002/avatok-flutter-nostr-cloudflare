-- [HF-REF-AUTH-1] Native registration identity and immutable public username.

CREATE TABLE IF NOT EXISTS hf_user_registration (
  uid TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  terms_accepted_at INTEGER NOT NULL,
  privacy_accepted_at INTEGER NOT NULL,
  disclaimer_accepted_at INTEGER NOT NULL,
  community_accepted_at INTEGER NOT NULL,
  engagement_accepted_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS hf_user_registration_username_ci
  ON hf_user_registration(lower(username));
